# Deploying

> Read this before your first deploy. `anchor build` alone produces binaries
> that **cannot be deployed**, and the error message does not say why.

## Build with the npm script, not `anchor build`

```sh
npm run build:programs
```

Not `anchor build` on its own. Here is why.

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

`scripts/build.mjs` runs `anchor build` for the IDLs and TypeScript types, then
overwrites the binaries with `cargo-build-sbf --arch v1`. The source is
identical; only the bytecode target differs. It then checks `e_flags` on every
output and fails loudly if anything is still v3, because a silent reversion
would not surface until someone tried to deploy.

## Verifying before you deploy

```sh
node -e "console.log(require('fs').readFileSync('target/deploy/oracle.so').readUInt32LE(48))"
```

`1` is deployable. `3` is not.

## Devnet

```sh
npm run build:programs
solana config set --url devnet
solana program deploy target/deploy/oracle.so \
  --program-id keys/oracle-keypair.json
```

Repeat per program. The IDs are fixed in `keys/` so all three developers and
the frontend hit the same addresses.

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
