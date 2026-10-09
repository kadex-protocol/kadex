# Custody — who holds what, and who you are trusting

Last reviewed 9 Oct 2026.

Kadex prices a token, not a card. Whether that token is worth anything depends
on a chain of custody that is mostly outside our programs. This file says
where each link is held and what checks it.

## The chain

```
physical card ──> grader ──> vault ──> Collector Crypt NFT ──> card-vault escrow ──> fractions
   (PSA slab)     (PSA,      (their    (Metaplex Core,         (our PDA)              (SPL, 6 dp)
                  BGS, CGC)  partner)   collection CCrypt…)
```

| Link | Held by | What proves it | Checked by us? |
|---|---|---|---|
| The card exists and is genuine | grader | grade + certificate | no |
| The card is in a vault | Collector Crypt's vault partner | their attestation, insurance | no |
| The NFT stands for that card | Collector Crypt | NFT is in collection `CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac` | **yes** — `card-vault` checks the collection and that the depositor owns it |
| The NFT is locked | `card-vault` | Core: the `VaultedCard` PDA becomes the asset's owner via `TransferV1`, re-read after transfer. SPL: `nft_escrow` PDA | **yes** |
| Fractions are backed | `card-vault` | mint authority is the `VaultedCard` PDA; supply fixed at whitelist | **yes** |
| Redemption returns the card | `card-vault` | burns the whole supply, transfers the NFT back | **yes** |
| The NFT turns back into the card | Collector Crypt | their redemption process | no |

## What this means

On-chain, nothing can mint a fraction without a locked NFT, and nothing can
take the NFT out without burning every fraction. That part is code and is
tested against the real Metaplex Core program (`tests/integration/vault.test.mjs`).

Off-chain, the trust **moves** from a Kadex admin to Collector Crypt, the
grader and the vault. That is better than trusting us, because they have a
business to lose and insurance behind it. It is delegation, not elimination,
and the submission should say so.

## What the admin still controls

- **Whitelisting** — which cards enter, at what appraisal (fraction count) and
  at what index weight. Permissioned on purpose: an open whitelist would let
  anyone price their own collateral into the index.
- **`set_card_enabled`** — disabling a card stops new deposits.
- **Upgrade authority** — the deployer, on devnet. Before real value: multisig,
  timelock or burned (#12).

## Open

- Basket units (#1) add a link: basket mint ↔ card fractions. It has to be
  redeemable for the underlying fractions, or the index is backed by nothing.
- Only Core assets are supported. Collector Crypt's `pnft` cards (about a
  quarter of listings) cannot be deposited.
