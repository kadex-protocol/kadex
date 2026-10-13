"use client";

/**
 * The card vault — role 3 in docs/users.md.
 *
 * Mirrors programs/card-vault, including the two parts people get wrong:
 * whitelisting is admin-only (an open mint would let anyone price their own
 * collateral into the index), and redeeming the card burns the ENTIRE fraction
 * supply. Both are stated before the deposit button rather than after it.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { ArrowIcon } from "@/components/ArrowIcon";
import { fmtUsd, IS_SAMPLE } from "@/lib/market";
import type { CategoryGroup, MarketplaceSource, OrderBy } from "@kadex/collector-crypt";
import { SOLANA_ADDRESS, loadVaultCard, loadVaultCards, type VaultCard } from "@/lib/collectorCrypt";
import { askOverAppraisal, titleParts } from "@/lib/cardText";
import { useWallet } from "@/lib/wallet";
import { loadTestCards } from "@/lib/testCards";
import { VaultInventory } from "@/components/VaultInventory";
import { TestCards } from "@/components/TestCards";
import { TiltSlab } from "@/components/TiltSlab";
import { VaultBanner } from "@/components/HomeBanner";

const STEPS = [
  ["Graded and whitelisted", "A professional grade and an appraisal fix how many fractions the card is worth, and an admin whitelists the mint at that number. Permissioned on purpose: an open mint would let anyone price their own collateral into an index other people's positions settle against."],
  ["You deposit it", "The NFT representing custody moves into a program escrow and the vault mints exactly the whitelisted number of fractions — never a number chosen at deposit time. The card is locked for as long as those fractions exist."],
  ["The fractions are yours", "Hold them, provide liquidity with them, or deposit them into the CLP pool for a share of trading fees. Ordinary tokens with six decimals, priced one to one against a dollar at parity."],
  ["Getting the card back", "Redemption burns the entire fraction supply and returns the NFT. If you have sold or deposited any of them, you have to buy them all back first. This is the real cost of fractionalising something indivisible."],
] as const;

const FORMATS = [
  ["market", "Market"],
  ["sheet", "Sheet"],
  ["gallery", "Gallery"],
  ["spec", "Spec"],
  ["list", "List"],
  ["compact", "Compact"],
] as const;

type Format = (typeof FORMATS)[number][0];

const GROUPS: readonly (readonly [CategoryGroup | null, string, string])[] = [
  [null, "Cards", "all"],
  ["pokemon", "Pokémon", "monsters"],
  ["one-piece", "One Piece", "pirates"],
  ["tcg", "Other TCG", "tcg"],
  ["sports", "Sports", "sports"],
];

const SORTS: readonly (readonly [OrderBy, string])[] = [
  ["listedDateDesc", "Newest listing"],
  ["listedDateAsc", "Oldest listing"],
  ["listedPriceAsc", "Ask: low to high"],
  ["listedPriceDesc", "Ask: high to low"],
  ["nameAsc", "Name: A to Z"],
  ["yearAsc", "Year: oldest"],
  ["yearDesc", "Year: newest"],
];

const FORMAT_KEY = "kadex.vault.format.v2";
const isFormat = (v: string | null): v is Format => FORMATS.some(([id]) => id === v);

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not reach Collector Crypt.");

function pagerItems(current: number, known: number): (number | null)[] {
  const shown = new Set([0, known - 1, current - 1, current, current + 1]);
  const items: (number | null)[] = [];
  for (let i = 0; i < known; i += 1) {
    if (!shown.has(i)) continue;
    if (items.length > 0 && items[items.length - 1] !== i - 1) items.push(null);
    items.push(i);
  }
  return items;
}

function CardItem({ card: c, format, mine, availability }: { card: VaultCard; format: Format; mine: boolean; availability: string | null }) {
  const [back, setBack] = useState(false);
  const t = titleParts(c);
  const market = format === "market";
  const listed = c.askUsdc !== null;
  const faces = market && c.frontImage && c.backImage ? [c.frontImage, c.backImage] : [];
  const flip = (e: MouseEvent, toBack: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setBack(toBack);
  };
  return (
    <Link
      href={`/vault/${c.nftAddress}`}
      className="vcard"
      aria-label={`${c.name}, appraised at $${fmtUsd(c.insuredValueUsdc)}`}
    >
      <span className="v-grade"><span className="l">Grade</span>{t.grade}</span>
      <b className="v-value"><span className="l">Appraised</span>${fmtUsd(c.insuredValueUsdc)}</b>
      <div className="v-shot">
        <TiltSlab src={faces.length > 0 && back ? c.backImage : c.frontImage} still={format === "list"} />
        {faces.length > 0 && (
          <span className="v-faces">
            {faces.map((src, i) => (
              <button key={src} type="button" aria-label={i === 1 ? "Show back" : "Show front"} data-on={back === (i === 1)} onClick={(e) => flip(e, i === 1)}>
                <img src={src} alt="" loading="lazy" />
              </button>
            ))}
          </span>
        )}
      </div>
      <span className="v-kick">{market ? c.category || t.kicker : t.kicker}{availability && ` · ${availability}`}</span>
      <span className="v-name">{market ? c.name : t.title}</span>
      <span className="v-ask" data-listed={listed}>
        <span className="l">{market ? (listed ? "Listed" : "Not listed") : "Ask"}</span>
        {listed ? `$${fmtUsd(c.askUsdc!)}` : market ? "" : "—"}
      </span>
      <span className="v-delta"><span className="l">Ask / appraisal</span>{askOverAppraisal(c) ?? "—"}</span>
      {mine && <span className="v-mine">Yours</span>}
    </Link>
  );
}

function GhostItem() {
  return (
    <div className="vcard ghost" aria-hidden="true">
      <span className="v-grade">—</span>
      <b className="v-value">—</b>
      <div className="v-shot"><span className="vblank" /></div>
      <span className="v-kick">—</span>
      <span className="v-name">Loading</span>
      <span className="v-ask">—</span>
      <span className="v-delta">—</span>
    </div>
  );
}

export default function VaultPage() {
  const { status, publicKey } = useWallet();
  const [cards, setCards] = useState<VaultCard[]>([]);
  const [banner, setBanner] = useState<VaultCard[]>([]);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [format, setFormat] = useState<Format>("market");
  const [filters, setFilters] = useState(false);
  const [group, setGroup] = useState<CategoryGroup | null>(null);
  const [sort, setSort] = useState<OrderBy>("listedDateDesc");
  const [source, setSource] = useState<MarketplaceSource | null>(null);
  const [askMin, setAskMin] = useState("");
  const [askMax, setAskMax] = useState("");
  const [range, setRange] = useState({ min: "", max: "" });
  const [counts, setCounts] = useState<{ total: number; groups: Record<CategoryGroup, number> } | null>(null);
  const [returnedCount, setReturnedCount] = useState<number | null>(null);
  const [twinAddresses, setTwinAddresses] = useState<Set<string> | null>(null);
  const [testCardsError, setTestCardsError] = useState(false);
  const [testCardsVersion, setTestCardsVersion] = useState(0);
  const request = useRef(0);

  const connected = status === "connected" && publicKey !== null;
  const wallet = publicKey?.toBase58() ?? null;
  const owner = mineOnly && connected ? wallet : null;
  const direct = SOLANA_ADDRESS.test(search);

  useEffect(() => {
    if (connected) return;
    setMineOnly(false);
  }, [connected]);

  useEffect(() => {
    if (IS_SAMPLE) return;
    let live = true;
    setTwinAddresses(null);
    setTestCardsError(false);
    loadTestCards()
      .then((list) => live && setTwinAddresses(new Set(list.map((card) => card.mainnet))))
      .catch(() => live && setTestCardsError(true));
    return () => {
      live = false;
    };
  }, [testCardsVersion]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FORMAT_KEY);
      if (isFormat(saved)) setFormat(saved);
    } catch {}
  }, []);

  const chooseFormat = (next: string) => {
    if (!isFormat(next)) return;
    setFormat(next);
    try {
      window.localStorage.setItem(FORMAT_KEY, next);
    } catch {}
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setRange((r) => (r.min === askMin && r.max === askMax ? r : { min: askMin, max: askMax }));
    }, 350);
    return () => clearTimeout(t);
  }, [query, askMin, askMax]);

  const loadPage = useCallback(
    async (index: number, from: string | null) => {
      const id = ++request.current;
      setLoading(true);
      setError(null);
      setCards([]);
      setReturnedCount(null);
      setPage(index);
      try {
        const result = SOLANA_ADDRESS.test(search)
          ? { cards: [await loadVaultCard(search)], nextCursor: null, total: 1, returnedCount: 1, groups: null }
          : await loadVaultCards(from, { search, owner, group, sort, source, askMin: range.min, askMax: range.max });
        if (id !== request.current) return;
        setCards(result.cards.filter((c, i, all) => all.findIndex((o) => o.nftAddress === c.nftAddress) === i));
        setReturnedCount(result.returnedCount);
        setCursors((prev) => {
          const known = index === 0 ? [] : prev.slice();
          known[index] = from;
          if (result.nextCursor) known[index + 1] = result.nextCursor;
          else known.length = index + 1;
          return known;
        });
        setBanner((shown) => (shown.length > 0 ? shown : result.cards));
        if (result.groups) setCounts({ total: result.total, groups: result.groups });
      } catch (e) {
        if (id === request.current) {
          setError(message(e));
          if (SOLANA_ADDRESS.test(search)) setReturnedCount(0);
        }
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [search, owner, group, sort, source, range],
  );

  useEffect(() => {
    void loadPage(0, null);
  }, [loadPage]);

  const goTo = (index: number) => {
    if (index < 0 || index >= cursors.length || index === page || loading) return;
    void loadPage(index, cursors[index] ?? null);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const named = search !== "" && !direct;
  const groupLabel = direct ? "Address result" : GROUPS.find(([id]) => id === group)?.[1] ?? "Cards";

  return (
    <div className="page vmkt">
      <VaultBanner cards={banner} />

      <VaultInventory />

      <TestCards />

      <header className="vmkt-head">
        <h1>
          Vault: <span>{groupLabel}</span>
        </h1>
        <p className="vmkt-total">
          {direct ? "Search results" : "Cards returned"} <b>{returnedCount !== null ? returnedCount.toLocaleString("en-US") : "—"}</b>
        </p>
      </header>

      <div className="vmkt-bar">
        <button
          type="button"
          className="vmkt-ico"
          aria-label="Filters"
          aria-pressed={!direct && filters}
          disabled={direct}
          onClick={() => setFilters((f) => !f)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M3 5h12M5.5 9h7M8 13h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <label className="vmkt-search">
          <input
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search cards by name, or paste a card address"
            aria-label="Search cards"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.5" />
            <path d="m12 12 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </label>
        <select className="vmkt-select" aria-label="Sort by" value={sort} disabled={direct} onChange={(e) => setSort(e.target.value as OrderBy)}>
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <button className="vmkt-select" type="button" aria-pressed={!direct && connected && mineOnly} disabled={direct || !connected} onClick={() => setMineOnly((m) => !m)}>
          Only mine
        </button>
        <select className="vmkt-select narrow" aria-label="Listing format" value={format} onChange={(e) => chooseFormat(e.target.value)}>
          {FORMATS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      {filters && !direct && (
        <div className="vfilters">
          <label className="field">
            <span>Ask from · USDC</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={askMin}
              onChange={(e) => setAskMin(e.target.value.replace(/[^0-9.]/g, ""))}
            />
          </label>
          <label className="field">
            <span>Ask to · USDC</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="Any"
              value={askMax}
              onChange={(e) => setAskMax(e.target.value.replace(/[^0-9.]/g, ""))}
            />
          </label>
          <label className="field">
            <span>Listed on</span>
            <select value={source ?? ""} onChange={(e) => setSource((e.target.value || null) as MarketplaceSource | null)}>
              <option value="">Any marketplace</option>
              <option value="CC">Collector Crypt</option>
              <option value="ME">Magic Eden</option>
            </select>
          </label>
        </div>
      )}

      <div className="vmkt-cats" role="group" aria-label="Card category" ref={top}>
        {GROUPS.map(([id, label, icon]) => {
          const n = !direct && counts ? (id === null ? counts.total : counts.groups[id]) : null;
          return (
            <button key={label} type="button" aria-pressed={!direct && group === id} disabled={direct} onClick={() => setGroup(id)}>
              <img src={`/cats/${icon}.png`} alt="" width={34} height={34} />
              <b>{id === null ? "All" : label}</b>
              <span title="Listings on Collector Crypt">{n !== null ? n.toLocaleString("en-US") : "—"}</span>
            </button>
          );
        })}
      </div>

      <p className="vmkt-note">
        {loading && cards.length === 0 ? "Loading" : `${cards.length} shown`}
        {cursors.length > 1 && ` · page ${page + 1}`}
        {mineOnly && connected && !direct && " · your wallet"}
        {named && <> · <q>{search}</q></>}
        {" · value is the appraisal, in USDC"}
      </p>

      {testCardsError && (
        <p className="hint bad" role="alert">
          Could not read test cards. <button className="btn" type="button" onClick={() => setTestCardsVersion((v) => v + 1)}>Try again</button>
        </p>
      )}

      <div className="vsheet">
        {!loading && !error && cards.length === 0 ? (
          <div className="empty">
            <h3>No cards found</h3>
            <p>
              {mineOnly
                ? "This wallet has no Core cards listed on Collector Crypt."
                : named
                  ? `Nothing listed on Collector Crypt matches “${search}”.`
                  : "No Core cards on this page of the marketplace."}
            </p>
          </div>
        ) : error && cards.length === 0 ? (
          <div className="empty" role="alert">
            <h3>Could not load cards</h3>
            <p>{error}</p>
            <button className="btn" type="button" onClick={() => void loadPage(page, cursors[page] ?? null)}>Try again</button>
          </div>
        ) : (
          <>
            {format === "list" && (
              <div className="vlist-head" aria-hidden="true">
                <span />
                <span>Card</span>
                <span>Grade</span>
                <span>Appraised</span>
                <span>Ask</span>
                <span>Premium</span>
              </div>
            )}
            <div className={`vgrid ${format}`} aria-busy={loading}>
              {cards.map((c) => (
                <CardItem key={c.nftAddress} card={c} format={format} mine={c.ownerWallet === wallet} availability={IS_SAMPLE ? null : testCardsError ? "Test cards unavailable" : twinAddresses === null ? "Checking cluster" : twinAddresses.has(c.nftAddress) ? "Test copy available" : "View only"} />
              ))}
              {loading && Array.from({ length: 8 }, (_, i) => <GhostItem key={i} />)}
            </div>
          </>
        )}
        {cursors.length > 1 && (
          <nav className="vpager" aria-label="Pages">
            <button type="button" className="step" disabled={page === 0 || loading} onClick={() => goTo(page - 1)}>
              <span aria-hidden="true">‹</span> Previous
            </button>
            <ol>
              {pagerItems(page, cursors.length).map((item, i) =>
                item === null ? (
                  <li key={`gap-${i}`} aria-hidden="true">…</li>
                ) : (
                  <li key={item}>
                    <button type="button" aria-current={item === page ? "page" : undefined} disabled={loading && item !== page} onClick={() => goTo(item)}>
                      {item + 1}
                    </button>
                  </li>
                ),
              )}
            </ol>
            <button type="button" className="step" disabled={page >= cursors.length - 1 || loading} onClick={() => goTo(page + 1)}>
              Next <span aria-hidden="true">›</span>
            </button>
          </nav>
        )}
      </div>

      <section className="panel faq vmkt-faq">
        <h2 className="title sm" style={{ marginBottom: 6 }}>How vaulting works</h2>
        {STEPS.map(([h, body], i) => (
          <details className="acc" key={h} open={i === 3}>
            <summary>{i + 1} · {h}</summary>
            <p>{body}</p>
          </details>
        ))}
        <p className="sub">
          Open a card to vault it. Already have fractions? <Link href="/pool" className="link">Deposit them to earn <ArrowIcon /></Link>
        </p>
      </section>
    </div>
  );
}
