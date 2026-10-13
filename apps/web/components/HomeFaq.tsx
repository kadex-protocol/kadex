"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IS_SAMPLE } from "@/lib/market";
import { USD_LABEL } from "@/lib/cluster";
import styles from "./HomeFaq.module.css";

const questions = [
  {
    question: "What am I trading?",
    answer: "One index tracking a fixed basket of graded cards. A long or short position follows the index price; it does not give you ownership of an individual card.",
  },
  {
    question: "How is the index priced?",
    answer: "Card fractions trade in an on-chain pool. Their price is smoothed over a 30-minute window, then limited by a time-scaled clamp. External card sales are a safety check, not the price source.",
  },
  {
    question: "What is the risk of a trade?",
    answer: "Perpetual positions use margin. A move against your position can liquidate it and you can lose all of that margin. Check the liquidation price in the ticket before opening.",
  },
  {
    question: "How does Earn work?",
    answer: `You can deposit ${USD_LABEL} or eligible card fractions for CLP pool shares. The pool collects fees, takes the other side of trades, and its value can rise or fall with trader results.`,
  },
  {
    question: "What happens when I vault a card?",
    answer: "An eligible graded card is held in the vault and you receive fractions. To redeem the card, you must hold and return the full fraction supply.",
  },
];

export function HomeFaq() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <>
      <button type="button" className={`panel ${styles.trigger}`} aria-label="Open help and frequently asked questions" aria-haspopup="dialog" onClick={() => setOpen(true)}>?</button>
      <dialog ref={dialog} className={`panel ${styles.dialog}`} aria-labelledby="home-faq-title" onClose={() => setOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <div className={styles.content}>
          <header className={styles.header}>
            <div><span className={styles.kicker}>Quick answers</span><h2 id="home-faq-title">How can we help?</h2><p>The essentials about Trade, Earn and Vault.</p></div>
            <button type="button" className={styles.close} aria-label="Close help" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className={styles.questions}>
            {questions.map(({ question, answer }) => (
              <details key={question}><summary>{question}</summary><p>{answer}</p></details>
            ))}
            <details><summary>Is this using real money?</summary><p>{IS_SAMPLE ? "This preview uses a simulated browser ledger. Nothing is signed or settled on-chain." : "This screen reads the configured Solana cluster. Check the network and token shown in your wallet before signing a transaction."}</p></details>
          </div>
          <div className={styles.links}><Link href="/index-methodology" onClick={() => setOpen(false)}>How the index works</Link><Link href="/pool" onClick={() => setOpen(false)}>Explore Earn</Link><Link href="/vault" onClick={() => setOpen(false)}>Explore Vault</Link></div>
        </div>
      </dialog>
    </>
  );
}
