import type { VaultCard } from "./collectorCrypt";

export const gradeLine = (c: VaultCard) => [c.gradingCompany, c.grade].filter(Boolean).join(" ") || "Ungraded";

export const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function titleParts(c: VaultCard) {
  const gradeNum = c.grade.match(/(\d+(?:\.\d+)?)\s*$/)?.[1] ?? null;
  const lead = c.name.match(/^(\d{4})\s+(?:(#\S+)\s+)?(.+)$/);
  let title = lead ? lead[3]! : c.name;
  if (c.gradingCompany && gradeNum) {
    const graded = new RegExp(`\\s*\\b${escapeRe(c.gradingCompany)}\\s+${escapeRe(gradeNum)}\\b`, "i");
    title = title.replace(graded, " ·").replace(/\s·\s*$/, "").replace(/^\s*·\s*/, "");
  }
  const kicker = [lead?.[1] ?? (c.year ? String(c.year) : null), lead?.[2]].filter(Boolean).join(" · ") || c.category;
  const grade = [c.gradingCompany, gradeNum ?? c.grade].filter(Boolean).join(" ") || "Ungraded";
  return { kicker, title: title.trim(), grade };
}

export function askOverAppraisal(c: VaultCard): string | null {
  if (c.askUsdc === null || c.insuredValueUsdc <= 0n) return null;
  const ratio = Number(c.askUsdc) / Number(c.insuredValueUsdc);
  if (ratio >= 2) return `${ratio.toFixed(1)}×`;
  const pct = Math.round((ratio - 1) * 100);
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%`;
}
