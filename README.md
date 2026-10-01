# SLAB

Perps sobre índice de cards tokenizados na Solana. O pool CLP é a contraparte
de todo trade; o preço vem de um pool AMM de frações, não de oráculo assinado.

## Começar

```sh
npm install
npm run sync-keys        # keys/ -> target/deploy/ (program IDs fixos)
anchor build             # compila os 4 programas + IDLs + tipos TS
cargo test --workspace   # 78 testes de invariante, < 1s
node --test tests/parity.test.mjs   # 19 testes de paridade Rust <-> TS
```

## Onde está o quê

| Caminho | O quê |
|---|---|
| `packages/slab-math` | aritmética de ponto fixo, sem float |
| `packages/slab-interface` | **interfaces congeladas** entre times |
| `programs/oracle` | preço: TWAP, clamp, profundidade, divergência |
| `programs/card-vault` | NFT ↔ frações SPL |
| `programs/clp-pool` | pool, NAV, mangas, estado |
| `programs/perp` | posições, borrow, liquidação |
| `packages/types` `packages/sdk` | contrato com o frontend |
| `docs/` | plano, arquitetura, invariantes, oráculo, frontend |

## Leia antes de programar

0. `docs/handoff.md` — **comece por aqui**
1. `docs/implementation-plan.md` — quem faz o quê e o que está bloqueado
2. `docs/invariants.md` — as 12 regras que não se negociam
3. `packages/slab-interface/src/lib.rs` — o que está congelado e como mudar

## Branches

```
main                          integração, sempre verde
backend/card-vault-oracle     Backend A
backend/risk-engine           Backend B
frontend/web                  Frontend
```

Commits pequenos e isolados. Não misture oráculo, risco e frontend no mesmo
commit.
