# Arquitetura

## Fronteiras de programa

```
┌─ Backend A ─────────────────┐   ┌─ Backend B ──────────────────┐
│                             │   │                              │
│  card-vault                 │   │  clp-pool                    │
│   • fractionalize           │   │   • deposit / withdraw       │
│   • redeem_card             │   │   • NAV, CLP mint/burn       │
│   • whitelist, peso máximo  │   │   • params, estado, bad debt │
│                             │   │                              │
│  oracle                     │   │  perp                        │
│   • refresh_price           │   │   • open / close / liquidate │
│   • TWAP, clamp, depth      │   │   • borrow index, OI         │
│   • adaptadores de AMM      │   │                              │
│         │                   │   │         ▲                    │
└─────────┼───────────────────┘   └─────────┼────────────────────┘
          │                                 │
          └────── OracleAccount ────────────┘
                (conta lida, sem CPI)
```

A **única** coisa que cruza a fronteira é a conta do oráculo. Não há CPI entre
A e B, o que significa que os dois podem trabalhar sem sincronizar builds.

Dentro de B, `perp` faz CPI em `clp-pool` para mover USDC — os dois são do
mesmo dono, então esse acoplamento não bloqueia ninguém.

## Por que o oráculo é um programa e não um módulo

Propriedade de conta em Solana é por programa. Se `OracleAccount` vivesse
dentro do `clp-pool`, quem escreve preço e quem escreve risco editariam o
mesmo crate todo dia.

Com programa separado, `#[account]` em `slab-interface` declara o ID do
programa `oracle`, e o Anchor passa a exigir sozinho que qualquer
`Account<'info, OracleAccount>` pertença a ele. Uma conta forjada por outro
programa é rejeitada antes de qualquer lógica rodar — a checagem é do
framework, não nossa.

## Camadas de código

```
programs/*        ← validação de conta, CPI, movimento de token
      │             (fino: só orquestra)
      ▼
funções puras     ← Market::check_open, Position::health, evaluate_state
      │             (grosso: aqui mora a decisão, e é testável sem validador)
      ▼
slab-math         ← aritmética de ponto fixo, sem I/O, sem Anchor
```

Toda decisão de risco é escrita como função pura sobre structs. Por isso 78
testes rodam em menos de um segundo, sem compilar SBF e sem subir validador.

## Movimento de token

| O quê | Quem custodia | Autoridade |
|---|---|---|
| NFT do card | `nft_escrow` PDA | `VaultedCard` PDA |
| mint das frações | — | `VaultedCard` PDA |
| manga USDC | `usdc_vault` | `Pool` PDA |
| mint do CLP | — | `Pool` PDA |
| margem das posições | manga USDC | `Pool` PDA, via `perp_market` |

`Pool.perp_market` guarda o único PDA autorizado a mexer na contabilidade de
risco. Sem isso, qualquer programa poderia pedir ao pool para pagar.

## Aritmética

Sem ponto flutuante em nenhum caminho que toque dinheiro. Intermediários em
`u128`/`i128`, conversão de volta só via `to_u64`, que erra em vez de truncar.

Escalas: WAD 1e6 (razões e preços), BPS 1e4 (taxas de config), RAY 1e12
(índice de borrow, precisa de mais casas porque acumula muitas vezes).

USDC tem 6 casas e as frações também — a coincidência é proposital: preço em
WAD vezes quantidade nativa cai direto em USDC nativo, sem conversão.
