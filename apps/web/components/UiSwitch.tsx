"use client";

import { useEffect, useState } from "react";

export const UI_KEY = "slab.skin.v2";

const SKINS = [
  { id: "magenta", label: "Magenta" },
  { id: "amber", label: "Amber" },
  { id: "ember", label: "Ember" },
  { id: "terminal", label: "Terminal" },
  { id: "cobalt", label: "Cobalt" },
  { id: "midnight", label: "Midnight" },
  { id: "vault", label: "Vault" },
  { id: "mint", label: "Mint" },
  { id: "mono", label: "Mono" },
  { id: "paper", label: "Paper" },
  { id: "daylight", label: "Daylight" },
  { id: "wireframe", label: "Wire" },
] as const;

type Skin = (typeof SKINS)[number]["id"];

const isSkin = (v: string | null | undefined): v is Skin => SKINS.some((s) => s.id === v);

export function UiSwitch() {
  const [skin, setSkin] = useState<Skin>("ember");

  useEffect(() => {
    const current = document.documentElement.dataset.ui;
    if (isSkin(current)) setSkin(current);
  }, []);

  const choose = (next: string) => {
    if (!isSkin(next)) return;
    setSkin(next);
    document.documentElement.dataset.ui = next;
    try {
      window.localStorage.setItem(UI_KEY, next);
    } catch {}
  };

  return (
    <label className="gear" title="Interface style">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
      <select className="ui-switch" aria-label="Interface style" value={skin} onChange={(e) => choose(e.target.value)}>
        {SKINS.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
    </label>
  );
}
