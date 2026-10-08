import { NextResponse, type NextRequest } from "next/server";
import {
  categoryGroup,
  fetchMarketplacePage,
  groupCounts,
  isCategoryGroup,
  isMarketplaceSource,
  isOrderBy,
  isVaultable,
  type CollectorCard,
} from "@slab/collector-crypt";
import { SOLANA_ADDRESS, toWire, type MarketplaceWire } from "@/lib/collectorCrypt";

const cached: typeof fetch = (input, init) => fetch(input, { ...init, next: { revalidate: 60 } });

const GROUP_STEP = 500;
const GROUP_MIN_CARDS = 24;
const GROUP_MAX_PAGES = 5;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const search = q.get("search")?.trim().slice(0, 80) || undefined;
  const owner = q.get("owner") ?? undefined;
  const requested = q.get("group");
  const group = isCategoryGroup(requested) ? requested : null;
  const sort = q.get("sort");
  const source = q.get("source");
  const price = (key: string) => {
    const n = Number(q.get(key) ?? "");
    return q.get(key) && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const listing = {
    orderBy: isOrderBy(sort) ? sort : undefined,
    marketplaceSource: isMarketplaceSource(source) ? source : undefined,
    listPriceMin: price("min"),
    listPriceMax: price("max"),
  };
  if (owner !== undefined && !SOLANA_ADDRESS.test(owner)) {
    return NextResponse.json({ error: "That is not a Solana address." }, { status: 400 });
  }
  try {
    const cards: CollectorCard[] = [];
    let cursor = q.get("cursor");
    let total = 0;
    let counts: Record<string, number> = {};
    for (let fetched = 0; fetched < (group ? GROUP_MAX_PAGES : 1); fetched += 1) {
      const page = await fetchMarketplacePage(
        cursor,
        { fetch: cached },
        { ...listing, search, ownerAddress: owner, step: group ? GROUP_STEP : undefined },
      );
      cards.push(...page.cards.filter((c) => isVaultable(c) && (!group || categoryGroup(c.category) === group)));
      cursor = page.nextCursor;
      total = page.total;
      counts = page.categoryCounts;
      if (!cursor || cards.length >= GROUP_MIN_CARDS) break;
    }
    const body: MarketplaceWire = {
      cards: cards.map(toWire),
      nextCursor: cursor,
      total,
      groups: groupCounts(counts),
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Collector Crypt is unreachable." },
      { status: 502 },
    );
  }
}
