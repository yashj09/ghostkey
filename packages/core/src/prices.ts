import { getAddress, type Address, type PublicClient } from "viem";
import { chainlinkAbi, wstethAbi } from "./abis.js";
import { ETH_USD_FEED, MAINNET, TOKENS, type TokenInfo } from "./mainnet.js";

const STETH = TOKENS.find((t) => t.symbol === "stETH")!;
const STETH_FEED = (STETH.price as { feed: Address }).feed;

/**
 * USD prices from Chainlink feeds, in one Multicall3 round trip (RPC-only, so no price API learns what you hold).
 * - `{ feed }`: latestRoundData().answer / 1e8
 * - `{ via: "wsteth" }`: stETH/USD * wstETH.stEthPerToken() / 1e18
 * - `{ fixedUsd }`: constant
 * - `null`, or a failing / non-positive feed: no entry in `byToken`
 * `eth` is 0 if the ETH/USD feed fails.
 */
export async function getUsdPrices(
  client: PublicClient,
  tokens: TokenInfo[],
): Promise<{ eth: number; byToken: Map<Address, number> }> {
  const feeds = new Set<Address>([ETH_USD_FEED]);
  let needWsteth = false;
  for (const t of tokens) {
    if (!t.price) continue;
    if ("feed" in t.price) feeds.add(t.price.feed);
    else if ("via" in t.price) {
      needWsteth = true;
      feeds.add(STETH_FEED);
    }
  }
  const feedList = [...feeds];
  const wsteth = tokens.find((t) => t.price && "via" in t.price)?.address;

  const res = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: [
      ...feedList.map((address) => ({ address, abi: chainlinkAbi, functionName: "latestRoundData" as const })),
      ...(needWsteth && wsteth ? [{ address: wsteth, abi: wstethAbi, functionName: "stEthPerToken" as const }] : []),
    ],
  });

  const feedPrice = new Map<Address, number>();
  feedList.forEach((feed, i) => {
    const r = res[i];
    if (r?.status !== "success") return;
    const answer = (r.result as readonly [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer > 0n) feedPrice.set(feed, Number(answer) / 1e8);
  });
  let stEthPerToken: number | undefined;
  if (needWsteth && wsteth) {
    const r = res[feedList.length];
    if (r?.status === "success") stEthPerToken = Number(r.result as bigint) / 1e18;
  }

  const byToken = new Map<Address, number>();
  for (const t of tokens) {
    const addr = getAddress(t.address);
    if (!t.price) continue;
    let p: number | undefined;
    if ("feed" in t.price) p = feedPrice.get(t.price.feed);
    else if ("via" in t.price) {
      const st = feedPrice.get(STETH_FEED);
      p = st !== undefined && stEthPerToken !== undefined ? st * stEthPerToken : undefined;
    } else p = t.price.fixedUsd;
    if (p !== undefined && Number.isFinite(p)) byToken.set(addr, p);
  }
  return { eth: feedPrice.get(ETH_USD_FEED) ?? 0, byToken };
}

/** `amount` in base units → USD, or undefined when unpriced. */
export function toUsd(amount: bigint, decimals: number, price: number | undefined): number | undefined {
  if (price === undefined) return undefined;
  return (Number(amount) / 10 ** decimals) * price;
}
