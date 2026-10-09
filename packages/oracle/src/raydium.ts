/**
 * Raydium CPMM (`raydium-io/raydium-cp-swap`) — the TypeScript twin of
 * `programs/oracle/src/adapter.rs::raydium`.
 *
 * Same rules, same order, same answer: the pool must be owned by Raydium, be
 * a 637-byte `PoolState`, pair two 6-decimal classic SPL tokens, have swaps
 * enabled, and pair the oracle's basket mint. Each vault must be the one the
 * pool records, hold that side's mint, be initialized, and be owned by
 * Raydium's authority PDA. Usable reserves are the vault balances minus the
 * protocol, fund and creator fees the pool owes. `tests/raydium.test.mjs`
 * holds this file to the Rust on the same captured devnet accounts.
 */

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, type Connection } from "@solana/web3.js";

export const RAYDIUM_CPMM = {
  mainnet: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
  devnet: new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"),
} as const;

/** Raydium's own create-pool fee receivers (a wrapped-SOL token account). */
export const RAYDIUM_CREATE_POOL_FEE = {
  mainnet: new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8"),
  devnet: new PublicKey("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy"),
} as const;

export const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PE9wGq7Rgd5B8n");
export const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const POOL_DISCRIMINATOR = [247, 237, 227, 245, 215, 195, 222, 70] as const;
export const INITIALIZE_DISCRIMINATOR = [175, 175, 109, 31, 13, 152, 155, 237] as const;
export const POOL_LEN = 637;
export const TOKEN_ACCOUNT_LEN = 165;
export const REQUIRED_DECIMALS = 6;
const SWAP_DISABLED = 1 << 2;

const OFF = {
  ammConfig: 8, token0Vault: 72, token1Vault: 104, lpMint: 136, token0Mint: 168, token1Mint: 200,
  token0Program: 232, token1Program: 264, observation: 296, authBump: 328, status: 329,
  mint0Decimals: 331, mint1Decimals: 332, lpSupply: 333,
  protocolFees0: 341, protocolFees1: 349, fundFees0: 357, fundFees1: 365, openTime: 373,
  creatorFees0: 397, creatorFees1: 405,
} as const;

const U64_MAX = (1n << 64n) - 1n;

/** Error names match `OracleError` in Rust, so a mismatch is easy to compare. */
export class AdapterError extends Error {
  constructor(readonly code: AdapterErrorCode, detail: string) {
    super(`${code}: ${detail}`);
  }
}
export type AdapterErrorCode =
  | "AdapterBadAccount" | "AdapterWrongVault" | "AdapterWrongMint" | "AdapterWrongAuthority"
  | "AdapterUnsupportedToken" | "AdapterPoolDisabled" | "AdapterInsufficientVault";

const fail = (code: AdapterErrorCode, detail: string): never => {
  throw new AdapterError(code, detail);
};

export interface RaydiumPool {
  address: PublicKey;
  program: PublicKey;
  ammConfig: PublicKey;
  vaults: [PublicKey, PublicKey];
  mints: [PublicKey, PublicKey];
  lpMint: PublicKey;
  observation: PublicKey;
  authBump: number;
  status: number;
  lpSupply: bigint;
  /** Owed per side: protocol + fund + creator. */
  fees: [bigint, bigint];
}

export interface Reserves {
  /** Native USDC. The `R` in the depth ceiling. */
  usdc: bigint;
  /** Index-token reserve, native units. */
  fraction: bigint;
}

const isRaydium = (owner: PublicKey) => owner.equals(RAYDIUM_CPMM.mainnet) || owner.equals(RAYDIUM_CPMM.devnet);
const keyAt = (d: Uint8Array, at: number) => new PublicKey(d.subarray(at, at + 32));
const u64At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

