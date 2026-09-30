//! Aritmetica de ponto fixo do SLAB.
//!
//! REGRA ZERO: nao existe ponto flutuante em nenhum caminho que toque dinheiro.
//! Todo calculo aqui e inteiro, com escala explicita e direcao de arredondamento
//! declarada por funcao.
//!
//! # Escalas
//!
//! | constante | valor | usada para |
//! |---|---|---|
//! | [`WAD`]  | 1e6  | razoes, precos, parametros (phi, delta, mu, psi) |
//! | [`BPS`]  | 1e4  | taxas e haircuts vindos de configuracao |
//! | [`RAY`]  | 1e12 | indice de borrow acumulado (precisa de mais casas) |
//!
//! Quantias de token sao `u64` em unidades nativas. USDC tem 6 casas, entao
//! 1 USDC = 1_000_000 = 1 WAD. Essa coincidencia e proposital: preco em WAD
//! multiplicado por quantidade em unidades nativas cai direto em USDC nativo.
//!
//! # Politica de arredondamento
//!
//! Sempre a favor do pool, nunca do usuario. Em caso de duvida o pool fica
//! com o centavo. Concretamente:
//!
//! - deposito -> CLP mintado arredonda PARA BAIXO ([`shares_for_deposit`])
//! - saque -> ativo devolvido arredonda PARA BAIXO ([`assets_for_shares`])
//! - taxa, borrow e margem exigida arredondam PARA CIMA
//! - PnL do trader arredonda PARA BAIXO em modulo
//!
//! Toda funcao abaixo diz no nome ou no doc qual direcao usa.
//!
//! # Overflow
//!
//! Intermediarios sao `u128`/`i128`. Nada usa `as` para estreitar sem checar.
//! Toda conversao de volta para `u64` passa por [`to_u64`], que retorna
//! [`MathError::Overflow`] em vez de truncar silenciosamente.

#![allow(clippy::result_large_err)]

/// Escala de razoes, precos e parametros. 1.0 == `WAD`.
pub const WAD: u128 = 1_000_000;
/// Escala de basis points vindos de configuracao. 100% == `BPS`.
pub const BPS: u128 = 10_000;
/// Escala do indice de borrow acumulado.
pub const RAY: u128 = 1_000_000_000_000;

/// Segundos em uma hora. O borrow do spec e por hora.
pub const SECONDS_PER_HOUR: i64 = 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// O resultado nao cabe no tipo de destino.
    Overflow,
    /// Divisao por zero.
    DivByZero,
    /// Um argumento violou uma pre-condicao documentada.
    BadInput,
}

impl core::fmt::Display for MathError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MathError::Overflow => write!(f, "overflow"),
            MathError::DivByZero => write!(f, "division by zero"),
            MathError::BadInput => write!(f, "bad input"),
        }
    }
}

pub type MResult<T> = core::result::Result<T, MathError>;

// ---------------------------------------------------------------------------
// primitivas
// ---------------------------------------------------------------------------

/// Estreita `u128` para `u64` falhando em vez de truncar.
#[inline]
pub fn to_u64(x: u128) -> MResult<u64> {
    u64::try_from(x).map_err(|_| MathError::Overflow)
}

/// `a * b / c` arredondando PARA BAIXO.
#[inline]
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> MResult<u128> {
    if c == 0 {
        return Err(MathError::DivByZero);
    }
    a.checked_mul(b)
        .ok_or(MathError::Overflow)
        .map(|prod| prod / c)
}

/// `a * b / c` arredondando PARA CIMA.
///
/// Usada onde o arredondamento tem que favorecer o pool: taxa, borrow devido,
/// margem minima exigida.
#[inline]
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> MResult<u128> {
    if c == 0 {
        return Err(MathError::DivByZero);
    }
    let prod = a.checked_mul(b).ok_or(MathError::Overflow)?;
    Ok(prod.div_ceil(c))
}

/// `x * f / WAD`, para baixo. `f` e uma razao em WAD.
#[inline]
pub fn mul_wad_floor(x: u128, f: u128) -> MResult<u128> {
    mul_div_floor(x, f, WAD)
}

/// `x * f / WAD`, para cima.
#[inline]
pub fn mul_wad_ceil(x: u128, f: u128) -> MResult<u128> {
    mul_div_ceil(x, f, WAD)
}

/// `x * WAD / d`, para baixo. Resultado e uma razao em WAD.
#[inline]
pub fn div_wad_floor(x: u128, d: u128) -> MResult<u128> {
    mul_div_floor(x, WAD, d)
}

