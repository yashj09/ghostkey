import type { Finding, ResidualReport } from "@ghostkey/core";
import { Check, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAmount, formatUsd, shortAddr } from "@/lib/format";
import { SEVERITY, SURFACE, SeverityBadge } from "./severity";

export function Headline({ report }: { report: ResidualReport }) {
  const { account } = report;
  const safe = report.usdControlledByOldKey < 0.5 && report.usdConditional < 0.5;
  return (
    <Card>
      <CardHeader>
        <CardDescription className="font-mono">
          {shortAddr(account.address, 6)} · block {report.blockNumber.toString()}
          {account.delegatedTo ? ` · 7702 → ${shortAddr(account.delegatedTo)}` : " · plain EOA"}
          {account.killswitch !== undefined ? ` · killswitch ${account.killswitch ? "ON" : "off"}` : ""}
        </CardDescription>
        <CardTitle className="text-base font-medium text-muted-foreground">Still controlled by your old ECDSA key</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <div className={`text-5xl font-bold tracking-tight tabular-nums sm:text-6xl ${safe ? "text-sev-clear" : "text-sev-exposed"}`}>
          {formatUsd(report.usdControlledByOldKey)}
        </div>
        {report.usdConditional > 0.5 && (
          <div className="pb-1.5">
            <div className="text-2xl font-semibold tabular-nums text-sev-conditional">+{formatUsd(report.usdConditional)}</div>
            <div className="text-sm text-muted-foreground">one old-key action away (re-delegation)</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Assets({ f }: { f: Finding }) {
  if (f.assets.length === 0) return <span className="text-muted-foreground">nothing at risk</span>;
  return (
    <ul className="space-y-0.5 font-mono text-sm">
      {f.assets.slice(0, 6).map((a, i) => (
        <li key={i}>
          {a.kind === "erc20" || a.kind === "eth" ? `${formatAmount(a.amount, a.decimals)} ${a.symbol}` : a.symbol}
          {a.note && <span className="text-muted-foreground"> · {a.note}</span>}
        </li>
      ))}
      {f.assets.length > 6 && <li className="text-muted-foreground">+{f.assets.length - 6} more</li>}
    </ul>
  );
}

export function FindingsTable({ report }: { report: ResidualReport }) {
  const rows = [...report.findings].sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank || SURFACE[a.surface].n - SURFACE[b.surface].n);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Residual authority, surface by surface</CardTitle>
        <CardDescription>Every way the old key can still move value or identity after your migration.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[30%]">Surface</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>At risk</TableHead>
              <TableHead className="text-right">USD</TableHead>
              <TableHead className="text-center">Fix today</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((f, i) => (
              <TableRow key={`${f.surface}-${i}`} className="align-top">
                <TableCell className="whitespace-normal">
                  <div className="font-medium">
                    <span className="mr-1.5 text-muted-foreground tabular-nums">{SURFACE[f.surface].n}.</span>
                    {f.title || SURFACE[f.surface].title}
                  </div>
                  <div className="mt-0.5 text-sm text-muted-foreground">{f.detail || SURFACE[f.surface].blurb}</div>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={f.severity} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Assets f={f} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{f.usdAtRisk > 0 ? formatUsd(f.usdAtRisk) : "n/a"}</TableCell>
                <TableCell className="text-center" title={f.fix}>
                  {f.fixable ? (
                    <Check className="mx-auto size-4 text-sev-clear" aria-label="Fixable today" />
                  ) : (
                    <X className="mx-auto size-4 text-muted-foreground" aria-label="Needs a protocol change" />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
