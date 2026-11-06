// Q-day simulator runner: one simulation at a time on a dedicated fork, streamed to the cockpit.
import type { SimView } from "@ghostkey/core/demo-api";
import { simulateQday, type SimEvent } from "@ghostkey/core/sim";
import type { Hex } from "viem";
import type { Hub } from "./infra.js";

const PRESETS = (process.env.SIM_PRESETS ?? "vitalik.eth,yashj09.eth").split(",").map((s) => s.trim()).filter(Boolean);

export function createSimulator(hub: Hub, anvilUrl: string, forkUrl: string) {
  let base: Hex | undefined;
  let chain: Promise<unknown> = Promise.resolve(); // serialises runs (anvil state is shared)
  const warm = new Set<string>();
  const empty = (): SimView => ({ status: "idle", attack: [], reattack: [], fixSteps: [], warm: [...warm] });
  hub.patch({ sim: empty() });

  const view = () => hub.state.sim ?? empty();
  const set = (p: Partial<SimView>) => hub.patch({ sim: { ...view(), ...p, warm: [...warm] } });

  async function runOne(target: string, quiet: boolean) {
    const key = target.toLowerCase();
    if (!quiet) set({ ...empty(), status: "forking", target, startedAt: Date.now() });
    const onEvent = (e: SimEvent) => {
      if (quiet) return;
      const p: Partial<SimView> = { status: e.phase === "done" ? "done" : e.phase === "error" ? "error" : e.phase };
      if (e.holdings) p.holdings = e.holdings;
      if (e.report && e.phase === "scanning") p.before = e.report;
      if (e.report && e.phase === "done") p.after = e.report;
      if (e.action && e.phase === "attacking") p.attack = [...view().attack, e.action];
      if (e.action && e.phase === "reattacking") p.reattack = [...view().reattack, e.action];
      if (e.phase === "fixing" && e.msg.startsWith("✓")) p.fixSteps = [...view().fixSteps, e.msg.slice(2)];
      if (e.phase === "attacking" && e.holdings && view().startUsd === undefined) p.startUsd = e.holdings.targetUsd + e.holdings.safesUsd;
      set(p);
      hub.log("sim", e.level, e.msg, { tx: e.tx });
    };
    try {
      const r = await simulateQday({ anvilUrl, forkUrl, target, base, onEvent });
      base = r.nextBase;
      warm.add(key);
      if (!quiet)
        set({ status: "done", address: r.address, name: r.name, forkBlock: Number(r.forkBlock), stolenUsd: r.stolenUsd, stolenAfterUsd: r.stolenAfterUsd, remaining: r.remaining, before: r.before, after: r.after });
      else set({});
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!;
      if (!quiet) {
        set({ status: "error", error: msg });
        hub.log("sim", "danger", `Simulation failed: ${msg}`);
      }
    }
  }

  return {
    /** queue a visible simulation */
    run(target: string) {
      set({ ...empty(), status: "queued", target });
      chain = chain.then(() => runOne(target, false));
      return chain;
    },
    /** warm the fork for the presets in the background (silent) */
    prewarm() {
      for (const t of PRESETS) chain = chain.then(() => (console.log(`[sim] pre-warming ${t}…`), runOne(t, true)).then(() => console.log(`[sim] ${t} warm`)));
    },
    busy: () => ["queued", "forking", "scanning", "attacking", "rewinding", "fixing", "reattacking"].includes(view().status),
  };
}
