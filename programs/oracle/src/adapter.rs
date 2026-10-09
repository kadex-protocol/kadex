//! Adapters that read AMM reserves.
//!
//! `Mock` reads the mock AMM's own layout, for tests and local work.
//! `Raydium` reads a Raydium CPMM (constant-product) pool, which is what the
//! Kadex index token trades in. `Meteora` and `Orca` return
//! `AdapterUnsupported`: an adapter that does not exist must fail, never
//! return a plausible number.
//!
//! Only this file changes per venue. Nothing in `perp` or `clp-pool` does.

use anchor_lang::prelude::*;
use kadex_interface::AmmAdapter;

use crate::errors::OracleError;

/// Reserves of a fraction/USDC pool, in native units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    /// USDC reserve. This is the `R` in the depth invariant.
    pub usdc: u64,
    /// Card-fraction (index token) reserve.
    pub fraction: u64,
}

/// Layout of the mock pool account. Plain constant-product, devnet and tests
/// only. 8 discriminator bytes + two little-endian u64.
pub const MOCK_POOL_LEN: usize = 8 + 8 + 8;

/// Read the pool's reserves.
///
/// `extra` are the instruction's remaining accounts: the adapters that keep
/// reserves outside the pool account (Raydium: the two vaults) take them
/// from there, so the mock path and its callers are unchanged. `basket` is
/// the oracle's basket, which for a real pool is the index token's mint and
/// decides which side of the pool is USDC.
pub fn read_reserves(adapter: AmmAdapter, pool: &AccountInfo, extra: &[AccountInfo], basket: &Pubkey) -> Result<Reserves> {
    match adapter {
        AmmAdapter::Mock => read_mock(pool),
        AmmAdapter::Raydium => raydium::read(pool, extra, basket),
        AmmAdapter::Meteora | AmmAdapter::Orca => err!(OracleError::AdapterUnsupported),
    }
}

/// What can be checked when the oracle is created, before any vault is
/// passed: the pool is genuine and pairs the basket's mint. Refreshes check
/// it all again.
pub fn validate_pool(adapter: AmmAdapter, pool: &AccountInfo, basket: &Pubkey) -> Result<()> {
    match adapter {
        AmmAdapter::Mock => Ok(()),
        AmmAdapter::Raydium => raydium::Pool::load(pool)?.orientation(basket).map(|_| ()),
        AmmAdapter::Meteora | AmmAdapter::Orca => err!(OracleError::AdapterUnsupported),
    }
}

#[cfg(test)]
mod mock_tests {
    use super::*;

    #[test]
    fn mock_reserves_are_refused_from_an_account_the_mock_amm_does_not_own() {
        let lamports = &mut 0u64;
        let mut bytes = [0u8; MOCK_POOL_LEN];
        bytes[8..16].copy_from_slice(&1_000_000u64.to_le_bytes());
        bytes[16..24].copy_from_slice(&1u64.to_le_bytes());
        let key = Pubkey::default();
        let forger = Pubkey::new_unique();
        let ai = AccountInfo::new(&key, false, false, lamports, &mut bytes, &forger, false);
        assert!(read_reserves(AmmAdapter::Mock, &ai, &[], &Pubkey::default()).is_err());
    }
}

/// The mock AMM program. Reserves are only believed from an account it owns:
/// anyone can write two u64s into an account of their own.
pub const MOCK_AMM_PROGRAM_ID: Pubkey = pubkey!("AUPEWRMXpNvN42nCA6ovZRt4eYcaySyRhewxnTa6ygJi");

fn read_mock(ai: &AccountInfo) -> Result<Reserves> {
    require_keys_eq!(*ai.owner, MOCK_AMM_PROGRAM_ID, OracleError::AdapterBadAccount);
    let data = ai.try_borrow_data()?;
    require!(data.len() >= MOCK_POOL_LEN, OracleError::AdapterBadAccount);
    let usdc = u64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| error!(OracleError::AdapterBadAccount))?,
    );
    let fraction = u64::from_le_bytes(
        data[16..24]
            .try_into()
            .map_err(|_| error!(OracleError::AdapterBadAccount))?,
    );
    Ok(Reserves { usdc, fraction })
}