export function decodePool(address: PublicKey, owner: PublicKey, data: Uint8Array): RaydiumPool {
  if (!isRaydium(owner)) fail("AdapterBadAccount", `pool ${address.toBase58()} is owned by ${owner.toBase58()}, not Raydium CPMM`);
  if (data.length !== POOL_LEN) fail("AdapterBadAccount", `pool is ${data.length} bytes, expected ${POOL_LEN}`);
  if (POOL_DISCRIMINATOR.some((b, i) => data[i] !== b)) fail("AdapterBadAccount", "not a Raydium PoolState");
  if (!keyAt(data, OFF.token0Program).equals(SPL_TOKEN) || !keyAt(data, OFF.token1Program).equals(SPL_TOKEN)) {
    fail("AdapterUnsupportedToken", "only classic SPL Token pools are priced");
  }
  if (data[OFF.mint0Decimals] !== REQUIRED_DECIMALS || data[OFF.mint1Decimals] !== REQUIRED_DECIMALS) {
    fail("AdapterUnsupportedToken", `both mints must have ${REQUIRED_DECIMALS} decimals`);
  }
  if ((data[OFF.status]! & SWAP_DISABLED) !== 0) fail("AdapterPoolDisabled", "swaps are disabled on this pool");
  const sum = (...at: number[]) => {
    const total = at.reduce((acc, o) => acc + u64At(data, o), 0n);
    return total > U64_MAX ? fail("AdapterBadAccount", "fee counters overflow u64") : total;
  };
  return {
    address,
    program: owner,
    ammConfig: keyAt(data, OFF.ammConfig),
    vaults: [keyAt(data, OFF.token0Vault), keyAt(data, OFF.token1Vault)],
    mints: [keyAt(data, OFF.token0Mint), keyAt(data, OFF.token1Mint)],
    lpMint: keyAt(data, OFF.lpMint),
    observation: keyAt(data, OFF.observation),
    authBump: data[OFF.authBump]!,
    status: data[OFF.status]!,
    lpSupply: u64At(data, OFF.lpSupply),
    fees: [sum(OFF.protocolFees0, OFF.fundFees0, OFF.creatorFees0), sum(OFF.protocolFees1, OFF.fundFees1, OFF.creatorFees1)],
  };
}

/** 0 when the basket is token 0, 1 when it is token 1. */
export function orientation(pool: RaydiumPool, basket: PublicKey): 0 | 1 {
  if (pool.mints[0].equals(pool.mints[1])) fail("AdapterWrongMint", "pool pairs a mint with itself");
  if (pool.mints[0].equals(basket)) return 0;
  if (pool.mints[1].equals(basket)) return 1;
  return fail("AdapterWrongMint", `pool does not pair basket ${basket.toBase58()}`);
}

export function poolAuthority(pool: Pick<RaydiumPool, "program" | "authBump">): PublicKey {
  try {
    return PublicKey.createProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed"), Buffer.from([pool.authBump])], pool.program);
  } catch {
    return fail("AdapterWrongAuthority", "the pool's auth bump does not derive an authority");
  }
}

export interface VaultAccount {
  address: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
}

function vaultAmount(v: VaultAccount, expected: PublicKey, mint: PublicKey, authority: PublicKey): bigint {
  if (!v.address.equals(expected)) fail("AdapterWrongVault", `${v.address.toBase58()} is not the vault the pool records`);
  if (!v.owner.equals(SPL_TOKEN)) fail("AdapterWrongVault", "vault is not an SPL Token account");
  if (v.data.length !== TOKEN_ACCOUNT_LEN) fail("AdapterWrongVault", "vault has the wrong size");
  if (v.data[108] !== 1) fail("AdapterWrongVault", "vault is not initialized, or is frozen");
  if (!keyAt(v.data, 0).equals(mint)) fail("AdapterWrongMint", "vault holds another mint");
  if (!keyAt(v.data, 32).equals(authority)) fail("AdapterWrongAuthority", "vault is not owned by Raydium's authority");
  return u64At(v.data, 64);
}

/** Usable reserves, oriented by the basket mint. Pure: no RPC. */
export function reservesOf(pool: RaydiumPool, vaults: readonly VaultAccount[], basket: PublicKey): Reserves {
  const side = orientation(pool, basket);
  const authority = poolAuthority(pool);
  if (vaults.length < 2) fail("AdapterWrongVault", "both vaults are required");
  const usable = [0, 1].map((i) => {
    const raw = vaultAmount(vaults[i]!, pool.vaults[i]!, pool.mints[i]!, authority);
    return raw < pool.fees[i]! ? fail("AdapterInsufficientVault", `vault ${i} holds less than the fees it owes`) : raw - pool.fees[i]!;
  }) as [bigint, bigint];
  return side === 0 ? { fraction: usable[0], usdc: usable[1] } : { fraction: usable[1], usdc: usable[0] };
}

/** Read and validate a pool and its vaults in one RPC call, so they agree. */
export async function readRaydium(conn: Connection, address: PublicKey, basket: PublicKey) {
  const first = await conn.getAccountInfo(address, "confirmed");
  if (!first) throw new Error(`pool ${address.toBase58()} does not exist`);
  const vaults = decodePool(address, first.owner, first.data).vaults;
  const [p, v0, v1] = await conn.getMultipleAccountsInfo([address, ...vaults], "confirmed");
  if (!p || !v0 || !v1) throw new Error("pool or a vault disappeared between reads");
  const pool = decodePool(address, p.owner, p.data);
  const reserves = reservesOf(
    pool,
    [
      { address: vaults[0], owner: v0.owner, data: v0.data },
      { address: vaults[1], owner: v1.owner, data: v1.data },
    ],
    basket,
  );
  return { pool, reserves };
}