/// `x * bps / BPS`, para cima. Usada para taxas e haircuts.
#[inline]
pub fn apply_bps_ceil(x: u128, bps: u128) -> MResult<u128> {
    mul_div_ceil(x, bps, BPS)
}

/// `x - x*bps/BPS`, com o desconto arredondado PARA CIMA (pool fica com a sobra).
///
/// Usada no haircut de deposito de fracao de card.
#[inline]
pub fn subtract_bps_ceil(x: u128, bps: u128) -> MResult<u128> {
    if bps > BPS {
        return Err(MathError::BadInput);
    }
    let cut = apply_bps_ceil(x, bps)?;
    Ok(x.saturating_sub(cut))
}

/// Raiz quadrada inteira por Newton. `isqrt(x)` = maior `r` com `r*r <= x`.
pub fn isqrt(x: u128) -> u128 {
    if x < 2 {
        return x;
    }
    // chute inicial baseado no bit mais alto
    let mut r = 1u128 << ((128 - x.leading_zeros()).div_ceil(2));
    loop {
        let next = (r + x / r) / 2;
        if next >= r {
            return r;
        }
        r = next;
    }
}

/// `sqrt(x)` onde `x` esta em WAD e o resultado tambem. Arredonda PARA BAIXO.
///
/// `sqrt_wad(WAD) == WAD`, `sqrt_wad(4*WAD) == 2*WAD`.
pub fn sqrt_wad(x_wad: u128) -> MResult<u128> {
    let scaled = x_wad.checked_mul(WAD).ok_or(MathError::Overflow)?;
    Ok(isqrt(scaled))
}

// ---------------------------------------------------------------------------
// utilizacao e borrow
// ---------------------------------------------------------------------------

/// `u = OI_total / capacidade`, em WAD. Satura em `WAD` (100%).
///
/// Capacidade zero com OI zero e 0; capacidade zero com OI positivo e 100%,
/// porque nao ha espaco nenhum.
pub fn utilization(oi_total: u64, capacity: u64) -> MResult<u128> {
    if capacity == 0 {
        return Ok(if oi_total == 0 { 0 } else { WAD });
    }
    let u = div_wad_floor(oi_total as u128, capacity as u128)?;
    Ok(u.min(WAD))
}

/// `r_hora = r0 + r1 * u^2`, em WAD por hora.
///
/// O termo quadratico e o que faz a taxa subir devagar enquanto sobra
/// capacidade e disparar perto do teto.
pub fn borrow_rate_hourly(r0_wad: u128, r1_wad: u128, u_wad: u128) -> MResult<u128> {
    let u2 = mul_wad_floor(u_wad, u_wad)?;
    let quad = mul_wad_floor(r1_wad, u2)?;
    r0_wad.checked_add(quad).ok_or(MathError::Overflow)
}

/// Multiplicador de borrow do lado lotado: `1 + psi * max(0, (lado - oposto)/total)`.
///
/// Retorna WAD (== 1.0) quando o lado nao esta lotado.
pub fn side_multiplier(oi_side: u64, oi_opposite: u64, psi_wad: u128) -> MResult<u128> {
    let total = (oi_side as u128)
        .checked_add(oi_opposite as u128)
        .ok_or(MathError::Overflow)?;
    if total == 0 || oi_side <= oi_opposite {
        return Ok(WAD);
    }
    let excess = (oi_side - oi_opposite) as u128;
    let skew = div_wad_floor(excess, total)?;
    let bump = mul_wad_floor(psi_wad, skew)?;
    WAD.checked_add(bump).ok_or(MathError::Overflow)
}

/// Avanca o indice de borrow (escala [`RAY`]) por `elapsed` segundos.
///
/// Arredonda PARA CIMA: o trader paga o centavo, nunca o pool.
pub fn accrue_borrow_index(
    index_ray: u128,
    rate_hourly_wad: u128,
    elapsed_secs: i64,
) -> MResult<u128> {
    if elapsed_secs < 0 {
        return Err(MathError::BadInput);
    }
    if elapsed_secs == 0 || rate_hourly_wad == 0 {
        return Ok(index_ray);
    }
    // fator = rate * elapsed / 3600, em WAD
    let factor = mul_div_ceil(
        rate_hourly_wad,
        elapsed_secs as u128,
        SECONDS_PER_HOUR as u128,
    )?;
    let growth = mul_div_ceil(index_ray, factor, WAD)?;
    index_ray.checked_add(growth).ok_or(MathError::Overflow)
}

