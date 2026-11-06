// 7702 census: who "upgraded" with EIP-7702 recently, who is still delegated now, and how much value their
// OLD ECDSA KEYS still control. Rules are written into the output so the number can be checked.
//   CENSUS_BLOCKS=7200 pnpm -F @ghostkey/core census
// Errors are retried with backoff and never silently turned into zeros; the run fails loudly instead.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";
import { MAINNET, TOKENS } from "../src/mainnet.js";
import { getUsdPrices } from "../src/prices.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../apps/web/public/census.json");
const BLOCKS = Number(process.env.CENSUS_BLOCKS ?? 7200);
const RPC = process.env.MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const CONC = Number(process.env.CENSUS_CONCURRENCY ?? 5);
const WALLET_MIN_CODE = 5000; // bytes: delegates at least this big are treated as smart-wallet implementations

type Json = Record<string, unknown>;
interface RpcRes<T> { id?: number; result?: T; error?: { code: number; message: string } }

/** JSON-RPC with retries + exponential backoff (429s included). Never prints the URL (it may hold a key). */
async function rpc<T>(body: Json): Promise<T>;
async function rpc<T>(body: Json[]): Promise<T[]>;
async function rpc<T>(body: Json | Json[]): Promise<T | T[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as RpcRes<T> | RpcRes<T>[];
      const list = Array.isArray(j) ? j : [j];
      const bad = list.find((x) => x.error);
      if (bad) throw new Error(`rpc error ${bad.error!.code}: ${bad.error!.message.slice(0, 120)}`);
      if (!Array.isArray(body)) return (list[0] as RpcRes<T>).result as T;
      const byId = new Map(list.map((x) => [x.id, x.result as T]));
      return body.map((b) => byId.get(b.id as number) as T);
    } catch (e) {
      if (attempt >= 7) throw new Error(`census rpc failed after retries: ${(e as Error).message}`);
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
    }
  }
}
const call = (method: string, params: unknown[], id = 1) => ({ jsonrpc: "2.0", id, method, params });

interface Auth { chainId: Hex; address: Address; nonce: Hex; yParity: Hex; r: Hex; s: Hex }
interface Tx { type: Hex; authorizationList?: Auth[] }

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const head = BigInt(await rpc<Hex>(call("eth_blockNumber", [])));
const from = head - BigInt(BLOCKS) + 1n;
console.log(`census: blocks ${from}..${head} (${BLOCKS})`);

// ---- 1. type-4 transactions -> authorities (the latest authorization per authority wins)
const latest = new Map<Address, { delegate: Address; block: bigint }>();
let type4 = 0;
let auths = 0;
for (let b = head; b >= from; b -= BigInt(CONC)) {
  const nums = Array.from({ length: CONC }, (_, i) => b - BigInt(i)).filter((n) => n >= from);
  const blocks = await Promise.all(nums.map((n) => rpc<{ number: Hex; transactions: Tx[] }>(call("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]))));
  for (const blk of blocks) {
    const bn = BigInt(blk.number);
    for (const tx of blk.transactions) {
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
  const done = Number(head - b) + CONC;
  if (done % 300 < CONC) console.log(`  …${done}/${BLOCKS} blocks, ${latest.size} authorities, ${secs()}`);
}

// ---- 2. classify the (few hundred) delegates by code size
const delegates = [...new Set([...latest.values()].map((v) => v.delegate))];
const codeSize = new Map<Address, number>();
for (let i = 0; i < delegates.length; i += 20) {
  const chunk = delegates.slice(i, i + 20);
  const codes = await rpc<Hex>(chunk.map((d, k) => call("eth_getCode", [d, "latest"], k)));
  chunk.forEach((d, k) => codeSize.set(d, ((codes[k] ?? "0x").length - 2) / 2));
}
type Cls = "wallet" | "minimal";
const cls = (d: Address): Cls => ((codeSize.get(d) ?? 0) >= WALLET_MIN_CODE ? "wallet" : "minimal");
console.log(`delegates: ${delegates.length} (${delegates.filter((d) => cls(d) === "wallet").length} wallet-class), ${secs()}`);

// ---- 3. wallet-class authorities: still delegated right now?
const walletAuth = [...latest.entries()].filter(([, v]) => cls(v.delegate) === "wallet").map(([a]) => a);
const stillDelegated = new Map<Address, Address>();
for (let i = 0; i < walletAuth.length; i += 20) {
  const chunk = walletAuth.slice(i, i + 20);
  const codes = await rpc<Hex>(chunk.map((a, k) => call("eth_getCode", [a, "latest"], k)));
  chunk.forEach((a, k) => {
    const code = codes[k] ?? "0x";
    if (code.length === 48 && code.startsWith("0xef0100")) {
      const d = getAddress(`0x${code.slice(8)}`);
      if (cls(d) === "wallet" || codeSize.has(d)) stillDelegated.set(a, d);
    }
  });
}
console.log(`wallet-class still delegated: ${stillDelegated.size}/${walletAuth.length}, ${secs()}`);

// ---- 4. price them (ETH + curated tokens) via Multicall3
const client = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 60_000, retryCount: 5 }) });
const prices = await getUsdPrices(client as never, TOKENS);
if (!(prices.eth > 0)) throw new Error("ETH price unavailable: refusing to publish a census priced at zero");
const mcAbi = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])", "function getEthBalance(address) view returns (uint256)"]);
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const accounts = [...stillDelegated.keys()];
const usd = new Map<Address, number>();
const PER = TOKENS.length + 1;
for (let i = 0; i < accounts.length; i += 25) {
  const chunk = accounts.slice(i, i + 25);
  const calls = chunk.flatMap((a) => [
    { target: MAINNET.multicall3, allowFailure: true, callData: encodeFunctionData({ abi: mcAbi, functionName: "getEthBalance", args: [a] }) },
    ...TOKENS.map((t) => ({ target: t.address, allowFailure: true, callData: encodeFunctionData({ abi: balAbi, functionName: "balanceOf", args: [a] }) })),
  ]);
  const data = await rpc<Hex>(call("eth_call", [{ to: MAINNET.multicall3, data: encodeFunctionData({ abi: mcAbi, functionName: "aggregate3", args: [calls] }) }, "latest"]));
  const out = decodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", data }) as readonly { success: boolean; returnData: Hex }[];
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
}

