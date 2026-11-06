import { DEMO_STEP_META, type DemoState, type DemoStepId, type PartyBalances } from "@ghostkey/core/demo-api";
import { ShieldCheck, ShieldOff, Skull, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUsd, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: "bad" | "good" | "warn" | "muted"; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-4xl font-bold tracking-tight tabular-nums lg:text-5xl [&_svg]:size-7",
          tone === "bad" && "text-sev-exposed",
          tone === "good" && "text-sev-clear",
          tone === "warn" && "text-sev-conditional",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-sm text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Party({ name, address, b, tone, note }: { name: string; address?: Address; b?: PartyBalances; tone?: "bad" | "good"; note?: ReactNode }) {
  const tokens = b ? Object.entries(b.tokens).filter(([, v]) => v > 0.000001) : [];
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{name}</span>
        <span className={cn("font-mono text-lg font-semibold tabular-nums", tone === "bad" && "text-sev-exposed", tone === "good" && "text-sev-clear")}>
          {b ? formatUsd(b.usd) : "n/a"}
        </span>
      </div>
      {address && <div className="font-mono text-xs text-muted-foreground">{shortAddr(address, 6)}</div>}
      {note && <div className="mt-1 text-xs">{note}</div>}
      <div className="mt-1.5 font-mono text-xs text-muted-foreground">
        {tokens.length ? tokens.map(([s, v]) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${s}`).join(" · ") : "empty"}
      </div>
    </div>
  );
}

export function Stage({ state, focus }: { state: DemoState; focus?: DemoStepId }) {
  const w = state.world;
  const meta = focus ? DEMO_STEP_META[focus] : undefined;
  const ensWho =
    state.ensResolvesTo && w
      ? state.ensResolvesTo.toLowerCase() === w.attacker.toLowerCase()
        ? "attacker"
        : state.ensResolvesTo.toLowerCase() === w.pqAccount.toLowerCase()
          ? "pq"
          : state.ensResolvesTo.toLowerCase() === w.alice.toLowerCase()
            ? "alice"
            : "other"
      : undefined;
  const controlled = state.report?.usdControlledByOldKey;

  return (
    <div className="space-y-5">
      {meta && (
        <div>
          <div className="text-sm font-medium text-primary">Act {meta.act}</div>
          <h2 className="text-2xl font-semibold tracking-tight lg:text-3xl">{meta.title}</h2>
          <p className="mt-1 max-w-prose text-muted-foreground">{meta.blurb}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Old key still controls"
          value={controlled === undefined ? "n/a" : formatUsd(controlled)}
          tone={controlled === undefined ? "muted" : controlled > 0.5 ? "bad" : "good"}
          sub={state.report?.usdConditional ? `+${formatUsd(state.report.usdConditional)} conditional` : "per GhostKey scan"}
        />
        <Stat
          label="Attacker took"
          value={state.attackerUsd === undefined ? "n/a" : formatUsd(state.attackerUsd)}
          tone={state.attackerUsd === undefined ? "muted" : state.attackerUsd > 0.5 ? "bad" : "good"}
          sub="with Alice's old ECDSA key"
        />
        <Stat
          label="Wallet killswitch"
          value={
            <span className="inline-flex items-center gap-2">
              {state.killswitch ? <ShieldCheck /> : <ShieldOff />}
              {state.killswitch ? "ON" : "off"}
            </span>
          }
          tone={state.killswitch ? "good" : "muted"}
          sub={state.delegatedTo ? `7702 → PQ wallet ${shortAddr(state.delegatedTo)}` : "plain EOA"}
        />
        <Stat
          label="Quantum canary"
          value={
            <span className="inline-flex items-center gap-2">
              <Zap />
              {state.canary?.tripped ? "tripped" : "armed"}
            </span>
          }
          tone={state.canary?.tripped ? "warn" : "muted"}
          sub={state.canary?.crackMs !== undefined ? `${state.canary.bits}-bit key cracked in ${state.canary.crackMs} ms` : `${state.canary?.bits ?? 44}-bit demo key`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where the money is</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Party name="Alice (old EOA)" address={w?.alice} b={state.balances?.alice} />
          <Party
            name="Alice's Safe"
            address={w?.safe}
            b={state.balances?.safe}
            note={
              state.safeOwner && (
                <span className={state.safeOwner === "pq" ? "text-sev-clear" : state.safeOwner === "alice" ? "text-sev-exposed" : "text-muted-foreground"}>
                  owner: {state.safeOwner === "pq" ? "PQ account" : state.safeOwner === "alice" ? "the old ECDSA key" : "someone else"}
                </span>
              )
            }
          />
          <Party name="Fresh PQ account" address={w?.pqAccount} b={state.balances?.pqAccount} tone="good" />
          <Party name="Attacker (stolen)" address={w?.attacker} b={state.balances?.attacker} tone="bad" />
          {w && (
            <div className="rounded-lg border p-3 sm:col-span-2">
              <span className="font-mono">{w.ensName}</span> <span className="text-muted-foreground">resolves to</span>{" "}
              <span
                className={cn(
                  "font-mono font-semibold",
                  ensWho === "attacker" && "text-sev-exposed",
                  ensWho === "pq" && "text-sev-clear",
                )}
              >
                {state.ensResolvesTo ? shortAddr(state.ensResolvesTo, 6) : "n/a"}
              </span>{" "}
              <span className="text-muted-foreground">
                {ensWho === "attacker" ? "(the attacker!)" : ensWho === "pq" ? "(PQ account)" : ensWho === "alice" ? "(Alice)" : ""}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {state.attacks && state.attacks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attacks with the old key</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {state.attacks.map((a) => (
                <li key={a.surface} className="flex items-center gap-3 py-2">
                  {a.ok ? <Skull className="size-4 shrink-0 text-sev-exposed" aria-label="succeeded" /> : <ShieldCheck className="size-4 shrink-0 text-sev-clear" aria-label="failed" />}
                  <span className="font-medium">{a.label}</span>
                  <span className="hidden text-sm text-muted-foreground md:inline">{a.detail}</span>
                  <span className={cn("ml-auto font-mono tabular-nums", a.ok ? "text-sev-exposed" : "text-sev-clear")}>{a.ok ? formatUsd(a.usdTaken) : "blocked"}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
