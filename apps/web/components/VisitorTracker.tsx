"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@/lib/wallet";
import { flush, setDetectedWallets, setVisible, shouldTrack, track } from "@/lib/visitor";

const CLICKABLE = "button, a, summary, [role='button'], [role='tab']";

function clickLabel(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(CLICKABLE);
  if (!el) return null;
  const text = el.getAttribute("aria-label") || (el as HTMLElement).innerText?.split("\n")[0] || el.getAttribute("title") || "";
  const label = text.trim().slice(0, 60);
  if (!label) return null;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") : null;
  return href && /^https?:/.test(href) ? `${label} ↗ ${new URL(href).hostname}` : label;
}

export function VisitorTracker() {
  const path = usePathname();
  const { status, publicKey, walletName, detected, error } = useWallet();
  const connected = useRef(false);

  useEffect(() => {
    if (!shouldTrack()) return;
    setVisible(document.visibilityState === "visible");

    const onClick = (e: MouseEvent) => {
      const label = clickLabel(e.target);
      if (label) track("click", label);
    };
    const onError = (e: ErrorEvent) => {
      const where = e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}` : "";
      track("error", `${e.message}${where}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason: unknown = e.reason;
      track("error", `Unhandled: ${reason instanceof Error ? reason.message : String(reason)}`);
    };
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      setVisible(visible);
      if (!visible) flush(true);
    };
    const onHide = () => {
      setVisible(false);
      flush(true);
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  useEffect(() => {
    track("page", `${path}${window.location.search}`);
  }, [path]);

  useEffect(() => {
    setDetectedWallets(detected);
  }, [detected]);

  useEffect(() => {
    if (status === "connected" && publicKey) {
      connected.current = true;
      track("wallet", `${walletName ?? "Wallet"} connected · ${publicKey.toBase58()}`);
    } else if (status === "disconnected" && connected.current) {
      connected.current = false;
      track("wallet", "disconnected");
    }
  }, [status, publicKey, walletName]);

  useEffect(() => {
    if (error) track("error", `Wallet: ${error}`);
  }, [error]);

  return null;
}
