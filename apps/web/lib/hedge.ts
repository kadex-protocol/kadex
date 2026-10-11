import { WAD } from "@kadex/types";
import { borrowSpread, quote, type MarketSnapshot } from "@/lib/market";

export interface HedgeLimits {
  maxNotional: bigint;
  maxMonthlyCost: bigint;
}

export type HedgeBound =
  | "inventory"
  | "maximum notional"
  | "maximum monthly cost"
  | "market capacity";

export interface HedgeSuggestionResult {
  notional: bigint;
  hedgeRatio: bigint;
  margin: bigint;
  monthlyBorrowCost: bigint;
  liquidationPrice: bigint;
  bound: HedgeBound;
  problem: string | null;
}

export function suggestHedge(
  inBasketValue: bigint,
  outsideBasketValue: bigint,
  snapshot: MarketSnapshot,
  limits: HedgeLimits,
): HedgeSuggestionResult {
  const inventory = inBasketValue + outsideBasketValue;
  const spread = borrowSpread(snapshot);
  const monthlyRate = snapshot.borrow.short * 720n;
  const monthlyCostCap =
    spread.shortMonthly > 0 && monthlyRate > 0n
      ? (limits.maxMonthlyCost * WAD) / monthlyRate
      : inventory;
  const candidates: { value: bigint; bound: HedgeBound }[] = [
    { value: inventory, bound: "inventory" },
    { value: limits.maxNotional, bound: "maximum notional" },
    { value: monthlyCostCap, bound: "maximum monthly cost" },
    { value: snapshot.capacity.free, bound: "market capacity" },
  ];
  const binding = candidates.reduce((smallest, candidate) =>
    candidate.value < smallest.value ? candidate : smallest,
  );
  const notional = binding.value > 0n ? binding.value : 0n;
  const order = quote(snapshot, "short", notional);

  return {
    notional,
    hedgeRatio: inventory > 0n ? (notional * WAD) / inventory : 0n,
    margin: order.margin,
    monthlyBorrowCost:
      notional > 0n ? (notional * monthlyRate + WAD - 1n) / WAD : 0n,
    liquidationPrice: order.liquidationPrice,
    bound: binding.bound,
    problem: order.problem,
  };
}
