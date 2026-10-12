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
node scripts/devnet.mjs all        # programs, mints, pool, protocol, verify, env
```

`KADEX_DEPLOYER` is the keypair (default `~/.config/solana/id.json`); it becomes
the upgrade authority and must be the one that initializes. `DEVNET_RPC`
overrides the RPC.

- **Loader.** Devnet takes `solana program deploy` (loader v3). Loader v4
  (SIMD-0167) is **inactive on devnet** as of 9 Oct 2026, so the
  `program-v4 deploy` the local harness uses would fail there.
- **SOL.** About 6.6 SOL at the peak for oracle, clp_pool and perp: ~4.4 of
  program rent, a refundable deploy buffer the size of the largest, the
  0.15 SOL Raydium create-pool fee, and account rent. card_vault adds its own
  rent on top, and the `env` step sends 1 SOL to the faucet wallet. `check`
  prints the exact figure for the programs. Fund from https://faucet.solana.com (GitHub sign-in raises the
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

### The whole app on devnet, for a recorded demo

On Windows run all of this from WSL, where the toolchain is.

1. **Build.** `npm ci`, `npm run typecheck` (the scripts import the packages'
   `dist/`), then `npm run build:programs`. If that stops with `e_flags=3`,
   let `anchor build` write the IDLs and build each of the five programs with
   the 3.1.10 release: `cargo-build-sbf --arch v1 --manifest-path
   programs/<name>/Cargo.toml --sbf-out-dir target/deploy`.
2. **Rehearse on a local validator.** `npm run test:integration`, then
   `npm run dev:chain -- <wallet>` and open the app. It is the same web code
   path with a mock AMM, and it costs no devnet SOL.
3. **Decide the pool size before the first devnet run.** `SEED` in
   `scripts/devnet.mjs` is 50,000/50,000, which carries about $7.5k of open
   interest: one $1,000 margin at 5x takes two thirds of it. The script cannot
   enlarge the pool after it exists.
4. **Fund the deployer and deploy.** `node scripts/devnet.mjs check`, fund
   what it asks for, then `node scripts/devnet.mjs all`. The last step, `env`,
   creates a faucet wallet (never the deployer), sends it 1 SOL and 100,000
   kdUSD, and writes four lines to `apps/web/.env.local`, keeping every other
   line: `NEXT_PUBLIC_KADEX_RPC_URL`, `NEXT_PUBLIC_KADEX_USDC_MINT`,
   `NEXT_PUBLIC_KADEX_NETWORK` and `KADEX_FAUCET_KEYPAIR`.
5. **Start the app.** `npm run web`, restarted after any change to
   `.env.local`. Off mainnet the wallet picker also offers a demo wallet, and
   any wallet that connects is sent 0.05 SOL and 1,000 kdUSD by the faucet.
   `node scripts/devnet.mjs fund <wallet> [usd]` mints more.
6. **Give the wallet test cards.** Copy the connected wallet's address and run
   `node scripts/devnet.mjs cards <wallet>`. It creates a Core collection,
   initializes the vault registry with it, and makes copies of seven real
   Collector Crypt cards owned by that wallet, whitelisted at the real
   appraisal with equal weights (capped at 15%). `KADEX_CARDS=<address>,…`
   picks the cards. The vault page then lists them first, and their card
   pages vault and redeem the copy.
7. **Keep the price fresh.** `npm run keeper` and `npm run liquidator`, each
   in its own terminal. Both read the addresses from
   `deployments/devnet.json`; `KADEX_SERVICE_KEYPAIR` picks the payer.
8. **Make the price move on camera.** `npm run devnet:market -- swing 0.03
   600 15`. Each swap carries `refresh_price`, so it works without a keeper.
   The oracle keeps its 30-minute TWAP on devnet, so the price on screen
   follows a swing slowly: about a tenth of a 3% swing over ten minutes.

What this does not give you:

- Vaulted fractions cannot be deposited into the pool. Each card has its own
  fraction mint and the pool binds one, the index token (#1).
- Real Collector Crypt cards cannot be vaulted on devnet. They are mainnet
  assets; only the copies made in step 6 exist here.
- The copies point their metadata at the card's Collector Crypt page, not at
  a JSON file, so a wallet shows them without a picture.

## Hosting on Railway

One Railway project, `kadex`, with three services. Each is deployed by
uploading this checkout, from the repository root:

```sh
railway up --service web        # or keeper, liquidator
```

`.railwayignore` keeps the Rust workspace out of the upload, so the builder
treats it as a Node project. The build and start commands are set on each
service:

| Service | Build | Start | Variables |
|---|---|---|---|
| web | `npm run build -w @kadex/web` | `npm run start -w @kadex/web` | `NEXT_PUBLIC_KADEX_RPC_URL`, `NEXT_PUBLIC_KADEX_USDC_MINT`, `NEXT_PUBLIC_KADEX_NETWORK=devnet`, `KADEX_FAUCET_KEYPAIR` |
| keeper | `npm run typecheck` | `node scripts/service.mjs keeper` | `KADEX_SERVICE_KEYPAIR`, `DEVNET_RPC` (optional) |
| liquidator | `npm run typecheck` | `node scripts/service.mjs liquidator` | `KADEX_SERVICE_KEYPAIR`, `DEVNET_RPC` (optional) |

The web service runs without any variable: it then serves the sample market.
The `NEXT_PUBLIC_*` values are read at build time, so upload again after
setting them. Copy them, and `KADEX_FAUCET_KEYPAIR`, from the
`apps/web/.env.local` that `node scripts/devnet.mjs all` writes.

`KADEX_SERVICE_KEYPAIR` takes the keypair JSON array itself, since there is no
file to point at. Use a wallet made for the services and funded with a little
devnet SOL, never the deployer.

The keeper and the liquidator exit until `deployments/devnet.json` and
`deployments/idl/` exist in the checkout being uploaded. The deploy writes
both.

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
