# Program keypairs

The four programs use fixed IDs, versioned here, so all three developers
deploy to the same addresses and the frontend does not have to change an
address after every `anchor build`.

Before your first build:

    npm run sync-keys      # copies keys/*.json -> target/deploy/

`target/` is gitignored, so the keys live in `keys/`.

These are DEVNET and demo keys. Do not use them on mainnet and do not hold
real value in them.