/// Borrow devido por uma posicao entre o indice de entrada e o atual.
///
/// Arredonda PARA CIMA.
pub fn borrow_owed(notional: u64, index_entry_ray: u128, index_now_ray: u128) -> MResult<u64> {
    if index_now_ray < index_entry_ray {
        return Err(MathError::BadInput);
    }
    if index_entry_ray == 0 {
        return Err(MathError::BadInput);
    }
    let delta = index_now_ray - index_entry_ray;
    let owed = mul_div_ceil(notional as u128, delta, index_entry_ray)?;
    to_u64(owed)
}

// ---------------------------------------------------------------------------
// posicao
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

/// PnL da posicao em unidades nativas de USDC, com sinal.
///
/// `long  = (preco - entrada)/entrada * notional`
/// `short = (entrada - preco)/entrada * notional`
///
/// Arredonda PARA BAIXO em modulo: ganho do trader trunca para baixo, perda
/// tambem. O pool nunca paga o centavo de arredondamento.
pub fn pnl(side: Side, entry_price: u64, price: u64, notional: u64) -> MResult<i128> {
    if entry_price == 0 {
        return Err(MathError::DivByZero);
    }
    let entry = entry_price as u128;
    let now = price as u128;
    let (hi, lo, positive) = match side {
        Side::Long if now >= entry => (now, entry, true),
        Side::Long => (entry, now, false),
        Side::Short if entry >= now => (entry, now, true),
        Side::Short => (now, entry, false),
    };
    let magnitude = mul_div_floor(notional as u128, hi - lo, entry)?;
    let m = i128::try_from(magnitude).map_err(|_| MathError::Overflow)?;
    Ok(if positive { m } else { -m })
}

/// Patrimonio da posicao: `margem + pnl - borrow_devido`. Pode ser negativo
/// (isso e bad debt e o chamador tem que tratar explicitamente).
pub fn equity(margin: u64, pnl_signed: i128, borrow_owed: u64) -> MResult<i128> {
    let m = margin as i128;
    let b = borrow_owed as i128;
    m.checked_add(pnl_signed)
        .and_then(|v| v.checked_sub(b))
        .ok_or(MathError::Overflow)
}

/// Saude = `patrimonio / notional`, em WAD com sinal. Liquidavel quando
/// abaixo da margem de manutencao.
pub fn health_wad(equity_signed: i128, notional: u64) -> MResult<i128> {
    if notional == 0 {
        return Err(MathError::DivByZero);
    }
    let scaled = equity_signed
        .checked_mul(WAD as i128)
        .ok_or(MathError::Overflow)?;
    Ok(scaled / notional as i128)
}

/// Preco em que a posicao atinge a margem de manutencao. Deterministico e
/// calculavel no momento da abertura, como o spec exige.
///
/// Movimento tolerado = `(margem - borrow)/notional - manutencao`.
/// Se a posicao ja esta abaixo da manutencao, retorna o proprio preco de
/// entrada para o lado que perde (ou seja, ja liquidavel).
pub fn liquidation_price(
    side: Side,
    entry_price: u64,
    margin: u64,
    notional: u64,
    borrow_owed: u64,
    maintenance_wad: u128,
) -> MResult<u64> {
    if notional == 0 {
        return Err(MathError::DivByZero);
    }
    let net = (margin as i128) - (borrow_owed as i128);
    if net <= 0 {
        return Ok(entry_price);
    }
    let buffer = div_wad_floor(net as u128, notional as u128)?;
    if buffer <= maintenance_wad {
        return Ok(entry_price);
    }
    let move_wad = buffer - maintenance_wad;
    let delta = mul_wad_floor(entry_price as u128, move_wad)?;
    let p = match side {
        Side::Long => (entry_price as u128).saturating_sub(delta),
        Side::Short => (entry_price as u128)
            .checked_add(delta)
            .ok_or(MathError::Overflow)?,
    };
    to_u64(p)
}

/// Margem minima exigida para abrir `notional` com alavancagem maxima
/// `max_leverage_wad`. Arredonda PARA CIMA.
pub fn min_margin(notional: u64, max_leverage_wad: u128) -> MResult<u64> {
    if max_leverage_wad == 0 {
        return Err(MathError::DivByZero);
    }
    let m = mul_div_ceil(notional as u128, WAD, max_leverage_wad)?;
    to_u64(m)
}

// ---------------------------------------------------------------------------
// tetos de risco
// ---------------------------------------------------------------------------

