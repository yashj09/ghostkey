// Q-day Simulator: what could an attacker holding THIS account's ECDSA key do, right now?
// Forks mainnet at the latest block, then acts as the key via anvil impersonation (the fork equivalent of
// the key signing), drains every surface the scanner found, rewinds, applies GhostKey's migration and re-attacks.
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi as viemErc20Abi,
  getAddress,
  http,
  labelhash,
  namehash,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { ensPermissionedRegistryAbi, ensPermissionedResolverAbi, ensV1RegistryAbi, safeAbi } from "../abis.js";
import { buildMigration } from "../fix.js";
import { getUsdPrices } from "../prices.js";
import { scanAccount } from "../scan.js";
import { dnsEncode } from "../surfaces/ens.js";
import { MAINNET, TOKENS } from "../mainnet.js";
import type { ResidualReport, SurfaceId } from "../types.js";

const v1ResolverAbi = parseAbi(["function setAddr(bytes32 node, address a)"]);

export type SimPhase = "forking" | "scanning" | "attacking" | "rewinding" | "fixing" | "reattacking" | "done" | "error";

export interface SimAction {
  surface: SurfaceId;
  label: string;
  ok: boolean;
  usdTaken: number;
  detail: string;
  tx?: Hex;
}

export interface SimHoldings {
  /** USD in the target account (ETH + curated tokens) */
  targetUsd: number;
  /** USD in Safes the target controls (1-of-N where the key is enough) */
  safesUsd: number;
  attackerUsd: number;
  vaultUsd: number;
  /** what the target's ENS names resolve to now (name -> address) */
  ens: Record<string, Address | null>;
}

export interface SimEvent {
  phase: SimPhase;
  level: "info" | "success" | "danger" | "warn";
  msg: string;
  tx?: Hex;
  holdings?: SimHoldings;
  action?: SimAction;
  report?: ResidualReport;
}

export interface SimResult {
  address: Address;
  name?: string;
  forkBlock: bigint;
  attacker: Address;
  vault: Address;
  before: ResidualReport;
  after: ResidualReport;
  attack: SimAction[];
  reattack: SimAction[];
  stolenUsd: number;
  stolenAfterUsd: number;
  /** surfaces GhostKey can't close from the account (e.g. ENSv1 names, multi-sig Safes) */
  remaining: string[];
  /** clean-state snapshot to pass as `base` to the next run */
  nextBase: Hex;
}

export interface SimOptions {
  /** the simulator's own anvil, forked at a PINNED block (Foundry caches its state on disk) */
  anvilUrl: string;
  /** clean-state snapshot to rewind to before this run (from a previous run's `nextBase`) */
  base?: Hex;
  /** upstream mainnet RPC to fork from */
  forkUrl: string;
  /** address or ENS name */
  target: string;
  onEvent?: (e: SimEvent) => void;
}

/** anvil helpers via raw JSON-RPC (the fork is reset under viem's feet, so no caching anywhere). */
async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Upstream RPC client whose "latest" is pinned to `block`: reads are fast (no lazy fork fetching)
 * and consistent with the fork's state at that block.
 */
function pinnedClient(url: string, block: bigint): PublicClient {
  const tag = `0x${block.toString(16)}`;
  const PIN = new Set(["eth_call", "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getStorageAt"]);
  const base = http(url, { timeout: 60_000, batch: { batchSize: 50 } });
  const transport: typeof base = (args) => {
    const t = base(args);
    return {
      ...t,
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_blockNumber") return tag;
        if (PIN.has(method) && Array.isArray(params)) {
          const p = [...params];
          if (p.length && (p[p.length - 1] === "latest" || p[p.length - 1] === "pending")) p[p.length - 1] = tag;
          else if (method === "eth_call" && p.length === 1) p.push(tag);
          else if ((method === "eth_getBalance" || method === "eth_getCode" || method === "eth_getTransactionCount") && p.length === 1) p.push(tag);
          return t.request({ method, params: p } as never);
        }
        return t.request({ method, params } as never);
      },
    } as ReturnType<typeof base>;
  };
  return createPublicClient({ chain: mainnet, transport, cacheTime: 0 }) as PublicClient;
}

