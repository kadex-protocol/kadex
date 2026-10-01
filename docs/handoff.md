# Handoff — comece por aqui

> Leia este arquivo inteiro antes do primeiro commit. São 10 minutos e evitam
> uma semana de retrabalho.

Prazo de submissão: **12/10/2026**. Hoje é 01/10. Restam 11 dias.

## 1. Rodando em 5 minutos

```sh
git clone https://github.com/Ooffset/slab.git
cd slab
npm install
npm run sync-keys        # keys/ -> target/deploy/ — program IDs fixos, não pule
anchor build             # 4 programas + IDLs + tipos TS
cargo test --workspace   # 78 testes, menos de 1 segundo
node --test tests/parity.test.mjs   # 19 testes de paridade Rust <-> TS
```

Precisa de: Rust 1.89 (o `rust-toolchain.toml` cuida disso), Solana CLI 3.1.10,
Anchor CLI 1.2.0, Node 22+.

Se `cargo test` passar e `anchor build` gerar quatro `.so` em `target/deploy/`,
seu ambiente está certo.

## 2. O que já existe

97 testes passando. 3.373 linhas de Rust. Nenhum handler de risco implementado
ainda — e isso é proposital: o dia 1 foi para as fronteiras ficarem certas
antes de alguém escrever lógica em cima delas.

| Peça | Estado |
|---|---|
| `packages/slab-math` | **pronto** — ponto fixo, 32 testes |
| `packages/slab-interface` | **congelado** — contrato entre times |
| `programs/oracle` | contas + as 4 defesas, 11 testes. Falta: litesvm |
| `programs/card-vault` | ciclo completo NFT↔frações, 2 testes. Falta: litesvm |
| `programs/clp-pool` | contas + invariantes, 13 testes. Falta: handlers |
| `programs/perp` | `check_open` validando os 2 tetos, 17 testes. Falta: handlers |
| `packages/types` `packages/sdk` | PDAs e matemática prontos para o frontend |
| `apps/web` `apps/keeper` `apps/liquidator` | vazios |

## 3. As quatro decisões que você precisa conhecer

### 3.1 São quatro programas, não três

O spec descreve três. O oráculo virou programa próprio.

Motivo: propriedade de conta em Solana é por programa. Com `OracleAccount`
dentro do `clp-pool`, quem escreve preço e quem escreve risco editariam o mesmo
crate todo dia — exatamente o que esta estrutura existe para evitar.

Custo: zero CPI. `perp` recebe a conta e desserializa; o Anchor confere o dono
sozinho, porque `slab-interface` declara o ID do programa `oracle`. Conta
forjada por outro programa é rejeitada antes de qualquer lógica rodar.

### 3.2 Não existe chave de oráculo

`refresh_price` é permissionless e recalcula tudo de estado on-chain. Não há
assinatura off-chain para roubar, e se o keeper cair qualquer pessoa mantém o
preço vivo.

### 3.3 Toda decisão de risco é função pura

`Market::check_open`, `Position::health`, `evaluate_state` — nenhuma delas toca
`AccountInfo`. Recebem structs, devolvem resultado.

É por isso que 78 testes rodam em menos de um segundo, sem compilar SBF e sem
subir validador. **Mantenha esse padrão.** Se você escrever lógica dentro do
handler, ela vira intestável e todo mundo paga.

### 3.4 Adaptador não implementado falha alto

`Meteora`, `Orca` e `Raydium` retornam erro, em Rust e em TS. Retornar zero ou
um número plausível abriria o mercado com preço inventado. Não "resolva" isso
devolvendo um valor.

## 4. O que está CONGELADO

Mudar qualquer item desta lista quebra o trabalho de outra pessoa.

1. `slab_interface::seeds` — todos os PDAs
2. `OracleAccount` e `OracleView` — a interface A↔B
3. `PoolParams` — configuração econômica
4. `MarketState` e `OracleState`
5. Escalas: WAD = 1e6, BPS = 1e4, RAY = 1e12
6. `FRACTION_DECIMALS = 6` — mudar quebra o oráculo em silêncio
7. Os quatro program IDs em `keys/`

**Precisa mudar mesmo assim?** Processo no topo de
`packages/slab-interface/src/lib.rs`: explique o porquê, liste os módulos
afetados, atualize os docs, atualize os testes, avise quem travou. Nessa ordem.

## 5. Regras de código

**Sem float em nada que toque dinheiro.** Intermediários em `u128`/`i128`,
volta para `u64` só via `to_u64`, que erra em vez de truncar.

**Arredondamento sempre a favor do pool.** Depósito e saque para baixo; taxa,
borrow e margem exigida para cima. Está documentado em
`packages/slab-math/src/lib.rs` e testado.

**No TypeScript, tudo é BigInt.** `Number` perde precisão acima de 2^53 e um
saldo em USDC nativo passa disso fácil. Converta para `Number` só na última
linha, para exibir.

**Teste junto com o código, não depois.** E escreva os negativos: eles valem
mais que os positivos na avaliação.

