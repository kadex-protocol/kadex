# Program keypairs

Os quatro programas usam IDs fixos, versionados aqui, para que os tres
desenvolvedores deployem nos mesmos enderecos e o frontend nao precise
trocar de endereco a cada `anchor build`.

Antes do primeiro build:

    npm run sync-keys      # copia keys/*.json -> target/deploy/

`target/` esta no .gitignore, entao as chaves vivem em `keys/`.

Estas chaves sao de DEVNET e de demo. Nao usar em mainnet, nao guardar
valor real nelas.
