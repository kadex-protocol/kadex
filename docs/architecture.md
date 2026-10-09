# Architecture

## Program boundaries

```
┌─ Backend A ─────────────────┐   ┌─ Backend B ──────────────────┐
│                             │   │                              │
│  card-vault                 │   │  clp-pool                    │
│   • fractionalize           │   │   • deposit / withdraw       │
│   • redeem_card             │   │   • NAV, CLP mint/burn       │
│   • whitelist, max weight   │   │   • params, state, bad debt  │
│                             │   │                              │
│  oracle                     │   │  perp                        │
│   • refresh_price           │   │   • open / close / liquidate │
│   • TWAP, clamp, depth      │   │   • borrow index, OI         │
│   • AMM adapters            │   │                              │
│         │                   │   │         ▲                    │
└─────────┼───────────────────┘   └─────────┼────────────────────┘
          │                                 │
          └────── OracleAccount ────────────┘
                 (an account read, no CPI)
```

The **only** thing crossing the boundary is the oracle account. There is no
CPI between A and B, which means neither has to synchronise builds with the
other.

Inside B, `perp` does CPI into `clp-pool` to move USDC. Both belong to the
same owner, so that coupling blocks nobody.

## Why the oracle is a program and not a module

Account ownership in Solana is per program. With `OracleAccount` inside
`clp-pool`, whoever writes prices and whoever writes risk would be editing the
same crate every day.

As a separate program, `#[account]` in `kadex-interface` declares the oracle
program's ID, and Anchor then requires on its own that any
`Account<'info, OracleAccount>` belongs to it. An account forged by another
program is rejected before any of our logic runs — the check belongs to the
framework, not to us.

## Code layers

```
programs/*        ← account validation, CPI, token movement
      │             (thin: it only orchestrates)
      ▼
kadex-risk        ← every decision. No anchor-lang, no solana-program:
      │             a rule here physically cannot read an account
      ▼
kadex-math        ← fixed-point arithmetic. No I/O, no Anchor
```

This is enforced, not agreed:

- `perp::tests::risk_crate_cannot_reach_solana` fails if `kadex-risk` ever
  gains an Anchor or Solana dependency
- `perp::tests::handlers_stay_thin` fails if a handler grows past 45 lines,
  which is almost always a rule that leaked out of `kadex-risk`

That is why 152 tests run in under a second with no SBF build and no validator.

## Token custody

| What | Held by | Authority |
|---|---|---|
| card NFT | `nft_escrow` PDA | `VaultedCard` PDA |
| fraction mint | — | `VaultedCard` PDA |
| USDC sleeve | `usdc_vault` | `Pool` PDA |
| CLP mint | — | `Pool` PDA |
| position margin | USDC sleeve | `Pool` PDA, via `perp_market` |

`Pool.perp_market` stores the single PDA allowed to touch risk accounting.
Without it, any program could ask the pool to pay out.

## Arithmetic

No floating point anywhere near money. Intermediates in `u128`/`i128`, back to
`u64` only through `to_u64`, which errors instead of truncating.

Scales: WAD 1e6 (ratios and prices), BPS 1e4 (configured fees), RAY 1e12
(borrow index — it needs more places because it compounds many times).

USDC has 6 decimals and so do the fractions. The coincidence is deliberate: a
WAD price times a native quantity lands directly in native USDC, with no
conversion step to get wrong.
