import type { SimView } from "@ghostkey/core/demo-api";
import { Loader2, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { buildRows, WireDiagram } from "@/components/sim/wire-diagram";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUsd } from "@/lib/format";
import { useCensus } from "@/lib/use-census";
import { useCount } from "@/lib/use-count";
import { useDemo } from "@/lib/use-demo";
import { cn } from "@/lib/utils";

const PHASES: { label: string; when: SimView["status"][] }[] = [
  { label: "Scan", when: ["forking", "scanning"] },
  { label: "Q-day", when: ["attacking"] },
  { label: "Rewind", when: ["rewinding"] },
  { label: "GhostKey migration", when: ["fixing"] },
  { label: "Q-day again", when: ["reattacking", "done"] },
];
const RUNNING: SimView["status"][] = ["queued", "forking", "scanning", "attacking", "rewinding", "fixing", "reattacking"];

function CensusHero() {
  const c = useCensus();
  const usd = useCount(c?.wallet.usd ?? 0, 1400);
  if (!c) return null;
  const hasWallet = c.wallet.accounts > 0;
  return (
    <section className="space-y-3">
      <p className="text-5xl font-bold tracking-tighter tabular-nums sm:text-7xl lg:text-8xl">{formatUsd(hasWallet ? usd : c.totals.usd)}</p>
      <p className="max-w-2xl text-lg text-muted-foreground sm:text-xl">
        {hasWallet ? (
          <>
            is still controlled by the old ECDSA keys of <span className="text-foreground">{c.wallet.accounts.toLocaleString("en-US")} accounts</span> that upgraded to a smart wallet with
            EIP-7702 in the last {Math.round(c.blocks.count / 300)} hours. Upgrading installed code. It never switched the key off.
          </>
        ) : (
          <>is held by accounts delegated with EIP-7702 in the last {Math.round(c.blocks.count / 300)} hours, and every unit of it can still be moved by their old ECDSA keys.</>
        )}
      </p>
      <details className="max-w-2xl text-sm text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">How this was counted</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>{c.rules.window}: {c.totals.type4Txs.toLocaleString("en-US")} transactions, {c.totals.uniqueAuthorities.toLocaleString("en-US")} accounts.</li>
          <li>{c.totals.stillDelegated.toLocaleString("en-US")} are still delegated now. {c.minimal.accounts.toLocaleString("en-US")} of them point at tiny delegates (bots, batchers, sweepers) and are left out of the headline.</li>
          <li>{c.rules.walletClass}.</li>
          <li>{c.rules.value}. Snapshot taken {new Date(c.generatedAt).toLocaleString()}.</li>
        </ul>
      </details>
    </section>
  );
}

export function SimulatePage() {
  const { state, conn, simulate } = useDemo();
  const [target, setTarget] = useState("");
  const sim = state?.sim;
  const running = !!sim && RUNNING.includes(sim.status);
  const rows = useMemo(() => (sim?.before ? buildRows(sim) : []), [sim]);

  const stolenLive = sim?.holdings?.attackerUsd ?? 0;
  const afterFix = sim && ["fixing", "reattacking", "done"].includes(sim.status);
  const attackerNumber = useCount(afterFix ? (sim?.stolenAfterUsd ?? 0) : stolenLive);
  const phaseIdx = sim ? PHASES.findIndex((p) => p.when.includes(sim.status)) : -1;

  async function go(t = target) {
    const v = t.trim();
    if (!v) return;
    setTarget(v);
    try {
      await simulate(v);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-12">
      <CensusHero />

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">What could someone holding your old key do today?</h2>
        {conn === "online" ? (
          <>
            <form
              className="flex max-w-2xl flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void go();
              }}
            >
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Any address or ENS name"
                aria-label="Address or ENS name to simulate"
                className="h-12 text-base"
                spellCheck={false}
                autoComplete="off"
              />
              <Button type="submit" size="lg" className="h-12 px-6" disabled={running || !target.trim()}>
                {running ? <Loader2 className="animate-spin" /> : <Play />} Simulate Q-day
              </Button>
            </form>
            <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
              Try
              {["vitalik.eth", "yashj09.eth"].map((p) => (
                <button key={p} type="button" disabled={running} onClick={() => void go(p)} className="font-mono text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground disabled:opacity-50">
                  {p}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="max-w-2xl text-muted-foreground">
            The simulator forks mainnet on your machine. Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">pnpm demo</code> from the repo, or use
            the Scan tab to read any account's residual authority right here.
          </p>
        )}
      </section>

      {sim && sim.status !== "idle" && (
        <section className="space-y-8" aria-live="polite">
          <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {PHASES.map((p, i) => (
              <li key={p.label} className={cn("flex items-center gap-2", i === phaseIdx ? "font-semibold text-foreground" : i < phaseIdx ? "text-muted-foreground" : "text-muted-foreground/60")}>
                <span className={cn("grid size-6 place-items-center rounded-full border text-xs tabular-nums", i === phaseIdx && "border-foreground", i < phaseIdx && "border-transparent bg-muted")}>{i + 1}</span>
                {p.label}
                {i === phaseIdx && running && <Loader2 className="size-3.5 animate-spin" />}
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-end gap-x-12 gap-y-4">
            <div>
              <div className="text-sm text-muted-foreground">{afterFix ? "Attacker gets after GhostKey" : "Attacker has taken"}</div>
              <div className={cn("text-6xl font-bold tracking-tighter tabular-nums sm:text-7xl", afterFix && sim.status === "done" ? "text-secure" : "text-wire")}>{formatUsd(attackerNumber)}</div>
            </div>
            {sim.before && (
              <div className="pb-2 text-muted-foreground">
                of {formatUsd(sim.before.usdControlledByOldKey)} the old key of <span className="font-mono text-foreground">{sim.target}</span> controls
                {sim.forkBlock ? <> at block {sim.forkBlock.toLocaleString("en-US")}</> : null}
              </div>
            )}
          </div>

          {rows.length > 0 ? (
            <WireDiagram sim={sim} rows={rows} />
          ) : (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {sim.status === "queued" ? "Waiting for the fork to warm up…" : "Reading the account from a mainnet fork…"}
            </div>
          )}

          {sim.status === "done" && (
            <div className="max-w-2xl space-y-1">
              <p className="text-lg">
                {sim.stolenAfterUsd !== undefined && sim.stolenAfterUsd < 0.5 ? "After one GhostKey migration the same key takes nothing." : `After GhostKey the key still takes ${formatUsd(sim.stolenAfterUsd)}.`}
              </p>
              {sim.remaining && sim.remaining.length > 0 && (
                <p className="text-muted-foreground">
                  Still open: {sim.remaining.join(", ")}. ENSv1 names have to be moved in the ENS app, and only a protocol change (EIP-7851) can switch the key off for good.
                </p>
              )}
            </div>
          )}
          {sim.status === "error" && <p className="text-wire">Simulation failed: {sim.error}</p>}
          <p className="max-w-2xl text-xs text-muted-foreground">
            Runs on a local fork of mainnet. The attacker's signatures are simulated by impersonating the account, which is exactly the authority the old key has.
          </p>
        </section>
      )}
    </div>
  );
}