**Commits pequenos e isolados.** Não misture oráculo, risco e frontend no mesmo
commit.

## 6. Quem faz o quê

### Backend A — ativo e oráculo

Branch: `backend/card-vault-oracle`

| Dia | Tarefa |
|---|---|
| ✅ D1 | decimais das frações travados em 6 |
| D2 | testes litesvm de `fractionalize` e `redeem_card` |
| D3 | pool AMM mock on-chain + primeiro depósito de liquidez |
| D4 | leitor de reservas + TWAP + clamp isolados e testados |
| D5–D6 | `refresh_price` on-chain + piso de profundidade |
| **D7** | **congela a função de preço e entrega para B** |
| D8–D11 | negativos do oráculo: clamp, divergência, profundidade mínima |

Negativos do D2 que importam: mint fora da whitelist, resgate com frações
insuficientes, resgate por quem não tem todas as frações, card desabilitado.

### Backend B — motor de risco

Branch: `backend/risk-engine`

| Dia | Tarefa |
|---|---|
| ✅ D1–D2 | contas + ponto fixo + testes de overflow |
| D3–D5 | `deposit`, `withdraw` proporcional, NAV, CPI de token |
| D6–D8 | `open_position`, `close_position`, borrow por utilização |
| **D9** | **os dois tetos de OI e a invariante de solvência** |
| D10 | `liquidate` + bot liquidador de referência |
| D11 | `ReduceOnly`, `Settled`, haircut pro-rata |

O D9 está no meio de propósito. Deixar o coração do mecanismo para o fim é
como esses projetos morrem.

A matemática já está pronta e testada — falta a movimentação de token.
**Não implemente caminho de saque só em USDC**, nem como atalho temporário.

### Frontend

Branch: `frontend/web`

Pode começar agora, sem esperar ninguém. Já existem: `target/idl/*.json`,
`target/types/*.ts`, PDAs em `@slab/types`, e `derivePosition`,
`deriveCapacity`, `deriveBorrowRates`, `derivePool` em `@slab/sdk`.

| Dia | Tarefa |
|---|---|
| D1–D2 | scaffold Next.js, wallet adapter, leitura de contas |
| D3–D4 | tela de depósito no pool: mangas, NAV, preço do CLP |
| D5–D7 | tela de trade: preço, borrow, PnL, preço de liquidação |
| D8–D9 | botão proteger coleção, lendo os cards da carteira |
| D10 | painel com **os dois lados na mesma tela** — PnL do trader e NAV do pool |
| D11–D12 | roteiro, vídeo, texto da submissão |

Leia `docs/frontend-contract.md`. Comece com dados mockados nas formas de
`PoolView`, `OracleView`, `MarketView` e `PositionView` — quando os handlers
chegarem, só o fetch muda.

### Todos

- D12: integração completa em devnet, os três juntos
- D13: congelar código, ensaiar a demo duas vezes
- D14: submeter com folga

## 7. O único ponto onde um trava o outro

**D7.** Backend A congela a função de preço e entrega para B. Depois disso a
interface não muda mais.

Fora isso, as trilhas são independentes. B não espera A porque consome
`OracleView` e os testes constroem essa struct na mão. Frontend não espera
ninguém porque os PDAs e os tipos já existem.

## 8. Bloqueadores conhecidos

| # | O quê | Grau | Dono |
|---|---|---|---|
| 1 | Layout on-chain do AMM real não confirmado | Alto | A |
| 2 | Quem é o primeiro LP do pool de frações | Alto | A + produto |
| 3 | Circularidade do NAV: o mesmo pool precifica perp e colateral | Alto | B |
| 4 | CPI de risco entre `perp` e `clp-pool` | Médio | B |
| 5 | Espaço no fim do nome da pasta local | Baixo | qualquer um |

Sobre o **#2**, que é o mais fácil de subestimar: sem depósito inicial no AMM
não existe reserva, não existe preço, e nada mais funciona. E o tamanho desse
depósito define o teto de OI do mercado inteiro.

Sobre o **#3**: a manga líquida mitiga, não elimina. Vai declarado na
submissão — dizer que reduzimos a circularidade é honesto; dizer que
resolvemos, não.

## 9. O achado que muda o planejamento

O teste `depth_cap_binds_far_before_solvency_cap` confirma:

```
teto de solvência do CLP   $233.333
teto de profundidade AMM    $17.944   ← trava
```

**A profundidade do AMM trava 13 vezes antes da solvência.** O teto que o spec
mais detalha praticamente nunca vai morder. Quem define o tamanho do mercado é
a liquidez do pool de frações, não o saldo do CLP.

Vale o time discutir se `phi` e `delta_max` estão conservadores demais para uma
restrição que quase nunca morde.

## 10. Leitura obrigatória

1. `docs/invariants.md` — as 12 regras que não se negociam
2. `docs/architecture.md` — fronteiras de programa e camadas
3. `docs/oracle.md` — as 4 defesas e o Blocker #1
4. `docs/frontend-contract.md` — só o frontend
5. `packages/slab-interface/src/lib.rs` — o que está congelado
