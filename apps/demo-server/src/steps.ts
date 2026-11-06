// The 8 demo steps, wired to @ghostkey/core. Each step streams log lines + state to the cockpit.
import { buildMigration, getUsdPrices, scanAccount, TOKENS, type ResidualReport } from "@ghostkey/core";
import {
  attackDaiPermit,
  attackDirect,
  attackEns,
  attackRedelegateThenPermit2,
  attackSafe,
  clientsFor,
  completeMigration,
  crackAndTripCanary,
  delegationOf,
  DEMO_TOKENS,
  ensResolvesTo,
  migrateTo7702,
  revert,
  setupWorld,
  snapshot,
  type DemoWorld,
  type StepResult,
} from "@ghostkey/core/demo";
import { DEMO_STEPS, type AttackSummary, type DemoStepId, type PartyBalances } from "@ghostkey/core/demo-api";
import { createBsgsCracker, createCliPQSigner } from "@ghostkey/core/node";
import { erc20Abi, formatUnits, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import type { Hub } from "./infra.js";

const PQ_SEED = keccak256(toHex("ghostkey-demo-seed-1"));
const CANARY_BITS = 44;
const CANARY_SEED = 7;
const killswitchAbi = parseAbi(["function killswitch() view returns (bool)"]);
const canaryAbi = parseAbi(["function tripped() view returns (bool)"]);
const safeOwnersAbi = parseAbi(["function getOwners() view returns (address[])"]);
const SYMBOLS = Object.keys(DEMO_TOKENS) as (keyof typeof DEMO_TOKENS)[];

/** Shorten revert payloads and long addresses so log lines fit a projector. */
const tidy = (s: string) =>
  s.replace(/\s?\(([^()]{40,})\)/g, "").replace(/0x[0-9a-fA-F]{40}/g, (a) => `${a.slice(0, 6)}…${a.slice(-4)}`).replace(/(\d+\.\d{4})\d+/g, "$1");

const ATTACKS: [label: string, surface: string, fn: (w: DemoWorld) => Promise<StepResult>][] = [
  ["DAI permit (ecrecover)", "ecrecover-permit", attackDaiPermit],
  ["Safe owner signature", "safe-owner", attackSafe],
  ["ENSv2 resolver role", "ens-roles", attackEns],
  ["Direct tx from the EOA", "direct-tx", attackDirect],
  ["Re-delegate, then Permit2", "redelegation", attackRedelegateThenPermit2],
];

export async function createDemo(hub: Hub, rpcUrl: string, forkBlock: number) {
  const { publicClient: pc } = clientsFor(rpcUrl);
  const pqSigner = createCliPQSigner(PQ_SEED);
  const cracker = createBsgsCracker();
  let pristine: Hex = await snapshot(rpcUrl);
  let preAttack: Hex | undefined;
  let world: DemoWorld | undefined;
  let attackerBase: PartyBalances | undefined; // attacker's own gas money; the cockpit shows only what was stolen

  const curated = TOKENS.filter((t) => (Object.values(DEMO_TOKENS) as string[]).includes(t.address));
  let prices = await getUsdPrices(pc, curated);
  const priceOf = (sym: string) => (sym === "ETH" ? prices.eth : prices.byToken.get(DEMO_TOKENS[sym as keyof typeof DEMO_TOKENS]) ?? 0);

  async function balancesOf(who: Address): Promise<PartyBalances> {
    const [eth, ...toks] = await Promise.all([pc.getBalance({ address: who }), ...SYMBOLS.map((s) => pc.readContract({ address: DEMO_TOKENS[s], abi: erc20Abi, functionName: "balanceOf", args: [who] }))]);
    const tokens: Record<string, number> = { ETH: Number(formatUnits(eth, 18)) };
    SYMBOLS.forEach((s, i) => (tokens[s] = Number(formatUnits(toks[i]!, s === "USDC" ? 6 : 18))));
    const usd = Object.entries(tokens).reduce((acc, [s, v]) => acc + v * priceOf(s), 0);
    return { usd, tokens };
  }

  function stolen(now: PartyBalances): PartyBalances {
    if (!attackerBase) return now;
    const tokens: Record<string, number> = {};
    for (const [sym, v] of Object.entries(now.tokens)) tokens[sym] = Math.max(0, v - (attackerBase.tokens[sym] ?? 0));
    return { usd: Object.entries(tokens).reduce((a, [sym, v]) => a + v * priceOf(sym), 0), tokens };
  }

  async function refresh() {
    if (!world) return;
    const w = world;
    const [alice, safe, pqAccount, attacker, delegatedTo, ens, tripped] = await Promise.all([
      balancesOf(w.alice.address),
      balancesOf(w.contracts.safe),
      balancesOf(w.contracts.pqAccount),
      balancesOf(w.attacker.address),
      delegationOf(w),
      ensResolvesTo(w).catch(() => undefined),
      pc.readContract({ address: w.canary.address, abi: canaryAbi, functionName: "tripped" }),
    ]);
    let killswitch: boolean | undefined;
    if (delegatedTo?.toLowerCase() === w.contracts.delegate.toLowerCase()) {
      killswitch = await pc.readContract({ address: w.alice.address, abi: killswitchAbi, functionName: "killswitch" });
    }
    const owners = await pc.readContract({ address: w.contracts.safe, abi: safeOwnersAbi, functionName: "getOwners" });
    const safeOwner = owners.some((o) => o.toLowerCase() === w.contracts.pqAccount.toLowerCase())
      ? "pq"
      : owners.some((o) => o.toLowerCase() === w.alice.address.toLowerCase())
        ? "alice"
        : "other";
    hub.patch({
      safeOwner,
      balances: { alice, safe, pqAccount, attacker: stolen(attacker) },
      delegatedTo: delegatedTo ?? null,
      killswitch,
      ensResolvesTo: ens,
      canary: { ...hub.state.canary, bits: CANARY_BITS, tripped },
    });
  }

  async function scan(step: DemoStepId): Promise<ResidualReport> {
    const w = world!;
    const report = await scanAccount(pc, w.alice.address, {
      ensNames: [w.ens.name],
      ensResolvers: [w.contracts.resolver],
      safes: [w.contracts.safe],
      rpcOnly: true,
    });
    hub.patch({ report });
    const atRisk = report.findings.filter((f) => f.usdAtRisk > 0.5 || f.assets.length > 0).length;
    const open = report.findings.filter((f) => f.severity === "protocol-only").length;
    const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    hub.log(
      step,
      report.usdControlledByOldKey > 0.5 ? "danger" : "success",
      report.usdControlledByOldKey > 0.5
        ? `Scan: old key still controls ${usd(report.usdControlledByOldKey)} across ${atRisk} surfaces` + (report.usdConditional > 0.5 ? ` (+${usd(report.usdConditional)} conditional)` : "")
        : `Scan: old key controls $0. ${open} protocol-level surface${open === 1 ? "" : "s"} still open (EIP-7851), nothing left behind them`,
    );
    return report;
  }

  async function attackRound(step: DemoStepId) {
    const w = world!;
    const base = (await balancesOf(w.attacker.address)).usd;
    const attacks: AttackSummary[] = [];
    hub.patch({ attacks, attackerUsd: 0 });
    for (const [label, surface, fn] of ATTACKS) {
      const before = (await balancesOf(w.attacker.address)).usd;
      const r = await fn(w);
      const after = (await balancesOf(w.attacker.address)).usd;
      const usdTaken = Math.max(0, after - before);
      attacks.push({ surface, label, ok: r.ok, usdTaken, detail: tidy(r.detail), tx: r.txHashes.at(-1) });
      hub.log(step, r.ok ? "danger" : "success", `${r.ok ? "✗" : "✓"} ${label}: ${tidy(r.detail)}`, { tx: r.txHashes.at(-1) });
      hub.patch({ attacks: [...attacks], attackerUsd: Math.max(0, after - base) });
      await refresh();
    }
    const total = Math.max(0, (await balancesOf(w.attacker.address)).usd - base);
    hub.log(step, total > 0.5 ? "danger" : "success", total > 0.5 ? `Attacker walked away with $${Math.round(total).toLocaleString("en-US")}. The killswitch was ON the whole time.` : "Attacker got $0. The old key controls nothing.");
  }

  const handlers: Record<DemoStepId, () => Promise<void>> = {
    async setup() {
      prices = await getUsdPrices(pc, curated);
      world = await setupWorld({ rpcUrl, pqSigner, pqSeed: PQ_SEED, canaryBits: CANARY_BITS, canarySeed: CANARY_SEED, log: (m) => hub.log("setup", "info", m) });
      const w = world;
      hub.patch({
        forkBlock,
        world: { alice: w.alice.address, attacker: w.attacker.address, pqAccount: w.contracts.pqAccount, delegate: w.contracts.delegate, safe: w.contracts.safe, canary: w.canary.address, ensName: w.ens.name },
        canary: { tripped: false, bits: CANARY_BITS, bountyEth: 1 },
      });
      attackerBase = await balancesOf(w.attacker.address);
      await refresh();
      hub.log("setup", "success", `Alice is ready: ${w.ens.name}, a 1/1 Safe, DAI/UNI/USDC/wstETH and a Permit2 approval`);
    },
    async migrate() {
      const r = await migrateTo7702(world!);
      if (!r.ok) throw new Error(r.detail);
      hub.log("migrate", "success", `EIP-7702: Alice's EOA now runs PQDelegate (leanSphincs-s). Wallet says "quantum-safe" ✓`, { tx: r.txHashes.at(-1) });
      await refresh();
    },
    async crack() {
      hub.log("crack", "info", `Laptop "quantum computer": baby-step giant-step on the ${CANARY_BITS}-bit canary key…`);
      const r = await crackAndTripCanary(world!, cracker);
      if (!r.ok) throw new Error(r.detail);
      const ms = Number(r.data?.ms ?? 0);
      hub.patch({ canary: { tripped: true, bits: CANARY_BITS, crackMs: ms, bountyEth: 1 } });
      hub.log("crack", "warn", `Canary key cracked in ${ms} ms, bounty claimed. Canary TRIPPED`, { tx: r.txHashes.at(-1) });
      await refresh();
      hub.log("crack", "success", `Alice's wallet killswitch: ${hub.state.killswitch ? "ON. ECDSA disabled in the wallet" : "off?"}`);
      // the canary bounty went to the "quantum attacker": re-baseline so the cockpit shows only Q-day loot
      attackerBase = await balancesOf(world!.attacker.address);
      await refresh();
      preAttack = await snapshot(rpcUrl);
    },
    async scan() {
      await scan("scan");
    },
    async attack() {
      hub.log("attack", "danger", "Q-day: the attacker has Alice's old ECDSA key.");
      await attackRound("attack");
    },
    async rewind() {
      if (!preAttack) throw new Error("no pre-attack snapshot");
      await revert(rpcUrl, preAttack);
      preAttack = await snapshot(rpcUrl);
      hub.patch({ attacks: undefined, attackerUsd: undefined, report: undefined });
      await refresh();
      hub.log("rewind", "info", "Rewound to just after the migration + canary trip. Killswitch still ON, money back.");
    },
    async fix() {
      const w = world!;
      const report = await scan("fix");
      const mig = await buildMigration(pc, report, w.contracts.pqAccount);
      hub.log("fix", "info", `GhostKey built a ${mig.calls.length}-call migration batch:`);
      for (const s of mig.steps) hub.log("fix", "info", `  · ${s.description}`);
      const r = await completeMigration(w, mig.calls, pqSigner);
      if (!r.ok) throw new Error(r.detail);
      hub.log("fix", "success", `Signed with leanSphincs-s (${r.data?.sigBytes ?? 4164}-byte post-quantum signature) and relayed: ${r.data?.gasUsed ?? "?"} gas`, { tx: r.txHashes.at(-1) });
      await refresh();
      await scan("fix");
    },
    async reattack() {
      hub.log("reattack", "warn", "Q-day again: same attacker, same old key.");
      await attackRound("reattack");
    },
  };

  return {
    async run(step: DemoStepId) {
      const next = DEMO_STEPS.find((s) => !hub.state.completed.includes(s));
      if (step !== next) {
        hub.log("system", "warn", `Step "${step}" is out of order (next is "${next}")`);
        return;
      }
      hub.patch({ busy: step, error: undefined });
      try {
        await handlers[step]();
        hub.markDone(step);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        hub.log(step, "danger", `Step failed: ${msg}`);
        hub.patch({ error: msg });
      } finally {
        hub.patch({ busy: null });
      }
    },
    async reset() {
      hub.patch({ busy: null });
      await revert(rpcUrl, pristine);
      pristine = await snapshot(rpcUrl);
      world = undefined;
      preAttack = undefined;
      hub.state = { ready: true, busy: null, completed: [] };
      hub.clearLog();
      hub.patch({});
      hub.log("system", "info", `Fresh mainnet fork at block ${forkBlock}. Ready.`);
    },
    ready() {
      hub.patch({ ready: true });
      hub.log("system", "info", `Fresh mainnet fork at block ${forkBlock}. Ready.`);
    },
  };
}
