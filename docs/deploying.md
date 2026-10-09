# Deploying

> Read this before your first deploy. `anchor build` alone produces binaries
> that **cannot be deployed**, and the error message does not say why.

## Build

```sh
export PATH="$PWD/scripts/bin:$PATH"   # once, in your shell profile
npm run build:programs                 # or plain `anchor build`
```

With `scripts/bin` on your PATH, `anchor build` is safe. Without it, it
produces binaries that cannot be deployed anywhere. Here is why.

Anchor 1.2 hardcodes `--arch v3`, so `anchor build` emits SBPF v3 binaries.
The Solana CLI 3.1.10 that ships with this toolchain cannot parse them:

```
$ solana program deploy target/deploy/oracle.so
Error: ELF error: ELF error: Failed to parse ELF file: invalid file header
```

It fails identically through `solana program-v4 deploy`, and litesvm rejects
them too. The *runtime* supports SBPFv3 — the feature gate
`SIMD-0178, SIMD-0179 and SIMD-0189` is active on a fresh validator — but every
tool that has to read the ELF before sending it is capped below v3.

### The fix

`scripts/bin/cargo-build-sbf` is a shim. Anchor invokes `cargo-build-sbf` by
name, so putting that directory first on PATH lets the shim rewrite `--arch v3`
to `--arch v1` and pass everything else straight through. The source is
identical; only the bytecode target differs.

`npm run build:programs` puts the shim on PATH itself and then checks `e_flags`
on every output, failing loudly if anything is still v3 — a silent reversion
would not otherwise surface until someone tried to deploy.

Add the shim to your own PATH as well, so a bare `anchor build` is safe too:

```sh
echo 'export PATH="$HOME/Desktop/kadex/scripts/bin:$PATH"' >> ~/.zshrc
```

### Removing the shim later

It exists only because the local CLI is older than the bytecode Anchor emits.
Agave 4.3.0 is released and should parse SBPF v3 natively. Once the toolchain
is upgraded and `solana program deploy target/deploy/oracle.so` works on a v3
binary, delete `scripts/bin/` and the `REQUIRED_ARCH` check in
`scripts/build.mjs`.

## Who initializes

Every `initialize_*` (oracle, pool, card registry) checks that the signer is
the program's **upgrade authority**, read from the loader: loader v4 keeps it in
the program account header; for the v3 loader pass the `program_data` account.
The market is created by the pool's admin and only with the pool's oracle, and
the pool binds only the market PDA the perp program derives for it.

So deploy and initialize with the same key, and initialize **before** handing
the upgrade authority anywhere else.

## Program keypairs

`keys/` holds the program-ID keypairs, committed so every machine deploys to
the same addresses. That is fine for localnet and devnet. **Do not use them on
mainnet:** once the repository is public, anyone holding these files can deploy
to these addresses on any cluster where they are still free. Generate fresh
keypairs for mainnet, keep them out of git, and update `declare_id!`,
`Anchor.toml` and `PROGRAM_IDS` together.

## Verifying before you deploy

```sh
node -e "console.log(require('fs').readFileSync('target/deploy/oracle.so').readUInt32LE(48))"
```

`1` is deployable. `3` is not.

## Devnet

`scripts/devnet.mjs` does it all and is safe to re-run: each step checks the
chain and skips what exists, and records addresses and signatures (never keys)
in `deployments/devnet.json`.

```sh
npm run build:programs
node scripts/devnet.mjs check      # balances, what is deployed, SOL needed
node scripts/devnet.mjs all        # programs, mints, pool, protocol, verify
```

`KADEX_DEPLOYER` is the keypair (default `~/.config/solana/id.json`); it becomes
the upgrade authority and must be the one that initializes. `DEVNET_RPC`
overrides the RPC.

- **Loader.** Devnet takes `solana program deploy` (loader v3). Loader v4
  (SIMD-0167) is **inactive on devnet** as of 9 Oct 2026, so the
  `program-v4 deploy` the local harness uses would fail there.
- **SOL.** About 6.6 SOL at the peak: ~4.4 of program rent for oracle,
  clp_pool and perp, a refundable deploy buffer the size of the largest, the
  0.15 SOL Raydium create-pool fee, and account rent. `check` prints the exact
  figure. Fund from https://faucet.solana.com (GitHub sign-in raises the
  allowance); `solana airdrop` is rate-limited.
- **What it creates.** A 6-decimal **index token** ("Kadex Card Index (devnet
  test)", `tKDX`, Metaplex metadata, mint authority the deployer, no freeze
  authority), a 6-decimal **Kadex Devnet USD** (`kdUSD` — not USDC: a $25k-deep
  pool cannot be funded from the Circle devnet faucet), and a **Raydium CPMM
  pool** on fee config 0 (0.25%) seeded with 50,000 of each: $1.00 per index
  token, $50k of depth. The pool's address is a PDA of the config and the two
  mints, so a second run cannot create a duplicate.
- **What it does not claim.** The index token is a devnet demonstration
  instrument. It is not backed by, and cannot be redeemed for, any card.

The same script runs against the local validator for a dry run:

```sh
KADEX_DEPLOYMENT=/tmp/local.json DEVNET_RPC=http://127.0.0.1:8899 \
  node scripts/with-validator.mjs node scripts/devnet.mjs all
```

## Local validator

`scripts/with-validator.mjs` does the whole cycle — boot, airdrop, deploy all
five, run a command, tear down:

```sh
npm run test:integration
```

## If you see "Program is not deployed"

The program account exists but its ProgramData does not, or the binary was
never really loaded. Preloading at genesis with `--bpf-program` or
`--upgradeable-program` produces exactly this: the accounts appear, with
`executable: true`, and every call fails anyway. Deploy after boot instead,
which is what the harness does.
