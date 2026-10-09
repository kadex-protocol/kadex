/**
 * Card vault, Metaplex Core path: read a card's on-chain state and build
 * `fractionalize_core` / `redeem_core`.
 *
 * Accounts are listed in the order and with the writability the card-vault
 * IDL declares. Each decoder checks size and discriminator and throws if
 * either is off, like the pool and oracle decoders.
 */

import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import { PROGRAM_IDS, findCard, findFractionMint, findRegistry, findVaultedCard } from "@kadex/types";
import { TOKEN_PROGRAM_ID, decodeTokenAmount, findAta } from "./chain.js";

export const CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

export const VAULT_DISCRIMINATORS = {
  registry: [47, 174, 110, 246, 184, 182, 252, 218],
  whitelistedCard: [253, 76, 218, 153, 32, 24, 209, 125],
  vaultedCard: [82, 144, 106, 81, 198, 72, 94, 108],
  fractionalizeCore: [144, 181, 132, 197, 152, 228, 44, 239],
  redeemCore: [52, 191, 206, 205, 221, 81, 183, 212],
} as const;

export const REGISTRY_SIZE = 8 + 32 + 32 + 4 + 1;
export const WHITELISTED_CARD_SIZE = 8 + 32 + 32 + 8 + 2 + 1 + 1 + 1;
export const VAULTED_CARD_SIZE = 8 + 32 + 32 + 32 + 8 + 1 + 1;

export interface RegistryAccount {
  admin: PublicKey;
  collection: PublicKey;
  cardCount: number;
}

export interface WhitelistedCardAccount {
  nftMint: PublicKey;
  fractionMint: PublicKey;
  /** Fixed at whitelist time; minted in full on deposit, burned in full on redeem. */
  fractionsPerCard: bigint;
  weightBps: number;
  enabled: boolean;
  core: boolean;
}

export interface VaultedCardAccount {
  nftMint: PublicKey;
  fractionMint: PublicKey;
  depositor: PublicKey;
  fractionsMinted: bigint;
  locked: boolean;
}

function view(data: Uint8Array, name: string, size: number, discriminator: readonly number[]) {
  if (data.length !== size) throw new Error(`${name} account is ${data.length} bytes, expected ${size}: the on-chain layout changed`);
  if (discriminator.some((b, i) => data[i] !== b)) throw new Error(`not a ${name} account`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { key: (at: number) => new PublicKey(data.subarray(at, at + 32)), dv, data };
}

export function decodeRegistry(data: Uint8Array): RegistryAccount {
  const r = view(data, "Registry", REGISTRY_SIZE, VAULT_DISCRIMINATORS.registry);
  return { admin: r.key(8), collection: r.key(40), cardCount: r.dv.getUint32(72, true) };
}

export function decodeWhitelistedCard(data: Uint8Array): WhitelistedCardAccount {
  const r = view(data, "WhitelistedCard", WHITELISTED_CARD_SIZE, VAULT_DISCRIMINATORS.whitelistedCard);
  return {
    nftMint: r.key(8),
    fractionMint: r.key(40),
    fractionsPerCard: r.dv.getBigUint64(72, true),
    weightBps: r.dv.getUint16(80, true),
    enabled: r.data[82] === 1,
    core: r.data[83] === 1,
  };
}

export function decodeVaultedCard(data: Uint8Array): VaultedCardAccount {
  const r = view(data, "VaultedCard", VAULTED_CARD_SIZE, VAULT_DISCRIMINATORS.vaultedCard);
  return {
    nftMint: r.key(8),
    fractionMint: r.key(40),
    depositor: r.key(72),
    fractionsMinted: r.dv.getBigUint64(104, true),
    locked: r.data[112] === 1,
  };
}

/** Owner of a Metaplex Core asset: `BaseAssetV1` is a key byte, then the owner. */
export function coreAssetOwner(owner: PublicKey, data: Uint8Array): PublicKey {
  if (!owner.equals(CORE_PROGRAM_ID)) throw new Error("not a Metaplex Core asset");
  if (data.length < 33 || data[0] !== 1) throw new Error("not a Core AssetV1 account");
  return new PublicKey(data.subarray(1, 33));
}

export interface CoreVaultAccounts {
  asset: PublicKey;
  /** The registry's collection; the program checks it matches. */
  collection: PublicKey;
}

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

/** Lock a Core card in the vault and mint its whole fraction supply to `depositor`. */
export function fractionalizeCoreIx({ asset, collection }: CoreVaultAccounts, depositor: PublicKey, depositorFractions = findAta(depositor, findFractionMint(asset))): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.cardVault,
    keys: [
      w(depositor, true),
      r(findRegistry()),
      w(asset),
      r(collection),
      r(findCard(asset)),
      w(findVaultedCard(asset)),
      w(findFractionMint(asset)),
      w(depositorFractions),
      r(CORE_PROGRAM_ID),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data: Buffer.from(VAULT_DISCRIMINATORS.fractionalizeCore),
  });
}

/** Burn the WHOLE fraction supply from `redeemer` and take the Core card out. */
export function redeemCoreIx({ asset, collection }: CoreVaultAccounts, redeemer: PublicKey, redeemerFractions = findAta(redeemer, findFractionMint(asset))): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.cardVault,
    keys: [
      w(redeemer, true),
      r(findRegistry()),
      w(asset),
      r(collection),
      w(findVaultedCard(asset)),
      w(findFractionMint(asset)),
      w(redeemerFractions),
      r(CORE_PROGRAM_ID),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data: Buffer.from(VAULT_DISCRIMINATORS.redeemCore),
  });
}

