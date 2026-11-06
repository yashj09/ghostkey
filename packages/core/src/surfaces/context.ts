import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { erc20Abi } from "../abis.js";
import { MAINNET, TOKENS, type TokenInfo } from "../mainnet.js";
import { toUsd } from "../prices.js";
import type { AccountState, AssetAtRisk, Finding, ScanHints } from "../types.js";

/** Placeholder "token address" for native ETH in AssetAtRisk. */
export const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export type PermitClass = TokenInfo["permit"] | "ecrecover-probed";

export interface HeldToken {
  info: TokenInfo;
  /** permit kind; extra tokens that answer DOMAIN_SEPARATOR()/nonces() become "ecrecover-probed" */
  permit: PermitClass;
  balance: bigint;
  /** ERC-20 allowance(account, Permit2) */
  permit2Allowance: bigint;
  usd?: number;
}

export interface ScanContext {
  client: PublicClient;
  address: Address;
  account: AccountState;
  blockNumber: bigint;
  /** account bytecode (undefined / 0x for a plain EOA) */
  code?: Hex;
  /** EIP-7702 delegated (code = 0xef0100 ‖ delegate) */
  delegated: boolean;
  /** a real contract (not a delegation designator): no EOA key exists */
  isContract: boolean;
  /** delegate answers killswitch() + pkSeed(): a GhostKey PQDelegate */
  ghostKeyDelegate: boolean;
  /** curated + extra tokens with their balance / Permit2 allowance for this account */
  tokens: HeldToken[];
  prices: { eth: number; byToken: Map<Address, number> };
  hints: ScanHints;
}

export type Detector = (ctx: ScanContext) => Promise<Finding | Finding[]>;

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

/** Raw Multicall3 aggregate3 (no decoding), so callers can check returnData length themselves. */
export async function rawMulticall(client: PublicClient, calls: { target: Address; callData: Hex }[]) {
  if (calls.length === 0) return [];
  const res = await client.readContract({
    address: MAINNET.multicall3,
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls.map((c) => ({ ...c, allowFailure: true }))],
  });
  return res as readonly { success: boolean; returnData: Hex }[];
}

const isWord = (r: { success: boolean; returnData: Hex } | undefined) => !!r && r.success && r.returnData.length === 66;

/**
 * Probe unknown ERC-20s for a permit path: DOMAIN_SEPARATOR() or nonces(holder) returning exactly 32 bytes.
 * Length matters: WETH-style fallbacks "succeed" with empty return data for any selector.
 * (UNI / COMP expose nonces() but no DOMAIN_SEPARATOR(), so either is enough.)
 */
export async function probePermit(client: PublicClient, tokens: Address[], holder: Address): Promise<Map<Address, boolean>> {
  const calls = tokens.flatMap((t) => [
    { target: t, callData: encodeFunctionData({ abi: erc20Abi, functionName: "DOMAIN_SEPARATOR" }) },
    { target: t, callData: encodeFunctionData({ abi: erc20Abi, functionName: "nonces", args: [holder] }) },
  ]);
  const res = await rawMulticall(client, calls);
  const out = new Map<Address, boolean>();
  tokens.forEach((t, i) => out.set(getAddress(t), isWord(res[2 * i]) || isWord(res[2 * i + 1])));
  return out;
}

/** Metadata for extra tokens not in the curated list (symbol/decimals via multicall, tolerant of odd tokens). */
export async function loadExtraTokenInfo(client: PublicClient, extra: Address[], holder: Address): Promise<{ info: TokenInfo; permit: PermitClass }[]> {
  const known = new Set(TOKENS.map((t) => t.address.toLowerCase()));
  const list = [...new Set(extra.map((a) => getAddress(a)))].filter((a) => !known.has(a.toLowerCase()));
  if (list.length === 0) return [];
  const [meta, probe] = await Promise.all([
    client.multicall({
      multicallAddress: MAINNET.multicall3,
      allowFailure: true,
      contracts: list.flatMap((address) => [
        { address, abi: erc20Abi, functionName: "symbol" as const },
        { address, abi: erc20Abi, functionName: "decimals" as const },
      ]),
    }),
    probePermit(client, list, holder),
  ]);
  return list.map((address, i) => {
    const sym = meta[2 * i];
    const dec = meta[2 * i + 1];
    const symbol = sym?.status === "success" ? String(sym.result) : `${address.slice(0, 8)}…`;
    const decimals = dec?.status === "success" ? Number(dec.result) : 18;
    const probed = probe.get(address) ?? false;
    const info: TokenInfo = { address, symbol, decimals, permit: probed ? "ecrecover" : "none", price: null, permitSource: "probe" };
    return { info, permit: probed ? ("ecrecover-probed" as const) : ("none" as const) };
  });
}

/** balanceOf + allowance(holder, Permit2) for each token, in one multicall. Failing calls read as 0. */
export async function loadTokenState(
  client: PublicClient,
  holder: Address,
  tokens: { info: TokenInfo; permit: PermitClass }[],
  prices: Map<Address, number>,
): Promise<HeldToken[]> {
  const res = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: tokens.flatMap(({ info }) => [
      { address: info.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [holder] as const },
      { address: info.address, abi: erc20Abi, functionName: "allowance" as const, args: [holder, MAINNET.permit2] as const },
    ]),
  });
  return tokens.map(({ info, permit }, i) => {
    const b = res[2 * i];
    const a = res[2 * i + 1];
    const balance = b?.status === "success" ? (b.result as bigint) : 0n;
    const permit2Allowance = a?.status === "success" ? (a.result as bigint) : 0n;
    return { info, permit, balance, permit2Allowance, usd: toUsd(balance, info.decimals, prices.get(getAddress(info.address))) };
  });
}

export function tokenAsset(t: HeldToken, note?: string): AssetAtRisk {
  return { kind: "erc20", address: getAddress(t.info.address), symbol: t.info.symbol, amount: t.balance, decimals: t.info.decimals, usd: t.usd, note };
}

export function ethAsset(ctx: ScanContext): AssetAtRisk {
  return {
    kind: "eth",
    address: ETH_ADDRESS,
    symbol: "ETH",
    amount: ctx.account.ethBalance,
    decimals: 18,
    usd: toUsd(ctx.account.ethBalance, 18, ctx.prices.eth || undefined),
  };
}

export const sumUsd = (assets: AssetAtRisk[]) => assets.reduce((s, a) => s + (a.usd ?? 0), 0);

export function fmtAmount(amount: bigint, decimals: number, max = 4): string {
  const n = Number(amount) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export function fmtUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Shared "nothing to see" finding. */
export function clear(surface: Finding["surface"], title: string, detail: string, fix = "Nothing to do."): Finding {
  return { surface, severity: "clear", title, detail, assets: [], usdAtRisk: 0, fixable: true, fix };
}

/** Finding used when the scanned address is a real contract: there is no EOA private key to leak. */
export function noKey(surface: Finding["surface"], title: string): Finding {
  return clear(surface, title, "The address is a contract, not an EOA: there is no ECDSA private key behind it.");
}
