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
echo 'export PATH="$HOME/Desktop/slab/scripts/bin:$PATH"' >> ~/.zshrc
```

### Removing the shim later

It exists only because the local CLI is older than the bytecode Anchor emits.
Agave 4.3.0 is released and should parse SBPF v3 natively. Once the toolchain
is upgraded and `solana program deploy target/deploy/oracle.so` works on a v3
binary, delete `scripts/bin/` and the `REQUIRED_ARCH` check in
`scripts/build.mjs`.

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