/// Teto de OI pela solvencia da manga liquida.
///
/// `OI_max = U * phi / delta_max`
///
/// Vem da invariante `OI * delta_max <= U * phi`: o pagamento a trader
/// vencedor sempre sai de ativo liquido.
pub fn oi_cap_solvency(usdc_sleeve: u64, phi_wad: u128, delta_max_wad: u128) -> MResult<u64> {
    if delta_max_wad == 0 {
        return Err(MathError::DivByZero);
    }
    let budget = mul_wad_floor(usdc_sleeve as u128, phi_wad)?;
    let cap = mul_div_floor(budget, WAD, delta_max_wad)?;
    to_u64(cap)
}

/// Teto de OI pela profundidade do AMM, que e a defesa anti-manipulacao.
///
/// `OI_max = R * (sqrt(1 + delta_liq) - 1) / mu`
///
/// O numerador e o custo de empurrar o preco do pool constant-product ate o
/// ponto de liquidacao; `mu` e a fracao do OI que um atacante captura na
/// cascata. Mover o preco tem que custar mais do que rende.
pub fn oi_cap_depth(depth_usdc: u64, delta_liq_wad: u128, mu_wad: u128) -> MResult<u64> {
    if mu_wad == 0 {
        return Err(MathError::DivByZero);
    }
    let one_plus = WAD.checked_add(delta_liq_wad).ok_or(MathError::Overflow)?;
    let root = sqrt_wad(one_plus)?;
    let factor = root.saturating_sub(WAD);
    let cost = mul_wad_floor(depth_usdc as u128, factor)?;
    let cap = mul_div_floor(cost, WAD, mu_wad)?;
    to_u64(cap)
}

/// O teto que vale e o MENOR dos dois. Nunca o maior, nunca a media.
pub fn oi_allowed(cap_solvency: u64, cap_depth: u64) -> u64 {
    cap_solvency.min(cap_depth)
}

/// Custo aproximado de mover o preco de um pool constant-product por um fator
/// `(1 + delta)`. Exposto para a UI e para os testes de ataque.
pub fn cost_to_move_price(depth_usdc: u64, delta_wad: u128) -> MResult<u64> {
    let one_plus = WAD.checked_add(delta_wad).ok_or(MathError::Overflow)?;
    let root = sqrt_wad(one_plus)?;
    let factor = root.saturating_sub(WAD);
    to_u64(mul_wad_floor(depth_usdc as u128, factor)?)
}

// ---------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------

/// NAV do pool: `U + valor_da_manga_de_cards - PnL_dos_traders - bad_debt`.
///
/// PnL positivo dos traders SAI do pool. Bad debt ja realizado tambem.
/// Satura em zero: um NAV negativo significa insolvencia e vira `Settled`,
/// nao um numero negativo circulando pelo resto do programa.
pub fn nav(usdc_sleeve: u64, card_sleeve_value: u64, trader_pnl: i128, bad_debt: u64) -> MResult<u64> {
    let assets = (usdc_sleeve as i128)
        .checked_add(card_sleeve_value as i128)
        .ok_or(MathError::Overflow)?;
    let after_pnl = assets
        .checked_sub(trader_pnl)
        .and_then(|v| v.checked_sub(bad_debt as i128))
        .ok_or(MathError::Overflow)?;
    if after_pnl <= 0 {
        return Ok(0);
    }
    to_u64(after_pnl as u128)
}

/// Preco do CLP em WAD. Pool vazio vale 1.0 por convencao (primeiro deposito).
pub fn clp_price(nav: u64, clp_supply: u64) -> MResult<u128> {
    if clp_supply == 0 {
        return Ok(WAD);
    }
    div_wad_floor(nav as u128, clp_supply as u128)
}

/// CLP mintado por um deposito de `value` (ja com haircut aplicado).
/// Arredonda PARA BAIXO: quem entra nunca recebe cota a mais.
pub fn shares_for_deposit(value: u64, nav: u64, clp_supply: u64) -> MResult<u64> {
    if clp_supply == 0 || nav == 0 {
        return Ok(value); // bootstrap: 1 CLP por unidade de valor
    }
    to_u64(mul_div_floor(value as u128, clp_supply as u128, nav as u128)?)
}

/// Valor devolvido por queimar `shares`. Arredonda PARA BAIXO.
pub fn assets_for_shares(shares: u64, nav: u64, clp_supply: u64) -> MResult<u64> {
    if clp_supply == 0 {
        return Err(MathError::DivByZero);
    }
    to_u64(mul_div_floor(shares as u128, nav as u128, clp_supply as u128)?)
}

