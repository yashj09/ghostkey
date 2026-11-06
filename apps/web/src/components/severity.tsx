import type { Severity, SurfaceId } from "@ghostkey/core";
import { KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const SEVERITY: Record<Severity, { label: string; icon: LucideIcon; text: string; bg: string; rank: number }> = {
  exposed: { label: "Exposed", icon: ShieldAlert, text: "text-sev-exposed", bg: "bg-sev-exposed/10 border-sev-exposed/30", rank: 0 },
  "protocol-only": { label: "Protocol-level", icon: KeyRound, text: "text-sev-protocol", bg: "bg-sev-protocol/10 border-sev-protocol/30", rank: 1 },
  conditional: { label: "Conditional", icon: ShieldQuestion, text: "text-sev-conditional", bg: "bg-sev-conditional/10 border-sev-conditional/30", rank: 2 },
  clear: { label: "Clear", icon: ShieldCheck, text: "text-sev-clear", bg: "bg-sev-clear/10 border-sev-clear/30", rank: 3 },
};

export const SURFACE: Record<SurfaceId, { n: number; title: string; blurb: string }> = {
  "direct-tx": { n: 1, title: "Direct transactions", blurb: "7702 keeps your old key a valid transaction signer." },
  redelegation: { n: 2, title: "7702 re-delegation", blurb: "The old key can replace your wallet code at any time." },
  "ecrecover-permit": { n: 3, title: "ecrecover-only permits", blurb: "DAI, UNI, AAVE… never ask your wallet; the old key signs." },
  "erc1271-sig": { n: 4, title: "Permit2 / ERC-1271 signatures", blurb: "Blocked while delegated, until the old key re-delegates." },
  "safe-owner": { n: 5, title: "Safe ownership", blurb: "Safe checks owner signatures with ecrecover." },
  "ens-roles": { n: 6, title: "ENS names & ENSv2 roles", blurb: "Resolver roles survive a name transfer, so the old key can redirect it." },
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const s = SEVERITY[severity];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", s.bg, s.text, className)}>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </span>
  );
}