/** Everything the card page needs to decide what to offer, in one read. */
export interface CoreCardState {
  asset: PublicKey;
  /** Null when the asset does not exist on this cluster. */
  assetOwner: PublicKey | null;
  registry: RegistryAccount | null;
  card: WhitelistedCardAccount | null;
  vault: VaultedCardAccount | null;
  /** Fractions the wallet holds in its associated account; 0 without one. */
  walletFractions: bigint;
}

export async function readCoreCard(connection: Connection, asset: PublicKey, wallet: PublicKey | null): Promise<CoreCardState> {
  const keys = [asset, findRegistry(), findCard(asset), findVaultedCard(asset)];
  if (wallet) keys.push(findAta(wallet, findFractionMint(asset)));
  const [a, reg, card, vault, frac] = await connection.getMultipleAccountsInfo(keys, "confirmed");
  return {
    asset,
    assetOwner: a && a.owner.equals(CORE_PROGRAM_ID) ? coreAssetOwner(a.owner, a.data) : null,
    registry: reg ? decodeRegistry(reg.data) : null,
    card: card ? decodeWhitelistedCard(card.data) : null,
    vault: vault ? decodeVaultedCard(vault.data) : null,
    walletFractions: frac ? decodeTokenAmount(frac.data) : 0n,
  };
}

export type VaultAction =
  | { kind: "missing"; reason: string }
  | { kind: "notWhitelisted"; reason: string }
  | { kind: "disabled"; reason: string }
  | { kind: "vault"; fractions: bigint }
  | { kind: "notOwner"; reason: string }
  | { kind: "redeem"; fractions: bigint }
  | { kind: "redeemShort"; fractions: bigint; held: bigint };

/**
 * What the card page may offer, decided from chain state alone. Mirrors the
 * program's own checks, so the button is never enabled for a transaction the
 * program would refuse.
 */
export function vaultAction(s: CoreCardState, wallet: PublicKey | null): VaultAction {
  if (!s.assetOwner) return { kind: "missing", reason: "This card is not on this cluster." };
  if (!s.registry) return { kind: "missing", reason: "The card vault is not initialized on this cluster." };
  if (!s.card || !s.vault) return { kind: "notWhitelisted", reason: "Not whitelisted yet. An admin fixes its fraction count from the appraisal first." };
  if (!s.card.core) return { kind: "notWhitelisted", reason: "Whitelisted as an SPL NFT, not a Core asset." };
  if (s.vault.locked) {
    const fractions = s.vault.fractionsMinted;
    return s.walletFractions >= fractions ? { kind: "redeem", fractions } : { kind: "redeemShort", fractions, held: s.walletFractions };
  }
  if (!s.card.enabled) return { kind: "disabled", reason: "Deposits are disabled for this card." };
  if (!wallet || !s.assetOwner.equals(wallet)) return { kind: "notOwner", reason: "Only its owner can vault this card." };
  return { kind: "vault", fractions: s.card.fractionsPerCard };
}

// --- inventory ------------------------------------------------------------

export interface InventoryRow {
  asset: PublicKey;
  fractionMint: PublicKey;
  /** The whole supply; redeeming burns all of it. */
  supply: bigint;
  /** Fractions this wallet holds, across all its token accounts for the mint. */
  held: bigint;
  /** Fractions still to acquire before this wallet can redeem. */
  missing: bigint;
  /** This wallet locked the card. */
  deposited: boolean;
  /** What `missing` costs at appraisal: 1 fraction is $1 of appraisal, native USDC. */
  missingAtAppraisal: bigint;
}

/**
 * Locked cards a wallet deposited or holds fractions of. Pure: the caller
 * supplies the vault records and the wallet's balances by mint.
 */
export function inventoryRows(vaults: readonly VaultedCardAccount[], balances: ReadonlyMap<string, bigint>, wallet: PublicKey): InventoryRow[] {
  return vaults
    .filter((v) => v.locked)
    .map((v) => {
      const held = balances.get(v.fractionMint.toBase58()) ?? 0n;
      const missing = v.fractionsMinted > held ? v.fractionsMinted - held : 0n;
      return {
        asset: v.nftMint,
        fractionMint: v.fractionMint,
        supply: v.fractionsMinted,
        held,
        missing,
        deposited: v.depositor.equals(wallet),
        // FRACTION_DECIMALS = USDC decimals = 6, so native fractions ARE native USDC at $1.
        missingAtAppraisal: missing,
      };
    })
    .filter((r) => r.deposited || r.held > 0n)
    .sort((a, b) => (a.missing < b.missing ? -1 : a.missing > b.missing ? 1 : a.asset.toBase58().localeCompare(b.asset.toBase58())));
}

/**
 * Every locked card, and the wallet's balance of each fraction mint, in two
 * RPC calls. Balances are summed over all the wallet's token accounts, not
 * only the associated one, so fractions held anywhere count.
 */
export async function readVaultInventory(connection: Connection, wallet: PublicKey): Promise<InventoryRow[]> {
  const [locked, tokens] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_IDS.cardVault, {
      commitment: "confirmed",
      filters: [
        { dataSize: VAULTED_CARD_SIZE },
        { memcmp: { offset: 0, bytes: bs58(VAULT_DISCRIMINATORS.vaultedCard) } },
        { memcmp: { offset: 112, bytes: bs58([1]) } },
      ],
    }),
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
  ]);
  const balances = new Map<string, bigint>();
  for (const { account } of tokens.value) {
    const mint = new PublicKey(account.data.subarray(0, 32)).toBase58();
    balances.set(mint, (balances.get(mint) ?? 0n) + decodeTokenAmount(account.data));
  }
  return inventoryRows(locked.map(({ account }) => decodeVaultedCard(account.data)), balances, wallet);
}

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 for the short memcmp filters above; no dependency for eight bytes. */
function bs58(bytes: readonly number[]): string {
  let n = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = "";
  while (n > 0n) {
    out = BS58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
