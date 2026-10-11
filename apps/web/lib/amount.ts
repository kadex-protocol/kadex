const SCALE = 1_000_000n;
const MAX_UNITS = 1_000_000_000_000_000n;

export function parseAmount(text: string): bigint | null {
  if (text === "") return 0n;
  if (!/^\d+(?:\.\d{0,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const digits = whole!.replace(/^0+/, "") || "0";
  if (digits.length > 10) return null;
  const units = BigInt(digits) * SCALE + BigInt(fraction.padEnd(6, "0"));
  return units <= MAX_UNITS ? units : null;
}

export function formatAmount(units: bigint): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