/** The extra accounts `refresh_price` needs for a Raydium oracle, in order. */
export const refreshAccounts = (pool: Pick<RaydiumPool, "vaults">): PublicKey[] => [pool.vaults[0], pool.vaults[1]];

// --- creating a pool -------------------------------------------------------

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Raydium requires token 0 < token 1 by key bytes. */
export function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

/** Every address `initialize` will create, all deterministic. */
export function poolAddresses(program: PublicKey, ammConfig: PublicKey, mintA: PublicKey, mintB: PublicKey) {
  const [mint0, mint1] = sortMints(mintA, mintB);
  const pool = pda([Buffer.from("pool"), ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer()], program);
  return {
    mint0,
    mint1,
    pool,
    authority: pda([Buffer.from("vault_and_lp_mint_auth_seed")], program),
    lpMint: pda([Buffer.from("pool_lp_mint"), pool.toBuffer()], program),
    vault0: pda([Buffer.from("pool_vault"), pool.toBuffer(), mint0.toBuffer()], program),
    vault1: pda([Buffer.from("pool_vault"), pool.toBuffer(), mint1.toBuffer()], program),
    observation: pda([Buffer.from("observation"), pool.toBuffer()], program),
  };
}

const ata = (owner: PublicKey, mint: PublicKey) => pda([owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN);

export interface CreatePool {
  program: PublicKey;
  ammConfig: PublicKey;
  createPoolFee: PublicKey;
  creator: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  /** Amounts by mint, so the caller never has to know Raydium's sort order. */
  amountA: bigint;
  amountB: bigint;
  openTime?: bigint;
}

/** Raydium CPMM `initialize`: creates the pool at its PDA and deposits both sides. */
export function createPoolIx(c: CreatePool): TransactionInstruction {
  const a = poolAddresses(c.program, c.ammConfig, c.mintA, c.mintB);
  const [amount0, amount1] = a.mint0.equals(c.mintA) ? [c.amountA, c.amountB] : [c.amountB, c.amountA];
  const data = Buffer.alloc(8 + 24);
  Buffer.from(INITIALIZE_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(amount0, 8);
  data.writeBigUInt64LE(amount1, 16);
  data.writeBigUInt64LE(c.openTime ?? 0n, 24);
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: c.program,
    keys: [
      w(c.creator, true),
      r(c.ammConfig),
      r(a.authority),
      w(a.pool),
      r(a.mint0),
      r(a.mint1),
      w(a.lpMint),
      w(ata(c.creator, a.mint0)),
      w(ata(c.creator, a.mint1)),
      w(ata(c.creator, a.lpMint)),
      w(a.vault0),
      w(a.vault1),
      w(c.createPoolFee),
      w(a.observation),
      r(SPL_TOKEN),
      r(SPL_TOKEN),
      r(SPL_TOKEN),
      r(ASSOCIATED_TOKEN),
      r(SystemProgram.programId),
      r(SYSVAR_RENT_PUBKEY),
    ],
    data,
  });
}

export const SWAP_BASE_INPUT_DISCRIMINATOR = [143, 190, 90, 218, 196, 30, 51, 222] as const;

export interface Swap {
  pool: Pick<RaydiumPool, "address" | "program" | "ammConfig" | "vaults" | "mints" | "observation" | "authBump">;
  payer: PublicKey;
  /** The mint being sold into the pool. */
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut?: bigint;
}

/** Raydium CPMM `swap_base_input`, from the payer's associated token accounts. */
export function swapBaseInputIx(s: Swap): TransactionInstruction {
  const i = s.pool.mints[0].equals(s.inputMint) ? 0 : s.pool.mints[1].equals(s.inputMint) ? 1 : fail("AdapterWrongMint", "input mint is not in the pool");
  const o = 1 - i;
  const data = Buffer.alloc(8 + 16);
  Buffer.from(SWAP_BASE_INPUT_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(s.amountIn, 8);
  data.writeBigUInt64LE(s.minimumAmountOut ?? 0n, 16);
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: s.pool.program,
    keys: [
      w(s.payer, true),
      r(poolAuthority(s.pool)),
      r(s.pool.ammConfig),
      w(s.pool.address),
      w(ata(s.payer, s.pool.mints[i]!)),
      w(ata(s.payer, s.pool.mints[o]!)),
      w(s.pool.vaults[i]!),
      w(s.pool.vaults[o]!),
      r(SPL_TOKEN),
      r(SPL_TOKEN),
      r(s.pool.mints[i]!),
      r(s.pool.mints[o]!),
      w(s.pool.observation),
    ],
    data,
  });
}
