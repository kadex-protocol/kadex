# Oráculo

> Dono: Backend A. Consumido por Backend B apenas através de `OracleView`.

## O desenho

```
reservas do AMM externo
        │
        ▼  spot = reserva_usdc / reserva_fracao
   observação no buffer circular (32 posições)
        │
        ▼  TWAP da janela de 30 min
   clamp de 5% por atualização sobre o preço anterior
        │
        ▼
   PREÇO OFICIAL  ──> perp (PnL, liquidação), clp-pool (marcação da manga)
```

Fills externos **não são fonte de preço**. Entram como `external_median` e
servem só de limite de sanidade. Se essa alimentação falhar, o mercado perde
uma defesa e continua funcionando.

## Por que não existe chave de oráculo

`refresh_price` é permissionless e recalcula tudo a partir de estado on-chain.
Não existe assinatura off-chain para ser roubada, e se o nosso keeper cair,
qualquer pessoa mantém o preço vivo.

Isso é uma melhoria sobre a versão anterior do spec, que tinha oráculo assinado
com chave única listada como risco.

## As quatro defesas

| Defesa | Parâmetro | Ataque que barra |
|---|---|---|
| TWAP | `twap_window_secs` = 1800 | manipulação de bloco único |
| Clamp por tick | `max_tick_move` = 5% | salto para caçar liquidação |
| Piso de profundidade | `min_pool_depth` = $25k | sacar liquidez para deixar o oráculo barato |
| Divergência externa | `max_divergence` = 15% | manipulação sustentada do pool |

Mais `max_staleness_secs` = 900, que derruba para `Stale`.

O clamp **não impede manipulação lenta**. Ele encarece e mata a versão
instantânea e lucrativa dela. Um teste mede isso:
`clamp_reaches_the_target_over_repeated_updates` prova que mover o preço 50%
exige pelo menos 8 atualizações consecutivas.

## A interface congelada

```rust
pub struct OracleView {
    pub price: u64,   // WAD, já com TWAP e clamp — use este
    pub twap: u64,    // WAD, bruto, só diagnóstico
    pub ts: i64,
    pub depth: u64,   // USDC nativo, entra no teto de OI
    pub state: OracleState,
}

impl OracleView {
    fn require_tradeable(&self) -> Result<u64>;  // só OracleState::Ok
    fn require_markable(&self, now, max_staleness) -> Result<u64>;
}
```

`require_tradeable` é para abrir risco. `require_markable` é para liquidar e
marcar — permitido mesmo fora de `Ok`, porque travar liquidação seria deixar
posição podre acumulando.

Backend B chama `perp::oracle_view(account_info)` e nunca desserializa na mão.

## Blocker #1 — layout do AMM real

**O formato on-chain do pool real de frações/USDC ainda não foi confirmado.**

Os adaptadores `Meteora`, `Orca` e `Raydium` retornam erro em Rust
(`AdapterUnsupported`) e lançam em TypeScript. Isso é deliberado: retornar zero
ou um número plausível seria pior, porque o mercado abriria com preço
inventado.

O adaptador `Mock` lê um layout próprio (8 bytes de discriminador + dois u64
little-endian) e serve devnet e testes.

Quando o layout real for confirmado, mudam **apenas**:

- `programs/oracle/src/adapter.rs`
- `packages/oracle/src/index.ts`

Nada em `perp`, `clp-pool` ou no frontend é tocado.
