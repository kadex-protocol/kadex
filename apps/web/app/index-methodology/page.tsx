"use client";

import Link from "next/link";
import { CLUSTER } from "@/lib/cluster";
import { CONSTITUENTS, fmtBps, fmtPct, fmtPrice, fmtUsd, IS_SAMPLE } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import styles from "./page.module.css";

const basket = [...CONSTITUENTS].sort((a, b) => b.weightBps - a.weightBps);
const totalWeight = CONSTITUENTS.reduce((sum, card) => sum + card.weightBps, 0);
const priceSteps = [
  { number: "01", title: "A fixed basket", body: `${CONSTITUENTS.length} graded cards each have a published weight. The list does not change automatically.` },
  { number: "02", title: "Fractions trade", body: "Trades in the on-chain fraction pool establish the spot price. No person submits an official price." },
  { number: "03", title: "Time smooths it", body: "A 30-minute time-weighted average reduces the effect of a brief price move." },
  { number: "04", title: "The index updates", body: "A time-scaled clamp limits movement to 5% per 15 seconds. The result prices positions and the pool." },
];

export default function IndexPage() {
  const { data, loading, error } = useMarket();
  const capacity = data?.capacity;
  const usage = capacity ? Math.min(100, Math.max(0, Number(capacity.utilization) / 10_000)) : 0;
  const binding = capacity?.binding === "depth" ? "Pool depth" : "Liquid reserve";

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Inside the Kadex Index</p>
          <h1>One market for graded cards. <span>Here is how it works.</span></h1>
          <p className={styles.lede}>The index turns prices from a fixed basket of graded cards into one number you can trade. Its price comes from an on-chain pool, with limits designed to protect the market.</p>
          <nav className={styles.jump} aria-label="On this page">
            <a href="#price">How price works</a>
            <a href="#basket">The basket</a>
            <a href="#capacity">Trading limits</a>
          </nav>
        </div>
        <aside className={styles.priceCard} aria-label="Current index price">
          <div className={styles.priceTop}>
            <span className={styles.brandMark} aria-hidden="true" />
            <span>Kadex Index</span>
            <span className={styles.priceStatus}>{IS_SAMPLE ? "Preview" : data?.oracle.state ?? (loading ? "Loading" : "Unavailable")}</span>
          </div>
          <p className={styles.priceLabel}>Current index price</p>
          <p className={styles.priceValue}>{data ? fmtPrice(data.oracle.price) : "—"}</p>
          <p className={styles.priceNote}>{IS_SAMPLE ? "Sample price shown in preview mode" : error ? "Live price is temporarily unavailable" : "Read from the on-chain oracle"}</p>
          <div className={styles.priceFoot}><span>{CONSTITUENTS.length} cards in the basket</span><span>30-minute average</span></div>
        </aside>
      </header>

      <section className={styles.section} id="price" aria-labelledby="price-title">
        <div className={styles.sectionHead}>
          <div><p className={styles.eyebrow}>01 / Price</p><h2 id="price-title">From card trades to one index price</h2></div>
          <p>Follow the four steps behind the number shown on the trading screen.</p>
        </div>
        <ol className={styles.flow}>
          {priceSteps.map((step) => (
            <li key={step.number}><span className={styles.stepNumber}>{step.number}</span><h3>{step.title}</h3><p>{step.body}</p></li>
          ))}
        </ol>
        <p className={styles.callout}><strong>What the external feed does:</strong> recent card sales provide a sanity check. They do not set the index price. Anyone can refresh the on-chain price; there is no oracle signing key.</p>
      </section>

      <section className={styles.section} id="basket" aria-labelledby="basket-title">
        <div className={styles.sectionHead}>
          <div><p className={styles.eyebrow}>02 / Basket</p><h2 id="basket-title">The cards behind the index</h2></div>
          <p>Published weights total {fmtBps(totalWeight)}. A card enters through a whitelist; the basket does not rebalance itself.</p>
        </div>
        <div className={styles.basketGrid}>
          {basket.map((card) => (
            <article className={styles.basketCard} key={card.id}>
              {card.image ? <img src={card.image} alt="" loading="lazy" className={styles.cardImage} /> : <span className={styles.cardImage} />}
              <div className={styles.cardInfo}>
                <span className={styles.cardMeta}>{card.year} · {card.series} · {card.grade}</span>
                <h3>{card.name}</h3>
                <div className={styles.weightLine}><span>Index weight</span><strong>{fmtBps(card.weightBps)}</strong></div>
                <div className={styles.weightTrack} aria-hidden="true"><i style={{ width: `${Math.min(100, (card.weightBps / 1500) * 100)}%` }} /></div>
              </div>
            </article>
          ))}
        </div>
        {(CLUSTER?.network === "devnet" || CLUSTER?.network === "local") && (
          <p className={styles.smallNote}>On this test cluster, the index token is for demonstration. It is not backed by or redeemable for cards.</p>
        )}
      </section>

      <section className={styles.section} id="capacity" aria-labelledby="capacity-title">
        <div className={styles.sectionHead}>
          <div><p className={styles.eyebrow}>03 / Capacity</p><h2 id="capacity-title">How much can the market hold?</h2></div>
          <p>Trading capacity is the lower of two limits. The market cannot take more open positions just because one limit has room.</p>
        </div>
        <div className={styles.capacityLayout}>
          <div className={styles.capacityMain}>
            <span className={styles.cardMeta}>Capacity available now</span>
            <strong className={styles.capacityValue}>{capacity ? `$${fmtUsd(capacity.free, 2)}` : "—"}</strong>
            <p>of {capacity ? `$${fmtUsd(capacity.cap, 2)}` : "—"} total capacity remains open</p>
            <div className={styles.usageTrack} role="meter" aria-label="Open interest utilization" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage}><i style={{ width: `${usage}%` }} /></div>
            <div className={styles.usageLabels}><span>Open interest {capacity ? `$${fmtUsd(capacity.oiTotal, 2)}` : "—"}</span><strong>{capacity ? fmtPct(capacity.utilization, 1) : "—"} used</strong></div>
            <p className={styles.binding}>Current limiting factor: <strong>{capacity ? binding : "—"}</strong></p>
          </div>
          <div className={styles.limitList}>
            <article><span className={styles.limitIcon} aria-hidden="true">01</span><div><h3>Liquid reserve</h3><p>The pool must hold enough liquid assets to pay winning traders.</p></div><strong>{capacity ? `$${fmtUsd(capacity.capSolvency, 2)}` : "—"}</strong></article>
            <article><span className={styles.limitIcon} aria-hidden="true">02</span><div><h3>Pricing pool depth</h3><p>Moving the index far enough to force liquidations should cost more than it pays.</p></div><strong>{capacity ? `$${fmtUsd(capacity.capDepth, 2)}` : "—"}</strong></article>
          </div>
        </div>
        <p className={styles.smallNote}>Capacity figures use the current market snapshot. A stale or unavailable oracle can also prevent new trades, even when capacity remains.</p>
      </section>

      <section className={styles.footerCta} aria-label="Next steps">
        <div><p className={styles.eyebrow}>Ready to explore?</p><h2>See the index in action.</h2><p>Check the live chart and trading ticket, or see how the pool earns fees.</p></div>
        <div className={styles.footerActions}><Link href="/" className={styles.primaryAction}>Go to Trade</Link><Link href="/pool" className={styles.secondaryAction}>Explore Earn</Link></div>
      </section>
    </div>
  );
}