/// Raydium CPMM (`raydium-io/raydium-cp-swap`), a plain two-reserve
/// constant-product pool.
///
/// The pool account holds no balances. Reserves are the two vault token
/// accounts MINUS the fees the pool owes and has not yet paid out
/// (protocol + fund + creator, per side) — exactly Raydium's own
/// `vault_amount_without_fee`. Reading the raw vault balance overstates the
/// reserve, sometimes absurdly: a devnet pool holding 800,001 units owed
/// 800,000 of them in fees.
///
/// Nothing the caller passes is trusted: the pool must be owned by Raydium,
/// the vaults must be the ones the pool records, hold the pool's mints, and
/// be owned by Raydium's authority PDA.
pub mod raydium {
    use super::*;

    /// Raydium's mainnet and devnet CPMM deployments. Both are Raydium's own
    /// program keys; the oracle believes reserves from no other owner.
    pub const PROGRAM_IDS: [Pubkey; 2] = [
        pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
        pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"),
    ];
    pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
    /// `sha256("account:PoolState")[..8]`; checked in tests/raydium.test.mjs.
    pub const POOL_DISCRIMINATOR: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
    pub const POOL_LEN: usize = 637;
    pub const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    pub const TOKEN_ACCOUNT_LEN: usize = 165;
    /// USDC and the index token both have 6, and the whole protocol prices
    /// `usdc * WAD / fraction` on that assumption (`FRACTION_DECIMALS` in
    /// card-vault). With equal decimals the normalised ratio IS the raw one,
    /// so anything else is refused rather than rescaled.
    pub const REQUIRED_DECIMALS: u8 = 6;
    /// `status` bit 2: swaps disabled. Reserves nobody can trade against are
    /// not a market price.
    const SWAP_DISABLED: u8 = 1 << 2;

    // PoolState is `#[repr(C, packed)]`: fixed offsets, no padding.
    const TOKEN_0_VAULT: usize = 72;
    const TOKEN_1_VAULT: usize = 104;
    const TOKEN_0_MINT: usize = 168;
    const TOKEN_1_MINT: usize = 200;
    const TOKEN_0_PROGRAM: usize = 232;
    const TOKEN_1_PROGRAM: usize = 264;
    const AUTH_BUMP: usize = 328;
    const STATUS: usize = 329;
    const MINT_0_DECIMALS: usize = 331;
    const MINT_1_DECIMALS: usize = 332;
    const PROTOCOL_FEES_0: usize = 341;
    const PROTOCOL_FEES_1: usize = 349;
    const FUND_FEES_0: usize = 357;
    const FUND_FEES_1: usize = 365;
    const CREATOR_FEES_0: usize = 397;
    const CREATOR_FEES_1: usize = 405;

    fn key_at(d: &[u8], at: usize) -> Pubkey {
        Pubkey::new_from_array(d[at..at + 32].try_into().expect("32 bytes"))
    }
    fn u64_at(d: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(d[at..at + 8].try_into().expect("8 bytes"))
    }

