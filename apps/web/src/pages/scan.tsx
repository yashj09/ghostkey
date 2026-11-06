import { scanAccount, type ResidualReport, type ScanHints } from "@ghostkey/core";
import { ChevronDown, Loader2, Search, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { MigrationPlan } from "@/components/migration-plan";
import { FindingsTable, Headline } from "@/components/report-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function usePersisted(key: string, initial: string) {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => localStorage.setItem(key, v), [key, v]);
  return [v, setV] as const;
}

export function ScanPage() {
  const [rpcUrl, setRpcUrl] = usePersisted("gk-rpc", DEFAULT_RPC);
  const [query, setQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [ensNames, setEnsNames] = useState("");
  const [safes, setSafes] = useState("");
  const [extraTokens, setExtraTokens] = useState("");
  const [useSafeApi, setUseSafeApi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<ResidualReport>();
  const [demo, setDemo] = useState<{ rpcUrl: string; alice: Address; ensName: string; safe: Address; resolver?: Address } | null>(null);

  // If the local demo server is running, offer its Alice as a preset.
  useEffect(() => {
    fetch("/api/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s?.world && setDemo({ rpcUrl: s.rpcUrl, alice: s.world.alice, ensName: s.world.ensName, safe: s.world.safe }))
      .catch(() => {});
  }, []);

  const client = useMemo(() => createPublicClient({ chain: mainnet, transport: http(rpcUrl, { batch: true }), cacheTime: 0 }), [rpcUrl]);

  async function run(target = query, override?: { rpc?: string; hints?: ScanHints }) {
    setBusy(true);
    setError(undefined);
    setReport(undefined);
    try {
      const c = override?.rpc ? createPublicClient({ chain: mainnet, transport: http(override.rpc, { batch: true }), cacheTime: 0 }) : client;
      let address: Address;
      const names = list(ensNames);
      if (isAddress(target)) address = target;
      else if (target.includes(".")) {
        const resolved = await c.getEnsAddress({ name: normalize(target) });
        if (!resolved) throw new Error(`${target} doesn't resolve to an address`);
        address = resolved;
        names.push(target);
      } else throw new Error("Enter an address (0x…) or an ENS name");
      const hints: ScanHints = {
        ensNames: names,
        safes: list(safes) as Address[],
        extraTokens: list(extraTokens) as Address[],
        rpcOnly: !useSafeApi,
        ...override?.hints,
      };
      setReport(await scanAccount(c, address, hints));
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">You migrated. Your old key didn't.</h1>
        <p className="max-w-prose text-muted-foreground">
          EIP-7702 and frame transactions <em>install code</em> on your account, but they never switch your old ECDSA key off. GhostKey finds every
          place it still has power: direct transactions, re-delegation, permits, Permit2, Safe ownership and ENSv2 roles.
        </p>
      </section>

      <Card>
        <CardContent className="space-y-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <Label htmlFor="q" className="sr-only">
              Address or ENS name
            </Label>
            <Input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="0x… or name.eth" className="h-11 font-mono text-base" autoComplete="off" spellCheck={false} />
            <Button type="submit" size="lg" className="h-11" disabled={busy || !query}>
              {busy ? <Loader2 className="animate-spin" /> : <Search />} Scan
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Try:</span>
            <Button variant="outline" size="sm" onClick={() => (setQuery("vitalik.eth"), void run("vitalik.eth"))}>
              vitalik.eth
            </Button>
            {demo && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery(demo.alice);
                  void run(demo.alice, { rpc: demo.rpcUrl, hints: { ensNames: [demo.ensName], safes: [demo.safe], rpcOnly: true } });
                }}
              >
                Demo Alice (local fork)
              </Button>
            )}
            <button type="button" className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              Advanced <ChevronDown className={`size-4 transition-transform ${advanced ? "rotate-180" : ""}`} />
            </button>
          </div>

          {advanced && (
            <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="rpc">RPC URL</Label>
                <Input id="rpc" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} className="font-mono" spellCheck={false} />
                <p className="text-xs text-muted-foreground">Every read goes here and nowhere else. Your RPC learns which address you scan, so prefer your own node.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ens">ENS names to check</Label>
                <Input id="ens" value={ensNames} onChange={(e) => setEnsNames(e.target.value)} placeholder="alice.eth, alice.box" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="safes">Safes</Label>
                <Input id="safes" value={safes} onChange={(e) => setSafes(e.target.value)} placeholder="0x…, 0x…" className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tok">Extra ERC-20s (permit is probed)</Label>
                <Input id="tok" value={extraTokens} onChange={(e) => setExtraTokens(e.target.value)} placeholder="0x…" className="font-mono" />
              </div>
              <div className="flex items-start gap-3 pt-6">
                <Switch id="safeapi" checked={useSafeApi} onCheckedChange={setUseSafeApi} />
                <Label htmlFor="safeapi" className="block leading-snug font-normal">
                  Find my Safes via the Safe Transaction Service
                  <span className="block text-xs text-muted-foreground">Off by default: it tells safe.global which address you scanned.</span>
                </Label>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-sev-exposed/40 bg-sev-exposed/10 p-3 text-sm text-sev-exposed">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      )}
      {busy && (
        <div className="space-y-4" aria-busy>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      )}
      {report && (
        <>
          <Headline report={report} />
          <FindingsTable report={report} />
          <MigrationPlan report={report} rpcUrl={demo && report.account.address === demo.alice ? demo.rpcUrl : rpcUrl} />
        </>
      )}
    </div>
  );
}
