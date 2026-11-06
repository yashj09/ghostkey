import { formatUnits, type Address } from "viem";

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdFmtCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function formatUsd(v: number | undefined, cents = false): string {
  if (v === undefined || Number.isNaN(v)) return "n/a";
  return (cents ? usdFmtCents : usdFmt).format(v);
}

export function formatAmount(amount: bigint, decimals: number, maxFrac = 4): string {
  const s = formatUnits(amount, decimals);
  const [i, f = ""] = s.split(".");
  const int = Number(i).toLocaleString("en-US");
  const frac = f.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function shortAddr(a: Address | string, n = 4): string {
  return a.length <= 2 + 2 * n ? a : `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}
