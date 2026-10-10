# Upgrade authority and admin keys (#12)

Status: **analysis and recommendation. Nothing here has been done on chain.**
Today every program's upgrade authority, and every account's `admin`, is the
deployer key (`KADEX_DEPLOYER`, default `~/.config/solana/id.json`). Fine for
devnet; not for anything holding real value.

## What the code does today

**Upgrade authority.** Read from the loader by `upgrade_authority()`
(`packages/kadex-interface/src/lib.rs`): loader v3 keeps it in `ProgramData`
(`Option<Pubkey>`), loader v4 in the program header. Devnet takes loader v3
(`scripts/devnet.mjs`; v4 is inactive there).

**What it is used for.** `require_deployer` gates `oracle::initialize`,
`clp_pool::initialize_pool` and `card_vault::initialize_registry`: only the
upgrade authority can create an oracle, a pool or the card registry. A
revoked (v3 `None`) or finalized (v4) program answers `NotDeployer`, so after
revoking, **no new oracle, pool or registry can ever be created**.

**Admin keys.** The initializer becomes `admin` on the oracle, pool and
registry, and **no instruction rotates it**. Changing the upgrade authority
does not change who is admin. What admin can do:

| Program | Admin can | Bounded by |
|---|---|---|
| oracle | `set_params` | `validate_params` (every field, including `max_divergence` since this audit) |
| oracle | `set_external_median` | nothing: any value, `0` switches the divergence check off |
| clp-pool | `set_params`, `set_state` (incl. irreversible `Settled`), `claim_protocol_fees`, `set_perp_market` | `validate_params`; fees ≤ accrued; market must be the derived PDA |
| card-vault | whitelist cards (sets `fractions_per_card`), `set_card_enabled` | registry admin only |

Admin cannot write the oracle price or move LP funds directly. The upgrade
authority can do anything: a new program binary can.

**The coupling with #11.** `set_external_median` takes `oracle.admin`, and
the feed sends it every 60 s. So the feed's hot key is also the key that can
loosen oracle parameters, and on devnet, the upgrade authority. A multisig
cannot sign every minute, so moving `admin` to a multisig would stop the feed.

## How Solana upgrades work, which limits the options

- The loader has **one** authority field and **no timelock**. Whoever holds it
  upgrades at once (`Upgrade` from a buffer) or revokes (`set-upgrade-authority
  --final`, or v4 `finalize`). Revoking is irreversible.
- The authority can be any address, including a **PDA**. A multisig program's
  vault PDA can hold it and sign the upgrade by CPI.
- So a timelock has to come from the program that owns that PDA. **Squads v4**
  multisigs have a per-multisig `time_lock` (seconds between approval and
  execution); **SPL Governance** (Realms) has a hold-up time on proposals.
  The flow is the same for both: `solana program write-buffer`, set the
  buffer's authority to the vault, propose `Upgrade`, approve, wait, execute.
- Verifiable builds (`solana-verify`) let anyone check that the deployed
  binary is the reviewed source. Without them, a multisig is approving
  something it can't inspect.

## The options, for this codebase

**A. Multisig (e.g. Squads v4, 3-of-5, hardware keys).**
- Security: no single key can replace the programs. You trust a quorum of
  signers.
- Operations: every upgrade is a proposal. Signer rotation happens inside the
  multisig, with no chain-level change.
- Emergency fixes: as fast as a quorum can sign, so minutes to hours.
- Changes: the multisig must also be the **initializer**, so it becomes
  `admin`. That breaks the feed (above) unless `admin` is split first.

**B. Multisig plus timelock (Squads `time_lock`, or Realms).**
- Security: same as A, plus users get a window to exit before an upgrade
  lands. That window is the property a "the deployer can replace the program"
  objection asks for.
- Operations: as A, plus waiting out the delay.
- Emergency fixes: delayed by the timelock too. The usual answer is a second,
  untimed role that can only *reduce* risk (pause new positions). That needs
  the admin role split on chain; today `set_state` sits with the same admin.
- Changes: as A, plus choosing the delay (24–72 h is common) and publishing it.

**C. Revoked (immutable).**
- Security: the strongest guarantee about code. Admin keys keep every power
  in the table above, with no way to rotate them, so it does not remove the
  trust in admin.
- Operations: none, and no recovery. A bug is permanent, and no new
  oracle, pool or registry can be created afterwards (`NotDeployer`).
- Emergency fixes: impossible. Only the admin levers remain.
- Changes: everything must be initialized first, audited, and the admin
  question solved, because revoking freezes the admin design too.

## Recommendation

**Now (devnet, submission):** keep the deployer key, and say so plainly: the
protocol is not live with real funds, and the path below is the plan.

**Before real funds: B**, in this order:
1. **Split the roles on chain** (a program change; frozen-interface process):
   a `feed_authority` for `set_external_median`, separate from `admin`; an
   admin rotation instruction (`set_admin`, two-step accept); optionally a
   `pause_authority` limited to `ReduceOnly`.
2. **Fresh mainnet program keypairs** (`docs/deploying.md`: the committed
   ones in `keys/` must not be used).
3. Deploy, then **initialize through the multisig**, so `admin` is the
   multisig vault from the start. Point `feed_authority` at a dedicated hot
   key.
4. Move the upgrade authority to the Squads vault, with a time lock, and
   publish the multisig address, members, threshold and delay.
5. Publish verifiable builds for every release.

**C later, per program, if ever:** only after an audit, after every pool and
oracle the protocol will need exists, and once the admin design is final.
The oracle is the most likely candidate, since it is small and has no funds
of its own.
