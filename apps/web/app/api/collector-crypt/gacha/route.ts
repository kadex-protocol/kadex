import { NextResponse } from "next/server";
import { fetchGachaMachines, fetchGachaStock, type GachaMachine, type TierCount } from "@kadex/collector-crypt";

/**
 * Collector Crypt gacha machines and stock, server side.
 *
 * The key (`COLLECTOR_CRYPT_GACHA_API_KEY`) never leaves this process: with it
 * the route reads your machines from `/api/v1/*`; without it, the public house
 * machines. `scope` in the response says which one you got.
 */

export const dynamic = "force-dynamic";

const cached: typeof fetch = (input, init) => fetch(input, { ...init, next: { revalidate: 30 } });

type Tiers<T> = Record<string, T>;

export interface GachaMachineWire {
  code: string;
  name: string;
  shortName: string;
  category: string | null;
  priceUsdc: string;
  evUsdc: string;
  contains: number;
  instantBuybackPct: number;
  fixedEv: boolean;
  public: boolean;
  isPartner: boolean;
  owner: string | null;
  enabled: boolean | null;
  flags: Record<string, boolean>;
  odds: Tiers<number>;
  tierRanges: Tiers<{ startUsdc: string; endUsdc: string }>;
  stock: Tiers<TierCount>;
}

export interface GachaWire {
  scope: "mine" | "house";
  machines: GachaMachineWire[];
  /** Stock from the stock endpoint, which carries the low-stock buffer when keyed. */
  stock: Record<string, Tiers<TierCount>>;
  rejected: { code: string; reason: string }[];
}

const toWire = (m: GachaMachine): GachaMachineWire => ({
  ...m,
  priceUsdc: m.priceUsdc.toString(),
  evUsdc: m.evUsdc.toString(),
  tierRanges: Object.fromEntries(
    Object.entries(m.tierRanges).map(([tier, r]) => [tier, { startUsdc: r.startUsdc.toString(), endUsdc: r.endUsdc.toString() }]),
  ),
});

export async function GET() {
  try {
    const [machines, stock] = await Promise.all([fetchGachaMachines({ fetch: cached }), fetchGachaStock({ fetch: cached })]);
    const body: GachaWire = {
      scope: machines.scope,
      machines: machines.machines.map(toWire),
      stock: stock.byMachine,
      rejected: [...machines.rejected, ...stock.rejected],
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error("Collector Crypt gacha request failed:", e);
    return NextResponse.json({ error: "Collector Crypt gacha is unreachable." }, { status: 502 });
  }
}
