# Invariantes econômicas

Cada uma é um teste. Se um teste desta lista ficar vermelho, o protocolo está
errado — não o teste.

## 1. Solvência

```
OI_total × δ_max  ≤  U × φ
```

Pagamento a trader vencedor sempre sai da manga líquida. Abertura que violaria
isso é **recusada na mesma transação**, não corrigida depois.

- Rust: `Pool::require_capacity`, `Market::check_open`
- Teste: `clp_pool::tests::opening_beyond_the_lower_cap_is_refused`

## 2. Os dois tetos, e o menor manda

```
OI_permitido = min( U × φ / δ_max ,  R × (√(1+δ_liq) − 1) / μ )
```

Nunca a média, nunca o maior. Com os parâmetros do spec, **o teto de
profundidade trava 13x antes do de solvência** — é a liquidez do AMM que
define o tamanho do mercado, não o saldo do CLP.

- Rust: `slab_math::oi_allowed`
- Teste: `clp_pool::tests::depth_cap_binds_far_before_solvency_cap`

## 3. Utilização e borrow

```
u = OI_total / OI_permitido
r_hora = r0 + r1 × u²
```

O termo quadrático faz a taxa subir devagar enquanto sobra capacidade e
disparar perto do teto. O pool fica caro antes de ser tomado de surpresa.

- Teste: `perp::tests::borrow_grows_quadratically_with_utilization`

## 4. Lado lotado paga mais

```
r_lado = r_hora × (1 + ψ × max(0, (OI_lado − OI_oposto) / OI_total))
```

O lado fino nunca paga prêmio. Multiplicador é exatamente 1.0 para ele.

- Teste: `perp::tests::crowded_side_pays_more_than_the_thin_side`

## 5. NAV

```
NAV = U + Σ(qᵢ × pᵢ) − PnL_traders − bad_debt
```

Lucro do trader sai do pool, um por um. Não existe arredondamento que crie
valor.

- Teste: `clp_pool::tests::trader_profit_reduces_nav_one_for_one`

## 6. Preço do CLP

```
CLP_price = NAV / CLP_supply
```

Pool vazio vale 1.0 por convenção (primeiro depósito).

## 7. Saque proporcional

Resgate sai proporcional **nas duas mangas**, sempre. Não existe caminho de
saque só em USDC. Se existisse, os primeiros levariam o líquido e os últimos
ficariam com a manga ilíquida inteira.

- Teste: `clp_pool::tests::withdraw_is_proportional_and_never_usdc_only`

## 8. A manga de cards nunca paga trader vencedor

É por isso que o teto de OI olha para `usdc_sleeve`, e não para o NAV total.

## 9. Liquidação usa o preço do oráculo

Nunca um preço interno. Se usasse um preço interno, alguém empurraria esse
preço para caçar liquidação alheia.

- Rust: `Position::is_liquidatable` recebe o preço do oráculo, sempre

## 10. Bad debt é explícito

Prejuízo que passou da margem é gravado em `Pool.bad_debt` e descontado do
NAV. Nunca some, nunca é escondido. Bad debt invisível foi o que permitiu o
nftperp operar insolvente por meses.

- Teste: `perp::tests::a_gap_through_the_margin_becomes_recorded_bad_debt`

## 11. ReduceOnly não abre risco novo

E também trava resgate de CLP — para o LP não sacar exatamente quando o pool
mais precisa de colchão.

- Teste: `clp_pool::tests::state_machine_gates_match_the_spec`

## 12. Settled aplica haircut pro-rata igual

Todo mundo sofre o mesmo corte. Nenhuma fila, nenhum privilégio.

- Teste: `clp_pool::tests::settlement_haircut_is_equal_for_everyone`

## Política de arredondamento

Sempre a favor do pool, nunca do usuário.

| Operação | Direção | Por quê |
|---|---|---|
| CLP mintado no depósito | para baixo | quem entra nunca recebe cota a mais |
| ativo devolvido no saque | para baixo | quem sai nunca leva a mais |
| taxa, borrow, margem exigida | para cima | o usuário paga o centavo |
| PnL do trader | para baixo em módulo | o pool nunca paga arredondamento |

Documentada em `packages/slab-math/src/lib.rs` e verificada em
`slab_math::tests::deposit_then_withdraw_never_creates_value`.
