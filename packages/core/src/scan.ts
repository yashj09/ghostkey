import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { PQDelegate } from "./generated.js";
import { MAINNET, TOKENS } from "./mainnet.js";
import { getUsdPrices } from "./prices.js";
import { loadExtraTokenInfo, loadTokenState, type Detector, type PermitClass, type ScanContext } from "./surfaces/context.js";
import { detectEnsRoles } from "./surfaces/ens.js";
import { detectDirectTx, detectRedelegation } from "./surfaces/eoa.js";
import { detectEcrecoverPermit, detectErc1271Sig } from "./surfaces/permits.js";
import { detectSafeOwner } from "./surfaces/safe.js";
import type { AccountState, AssetAtRisk, Finding, ResidualReport, ScanHints, SurfaceId } from "./types.js";

/** Detectors in report order (surface 1 → 6). */
export const DETECTORS: [SurfaceId, Detector][] = [
  ["direct-tx", detectDirectTx],
  ["redelegation", detectRedelegation],
  ["ecrecover-permit", detectEcrecoverPermit],
  ["erc1271-sig", detectErc1271Sig],
  ["safe-owner", detectSafeOwner],
  ["ens-roles", detectEnsRoles],
];

/** EIP-7702 delegation designator: 0xef0100 ‖ 20-byte delegate. */
export function parseDelegation(code: Hex | undefined): Address | undefined {
  if (!code || code.length !== 2 + 46 || !code.toLowerCase().startsWith("0xef0100")) return undefined;
  return getAddress(`0x${code.slice(8)}`);
}

/**
 * RPC-only residual-authority scan. Every read goes through `client` (batched with Multicall3);
 * the only other request is the optional Safe Transaction Service lookup (disable with hints.rpcOnly).
 */
export async function scanAccount(client: PublicClient, address: Address, hints: ScanHints = {}): Promise<ResidualReport> {
  address = getAddress(address);
  const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  const [code, ethBalance, nonce] = await Promise.all([
    client.getCode({ address }),
    client.getBalance({ address }),
    client.getTransactionCount({ address }),
  ]);
  const delegatedTo = parseDelegation(code);
  const delegated = !!delegatedTo;
  const isContract = !!code && code !== "0x" && !delegated;

  const account: AccountState = { address, ethBalance, nonce, ...(delegatedTo ? { delegatedTo } : {}) };

  // Is the delegate a GhostKey PQDelegate? It answers killswitch() and pkSeed() on the account itself.
  let ghostKeyDelegate = false;
  if (delegated) {
    const [ks, seed] = await client.multicall({
      multicallAddress: MAINNET.multicall3,
      allowFailure: true,
      contracts: [
        { address, abi: PQDelegate.abi, functionName: "killswitch" },
        { address, abi: PQDelegate.abi, functionName: "pkSeed" },
      ],
    });
    if (ks.status === "success" && seed.status === "success") {
      ghostKeyDelegate = true;
      account.killswitch = ks.result as boolean;
    }
  }

  const extras = await loadExtraTokenInfo(client, hints.extraTokens ?? [], address);
  const tokenList: { info: (typeof TOKENS)[number]; permit: PermitClass }[] = [...TOKENS.map((info) => ({ info, permit: info.permit as PermitClass })), ...extras];
  const prices = await getUsdPrices(client, tokenList.map((t) => t.info));
  const tokens = await loadTokenState(client, address, tokenList, prices.byToken);

  const ctx: ScanContext = { client, address, account, blockNumber, code, delegated, isContract, ghostKeyDelegate, tokens, prices, hints };
  const results = await Promise.all(DETECTORS.map(([, d]) => d(ctx)));
  const findings = results.flatMap((r) => (Array.isArray(r) ? r : [r]));

  return { account, chainId, blockNumber, scannedAt: new Date().toISOString(), findings, ...totals(findings) };
}

const assetKey = (a: AssetAtRisk) => `${a.kind}:${a.address.toLowerCase()}`;

/**
 * Deduplicated totals. The same asset (e.g. DAI) shows up on several surfaces; count it once.
 * - usdControlledByOldKey: assets on exposed / protocol-only findings
 * - usdConditional: assets on conditional findings that aren't already counted above
 */
export function totals(findings: Finding[]): { usdControlledByOldKey: number; usdConditional: number } {
  const now = new Map<string, number>();
  const cond = new Map<string, number>();
  for (const f of findings) {
    const into = f.severity === "exposed" || f.severity === "protocol-only" ? now : f.severity === "conditional" ? cond : undefined;
    if (!into) continue;
    for (const a of f.assets) into.set(assetKey(a), Math.max(into.get(assetKey(a)) ?? 0, a.usd ?? 0));
  }
  let usdControlledByOldKey = 0;
  for (const v of now.values()) usdControlledByOldKey += v;
  let usdConditional = 0;
  for (const [k, v] of cond) if (!now.has(k)) usdConditional += v;
  return { usdControlledByOldKey, usdConditional };
}
