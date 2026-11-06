import type { SimView } from "@ghostkey/core/demo-api";
import { KeyRound, Scissors } from "lucide-react";
import { formatAmount, formatUsd, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

type RowState = "live" | "taken" | "secured";
interface Row {
  id: string;
  kind: "token" | "safe" | "ens" | "note";
  label: string;
  sub?: string;
  usd?: number;
  state: RowState;
  /** bumps when this row was just hit, to replay the pulse */
  hit: number;
}

const afterGhostKey = (s: SimView["status"]) => ["fixing", "reattacking", "done"].includes(s);

/** Derive the diagram rows (assets the old key controls) and their live state from the simulator stream. */
export function buildRows(sim: SimView): Row[] {
  const rows: Row[] = [];
  const f = sim.before?.findings ?? [];
  const direct = f.find((x) => x.surface === "direct-tx");
  for (const a of direct?.assets ?? []) {
    if ((a.usd ?? 0) < 1) continue;
    rows.push({ id: `tok:${a.symbol}`, kind: "token", label: `${formatAmount(a.amount, a.decimals, a.amount < 10n ** BigInt(a.decimals) ? 4 : 2)} ${a.symbol}`, usd: a.usd, state: "live", hit: 0 });
  }
  let emptySafes = 0;
  for (const fi of f.filter((x) => x.surface === "safe-owner" && x.severity === "exposed")) {
    for (const a of fi.assets.filter((x) => x.kind === "safe")) {
      if ((a.usd ?? 0) < 1) emptySafes++;
      else rows.push({ id: `safe:${a.address.toLowerCase()}`, kind: "safe", label: `Safe ${shortAddr(a.address)}`, sub: "1-of-1 owner", usd: a.usd, state: "live", hit: 0 });
    }
  }
  const names = new Map<string, string>();
  for (const fi of f.filter((x) => x.surface === "ens-roles")) for (const a of fi.assets) if (a.kind === "ens-name" && !names.has(a.symbol)) names.set(a.symbol, a.note ?? "");
  for (const [n, note] of names) rows.push({ id: `ens:${n}`, kind: "ens", label: n, sub: note.split(",")[0], state: "live", hit: 0 });
  if (emptySafes) rows.push({ id: "note:safes", kind: "note", label: `+${emptySafes} more Safes it solely owns`, sub: "empty today, so future deposits are exposed", state: "live", hit: 0 });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const hitRow = (r: Row | undefined, state: RowState) => {
    if (r && r.kind !== "note") {
      r.state = state;
      r.hit++;
    }
  };
  const apply = (actions: SimView["attack"]) => {
    for (const act of actions) {
      if (!act.ok) continue;
      if (act.surface === "direct-tx") rows.filter((r) => r.kind === "token").forEach((r) => hitRow(r, "taken"));
      else if (act.surface === "safe-owner") hitRow(rows.find((r) => r.kind === "safe" && act.label.includes(r.label.slice(5))), "taken");
      else if (act.surface === "ens-roles") hitRow(rows.find((r) => r.kind === "ens" && act.label.startsWith(r.label)), "taken");
    }
  };

  if (!afterGhostKey(sim.status) && sim.status !== "rewinding") apply(sim.attack);
  if (afterGhostKey(sim.status)) {
    for (const step of sim.fixSteps) {
      const tok = step.match(/^Move [\d.,]+ (\S+) to/);
      if (tok) hitRow(byId.get(`tok:${tok[1]}`), "secured");
      const safe = step.match(/Safe (0x[0-9a-fA-F]{40})/);
      if (safe) hitRow(byId.get(`safe:${safe[1]!.toLowerCase()}`), "secured");
      for (const [n] of names) if (step.includes(n)) hitRow(byId.get(`ens:${n}`), "secured");
    }
    if (sim.fixSteps.some((s) => s.startsWith("Swap the old key"))) {
      const note = byId.get("note:safes");
      if (note) note.state = "secured";
    }
    apply(sim.reattack);
  }
  return rows;
}

function Wire({ state, hit }: { state: RowState; hit: number }) {
  return (
    <div className="relative flex h-full items-center" aria-hidden>
      <div
        className={cn(
          "h-0 w-full border-t-2 transition-colors duration-300",
          state === "live" && "border-wire",
          state === "taken" && "border-dashed border-wire/50",
          state === "secured" && "border-dotted border-cut",
        )}
      />
      {state === "secured" && <Scissors className="absolute left-1/2 size-4 -translate-x-1/2 bg-background text-cut" />}
      {hit > 0 && state !== "secured" && <span key={hit} className="wire-pulse absolute left-0 size-2.5 rounded-full bg-wire" />}
    </div>
  );
}

export function WireDiagram({ sim, rows }: { sim: SimView; rows: Row[] }) {
  const s = sim.before?.account;
  const disarmed = rows.length > 0 && rows.every((r) => r.state === "secured" || r.kind === "note") && sim.status === "done";
  return (
    <div className="grid grid-cols-[minmax(9rem,13rem)_minmax(3rem,1fr)_minmax(0,22rem)] gap-x-3 sm:gap-x-5">
      <div
        className={cn("row-span-full flex flex-col justify-center rounded-xl border-2 p-4 transition-colors duration-500", disarmed ? "border-cut bg-muted/40" : "border-wire bg-wire/5")}
        style={{ gridRow: `1 / span ${Math.max(rows.length, 1)}` }}
      >
        <KeyRound className={cn("size-6", disarmed ? "text-cut" : "text-wire")} aria-hidden />
        <div className="mt-2 font-semibold">Old ECDSA key</div>
        {disarmed && <div className="mt-1 text-sm font-medium text-secure">Still signs. Controls nothing.</div>}
        <div className="font-mono text-sm text-muted-foreground">{s ? shortAddr(s.address, 5) : "…"}</div>
        <div className="mt-2 text-sm text-muted-foreground">
          {s?.delegatedTo ? <>EIP-7702 delegated to {shortAddr(s.delegatedTo)}. The key still signs.</> : <>Plain EOA</>}
        </div>
      </div>
      {rows.map((r, i) => (
        <div key={r.id} className="contents">
          <div style={{ gridColumn: 2, gridRow: i + 1 }} className="min-h-14">
            <Wire state={r.state} hit={r.hit} />
          </div>
          <div style={{ gridColumn: 3, gridRow: i + 1 }} className="flex min-h-14 items-center justify-between gap-3 border-b border-border/60 py-2">
            <div className="min-w-0">
              <div className={cn("truncate font-medium", r.kind === "ens" || r.kind === "safe" ? "font-mono text-[15px]" : "", r.state === "taken" && "text-wire line-through decoration-2")}>{r.label}</div>
              {r.sub && <div className="truncate text-xs text-muted-foreground">{r.sub}</div>}
            </div>
            <div className="shrink-0 text-right text-sm tabular-nums">
              {r.usd !== undefined && <div className={cn(r.state === "taken" && "text-wire", r.state === "secured" && "text-secure")}>{formatUsd(r.usd)}</div>}
              <div className={cn("text-xs", r.state === "taken" ? "text-wire" : r.state === "secured" ? "text-secure" : "text-muted-foreground")}>
                {r.state === "taken"
                  ? r.kind === "ens"
                    ? "redirected to attacker"
                    : "to attacker"
                  : r.state === "secured"
                    ? r.kind === "safe" || r.kind === "note"
                      ? "owner is now your PQ account"
                      : r.kind === "ens"
                        ? "now your PQ account's"
                        : "moved to your PQ account"
                    : "old key controls"}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
