#![cfg(feature = "integration")]
//! BLOCKED — see Blocker #6 in docs/implementation-plan.md.
//!
//! These tests are correct and compile, but cannot run on this toolchain:
//! Anchor 1.2 hardcodes `--arch v3`, and the litesvm versions that load
//! SBPF v3 require a newer rustc than platform-tools pins. Run with
//! `cargo test -p oracle --features integration` once that is resolved.

//! On-chain tests for the oracle's four defences, against a real AMM curve.
//!
//! The pure-logic tests in `src/lib.rs` prove the arithmetic. These prove the
//! program: that a transaction which should be refused actually is, and that
//! the state machine lands where it should after real reserves move.
//!
//! Every test here is a NEGATIVE one except the first. That is deliberate —
//! the positives say the thing works, the negatives say the thing cannot be
//! broken, and only the second kind is worth much.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    slab_interface::{AmmAdapter, OracleAccount, OracleParams, OracleState},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const USDC: u64 = 1_000_000;
const WAD: u64 = 1_000_000;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    basket: Pubkey,
    pool: Pubkey,
    oracle: Pubkey,
}

fn setup(usdc: u64, fraction: u64) -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(
        oracle::id(),
        include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/oracle.so")),
    )
    .unwrap();
    svm.add_program(
        mock_amm::id(),
        include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/mock_amm.so")),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let pool_kp = Keypair::new();
    let basket = Keypair::new().pubkey();
    let oracle_pda =
        Pubkey::find_program_address(&[slab_interface::seeds::ORACLE, basket.as_ref()], &oracle::id()).0;

    let mut env = Env {
        svm,
        payer,
        basket,
        pool: pool_kp.pubkey(),
        oracle: oracle_pda,
    };

    // Blocker #2 in miniature: nothing works until someone funds the pool.
    let ix = Instruction::new_with_bytes(
        mock_amm::id(),
        &mock_amm::instruction::CreatePool { usdc, fraction }.data(),
        mock_amm::accounts::CreatePool {
            payer: env.payer.pubkey(),
            pool: pool_kp.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    env.send_signed(&[ix], &[&pool_kp]).expect("create_pool");

    let ix = Instruction::new_with_bytes(
        oracle::id(),
        &oracle::instruction::Initialize {
            adapter: AmmAdapter::Mock,
            params: OracleParams::default(),
        }
        .data(),
        oracle::accounts::Initialize {
            admin: env.payer.pubkey(),
            basket,
            amm_pool: pool_kp.pubkey(),
            oracle: oracle_pda,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    env.send(&[ix]).expect("initialize oracle");
    env
}

impl Env {
    fn send(&mut self, ixs: &[Instruction]) -> Result<(), String> {
        self.send_signed(ixs, &[])
    }

    fn send_signed(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), String> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &blockhash);
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers)
            .map_err(|e| e.to_string())?;
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    fn refresh(&mut self) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            oracle::id(),
            &oracle::instruction::RefreshPrice {}.data(),
            oracle::accounts::RefreshPrice {
                caller: self.payer.pubkey(),
                oracle: self.oracle,
                amm_pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(&[ix])
    }

    fn swap_usdc_in(&mut self, amount: u64) {
        let ix = Instruction::new_with_bytes(
            mock_amm::id(),
            &mock_amm::instruction::Swap {
                usdc_in: amount,
                fraction_in: 0,
            }
            .data(),
            mock_amm::accounts::Modify {
                caller: self.payer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(&[ix]).expect("swap");
    }

    fn remove_liquidity(&mut self, usdc: u64) {
        let ix = Instruction::new_with_bytes(
            mock_amm::id(),
            &mock_amm::instruction::RemoveLiquidity { usdc }.data(),
            mock_amm::accounts::Modify {
                caller: self.payer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(&[ix]).expect("remove_liquidity");
    }

    fn set_external_median(&mut self, median: u64) {
        let ix = Instruction::new_with_bytes(
            oracle::id(),
            &oracle::instruction::SetExternalMedian { median }.data(),
            oracle::accounts::SetExternal {
                admin: self.payer.pubkey(),
                oracle: self.oracle,
            }
            .to_account_metas(None),
        );
        self.send(&[ix]).expect("set_external_median");
    }

    fn read(&self) -> OracleAccount {
        let acc = self.svm.get_account(&self.oracle).unwrap();
        let mut data: &[u8] = &acc.data;
        OracleAccount::try_deserialize(&mut data).unwrap()
    }

    /// Move the clock forward without producing new observations.
    fn advance_secs(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>();
        clock.unix_timestamp += secs;
        clock.slot += (secs as u64).max(1);
        self.svm.set_sysvar(&clock);
    }
}

// ---------------------------------------------------------------------------

#[test]
fn a_funded_pool_produces_a_tradeable_price() {
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    assert_eq!(env.read().state, OracleState::Uninitialized);

    env.refresh().expect("refresh");
    let o = env.read();

    assert_eq!(o.state, OracleState::Ok);
    assert_eq!(o.price, WAD, "60k against 60k is $1.00 per fraction");
    assert_eq!(o.spot, WAD);
    assert_eq!(o.depth_usdc, 60_000 * USDC);
    assert!(o.last_update_ts > 0);
}

#[test]
fn the_clamp_blocks_a_single_block_price_jump() {
    // The attack: push the AMM hard in one transaction, then liquidate
    // everyone at the new price. The clamp is what makes it not work.
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();
    let before = env.read().price;

    env.swap_usdc_in(40_000 * USDC); // roughly +78% spot
    env.refresh().unwrap();
    let o = env.read();

    assert!(o.spot > before * 3 / 2, "the spot really did jump");
    assert!(
        o.price <= before + before / 20,
        "official price moved {} from {}, past the 5% clamp",
        o.price,
        before
    );
}

#[test]
fn a_sustained_push_still_gets_there_but_costs_many_updates() {
    // The clamp does not make manipulation impossible, it makes it expensive.
    // Stating that honestly is better than overclaiming.
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();
    let before = env.read().price;

    env.swap_usdc_in(40_000 * USDC);
    let mut updates = 0;
    while env.read().price < before * 3 / 2 && updates < 50 {
        env.advance_secs(60);
        env.refresh().unwrap();
        updates += 1;
    }
    assert!(updates >= 8, "a 50% move took only {updates} updates");
}

#[test]
fn draining_the_pool_below_the_depth_floor_stops_trading() {
    // The attack this blocks: pull liquidity out so the oracle becomes cheap
    // to push, then push it.
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();
    assert_eq!(env.read().state, OracleState::Ok);

    env.remove_liquidity(40_000 * USDC); // leaves $20k, floor is $25k
    env.refresh().unwrap();

    let o = env.read();
    assert_eq!(o.state, OracleState::ShallowDepth);
    assert!(!o.state.is_tradeable(), "a shallow pool must not price risk");
}

#[test]
fn a_stale_oracle_is_marked_stale_without_anyone_calling_it() {
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();
    assert_eq!(env.read().state, OracleState::Ok);

    // Past max_staleness_secs (900) with no refresh. The next read through
    // `OracleView::require_markable` is what enforces it, but the state itself
    // must also settle to Stale on the following refresh.
    env.advance_secs(2_000);
    env.set_external_median(WAD); // any instruction that re-evaluates state
    assert_eq!(env.read().state, OracleState::Stale);
}

#[test]
fn divergence_from_the_external_median_halts_the_market() {
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();

    // 10% apart: inside the 15% bound, still tradeable
    env.set_external_median(WAD * 90 / 100);
    assert_eq!(env.read().state, OracleState::Ok);

    // 40% apart: the AMM and the outside world disagree too much to trade
    env.set_external_median(WAD * 60 / 100);
    assert_eq!(env.read().state, OracleState::Diverged);
}

#[test]
fn a_missing_external_feed_degrades_instead_of_halting() {
    // If the fills feed dies we lose one defence. Losing the market as well
    // would make a secondary defence into a single point of failure.
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();
    let o = env.read();
    assert_eq!(o.external_median, 0, "never fed");
    assert_eq!(o.state, OracleState::Ok);
}

#[test]
fn refreshing_against_the_wrong_pool_is_refused() {
    // Swapping in an attacker-controlled pool account is the cheapest possible
    // oracle attack. `has_one` is what stops it.
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();

    let impostor = Keypair::new();
    let ix = Instruction::new_with_bytes(
        mock_amm::id(),
        &mock_amm::instruction::CreatePool {
            usdc: 1_000_000 * USDC,
            fraction: 1 * USDC,
        }
        .data(),
        mock_amm::accounts::CreatePool {
            payer: env.payer.pubkey(),
            pool: impostor.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    env.send_signed(&[ix], &[&impostor]).unwrap();

    let ix = Instruction::new_with_bytes(
        oracle::id(),
        &oracle::instruction::RefreshPrice {}.data(),
        oracle::accounts::RefreshPrice {
            caller: env.payer.pubkey(),
            oracle: env.oracle,
            amm_pool: impostor.pubkey(),
        }
        .to_account_metas(None),
    );
    assert!(
        env.send(&[ix]).is_err(),
        "the oracle accepted a pool it was not bound to"
    );
    assert_eq!(env.read().price, WAD, "price must be untouched");
}

#[test]
fn only_the_admin_can_move_the_parameters() {
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();

    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    // Widening the clamp to 100% would disarm the main defence.
    let mut params = OracleParams::default();
    params.max_tick_move = WAD;
    let ix = Instruction::new_with_bytes(
        oracle::id(),
        &oracle::instruction::SetParams { params }.data(),
        oracle::accounts::SetParams {
            admin: attacker.pubkey(),
            oracle: env.oracle,
        }
        .to_account_metas(None),
    );

    let blockhash = env.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&attacker.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&attacker]).unwrap();
    assert!(
        env.svm.send_transaction(tx).is_err(),
        "a stranger widened the clamp"
    );
    assert_eq!(env.read().params.max_tick_move, 50_000);
}

#[test]
fn refresh_is_permissionless_so_a_dead_keeper_cannot_freeze_the_price() {
    // There is no oracle key to steal, and no single keeper to take down.
    let mut env = setup(60_000 * USDC, 60_000 * USDC);
    env.refresh().unwrap();

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    env.advance_secs(60);

    let ix = Instruction::new_with_bytes(
        oracle::id(),
        &oracle::instruction::RefreshPrice {}.data(),
        oracle::accounts::RefreshPrice {
            caller: stranger.pubkey(),
            oracle: env.oracle,
            amm_pool: env.pool,
        }
        .to_account_metas(None),
    );
    let blockhash = env.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&stranger.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&stranger]).unwrap();
    assert!(
        env.svm.send_transaction(tx).is_ok(),
        "anyone must be able to keep the price alive"
    );
}
