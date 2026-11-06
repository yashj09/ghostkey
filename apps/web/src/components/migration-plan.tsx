import { buildMigration, type Migration, type ResidualReport } from "@ghostkey/core";
import { Check, Copy, Loader2, Wand2 } from "lucide-react";
import { useState } from "react";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SURFACE } from "./severity";

/** Builds GhostKey's atomic "complete migration" batch for the scanned account. */
export function MigrationPlan({ report, rpcUrl }: { report: ResidualReport; rpcUrl: string }) {
  const [dest, setDest] = useState("");
  const [plan, setPlan] = useState<Migration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const fixable = report.findings.some((f) => f.fixable && (f.assets.length > 0 || f.usdAtRisk > 0));
  if (!fixable) return null;

  async function build() {
    setBusy(true);
    setError(undefined);
    try {
      const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl, { batch: true }), cacheTime: 0 });
      setPlan(await buildMigration(client, report, dest as Address));
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  const json = plan ? JSON.stringify(plan.calls, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) : "";
  const viaPQ = report.account.killswitch !== undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Complete the migration</CardTitle>
        <CardDescription>
          One atomic batch moves everything the old key can reach to a fresh, key-less post-quantum account, swaps Safe owners, hands over ENS and revokes the old
          key's roles. {viaPQ ? "Sign it with your leanSphincs-s key: PQDelegate.execute(calls, sig), relayable by anyone." : "Execute it from your account as one batch."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="dest">Destination (your new post-quantum account)</Label>
            <Input id="dest" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="0x…" className="font-mono" spellCheck={false} />
          </div>
          <Button onClick={build} disabled={busy || !isAddress(dest)}>
            {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Build plan
          </Button>
        </div>
        {error && <p className="text-sm text-sev-exposed">{error}</p>}
        {plan && (
          <div className="space-y-3">
            <ol className="space-y-1.5">
              {plan.steps.map((s, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="w-6 shrink-0 text-right font-mono text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span>
                    {s.description} <span className="text-muted-foreground">· surface {SURFACE[s.surface].n}</span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(json);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check /> : <Copy />} Copy {plan.calls.length} calls (JSON)
              </Button>
              <span className="text-sm text-muted-foreground">Protocol-level surfaces stay open until EIP-7851 / EIP-8151, but nothing will be left behind them.</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
