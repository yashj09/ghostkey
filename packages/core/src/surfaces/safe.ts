import { getAddress, isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { erc20Abi, safeAbi } from "../abis.js";
import { MAINNET, TOKENS } from "../mainnet.js";
import { toUsd } from "../prices.js";
import type { Finding } from "../types.js";
import { clear, fmtAmount, fmtUsd, noKey, type Detector } from "./context.js";

const getEthBalanceAbi = parseAbi(["function getEthBalance(address addr) view returns (uint256 balance)"]);

/**
 * Safes owned by `owner`, from the Safe Transaction Service. The only non-RPC call GhostKey makes
 * (skip it with hints.rpcOnly). Accepts `{safes: string[]}`, `{results: [...]}` or a bare array.
 */
export async function fetchSafesFromService(owner: Address, timeoutMs = 8000): Promise<{ safes: Address[]; error?: string }> {
  try {
    const res = await fetch(`${MAINNET.safeTxService}/owners/${getAddress(owner)}/safes/`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { safes: [], error: `Safe Transaction Service returned HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}` };
    const body: unknown = await res.json();
    const raw: unknown[] = Array.isArray(body)
      ? body
      : body && typeof body === "object"
        ? ((body as { safes?: unknown[]; results?: unknown[] }).safes ?? (body as { results?: unknown[] }).results ?? [])
        : [];
    const safes = raw
      .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? (x as { address?: string }).address : undefined))
      .filter((x): x is string => typeof x === "string" && isAddress(x))
      .map((x) => getAddress(x));
    return { safes };
  } catch (e) {
    return { safes: [], error: `Safe Transaction Service unreachable (${(e as Error).message ?? e})` };
  }
}

export interface SafeState {
  address: Address;
  owners: Address[];
  threshold: bigint;
  ethBalance: bigint;
  tokens: { address: Address; symbol: string; decimals: number; balance: bigint }[];
}

/** getOwners + getThreshold + ETH + curated token balances for each Safe, in one multicall. Non-Safes are dropped. */
export async function readSafes(client: PublicClient, safes: Address[]): Promise<SafeState[]> {
  if (safes.length === 0) return [];
  const per = 3 + TOKENS.length;
  const res = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: safes.flatMap((s) => [
      { address: s, abi: safeAbi, functionName: "getOwners" as const },
      { address: s, abi: safeAbi, functionName: "getThreshold" as const },
      { address: MAINNET.multicall3, abi: getEthBalanceAbi, functionName: "getEthBalance" as const, args: [s] as const },
      ...TOKENS.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [s] as const })),
    ]),
  });
  const out: SafeState[] = [];
  safes.forEach((address, i) => {
    const o = res[i * per];
    const th = res[i * per + 1];
    if (o?.status !== "success" || th?.status !== "success") return;
    const eth = res[i * per + 2];
    out.push({
      address,
      owners: (o.result as readonly Address[]).map((a) => getAddress(a)),
      threshold: th.result as bigint,
      ethBalance: eth?.status === "success" ? (eth.result as bigint) : 0n,
      tokens: TOKENS.map((t, j) => {
        const b = res[i * per + 3 + j];
        return { address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals, balance: b?.status === "success" ? (b.result as bigint) : 0n };
      }).filter((t) => t.balance > 0n),
    });
  });
  return out;
}

/** Surface 5: Safe owner signatures with v = 27/28 are checked with ecrecover, regardless of the owner's code. */
export const detectSafeOwner: Detector = async (ctx) => {
  if (ctx.isContract) return noKey("safe-owner", "Safe ownership");
  const candidates = new Set<Address>((ctx.hints.safes ?? []).map((s) => getAddress(s)));
  let serviceNote = "";
  if (!ctx.hints.rpcOnly) {
    const { safes, error } = await fetchSafesFromService(ctx.address);
    safes.forEach((s) => candidates.add(s));
    if (error) serviceNote = ` ${error}; pass hints.safes to check Safes directly.`;
  }
  const states = await readSafes(ctx.client, [...candidates]);
  const owned = states.filter((s) => s.owners.some((o) => o === getAddress(ctx.address)));

  if (owned.length === 0) {
    const how = ctx.hints.rpcOnly ? "RPC-only mode: checked hinted Safes only." : "Checked hinted Safes and the Safe Transaction Service.";
    return clear("safe-owner", "Safe ownership", `Not an owner of any Safe found (${candidates.size} checked). ${how}${serviceNote}`.trim());
  }

  return owned.map((s): Finding => {
    let usd = toUsd(s.ethBalance, 18, ctx.prices.eth || undefined) ?? 0;
    const parts = s.ethBalance > 0n ? [`${fmtAmount(s.ethBalance, 18)} ETH`] : [];
    for (const t of s.tokens) {
      usd += toUsd(t.balance, t.decimals, ctx.prices.byToken.get(t.address)) ?? 0;
      parts.push(`${fmtAmount(t.balance, t.decimals)} ${t.symbol}`);
    }
    const n = s.owners.length;
    const solo = s.threshold <= 1n;
    const holdings = parts.length ? parts.join(" + ") : "no curated assets";
    return {
      surface: "safe-owner",
      severity: solo ? "exposed" : "conditional",
      title: solo ? `Old key alone controls Safe ${s.address.slice(0, 8)}…` : `Old key is 1 of ${s.threshold} signatures on Safe ${s.address.slice(0, 8)}…`,
      detail: solo
        ? `Threshold 1 of ${n} owners: one ECDSA signature from the old key (checked with ecrecover) moves ${fmtUsd(usd)} (${holdings}).`
        : `Threshold ${s.threshold} of ${n} owners: the old key supplies one signature; ${s.threshold - 1n} more needed to move ${fmtUsd(usd)} (${holdings}).` + serviceNote,
      assets: [
        {
          kind: "safe",
          address: s.address,
          symbol: "Safe",
          amount: 1n,
          decimals: 0,
          usd,
          note: `${solo ? 1 : s.threshold} of ${n} owners; holds ${holdings}`,
        },
      ],
      usdAtRisk: usd,
      fixable: solo,
      fix: solo
        ? "Swap the old key out for the post-quantum account: execTransaction(swapOwner) from the account, authorised by the v=1 \"msg.sender is owner\" signature."
        : `Needs ${s.threshold - 1n} co-owner signature(s): ask the other owners to swapOwner(old key → post-quantum account). GhostKey's batch can't do it alone.`,
    };
  });
};
