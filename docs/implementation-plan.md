# SLAB — plano de implementação

> Fonte de verdade econômica: o spec do SLAB. Este documento traduz o spec em
> fronteiras de código e diz quem constrói o quê sem bloquear os outros.

Estado em 30/09/2026 — dia 1 concluído. Prazo de submissão: 12/10/2026.

## 1. O mapa

Quatro programas on-chain, dois pacotes Rust compartilhados, três pacotes
TypeScript, três apps.

| Peça | Tipo | Dono | Estado |
|---|---|---|---|
| `packages/slab-math` | crate Rust | compartilhado | **pronto**, 32 testes |
| `packages/slab-interface` | crate Rust | compartilhado | **congelado**, 3 testes |
| `programs/oracle` | programa | Backend A | estado + defesas, 11 testes |
| `programs/card-vault` | programa | Backend A | ciclo completo, 2 testes |
| `programs/clp-pool` | programa | Backend B | estado + invariantes, 13 testes |
| `programs/perp` | programa | Backend B | estado + `check_open`, 17 testes |
| `packages/types` | TS | Frontend | PDAs e views congelados |
| `packages/sdk` | TS | Frontend | espelho da matemática + derivados |
| `packages/oracle` | TS | Backend A | adaptadores, mock funcionando |
| `apps/keeper` | TS | Backend A | vazio |
| `apps/liquidator` | TS | Backend B | vazio |
| `apps/web` | Next.js | Frontend | vazio |

## 2. Desvio declarado do spec

**O spec descreve três programas. Foram implementados quatro.**

O oráculo virou programa próprio em vez de morar dentro do `clp-pool`.

Motivo: propriedade de conta em Solana é por programa. Se a conta do oráculo
vivesse no `clp-pool`, Backend A e Backend B editariam o mesmo programa todo
dia, que é exatamente o que este trabalho existe para evitar. Com programa
separado, A é dono do oráculo, B é dono do risco, e a única coisa entre eles é
uma conta lida.

Custo: zero CPI. `perp` recebe a conta do oráculo e desserializa. O Anchor
confere sozinho que ela pertence ao programa `oracle`, porque
`slab-interface` declara esse ID — conta forjada por outro programa é rejeitada
antes de qualquer lógica rodar.

## 3. Grafo de dependências

```
slab-math  ──────────────┐
                         ├──> oracle ──(conta OracleAccount)──> perp
slab-interface ──────────┤                                       │
  (OracleAccount,        ├──> card-vault                         │
   PoolParams,           │                                       v
   seeds, estados)       └──> clp-pool <────(CPI de risco)──── perp
                                  │
                                  v
                          packages/types (espelho TS)
                                  │
                                  v
                          packages/sdk ──> apps/web
```

O que isso quer dizer na prática:

- **A não espera B.** `oracle` e `card-vault` só dependem dos dois crates
  compartilhados, que já estão prontos.
- **B não espera A.** `perp` consome `OracleView`, não o programa `oracle`.
  Os testes de B constroem `OracleView` na mão.
- **Frontend não espera ninguém.** `packages/types` já tem os PDAs e as views;
  `target/idl/*.json` e `target/types/*.ts` já existem.

## 4. Ordem recomendada D1–D3

| Dia | Backend A | Backend B | Frontend |
|---|---|---|---|
| D1 | ✅ decimais das frações (6, travado) | ✅ esqueleto de contas + ponto fixo | ✅ scaffold + PDAs |
| D2 | `fractionalize`/`redeem` em litesvm | `deposit`/`withdraw` proporcional | leitura de contas via SDK |
| D3 | pool AMM mock + primeira liquidez | NAV + mint/burn de CLP | tela do pool com dados reais |

## 5. O que está congelado

Mudar qualquer coisa desta lista exige o processo descrito no topo de
`packages/slab-interface/src/lib.rs`.

1. `slab_interface::seeds` — todos os PDAs
2. `OracleAccount` e `OracleView` — a interface A↔B
3. `PoolParams` — configuração econômica
4. `MarketState` e `OracleState` — máquina de estados
5. Escalas: WAD = 1e6, BPS = 1e4, RAY = 1e12
6. `FRACTION_DECIMALS = 6` — mudar quebra o oráculo silenciosamente
7. Os quatro program IDs em `keys/`

## 6. Bloqueadores

### Blocker #1 — layout do AMM real (ALTO, dono: A)

O formato on-chain do pool de frações/USDC não foi confirmado. Os adaptadores
`Meteora`, `Orca` e `Raydium` **falham alto** de propósito, em Rust e em TS.
O adaptador `Mock` existe para todo mundo trabalhar sem fingir integração.

Quando confirmar, só mudam `programs/oracle/src/adapter.rs` e
`packages/oracle/src/index.ts`. Nada em `perp` ou `clp-pool` é tocado.

### Blocker #2 — quem é o primeiro LP (ALTO, dono: A + produto)

Sem depósito inicial no AMM não existe reserva, não existe preço, e nada mais
funciona. O tamanho desse depósito define o teto de OI do mercado inteiro.

### Blocker #3 — circularidade do NAV (ALTO, dono: B)

O mesmo pool AMM precifica o perp **e** a manga de cards do CLP. Quem empurra
o AMM move os dois. A manga líquida mitiga; não elimina. Vai declarado na
submissão.

### Blocker #4 — CPI de risco entre `perp` e `clp-pool` (MÉDIO, dono: B)

`perp` precisa mover USDC do cofre do pool ao fechar posição vencedora. O
desenho é: `Pool.perp_market` guarda o PDA autorizado, e só ele assina. Ainda
não implementado — é o trabalho de D6–D8.

### Blocker #5 — espaço no nome da pasta (BAIXO, mas irritante)

O diretório do projeto termina com espaço. `anchor build` funciona, mas
`solana-keygen` recusa caminho absoluto com espaço e qualquer script que não
cite o caminho vai quebrar. Recomendo renomear para `Ooffset` antes de
clonar em outras máquinas.

## 7. Estratégia de testes

Três camadas, e a primeira é a que mais pega bug.

**Unitários puros (`cargo test`)** — 78 testes, rodam em menos de um segundo,
sem validador. É onde vivem as invariantes econômicas. Toda função de risco é
escrita como função pura sobre structs para poder ser testada aqui.

**Paridade Rust↔TS (`node --test`)** — 19 testes com os mesmos vetores dos
testes Rust. Se a matemática do frontend divergir da do programa, a tela mostra
um preço de liquidação e o programa usa outro. Este arquivo pega isso.

**Programa em litesvm** — testes por instrução, com o `.so` compilado. Ainda
não escritos; entram a partir de D2.

Os **negativos** valem mais que os positivos e estão marcados como tal:
capacidade estourada, oráculo forjado, salto acima do clamp, oráculo velho,
profundidade insuficiente, divergência excessiva, abertura fora de `Active`,
margem insuficiente, liquidação antes do gatilho, bad debt, haircut pro-rata.
