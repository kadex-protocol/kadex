"use client";

import { BRAND } from "@/lib/brand";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  borrowSpread, fmtPct, fmtUsd, HISTORY_STEP_SECS, IS_SAMPLE, loadIndexHistory, loadPortfolio, loadPositions, priceAt,
  type IndexPoint, type Portfolio,
} from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { useWallet } from "@/lib/wallet";
import type { PositionView } from "@kadex/types";
import { AccountPanel } from "@/components/AccountPanel";
import { loadVaultCards, type VaultCard } from "@/lib/collectorCrypt";
import { CardRail } from "@/components/CardRail";
import { focusTicket, HomeBanner } from "@/components/HomeBanner";
import { HowItWorks } from "@/components/HowItWorks";
import { IndexChart } from "@/components/IndexChart";
import { LivePrice } from "@/components/LiveChart";
import { TradeTicket } from "@/components/TradeTicket";

const CARDS_SHOWN = 24;

export default function HomePage() {
  const { data, loading, error, reload } = useMarket();
  const [positions, setPositions] = useState<PositionView[]>([]);
  const { publicKey } = useWallet();
  const [history, setHistory] = useState<IndexPoint[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [cards, setCards] = useState<VaultCard[]>([]);
  const [cardsFailed, setCardsFailed] = useState(false);
  const [cardsVersion, setCardsVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setCardsFailed(false);
    loadVaultCards(null, { search: "", owner: null, group: null })
      .then((page) => {
        if (live) setCards(page.cards.slice(0, CARDS_SHOWN));
      })
      .catch(() => {
        if (live) setCardsFailed(true);
      });
    return () => {
      live = false;
    };
  }, [cardsVersion]);

  useEffect(() => {
    let live = true;
    loadPortfolio(publicKey).then((p) => live && setPortfolio(p)).catch(() => live && setPortfolio(null));
    return () => {
      live = false;
    };
  }, [publicKey, data]);

  useEffect(() => {
    if (!data) return;
    let live = true;
    loadIndexHistory(data).then((points) => live && setHistory(points)).catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [data]);

  useEffect(() => {
    let live = true;
    loadPositions(publicKey, data).then((list) => live && setPositions(list)).catch(() => live && setPositions([]));
    return () => {
      live = false;
    };
  }, [publicKey, data]);

  const markAt = useCallback((ts: number) => priceAt(data, ts), [data]);
  const spread = data ? borrowSpread(data) : null;
  const dayChange =
    history.length > 1
      ? (Number(history[history.length - 1]!.price - history[0]!.price) / Number(history[0]!.price)) * 100
      : null;
  const changeSpan = history.length > 1 ? history[history.length - 1]!.ts - history[0]!.ts : 0;
  const changeLabel = changeSpan >= 86_400 - HISTORY_STEP_SECS
    ? "24h change"
    : `Change (${Math.floor(changeSpan / 3600) > 0 ? `${Math.floor(changeSpan / 3600)}h${Math.floor(changeSpan / 60) % 60 ? ` ${Math.floor(changeSpan / 60) % 60}m` : ""}` : `${Math.floor(changeSpan / 60)}m`})`;
  const oracleOk = data?.oracle.state === "ok";
  const marketAvailable = !loading && !error && !!data && data.marketInitialized &&
    data.pool.state === "active" && (data.oracle.state === "ok" || data.oracle.state === "stale") &&
    data.capacity.free > 0n;

  return (
    <div className="page home">
      <div className="dash">
        <div className="col">
          <HomeBanner cards={cards} marketAvailable={marketAvailable} />

          <IndexChart
            points={history}
            priceAt={markAt}
            head={
              <p className="chart-pair">
                <span className="mark" aria-hidden="true"><span className="star" /></span>
                {BRAND} Index {data && <span className="lev">{Number(data.pool.params.baseLeverage) / 1e6}x</span>}
              </p>
            }
            stats={
              <dl className="chart-stats">
                <div className="lead"><dt>Mark</dt><dd><LivePrice priceAt={markAt} /></dd></div>
                <div className="chg">
                  <dt>{changeLabel}</dt>
                  <dd className={dayChange === null ? undefined : dayChange >= 0 ? "up" : "down"}>
                    {dayChange === null ? "-" : `${dayChange >= 0 ? "+" : "−"}${Math.abs(dayChange).toFixed(2)}%`}
                  </dd>
                </div>
                <div><dt>Open interest</dt><dd>{data ? `$${fmtUsd(data.market.oiLong + data.market.oiShort, 2)}` : "-"}</dd></div>
                <div><dt>Capacity left</dt><dd>{data ? `$${fmtUsd(data.capacity.free, 2)}` : "-"}</dd></div>
                <div className="util">
                  <dt>Utilisation</dt>
                  <dd>
                    {data ? fmtPct(data.capacity.utilization, 1) : "-"}
                    <span className="meter"><i style={{ width: data ? fmtPct(data.capacity.utilization, 1) : "0%" }} /></span>
                  </dd>
                </div>
                <div>
                  <dt>Borrow / month</dt>
                  <dd>
                    {spread ? (
                      <>
                        <span className={spread.crowded === "long" ? "down" : "up"}>L {spread.longMonthly.toFixed(2)}%</span>
                        {" · "}
                        <span className={spread.crowded === "short" ? "down" : "up"}>S {spread.shortMonthly.toFixed(2)}%</span>
                      </>
                    ) : "-"}
                  </dd>
                </div>
              </dl>
            }
          />

          <AccountPanel portfolio={portfolio} positions={positions} snapshot={data} onTrade={focusTicket} onClosed={reload} />

          <CardRail cards={cards} failed={cardsFailed} onRetry={() => setCardsVersion((v) => v + 1)} />
        </div>

        {loading ? (
          <aside className="panel ticket"><p className="sub">Reading market state…</p></aside>
        ) : error || !data ? (
          <aside className="panel ticket">
            <h2 className="title sm">Market unavailable</h2>
            <p className="sub">{error ?? "Market state could not be read."}</p>
            <p className="fine">Trading is disabled until the market can be priced.</p>
          </aside>
        ) : (
          <TradeTicket snapshot={data} onOpened={reload} />
        )}
      </div>

      <HowItWorks cards={cards} data={data} onTrade={focusTicket} />

      <footer className="statusbar">
        <span>
          <i className={oracleOk ? "up" : "down"} /> Oracle {data?.oracle.state ?? "-"}
          <i className="up" /> Solana
          {IS_SAMPLE && <em>Preview · sample data</em>}
        </span>
        <span>
          <Link href="/index-methodology">Index methodology</Link>
          <Link href="/pool">Earn</Link>
          <Link href="/vault">Vault</Link>
        </span>
      </footer>
    </div>
  );
}
