// 7702 census: who "upgraded" with EIP-7702 recently, who is still delegated now, and how much value their
// OLD ECDSA KEYS still control. Rules are written into the output so the number can be checked.
//   CENSUS_BLOCKS=7200 pnpm -F @ghostkey/core census
// Block fetching uses CENSUS_BLOCK_RPC (default: a public node, to spare your key); state uses MAINNET_RPC_URL.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, decodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { TOKENS, ETH_USD_FEED, MAINNET } from "../src/mainnet.js";
import { getUsdPrices } from "../src/prices.js";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../apps/web/public/census.json");
const BLOCKS = Number(process.env.CENSUS_BLOCKS ?? 7200);
const BLOCK_RPC = process.env.CENSUS_BLOCK_RPC ?? "https://ethereum-rpc.publicnode.com";
const STATE_RPC = process.env.MAINNET_RPC_URL ?? BLOCK_RPC;
const CONC = Number(process.env.CENSUS_CONCURRENCY ?? 8);
const WALLET_MIN_CODE = 5000; // bytes: delegates at least this big are treated as smart-wallet implementations
void ETH_USD_FEED;

type Json = Record<string, unknown>;
async function rpc<T>(url: string, body: Json | Json[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as T;
    } catch (e) {
      if (attempt >= 4) throw new Error(`rpc failed: ${(e as Error).message}`); // never print the URL (may hold a key)
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
}
const call = (method: string, params: unknown[], id = 1) => ({ jsonrpc: "2.0", id, method, params });

interface Auth { chainId: Hex; address: Address; nonce: Hex; yParity: Hex; r: Hex; s: Hex }
interface Tx { type: Hex; authorizationList?: Auth[] }

const t0 = Date.now();
const head = BigInt((await rpc<{ result: Hex }>(BLOCK_RPC, call("eth_blockNumber", []))).result);
const from = head - BigInt(BLOCKS) + 1n;
console.log(`census: blocks ${from}..${head} (${BLOCKS})`);

// ---- 1. type-4 transactions -> authorities (latest authorization per authority wins)
const latest = new Map<Address, { delegate: Address; block: bigint }>();
let type4 = 0;
let auths = 0;
for (let b = head; b >= from; b -= BigInt(CONC)) {
  const nums = Array.from({ length: CONC }, (_, i) => b - BigInt(i)).filter((n) => n >= from);
  const res = await rpc<{ id: number; result: { number: Hex; transactions: Tx[] } }[]>(
    BLOCK_RPC,
    nums.map((n, i) => call("eth_getBlockByNumber", [`0x${n.toString(16)}`, true], i)),
  );
  for (const r of res) {
    if (!r.result) continue;
    const bn = BigInt(r.result.number);
    for (const tx of r.result.transactions) {
      if (tx.type !== "0x4" || !tx.authorizationList) continue;
      type4++;
      for (const a of tx.authorizationList) {
        auths++;
        if (BigInt(a.chainId) !== 1n && BigInt(a.chainId) !== 0n) continue;
        try {
          const who = await recoverAuthorizationAddress({ authorization: { chainId: Number(a.chainId), address: a.address, nonce: Number(a.nonce), yParity: Number(a.yParity), r: a.r, s: a.s } });
          const prev = latest.get(who);
          if (!prev || bn >= prev.block) latest.set(who, { delegate: getAddress(a.address), block: bn });
        } catch {
          /* malformed signature: the protocol skips it too */
        }
      }
    }
  }
  if (Number(head - b) % 500 < CONC) console.log(`  …${Number(head - b)}/${BLOCKS} blocks, ${latest.size} authorities, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ---- 2. who is STILL delegated right now (code = 0xef0100 || delegate)
const authorities = [...latest.keys()];
const stillDelegated = new Map<Address, Address>();
for (let i = 0; i < authorities.length; i += 200) {
  const chunk = authorities.slice(i, i + 200);
  const res = await rpc<{ id: number; result?: Hex }[]>(STATE_RPC, chunk.map((a, k) => call("eth_getCode", [a, "latest"], k)));
  for (const r of Array.isArray(res) ? res : []) {
    const code = r.result ?? "0x";
    if (code.length === 48 && code.startsWith("0xef0100")) stillDelegated.set(chunk[r.id]!, getAddress(`0x${code.slice(8)}`));
  }
}

// ---- 3. classify delegates by code size
const delegates = [...new Set(stillDelegated.values())];
const codeSize = new Map<Address, number>();
for (let i = 0; i < delegates.length; i += 100) {
  const chunk = delegates.slice(i, i + 100);
  const res = await rpc<{ id: number; result?: Hex }[]>(STATE_RPC, chunk.map((d, k) => call("eth_getCode", [d, "latest"], k)));
  for (const r of Array.isArray(res) ? res : []) codeSize.set(chunk[r.id]!, ((r.result ?? "0x").length - 2) / 2);
}

// ---- 4. price every still-delegated account (ETH + curated tokens) via Multicall3
const client = createPublicClient({ chain: mainnet, transport: http(STATE_RPC, { timeout: 60_000 }) });
const prices = await getUsdPrices(client as never, TOKENS);
const mcAbi = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])", "function getEthBalance(address) view returns (uint256)"]);
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const accounts = [...stillDelegated.keys()];
const usd = new Map<Address, number>();
const PER = TOKENS.length + 1;
const ACC_PER_CALL = Math.floor(400 / PER);
const priceChunk = async (chunk: Address[]): Promise<void> => {
  const calls = chunk.flatMap((a) => [
    { target: MAINNET.multicall3, allowFailure: true, callData: encodeFunctionData({ abi: mcAbi, functionName: "getEthBalance", args: [a] }) },
    ...TOKENS.map((t) => ({ target: t.address, allowFailure: true, callData: encodeFunctionData({ abi: balAbi, functionName: "balanceOf", args: [a] }) })),
  ]);
  const data = encodeFunctionData({ abi: mcAbi, functionName: "aggregate3", args: [calls] });
  const res = await rpc<{ result?: Hex; error?: { message: string } }>(STATE_RPC, call("eth_call", [{ to: MAINNET.multicall3, data }, "latest"]));
  if (!res.result) {
    // too big / node hiccup: split and retry; a single failing account is priced at 0
    if (chunk.length > 1) {
      const h = Math.ceil(chunk.length / 2);
      await priceChunk(chunk.slice(0, h));
      await priceChunk(chunk.slice(h));
    }
    return;
  }
  const out = decodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", data: res.result }) as readonly { success: boolean; returnData: Hex }[];
  chunk.forEach((a, k) => {
    let v = 0;
    const eth = out[k * PER]!;
    if (eth.success && eth.returnData.length > 2) v += (Number(BigInt(eth.returnData)) / 1e18) * prices.eth;
    TOKENS.forEach((t, j) => {
      const x = out[k * PER + 1 + j]!;
      if (x.success && x.returnData.length === 66) v += (Number(BigInt(x.returnData)) / 10 ** t.decimals) * (prices.byToken.get(t.address) ?? 0);
    });
    usd.set(a, v);
  });
};
for (let i = 0; i < accounts.length; i += ACC_PER_CALL) await priceChunk(accounts.slice(i, i + ACC_PER_CALL));

// ---- 5. aggregate
type Cls = "wallet" | "minimal";
const cls = (d: Address): Cls => ((codeSize.get(d) ?? 0) >= WALLET_MIN_CODE ? "wallet" : "minimal");
const agg: Record<Cls, { accounts: number; usd: number; withValue: number; delegates: Map<Address, { accounts: number; usd: number }> }> = {
  wallet: { accounts: 0, usd: 0, withValue: 0, delegates: new Map() },
  minimal: { accounts: 0, usd: 0, withValue: 0, delegates: new Map() },
};
for (const [a, d] of stillDelegated) {
  const c = agg[cls(d)];
  const v = usd.get(a) ?? 0;
  c.accounts++;
  c.usd += v;
  if (v >= 1) c.withValue++;
  const e = c.delegates.get(d) ?? { accounts: 0, usd: 0 };
  e.accounts++;
  e.usd += v;
  c.delegates.set(d, e);
}
const top = (m: Map<Address, { accounts: number; usd: number }>) =>
  [...m.entries()].sort((x, y) => y[1].usd - x[1].usd).slice(0, 10).map(([address, e]) => ({ address, codeSize: codeSize.get(address) ?? 0, accounts: e.accounts, usd: Math.round(e.usd) }));
const topAccounts = [...stillDelegated.entries()]
  .filter(([, d]) => cls(d) === "wallet")
  .map(([address, delegate]) => ({ address, delegate, usd: Math.round(usd.get(address) ?? 0) }))
  .sort((x, y) => y.usd - x.usd)
  .slice(0, 15);

const out = {
  generatedAt: new Date().toISOString(),
  blocks: { from: Number(from), to: Number(head), count: BLOCKS },
  rules: {
    window: `type-4 (EIP-7702) transactions in blocks ${from}–${head}`,
    authority: "signer recovered from each authorization tuple; the latest authorization per authority wins",
    stillDelegated: "account code is 0xef0100‖delegate at the head block (cleared or re-pointed delegations are dropped)",
    walletClass: `delegate bytecode ≥ ${WALLET_MIN_CODE} bytes ⇒ smart-wallet upgrade; smaller ⇒ minimal delegate (bots, batchers, sweepers)`,
    value: "ETH + GhostKey's curated tokens (DAI, USDC, USDT, UNI, wstETH, stETH, AAVE, LINK, ENA, USDe, WETH), Chainlink prices via the same RPC",
    whyItCounts: "EIP-7702 never disables the account's ECDSA key: every unit of this value can still be moved by it",
  },
  totals: { type4Txs: type4, authorizations: auths, uniqueAuthorities: latest.size, stillDelegated: stillDelegated.size, usd: Math.round(agg.wallet.usd + agg.minimal.usd) },
  wallet: { accounts: agg.wallet.accounts, withValue: agg.wallet.withValue, usd: Math.round(agg.wallet.usd), topDelegates: top(agg.wallet.delegates) },
  minimal: { accounts: agg.minimal.accounts, withValue: agg.minimal.withValue, usd: Math.round(agg.minimal.usd), topDelegates: top(agg.minimal.delegates) },
  topAccounts,
  tookSeconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ totals: out.totals, wallet: { accounts: out.wallet.accounts, usd: out.wallet.usd }, minimal: { accounts: out.minimal.accounts, usd: out.minimal.usd }, secs: out.tookSeconds }));
console.log(`wrote ${OUT}`);