export async function simulateQday(opts: SimOptions): Promise<SimResult> {
  const { anvilUrl, forkUrl, onEvent = () => {} } = opts;
  const emit = (e: SimEvent) => onEvent(e);

  // ---- resolve the target on real mainnet (the UniversalResolver also sees ENSv2 names)
  const upstream = createPublicClient({ chain: mainnet, transport: http(forkUrl) });
  let address: Address;
  let name: string | undefined;
  if (/^0x[0-9a-fA-F]{40}$/.test(opts.target)) address = getAddress(opts.target);
  else {
    name = normalize(opts.target);
    const resolved = await upstream.getEnsAddress({ name });
    if (!resolved) throw new Error(`${opts.target} doesn't resolve to an address`);
    address = resolved;
  }

  // ---- clean state: rewind to the base snapshot (keeps fetched mainnet state warm), never re-fork
  emit({ phase: "forking", level: "info", msg: `Loading live mainnet state for ${name ?? short(address)}…` });
  if (opts.base) await rpc(anvilUrl, "evm_revert", [opts.base]);
  const nextBase = await rpc<Hex>(anvilUrl, "evm_snapshot");
  const transport = http(anvilUrl, { retryCount: 0, timeout: 120_000 }); // a fresh fork pulls state lazily
  const pc = createPublicClient({ chain: mainnet, transport, cacheTime: 0 }) as PublicClient;
  const forkBlock = await pc.getBlockNumber();
  const up = pinnedClient(forkUrl, forkBlock);
  emit({ phase: "forking", level: "success", msg: `Mainnet fork at block ${forkBlock}` });

  const attacker = getAddress("0x00000000000000000000000000000000005e1f1e"); // "self-ie": a fresh address standing in for the attacker
  const vault = getAddress("0x0000000000000000000000000000000000c0ffee"); // stands in for the user's fresh post-quantum account

  const prices = await getUsdPrices(up, TOKENS);
  const mc3Abi = parseAbi(["function getEthBalance(address) view returns (uint256)"]);
  /** USD (ETH + curated tokens) for many addresses in ONE multicall. */
  const usdMany = async (whos: Address[], via: "fork" | "upstream" = "fork"): Promise<number[]> => {
    const contracts = whos.flatMap((who) => [
      { address: MAINNET.multicall3, abi: mc3Abi, functionName: "getEthBalance" as const, args: [who] as const },
      ...TOKENS.map((t) => ({ address: t.address, abi: viemErc20Abi, functionName: "balanceOf" as const, args: [who] as const })),
    ]);
    // upstream: one multicall (fast). fork: individual calls in parallel, so anvil fetches cold slots concurrently.
    const res = via === "upstream" ? await up.multicall({ contracts, allowFailure: true, multicallAddress: MAINNET.multicall3 }) : await Promise.all(
      contracts.map((c) =>
        pc.readContract(c as never).then(
          (result) => ({ status: "success" as const, result }),
          () => ({ status: "failure" as const, result: undefined }),
        ),
      ),
    );
    const per = TOKENS.length + 1;
    return whos.map((_, i) => {
      const r = res.slice(i * per, (i + 1) * per);
      let usd = r[0]!.status === "success" ? (Number(r[0]!.result as bigint) / 1e18) * prices.eth : 0;
      TOKENS.forEach((t, k) => {
        const x = r[k + 1]!;
        if (x.status === "success") usd += (Number(x.result as bigint) / 10 ** t.decimals) * (prices.byToken.get(t.address) ?? 0);
      });
      return usd;
    });
  };
  const usdOf = async (who: Address) => (await usdMany([who]))[0]!;

  /** Pre-fetch fork state in PARALLEL by simulating calls concurrently (anvil otherwise fetches slot by slot). */
  async function warm(calls: { to: Address; data?: Hex; value?: bigint }[], from: Address = address) {
    await Promise.all(
      calls.map((c) =>
        rpc(anvilUrl, "eth_call", [{ from, to: c.to, data: c.data ?? "0x", value: c.value ? `0x${c.value.toString(16)}` : undefined, gas: "0x2dc6c0", gasPrice: "0x0" }, "latest"]).catch(() => {}),
      ),
    );
  }

  /** Sends a tx as `from` (impersonated) with zero gas cost, so balances stay exact. */
  async function sendAs(from: Address, to: Address, data: Hex = "0x", value = 0n): Promise<Hex> {
    await rpc(anvilUrl, "anvil_impersonateAccount", [from]);
    await rpc(anvilUrl, "anvil_setNextBlockBaseFeePerGas", ["0x0"]);
    const w = createWalletClient({ chain: mainnet, transport, account: from, cacheTime: 0 });
    const hash = await w.sendTransaction({ to, data, value, gas: 3_000_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
    const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 300_000 });
    await rpc(anvilUrl, "anvil_stopImpersonatingAccount", [from]);
    if (r.status !== "success") throw new Error("reverted");
    return hash;
  }

  // ---- scan
  emit({ phase: "scanning", level: "info", msg: "GhostKey scan of the live account…" });
  const ensNames = name ? [name] : [];
  const before = await scanAccount(up, address, { ensNames, rpcOnly: false });
  emit({ phase: "scanning", level: before.usdControlledByOldKey > 0.5 ? "danger" : "success", msg: `Old key still controls $${Math.round(before.usdControlledByOldKey).toLocaleString("en-US")}`, report: before });

  const safes = before.findings.filter((f) => f.surface === "safe-owner" && f.severity === "exposed").flatMap((f) => f.assets.filter((a) => a.kind === "safe").map((a) => a.address));
  const safeValues = safes.length ? await usdMany(safes, "upstream") : [];
  const valuableSafes = safes.filter((_, i) => safeValues[i]! > 1);
  const emptySafes = safes.length - valuableSafes.length;
  const ensAssets = before.findings.filter((f) => f.surface === "ens-roles").flatMap((f) => f.assets.filter((a) => a.kind === "ens-name"));
  const ensTargets = [...new Set([...ensNames, ...ensAssets.map((a) => a.symbol)])];

  /** Cheap name resolution on the fork: ENSv1 registry resolver, else the ENSv2 resolver (no UniversalResolver). */
  const v1AddrAbi = parseAbi(["function addr(bytes32 node) view returns (address)"]);
  const resolveOnFork = async (n: string): Promise<Address | null> => {
    try {
      const node = namehash(n);
      const r1 = await pc.readContract({ address: MAINNET.ens.v1Registry, abi: ensV1RegistryAbi, functionName: "resolver", args: [node] });
      if (r1 !== "0x0000000000000000000000000000000000000000") return await pc.readContract({ address: r1, abi: v1AddrAbi, functionName: "addr", args: [node] });
      const label = n.replace(/\.eth$/, "");
      const r2 = await pc.readContract({ address: MAINNET.ens.ethRegistry, abi: ensPermissionedRegistryAbi, functionName: "getResolver", args: [label] });
      const out = await pc.readContract({ address: r2, abi: ensPermissionedResolverAbi, functionName: "resolve", args: [dnsEncode(n), encodeFunctionData({ abi: v1AddrAbi, functionName: "addr", args: [node] })] });
      return getAddress(`0x${out.slice(-40)}`);
    } catch {
      return null;
    }
  };

  const holdings = async (): Promise<SimHoldings> => {
    const [targetUsd, attackerUsd, vaultUsd, ...safeUsd] = await usdMany([address, attacker, vault, ...valuableSafes]);
    const ens: Record<string, Address | null> = {};
    await Promise.all(ensTargets.map(async (n) => (ens[n] = await resolveOnFork(n))));
    return { targetUsd, attackerUsd, vaultUsd, safesUsd: safeUsd.reduce((a, b) => a + b, 0), ens };
  };

  // ---- one full attack round, as the old key
  async function attackRound(phase: "attacking" | "reattacking"): Promise<SimAction[]> {
    const out: SimAction[] = [];
    const record = async (surface: SurfaceId, label: string, fn: () => Promise<{ ok: boolean; detail: string; tx?: Hex }>) => {
      const b = await usdOf(attacker);
      let res: { ok: boolean; detail: string; tx?: Hex };
      try {
        res = await fn();
      } catch (e) {
        res = { ok: false, detail: `blocked: ${(e as Error).message.split("\n")[0]}` };
      }
      const usdTaken = Math.max(0, (await usdOf(attacker)) - b);
      // rebasing tokens (stETH) leave 1-2 wei behind: a "theft" worth less than a cent is not a theft
      if (res.ok && (surface === "direct-tx" || surface === "safe-owner") && usdTaken < 0.01) res = { ok: false, detail: "only dust left: nothing to take" };
      const action: SimAction = { surface, label, usdTaken, ...res };
      out.push(action);
      emit({ phase, level: res.ok ? "danger" : "success", msg: `${res.ok ? "✗" : "✓"} ${label}: ${res.detail}`, tx: res.tx, action, holdings: await holdings() });
    };

    // 1. tokens + ETH, straight from the EOA
    await record("direct-tx", "Direct transfers from the EOA", async () => {
      const moved: string[] = [];
      let tx: Hex | undefined;
      for (const t of TOKENS) {
        const bal = await pc.readContract({ address: t.address, abi: viemErc20Abi, functionName: "balanceOf", args: [address] }).catch(() => 0n);
        if (bal === 0n) continue;
        try {
          tx = await sendAs(address, t.address, encodeFunctionData({ abi: viemErc20Abi, functionName: "transfer", args: [attacker, bal] }));
          moved.push(t.symbol);
        } catch {
          /* paused / blocklisted token: skip */
        }
      }
      const eth = await pc.getBalance({ address });
      if (eth > 0n) {
        tx = await sendAs(address, attacker, "0x", eth);
        moved.push("ETH");
      }
      return moved.length ? { ok: true, detail: `old key moved ${moved.join(", ")}`, tx } : { ok: false, detail: "nothing left in the EOA" };
    });

    // 2. Safes where the old key alone is enough (empty ones are summarised, not attacked one by one)
    if (emptySafes > 0 && phase === "attacking")
      emit({ phase, level: "warn", msg: `The old key also solely controls ${emptySafes} empty Safe${emptySafes === 1 ? "" : "s"} (future deposits are at risk)` });
    for (const safe of valuableSafes) {
      await record("safe-owner", `Safe ${short(safe)}`, async () => {
        const isOwner = await pc.readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [address] });
        if (!isOwner) return { ok: false, detail: "old key is no longer an owner" };
        const sig = (`0x${address.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01`) as Hex; // v=1: msg.sender is the owner
        const moved: string[] = [];
        let tx: Hex | undefined;
        for (const t of TOKENS) {
          const bal = await pc.readContract({ address: t.address, abi: viemErc20Abi, functionName: "balanceOf", args: [safe] }).catch(() => 0n);
          if (bal === 0n) continue;
          const data = encodeFunctionData({ abi: viemErc20Abi, functionName: "transfer", args: [attacker, bal] });
          tx = await sendAs(address, safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [t.address, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", sig] }));
          moved.push(t.symbol);
        }
        const eth = await pc.getBalance({ address: safe });
        if (eth > 0n) {
          tx = await sendAs(address, safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [attacker, eth, "0x", 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", sig] }));
          moved.push("ETH");
        }
        return moved.length ? { ok: true, detail: `old key emptied the Safe (${moved.join(", ")})`, tx } : { ok: true, detail: "old key controls the Safe (it's empty)" };
      });
    }

    // 3. ENS: re-point names / take the ENSv2 token
    for (const a of ensAssets) {
      const n = a.symbol;
      if (getAddress(a.address) === getAddress(MAINNET.ens.ethRegistry)) {
        await record("ens-roles", `${n}: steal the ENSv2 name`, async () => {
          const label = n.replace(/\.eth$/, "");
          const st = (await pc.readContract({ address: MAINNET.ens.ethRegistry, abi: ensPermissionedRegistryAbi, functionName: "getState", args: [BigInt(labelhash(label))] })) as { latestOwner: Address; tokenId: bigint };
          if (getAddress(st.latestOwner) !== address) return { ok: false, detail: "the name token is no longer with the old key" };
          const tx = await sendAs(address, MAINNET.ens.ethRegistry, encodeFunctionData({ abi: ensPermissionedRegistryAbi, functionName: "safeTransferFrom", args: [address, attacker, st.tokenId, 1n, "0x"] }));
          return { ok: true, detail: `old key transferred ${n} to the attacker`, tx };
        });
      } else if (getAddress(a.address) === getAddress(MAINNET.ens.v1Registry)) {
        await record("ens-roles", `${n}: re-point (ENSv1)`, async () => {
          const node = namehash(n);
          const res = await pc.readContract({ address: MAINNET.ens.v1Registry, abi: ensV1RegistryAbi, functionName: "resolver", args: [node] });
          const tx = await sendAs(address, res, encodeFunctionData({ abi: v1ResolverAbi, functionName: "setAddr", args: [node, attacker] }));
          return { ok: true, detail: `old key re-pointed ${n} → attacker`, tx };
        });
      } else {
        await record("ens-roles", `${n}: re-point (ENSv2 resolver role)`, async () => {
          const tx = await sendAs(address, a.address, encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "setAddress", args: [dnsEncode(n), 60n, attacker] }));
          return { ok: true, detail: `old key re-pointed ${n} → attacker`, tx };
        });
      }
    }
    return out;
  }

  const stolen = (as: SimAction[]) => as.reduce((s, a) => s + a.usdTaken, 0);

  const snap = await rpc<Hex>(anvilUrl, "evm_snapshot");
  emit({ phase: "attacking", level: "danger", msg: "Q-day: an attacker now holds this account's ECDSA key.", holdings: await holdings() });
  const attack = await attackRound("attacking");
  const stolenUsd = stolen(attack);
  emit({ phase: "attacking", level: stolenUsd > 0.5 ? "danger" : "info", msg: `Attacker walked away with $${Math.round(stolenUsd).toLocaleString("en-US")}`, holdings: await holdings() });

  // ---- rewind, migrate with GhostKey, re-attack
  emit({ phase: "rewinding", level: "info", msg: "Rewind: same account, before Q-day." });
  await rpc(anvilUrl, "evm_revert", [snap]);
  emit({ phase: "rewinding", level: "info", msg: "Rewound.", holdings: await holdings() });

  emit({ phase: "fixing", level: "info", msg: "GhostKey: building the complete-migration batch…" });
  // the fork is back at the base snapshot == upstream at forkBlock, so build from the fast pinned reads
  const mig = await buildMigration(up, before, vault, { activateKillswitch: false });
  await warm(mig.calls.map((c) => ({ to: c.to, data: c.data, value: c.value })));
  for (let i = 0; i < mig.calls.length; i++) {
    const c = mig.calls[i]!;
    try {
      const tx = await sendAs(address, c.to, c.data, c.value);
      emit({ phase: "fixing", level: "success", msg: `✓ ${mig.steps[i]!.description}`, tx, holdings: await holdings() });
    } catch (e) {
      emit({ phase: "fixing", level: "warn", msg: `skipped: ${mig.steps[i]!.description} (${(e as Error).message.split("\n")[0]})` });
    }
  }

  const reattack = await attackRound("reattacking");
  const stolenAfterUsd = stolen(reattack);
  // the empty Safes were swapped too; re-check only the ones that held value (fork state is warm for those)
  const after = await scanAccount(pc, address, { ensNames, safes: valuableSafes, rpcOnly: true });
  const remaining = reattack.filter((a) => a.ok && a.surface !== "direct-tx").map((a) => a.label);
  emit({
    phase: "done",
    level: stolenAfterUsd > 0.5 ? "warn" : "success",
    msg: `After GhostKey: attacker gets $${Math.round(stolenAfterUsd).toLocaleString("en-US")}` + (remaining.length ? `; still open: ${remaining.join(", ")}` : ""),
    report: after,
    holdings: await holdings(),
  });
  // leave the fork clean for the next run (the base snapshot is consumed on revert, so take a fresh one)
  await rpc(anvilUrl, "evm_revert", [nextBase]);
  const base = await rpc<Hex>(anvilUrl, "evm_snapshot");
  return { address, name, forkBlock, attacker, vault, before, after, attack, reattack, stolenUsd, stolenAfterUsd, remaining, nextBase: base };
}