    /// Which side of the pool is the index token.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Side {
        Token0,
        Token1,
    }

    /// The fields of a validated pool the oracle needs.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Pool {
        pub program: Pubkey,
        pub vaults: [Pubkey; 2],
        pub mints: [Pubkey; 2],
        pub auth_bump: u8,
        /// Fees owed per side, already summed.
        pub fees: [u64; 2],
    }

    impl Pool {
        pub fn load(ai: &AccountInfo) -> Result<Pool> {
            require!(PROGRAM_IDS.contains(ai.owner), OracleError::AdapterBadAccount);
            let d = ai.try_borrow_data()?;
            require!(d.len() == POOL_LEN, OracleError::AdapterBadAccount);
            require!(d[..8] == POOL_DISCRIMINATOR, OracleError::AdapterBadAccount);
            require!(
                key_at(&d, TOKEN_0_PROGRAM) == SPL_TOKEN && key_at(&d, TOKEN_1_PROGRAM) == SPL_TOKEN,
                OracleError::AdapterUnsupportedToken
            );
            require!(
                d[MINT_0_DECIMALS] == REQUIRED_DECIMALS && d[MINT_1_DECIMALS] == REQUIRED_DECIMALS,
                OracleError::AdapterUnsupportedToken
            );
            require!(d[STATUS] & SWAP_DISABLED == 0, OracleError::AdapterPoolDisabled);
            let sum = |a: usize, b: usize, c: usize| {
                u64_at(&d, a)
                    .checked_add(u64_at(&d, b))
                    .and_then(|x| x.checked_add(u64_at(&d, c)))
                    .ok_or(error!(OracleError::AdapterBadAccount))
            };
            Ok(Pool {
                program: *ai.owner,
                vaults: [key_at(&d, TOKEN_0_VAULT), key_at(&d, TOKEN_1_VAULT)],
                mints: [key_at(&d, TOKEN_0_MINT), key_at(&d, TOKEN_1_MINT)],
                auth_bump: d[AUTH_BUMP],
                fees: [
                    sum(PROTOCOL_FEES_0, FUND_FEES_0, CREATOR_FEES_0)?,
                    sum(PROTOCOL_FEES_1, FUND_FEES_1, CREATOR_FEES_1)?,
                ],
            })
        }

        /// The basket mint must be exactly one side; the other is the quote.
        pub fn orientation(&self, basket: &Pubkey) -> Result<Side> {
            require!(self.mints[0] != self.mints[1], OracleError::AdapterWrongMint);
            if self.mints[0] == *basket {
                Ok(Side::Token0)
            } else if self.mints[1] == *basket {
                Ok(Side::Token1)
            } else {
                err!(OracleError::AdapterWrongMint)
            }
        }

        pub fn authority(&self) -> Result<Pubkey> {
            Pubkey::create_program_address(&[AUTH_SEED, &[self.auth_bump]], &self.program)
                .map_err(|_| error!(OracleError::AdapterWrongAuthority))
        }
    }

    /// A vault's balance, after checking it is the vault the pool records,
    /// holds the pool's mint for that side, and belongs to Raydium's authority.
    fn vault_amount(ai: &AccountInfo, expected: &Pubkey, mint: &Pubkey, authority: &Pubkey) -> Result<u64> {
        require_keys_eq!(*ai.key, *expected, OracleError::AdapterWrongVault);
        require_keys_eq!(*ai.owner, SPL_TOKEN, OracleError::AdapterWrongVault);
        let d = ai.try_borrow_data()?;
        require!(d.len() == TOKEN_ACCOUNT_LEN, OracleError::AdapterWrongVault);
        // 1 = Initialized. 0 is uninitialized, 2 frozen: neither can be traded.
        require!(d[108] == 1, OracleError::AdapterWrongVault);
        require_keys_eq!(key_at(&d, 0), *mint, OracleError::AdapterWrongMint);
        require_keys_eq!(key_at(&d, 32), *authority, OracleError::AdapterWrongAuthority);
        Ok(u64_at(&d, 64))
    }

    pub fn read(pool: &AccountInfo, extra: &[AccountInfo], basket: &Pubkey) -> Result<Reserves> {
        let p = Pool::load(pool)?;
        let side = p.orientation(basket)?;
        let authority = p.authority()?;
        require!(extra.len() >= 2, OracleError::AdapterWrongVault);
        let mut usable = [0u64; 2];
        for i in 0..2 {
            let raw = vault_amount(&extra[i], &p.vaults[i], &p.mints[i], &authority)?;
            usable[i] = raw.checked_sub(p.fees[i]).ok_or(error!(OracleError::AdapterInsufficientVault))?;
        }
        Ok(match side {
            Side::Token0 => Reserves { fraction: usable[0], usdc: usable[1] },
            Side::Token1 => Reserves { fraction: usable[1], usdc: usable[0] },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unimplemented_adapters_fail_loudly_instead_of_returning_fake_data() {
        // An unimplemented adapter must ERROR. Returning zero, or a plausible
        // number, would be worse: the market would open on an invented price.
        for a in [AmmAdapter::Meteora, AmmAdapter::Orca] {
            let lamports = &mut 0u64;
            let data = &mut [0u8; MOCK_POOL_LEN][..];
            let key = Pubkey::default();
            let owner = Pubkey::default();
            let ai = AccountInfo::new(&key, false, false, lamports, data, &owner, false);
            assert!(read_reserves(a, &ai, &[], &key).is_err(), "{a:?} should fail");
            assert!(validate_pool(a, &ai, &key).is_err(), "{a:?} should fail");
        }
    }
}

/// Against a real Raydium CPMM pool captured from devnet with its two vaults
/// in one `getMultipleAccounts` call (`tests/fixtures/raydium_cpmm_pool.json`).
/// A fixture invented here would only prove the reader agrees with itself.
#[cfg(test)]
mod raydium_tests {
    use super::raydium::*;
    use super::*;
    use anchor_lang::solana_program::pubkey::Pubkey;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/raydium_cpmm_pool.json");
    // Values read off the fixture independently, not computed by this code.
    const MINT_0: Pubkey = pubkey!("5W1Mg5LYmczXTGAqjSoTeMi7tXUQx3bfXsLr1MKvV1Tk");
    const MINT_1: Pubkey = pubkey!("7rCj8wm31rhSDvSvK2kc9NUSXwvPNChx6R3HYNM6MqxP");
    const AUTHORITY: Pubkey = pubkey!("CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq");
    const USABLE_0: u64 = 1_045_469_077_015;
    const USABLE_1: u64 = 5_194_267_751_955;
    const RAW_0: u64 = 1_045_956_063_151;

    /// An account from the fixture: (key, owner, bytes).
    fn account(name: &str) -> (Pubkey, Pubkey, Vec<u8>) {
        let start = FIXTURE.find(&format!("\"{name}\"")).expect("account in fixture");
        let field = |label: &str| {
            let at = FIXTURE[start..].find(&format!("\"{label}\"")).expect(label) + start;
            let open = FIXTURE[at..].find(':').unwrap() + at + 1;
            let q1 = FIXTURE[open..].find('"').unwrap() + open + 1;
            let q2 = FIXTURE[q1..].find('"').unwrap() + q1;
            FIXTURE[q1..q2].to_string()
        };
        let data_at = FIXTURE[start..].find("\"data\"").unwrap() + start;
        let open = FIXTURE[data_at..].find('[').unwrap() + data_at;
        let q1 = FIXTURE[open..].find('"').unwrap() + open + 1;
        let q2 = FIXTURE[q1..].find('"').unwrap() + q1;
        let bytes = base64_decode(&FIXTURE[q1..q2]);
        (field("pubkey").parse().unwrap(), field("owner").parse().unwrap(), bytes)
    }

    fn base64_decode(s: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut buf, mut bits) = (0u32, 0u32);
        for c in s.bytes().filter(|&c| c != b'=') {
            buf = (buf << 6) | T.iter().position(|&t| t == c).expect("base64") as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
            }
        }
        out
    }

    struct Accounts {
        keys: [Pubkey; 3],
        owners: [Pubkey; 3],
        data: [Vec<u8>; 3],
        lamports: [u64; 3],
    }

    impl Accounts {
        fn real() -> Self {
            let (pk, po, pd) = account("pool");
            let (ak, ao, ad) = account("vault0");
            let (bk, bo, bd) = account("vault1");
            Accounts { keys: [pk, ak, bk], owners: [po, ao, bo], data: [pd, ad, bd], lamports: [0; 3] }
        }
        fn read(&mut self, basket: &Pubkey) -> Result<Reserves> {
            let [pd, ad, bd] = &mut self.data;
            let [pl, al, bl] = &mut self.lamports;
            let pool = AccountInfo::new(&self.keys[0], false, false, pl, pd, &self.owners[0], false);
            let v0 = AccountInfo::new(&self.keys[1], false, false, al, ad, &self.owners[1], false);
            let v1 = AccountInfo::new(&self.keys[2], false, false, bl, bd, &self.owners[2], false);
            read_reserves(AmmAdapter::Raydium, &pool, &[v0, v1], basket)
        }
    }

    fn code(r: Result<Reserves>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an error, got {other:?}"),
        }
    }
    fn is(e: OracleError) -> u32 {
        e.into()
    }

    #[test]
    fn a_real_pool_reads_its_reserves_net_of_owed_fees() {
        let r = Accounts::real().read(&MINT_0).unwrap();
        assert_eq!(r, Reserves { fraction: USABLE_0, usdc: USABLE_1 });
        assert!(RAW_0 > USABLE_0, "the raw vault balance includes fees the pool owes");
    }

    #[test]
    fn the_basket_mint_decides_which_side_is_usdc() {
        let r = Accounts::real().read(&MINT_1).unwrap();
        assert_eq!(r, Reserves { fraction: USABLE_1, usdc: USABLE_0 });
    }

    #[test]
    fn the_price_from_a_real_pool_is_usdc_over_index_in_wad() {
        let r = Accounts::real().read(&MINT_0).unwrap();
        let price = kadex_math::div_wad_floor(r.usdc as u128, r.fraction as u128).unwrap();
        assert_eq!(price, 4_968_360);
    }

    #[test]
    fn the_vault_authority_is_raydiums_pda_from_the_pools_bump() {
        let mut a = Accounts::real();
        let [pd, ..] = &mut a.data;
        let lamports = &mut 0;
        let pool = AccountInfo::new(&a.keys[0], false, false, lamports, pd, &a.owners[0], false);
        assert_eq!(Pool::load(&pool).unwrap().authority().unwrap(), AUTHORITY);
    }

    #[test]
    fn negative_a_pool_not_owned_by_raydium_is_refused() {
        let mut a = Accounts::real();
        a.owners[0] = Pubkey::new_unique();
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterBadAccount));
    }

    #[test]
    fn negative_a_basket_the_pool_does_not_pair_is_refused() {
        assert_eq!(code(Accounts::real().read(&Pubkey::new_unique())), is(OracleError::AdapterWrongMint));
    }

    #[test]
    fn negative_swapped_vaults_are_refused() {
        let mut a = Accounts::real();
        a.keys.swap(1, 2);
        a.data.swap(1, 2);
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongVault));
    }

    #[test]
    fn negative_a_substitute_vault_is_refused_even_with_the_right_mint() {
        let mut a = Accounts::real();
        a.keys[2] = Pubkey::new_unique();
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongVault));
    }

    #[test]
    fn negative_missing_vaults_are_refused() {
        let mut a = Accounts::real();
        let [pd, ..] = &mut a.data;
        let lamports = &mut 0;
        let pool = AccountInfo::new(&a.keys[0], false, false, lamports, pd, &a.owners[0], false);
        assert_eq!(code(read_reserves(AmmAdapter::Raydium, &pool, &[], &MINT_0)), is(OracleError::AdapterWrongVault));
    }

    #[test]
    fn negative_a_vault_holding_another_mint_is_refused() {
        let mut a = Accounts::real();
        a.data[2][0..32].copy_from_slice(Pubkey::new_unique().as_ref());
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongMint));
    }

    #[test]
    fn negative_a_vault_owned_by_someone_else_is_refused() {
        let mut a = Accounts::real();
        a.data[1][32..64].copy_from_slice(Pubkey::new_unique().as_ref());
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongAuthority));
    }

    #[test]
    fn negative_a_vault_not_held_by_the_token_program_is_refused() {
        let mut a = Accounts::real();
        a.owners[1] = Pubkey::new_unique();
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongVault));
    }

    #[test]
    fn negative_a_frozen_vault_is_refused() {
        let mut a = Accounts::real();
        a.data[1][108] = 2;
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongVault));
    }

    #[test]
    fn negative_wrong_discriminator_or_length_is_refused() {
        let mut a = Accounts::real();
        a.data[0][0] ^= 1;
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterBadAccount));
        let mut b = Accounts::real();
        b.data[0].pop();
        assert_eq!(code(b.read(&MINT_0)), is(OracleError::AdapterBadAccount));
    }

    #[test]
    fn negative_other_decimals_are_refused_not_rescaled() {
        let mut a = Accounts::real();
        a.data[0][331] = 9;
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterUnsupportedToken));
    }

    #[test]
    fn negative_a_token_2022_side_is_refused() {
        let mut a = Accounts::real();
        a.data[0][264..296].copy_from_slice(pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PE9wGq7Rgd5B8n").as_ref());
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterUnsupportedToken));
    }

    #[test]
    fn negative_a_pool_with_swaps_disabled_is_refused() {
        let mut a = Accounts::real();
        a.data[0][329] |= 1 << 2;
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterPoolDisabled));
    }

    #[test]
    fn negative_fees_above_the_vault_balance_are_refused_not_wrapped() {
        let mut a = Accounts::real();
        a.data[0][341..349].copy_from_slice(&(RAW_0 + 1).to_le_bytes());
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterInsufficientVault));
    }

    #[test]
    fn negative_fee_counters_that_overflow_are_refused_not_wrapped() {
        let mut a = Accounts::real();
        a.data[0][341..349].copy_from_slice(&u64::MAX.to_le_bytes());
        a.data[0][357..365].copy_from_slice(&1u64.to_le_bytes());
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterBadAccount));
    }

    #[test]
    fn negative_a_pool_pairing_one_mint_with_itself_is_refused() {
        let mut a = Accounts::real();
        let m0 = a.data[0][168..200].to_vec();
        a.data[0][200..232].copy_from_slice(&m0);
        assert_eq!(code(a.read(&MINT_0)), is(OracleError::AdapterWrongMint));
    }

    #[test]
    fn the_required_decimals_are_the_protocols_fraction_decimals() {
        assert_eq!(REQUIRED_DECIMALS, 6);
    }
}
