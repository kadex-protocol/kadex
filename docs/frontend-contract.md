# Contrato com o frontend

> O frontend NÃO desserializa conta na mão e NÃO deriva PDA na mão. Tudo passa
> por `@slab/sdk`, para que uma mudança de layout quebre a compilação do SDK
> em vez de quebrar a tela em silêncio.

## O que já dá para usar hoje

| Recurso | Onde | Estado |
|---|---|---|
| Program IDs | `@slab/types` → `PROGRAM_IDS` | congelado |
| Derivação de PDA | `@slab/types` → `find*` | congelado |
| IDLs | `target/idl/*.json` | gerados |
| Tipos Anchor | `target/types/*.ts` | gerados |
| Matemática | `@slab/sdk` → `math` | com teste de paridade |
| Derivados de tela | `@slab/sdk` → `derive*` | pronto |

## Derivação de PDA

```ts
import { findPool, findMarket, findPosition, findOracle } from "@slab/types";

const pool     = findPool(usdcMint);
const market   = findMarket(pool);
const oracle   = findOracle(basket);
const position = findPosition(market, wallet, 0n);
```

Os seeds espelham `slab_interface::seeds` byte a byte. Se divergirem, o
frontend deriva endereços que não existem.

## Os derivados que a tela precisa

Nenhum destes valores está gravado na conta. São calculados no SDK, com o
mesmo ponto fixo do Rust.

```ts
import { derivePosition, deriveCapacity, deriveBorrowRates, derivePool } from "@slab/sdk";

// posição: PnL, borrow devido, patrimônio, saúde, preço de liquidação
const p = derivePosition(raw, market, oraclePrice, pool.params);

// capacidade: os DOIS tetos e qual deles trava
const c = deriveCapacity(pool, oracle, market);
// c.binding === "depth" | "solvency"  ← mostre isso na tela
// c.free                              ← quanto ainda dá para abrir
// c.utilization                       ← em WAD

// borrow por lado, já com o acréscimo do lado lotado
const r = deriveBorrowRates(pool, market, c.cap);

// pool: NAV, preço do CLP, composição das mangas
const v = derivePool(pool);
```

## Escalas

| Valor | Escala | Converter com |
|---|---|---|
| preços, razões, parâmetros | WAD = 1e6 | `fromWad` |
| USDC e frações | 6 casas | `fromUsdc` / `toUsdc` |
| índice de borrow | RAY = 1e12 | — |
| taxas de configuração | bps = 1e4 | — |

**Tudo é BigInt.** Não existe `Number` em caminho de dinheiro: `Number` perde
precisão acima de 2^53 e um saldo em USDC nativo passa disso fácil. Converta
para `Number` só na última linha antes de exibir.

## Habilitar e desabilitar controles

```ts
import { gates, oracleTradeable } from "@slab/types";

const g = gates(pool.state);      // canOpen, canClose, canDeposit, canWithdraw...
const ok = oracleTradeable(oracle.state);

// botão de abrir posição:
disabled = !g.canOpen || !ok || c.free === 0n;
```

Espelha `MarketState::allows_*` do Rust. Se a tela habilitar um botão que o
programa recusa, o usuário paga gas para receber erro.

## O que mostrar quando o mercado trava

Nunca mostre só "erro". O estado diz o porquê:

| Estado | Mensagem |
|---|---|
| `reduceOnly` + oráculo `shallowDepth` | "Liquidez do pool abaixo do mínimo. Só é possível fechar posições." |
| `reduceOnly` + utilização alta | "Capacidade esgotada. Só é possível fechar posições." |
| oráculo `stale` | "Preço desatualizado. Aguardando atualização." |
| oráculo `diverged` | "Preço divergiu da referência externa. Mercado em espera." |
| `settled` | "Mercado encerrado. Resgate final disponível." |

## O que ainda não existe

- instruções de `deposit` / `withdraw` / `open_position` / `close_position` /
  `liquidate` — os esqueletos estão definidos, os handlers entram em D3–D10
- leitura real das contas (o SDK tem as formas, falta o fetch)
- `apps/web` está vazio

O frontend pode começar por: scaffold, wallet adapter, derivação de PDA,
telas com dados mockados nas formas de `PoolView`, `OracleView`, `MarketView`
e `PositionView`. Quando os handlers chegarem, só o fetch muda.