/// Fatia proporcional de uma manga para um resgate de `shares`.
///
/// O saque e SEMPRE proporcional nas duas mangas. Nao existe caminho de saque
/// so em USDC: se existisse, os primeiros levariam o liquido e os ultimos
/// ficariam com a manga ilíquida inteira.
pub fn proportional_share(sleeve_amount: u64, shares: u64, clp_supply: u64) -> MResult<u64> {
    if clp_supply == 0 {
        return Err(MathError::DivByZero);
    }
    if shares > clp_supply {
        return Err(MathError::BadInput);
    }
    to_u64(mul_div_floor(
        sleeve_amount as u128,
        shares as u128,
        clp_supply as u128,
    )?)
}

/// Haircut pro-rata na liquidacao graciosa: quanto cada um recebe quando o
/// pool nao cobre o total devido. Igual para todos, por construcao.
pub fn prorata_haircut(claim: u64, total_claims: u64, available: u64) -> MResult<u64> {
    if total_claims == 0 {
        return Ok(0);
    }
    if available >= total_claims {
        return Ok(claim);
    }
    to_u64(mul_div_floor(
        claim as u128,
        available as u128,
        total_claims as u128,
    )?)
}

/// Peso de um card dentro da manga de cards, em WAD. Usado contra
/// `max_card_weight` para o pool nao virar aposta num card so.
pub fn card_weight(card_value: u64, card_sleeve_value: u64) -> MResult<u128> {
    if card_sleeve_value == 0 {
        return Ok(0);
    }
    div_wad_floor(card_value as u128, card_sleeve_value as u128)
}

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    // ---- primitivas ----

    #[test]
    fn mul_div_rounds_in_the_declared_direction() {
        assert_eq!(mul_div_floor(10, 1, 3).unwrap(), 3);
        assert_eq!(mul_div_ceil(10, 1, 3).unwrap(), 4);
        // exato nao muda com a direcao
        assert_eq!(mul_div_floor(9, 1, 3).unwrap(), 3);
        assert_eq!(mul_div_ceil(9, 1, 3).unwrap(), 3);
    }

    #[test]
    fn div_by_zero_is_an_error_not_a_panic() {
        assert_eq!(mul_div_floor(1, 1, 0), Err(MathError::DivByZero));
        assert_eq!(mul_div_ceil(1, 1, 0), Err(MathError::DivByZero));
        assert_eq!(clp_price(1, 0).unwrap(), WAD); // caso definido, nao erro
        assert_eq!(assets_for_shares(1, 1, 0), Err(MathError::DivByZero));
        assert_eq!(health_wad(1, 0), Err(MathError::DivByZero));
        assert_eq!(pnl(Side::Long, 0, 1, 1), Err(MathError::DivByZero));
    }

    #[test]
    fn overflow_is_caught_not_truncated() {
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), Err(MathError::Overflow));
        assert_eq!(to_u64(u64::MAX as u128 + 1), Err(MathError::Overflow));
        // resultado grande demais para u64 vira erro, nao numero errado
        assert_eq!(
            oi_cap_solvency(u64::MAX, WAD, 1),
            Err(MathError::Overflow)
        );
    }

    #[test]
    fn to_u64_boundary() {
        assert_eq!(to_u64(u64::MAX as u128).unwrap(), u64::MAX);
        assert!(to_u64(u64::MAX as u128 + 1).is_err());
    }

    #[test]
    fn isqrt_is_exact_on_squares_and_floors_otherwise() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(3), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(8), 2);
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(1_000_000), 1_000);
        for n in 1u128..2_000 {
            let r = isqrt(n);
            assert!(r * r <= n, "isqrt({n}) alto demais");
            assert!((r + 1) * (r + 1) > n, "isqrt({n}) baixo demais");
        }
    }

    #[test]
    fn sqrt_wad_identity() {
        assert_eq!(sqrt_wad(WAD).unwrap(), WAD);
        assert_eq!(sqrt_wad(4 * WAD).unwrap(), 2 * WAD);
        // sqrt(1.1875) ~= 1.089724...
        let r = sqrt_wad(WAD + 187_500).unwrap();
        assert!((1_089_000..=1_090_000).contains(&r), "got {r}");
    }

    #[test]
    fn subtract_bps_keeps_the_remainder_for_the_pool() {
        // 3% de haircut sobre 1000 -> 970
        assert_eq!(subtract_bps_ceil(1_000, 300).unwrap(), 970);
        // arredondamento do corte e para cima: 3% de 101 = 3.03 -> 4
        assert_eq!(subtract_bps_ceil(101, 300).unwrap(), 97);
        assert_eq!(subtract_bps_ceil(100, 20_000), Err(MathError::BadInput));
    }

    // ---- utilizacao e borrow ----

    #[test]
    fn utilization_saturates_and_handles_empty_capacity() {
        assert_eq!(utilization(0, 0).unwrap(), 0);
        assert_eq!(utilization(1, 0).unwrap(), WAD);
        assert_eq!(utilization(50, 100).unwrap(), WAD / 2);
        assert_eq!(utilization(200, 100).unwrap(), WAD); // satura
    }

    #[test]
    fn borrow_rate_is_quadratic_in_utilization() {
        let r0 = 50; // 0.005% em WAD
        let r1 = 500; // 0.05% em WAD
        let at = |u: u128| borrow_rate_hourly(r0, r1, u).unwrap();

        assert_eq!(at(0), r0);
        assert_eq!(at(WAD), r0 + r1);

        // dobrar a utilizacao quadruplica o termo, a menos do arredondamento
        // para baixo: em u=0.25 o termo exato e 31.25 e vira 31, entao
        // 31*4 = 124 contra 125 medidos. A perda e sempre <= 1 unidade e
        // sempre a favor do pool.
        let a = at(WAD / 4) - r0;
        let b = at(WAD / 2) - r0;
        assert!(
            b >= a * 4 && b - a * 4 <= 1,
            "esperado ~{} pelo escalonamento quadratico, medido {b}",
            a * 4
        );

        // com parametros que dividem exato, a relacao e exata
        let at2 = |u: u128| borrow_rate_hourly(0, WAD, u).unwrap();
        assert_eq!(at2(WAD / 2), WAD / 4);
        assert_eq!(at2(WAD / 4), WAD / 16);
        assert_eq!(at2(WAD / 2), at2(WAD / 4) * 4);
    }

    #[test]
    fn crowded_side_pays_more_and_thin_side_does_not() {
        let psi = WAD / 2; // 0.5
        // equilibrado
        assert_eq!(side_multiplier(100, 100, psi).unwrap(), WAD);
        // lado fino nunca paga premio
        assert_eq!(side_multiplier(10, 90, psi).unwrap(), WAD);
        // livro vazio
        assert_eq!(side_multiplier(0, 0, psi).unwrap(), WAD);
        // 90/10 -> skew 0.8 -> multiplicador 1.4
        assert_eq!(side_multiplier(90, 10, psi).unwrap(), WAD + 400_000);
        // 100/0 -> skew 1.0 -> multiplicador 1.5
        assert_eq!(side_multiplier(100, 0, psi).unwrap(), WAD + 500_000);
    }

    #[test]
    fn borrow_index_only_grows_and_rounds_against_the_trader() {
        let start = RAY;
        let rate = 1_000; // 0.1%/h em WAD
        let after = accrue_borrow_index(start, rate, SECONDS_PER_HOUR).unwrap();
        assert!(after > start);
        // uma hora a 0.1% -> +0.1%
        assert_eq!(after, start + RAY / 1_000);

        // tempo zero nao move
        assert_eq!(accrue_borrow_index(start, rate, 0).unwrap(), start);
        // taxa zero nao move
        assert_eq!(accrue_borrow_index(start, 0, 7_200).unwrap(), start);
        // tempo negativo e entrada invalida, nao um decremento silencioso
        assert_eq!(
            accrue_borrow_index(start, rate, -1),
            Err(MathError::BadInput)
        );
    }

    #[test]
    fn borrow_owed_rejects_a_regressing_index() {
        assert_eq!(borrow_owed(1_000, RAY, RAY - 1), Err(MathError::BadInput));
        assert_eq!(borrow_owed(1_000, 0, RAY), Err(MathError::BadInput));
        assert_eq!(borrow_owed(1_000, RAY, RAY).unwrap(), 0);
        // indice subiu 1% -> devedor paga 1% do notional, para cima
        assert_eq!(borrow_owed(1_000, RAY, RAY + RAY / 100).unwrap(), 10);
    }

    // ---- posicao ----

    #[test]
    fn pnl_is_symmetric_between_sides() {
        let entry = WAD as u64;
        let up = (WAD + WAD / 5) as u64; // +20%
        let n = 1_000 * USDC;

        let long = pnl(Side::Long, entry, up, n).unwrap();
        let short = pnl(Side::Short, entry, up, n).unwrap();
        assert_eq!(long, 200 * USDC as i128);
        assert_eq!(short, -(200 * USDC as i128));
        assert_eq!(long + short, 0, "soma zero entre os lados");
    }

    #[test]
    fn pnl_at_entry_is_exactly_zero() {
        let e = 1_234_567;
        assert_eq!(pnl(Side::Long, e, e, 999_999).unwrap(), 0);
        assert_eq!(pnl(Side::Short, e, e, 999_999).unwrap(), 0);
    }

    #[test]
    fn health_and_equity_track_losses_into_bad_debt() {
        let margin = 200 * USDC;
        let notional = 1_000 * USDC;
        // perda de 250 > margem de 200 -> patrimonio negativo
        let p = -(250 * USDC as i128);
        let eq = equity(margin, p, 0).unwrap();
        assert!(eq < 0, "deveria ser bad debt");
        assert!(health_wad(eq, notional).unwrap() < 0);
    }

    #[test]
    fn liquidation_price_is_deterministic_and_sided() {
        let entry = WAD as u64;
        let notional = 1_000 * USDC;
        let margin = notional / 5; // 5x
        let maint = 62_500; // 6.25% em WAD

        let l = liquidation_price(Side::Long, entry, margin, notional, 0, maint).unwrap();
        let s = liquidation_price(Side::Short, entry, margin, notional, 0, maint).unwrap();

        // buffer = 20% - 6.25% = 13.75%
        assert_eq!(l, entry - 137_500);
        assert_eq!(s, entry + 137_500);
        assert!(l < entry && s > entry);
    }

    #[test]
    fn liquidation_price_collapses_when_already_underwater() {
        let entry = WAD as u64;
        let notional = 1_000 * USDC;
        let maint = 62_500;
        // margem ja consumida pelo borrow
        let p = liquidation_price(Side::Long, entry, 10, notional, 10_000, maint).unwrap();
        assert_eq!(p, entry, "posicao ja liquidavel");
    }

    #[test]
    fn min_margin_rounds_up() {
        // 5x sobre 1000 -> 200 exato
        assert_eq!(min_margin(1_000, 5 * WAD).unwrap(), 200);
        // 3x sobre 1000 -> 333.33 -> 334, o trader poe o centavo
        assert_eq!(min_margin(1_000, 3 * WAD).unwrap(), 334);
        assert_eq!(min_margin(1_000, 0), Err(MathError::DivByZero));
    }

    // ---- tetos ----

    #[test]
    fn solvency_cap_matches_the_spec_formula() {
        // U = 140k, phi = 0.5, delta_max = 0.3  ->  140k*0.5/0.3 = 233_333.33
        let cap = oi_cap_solvency(140_000 * USDC, WAD / 2, 300_000).unwrap();
        assert_eq!(cap / USDC, 233_333);
    }

    #[test]
    fn depth_cap_matches_the_spec_formula() {
        // R = 60k, delta_liq = 0.1875, mu = 0.3
        // 60000 * (sqrt(1.1875)-1) / 0.3 = 60000 * 0.089724 / 0.3 ~= 17_944
        let cap = oi_cap_depth(60_000 * USDC, 187_500, 300_000).unwrap();
        assert_eq!(cap / USDC, 17_944);
    }

    #[test]
    fn the_lower_cap_always_wins() {
        let solv = oi_cap_solvency(140_000 * USDC, WAD / 2, 300_000).unwrap();
        let depth = oi_cap_depth(60_000 * USDC, 187_500, 300_000).unwrap();
        assert_eq!(oi_allowed(solv, depth), depth, "profundidade deveria travar");
        // e com um AMM fundo, a solvencia passa a travar
        let deep = oi_cap_depth(5_000_000 * USDC, 187_500, 300_000).unwrap();
        assert_eq!(oi_allowed(solv, deep), solv);
    }

    #[test]
    fn deeper_pool_allows_more_oi_monotonically() {
        let a = oi_cap_depth(25_000 * USDC, 187_500, 300_000).unwrap();
        let b = oi_cap_depth(50_000 * USDC, 187_500, 300_000).unwrap();
        let c = oi_cap_depth(100_000 * USDC, 187_500, 300_000).unwrap();
        assert!(a < b && b < c);
        // dobrar a profundidade dobra o teto (a formula e linear em R)
        assert_eq!(b / a, 2);
    }

    #[test]
    fn attacking_must_cost_more_than_the_cascade_pays() {
        let depth = 60_000 * USDC;
        let mu = 300_000;
        let delta_liq = 187_500;
        let cap = oi_cap_depth(depth, delta_liq, mu).unwrap();
        let cost = cost_to_move_price(depth, delta_liq).unwrap();

        // com o OI exatamente no teto, custo == lucro maximo (fronteira)
        let gain_at_cap = mul_wad_floor(cap as u128, mu).unwrap() as u64;
        assert!(
            cost >= gain_at_cap,
            "custo {cost} deveria cobrir o lucro {gain_at_cap}"
        );

        // abaixo do teto, atacar da prejuizo
        let gain_below = mul_wad_floor((cap / 2) as u128, mu).unwrap() as u64;
        assert!(cost > gain_below);
    }

    // ---- pool ----

    #[test]
    fn nav_subtracts_trader_profit_one_for_one() {
        let base = nav(140_000 * USDC, 60_000 * USDC, 0, 0).unwrap();
        assert_eq!(base, 200_000 * USDC);
        // trader ganha 640 -> NAV cai exatamente 640
        let after = nav(140_000 * USDC, 60_000 * USDC, 640 * USDC as i128, 0).unwrap();
        assert_eq!(base - after, 640 * USDC);
        // trader perde 640 -> NAV sobe exatamente 640
        let worse = nav(140_000 * USDC, 60_000 * USDC, -(640 * USDC as i128), 0).unwrap();
        assert_eq!(worse - base, 640 * USDC);
    }

    #[test]
    fn nav_deducts_bad_debt_and_floors_at_zero() {
        let n = nav(1_000, 0, 0, 400).unwrap();
        assert_eq!(n, 600);
        assert_eq!(nav(1_000, 0, 0, 5_000).unwrap(), 0);
        assert_eq!(nav(1_000, 0, 9_999, 0).unwrap(), 0);
    }

    #[test]
    fn first_deposit_bootstraps_one_to_one() {
        assert_eq!(shares_for_deposit(5_000, 0, 0).unwrap(), 5_000);
        assert_eq!(clp_price(0, 0).unwrap(), WAD);
    }

    #[test]
    fn deposit_then_withdraw_never_creates_value() {
        let nav0 = 200_000 * USDC;
        let supply0 = 200_000 * USDC;
        let dep = 5_000 * USDC;

        let shares = shares_for_deposit(dep, nav0, supply0).unwrap();
        let nav1 = nav0 + dep;
        let supply1 = supply0 + shares;
        let back = assets_for_shares(shares, nav1, supply1).unwrap();

        assert!(back <= dep, "saiu {back} depois de entrar {dep}");
        assert!(dep - back <= 1, "perda de arredondamento maior que 1 unidade");
    }

    #[test]
    fn withdraw_is_proportional_across_both_sleeves() {
        let usdc = 140_000 * USDC;
        let cards = 60_000 * USDC;
        let supply = 200_000 * USDC;
        let shares = supply / 10; // 10%

        let u = proportional_share(usdc, shares, supply).unwrap();
        let c = proportional_share(cards, shares, supply).unwrap();

        assert_eq!(u, 14_000 * USDC);
        assert_eq!(c, 6_000 * USDC);
        // nenhuma manga sozinha cobre o resgate: e essa a defesa contra corrida
        assert!(u < shares);
    }

    #[test]
    fn proportional_share_rejects_more_shares_than_supply() {
        assert_eq!(proportional_share(100, 11, 10), Err(MathError::BadInput));
        assert_eq!(proportional_share(100, 1, 0), Err(MathError::DivByZero));
    }

    #[test]
    fn prorata_haircut_is_equal_for_everyone() {
        let total = 1_000u64;
        let available = 700u64;
        let a = prorata_haircut(600, total, available).unwrap();
        let b = prorata_haircut(400, total, available).unwrap();
        assert_eq!(a, 420);
        assert_eq!(b, 280);
        assert!(a + b <= available, "nunca paga mais do que existe");
        // sem escassez ninguem sofre haircut
        assert_eq!(prorata_haircut(600, total, 1_000).unwrap(), 600);
    }

    #[test]
    fn card_weight_guards_against_a_single_card_pool() {
        assert_eq!(card_weight(0, 0).unwrap(), 0);
        assert_eq!(card_weight(15, 100).unwrap(), 150_000); // 15%
        let max = 150_000u128; // max_card_weight = 15%
        assert!(card_weight(16, 100).unwrap() > max, "deveria estourar o teto");
    }

    // ---- cenario fim a fim do spec ----

    #[test]
    fn full_hedge_leaves_combined_pnl_near_zero() {
        // carteira com ~3200 em cards, short de 3200, indice cai 20%
        let entry = WAD as u64;
        let notional = 3_200 * USDC;
        let after = (WAD * 80 / 100) as u64;

        let card_loss = -(mul_wad_floor(notional as u128, WAD * 20 / 100).unwrap() as i128);
        let short_gain = pnl(Side::Short, entry, after, notional).unwrap();

        assert_eq!(short_gain, 640 * USDC as i128);
        assert_eq!(card_loss + short_gain, 0, "hedge deveria zerar");
    }
}