// ---- 5. aggregate + publish
const wallet = { accounts: stillDelegated.size, withValue: 0, usd: 0, delegates: new Map<Address, { accounts: number; usd: number }>() };
for (const [a, d] of stillDelegated) {
  const v = usd.get(a) ?? 0;
  wallet.usd += v;
  if (v >= 1) wallet.withValue++;
  const e = wallet.delegates.get(d) ?? { accounts: 0, usd: 0 };
  e.accounts++;
  e.usd += v;
  wallet.delegates.set(d, e);
}
const minimalAuthorities = [...latest.values()].filter((v) => cls(v.delegate) === "minimal").length;
const minimalDelegates = new Map<Address, number>();
for (const v of latest.values()) if (cls(v.delegate) === "minimal") minimalDelegates.set(v.delegate, (minimalDelegates.get(v.delegate) ?? 0) + 1);

const out = {
  generatedAt: new Date().toISOString(),
  blocks: { from: Number(from), to: Number(head), count: BLOCKS },
  rules: {
    window: `EIP-7702 (type-4) transactions in blocks ${from}–${head}`,
    authority: "signer recovered from each authorization tuple; the latest authorization per account wins",
    walletClass: `delegate bytecode ≥ ${WALLET_MIN_CODE} bytes counts as a smart-wallet upgrade; smaller delegates (bots, batchers, sweepers) are counted but not priced`,
    stillDelegated: "account code is 0xef0100‖delegate at the time of the snapshot",
    value: "ETH + DAI, USDC, USDT, UNI, wstETH, stETH, AAVE, LINK, ENA, USDe, WETH, Chainlink-priced",
    whyItCounts: "EIP-7702 never disables the account's ECDSA key: all of this value can still be moved by it",
  },
  totals: { type4Txs: type4, authorizations: auths, uniqueAuthorities: latest.size, stillDelegated: stillDelegated.size, usd: Math.round(wallet.usd) },
  wallet: {
    accounts: wallet.accounts,
    withValue: wallet.withValue,
    usd: Math.round(wallet.usd),
    topDelegates: [...wallet.delegates.entries()].sort((x, y) => y[1].usd - x[1].usd).slice(0, 10).map(([address, e]) => ({ address, codeSize: codeSize.get(address) ?? 0, accounts: e.accounts, usd: Math.round(e.usd) })),
  },
  minimal: {
    accounts: minimalAuthorities,
    withValue: 0,
    usd: 0,
    topDelegates: [...minimalDelegates.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([address, accounts]) => ({ address, codeSize: codeSize.get(address) ?? 0, accounts, usd: 0 })),
  },
  topAccounts: [...stillDelegated.entries()].map(([address, delegate]) => ({ address, delegate, usd: Math.round(usd.get(address) ?? 0) })).sort((x, y) => y.usd - x.usd).slice(0, 15),
  tookSeconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ totals: out.totals, wallet: { accounts: out.wallet.accounts, withValue: out.wallet.withValue, usd: out.wallet.usd }, minimalAuthorities, secs: out.tookSeconds }));
console.log(`wrote ${OUT}`);
