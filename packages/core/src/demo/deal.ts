// Generic ERC-20 balance setter for anvil forks (like forge-std `deal`).
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseEther, toHex, type Address, type Hex } from "viem";
import { erc20Abi } from "../abis.js";
import type { DemoTestClient } from "./clients.js";

type Layout = "solidity" | "vyper";
const found = new Map<string, { slot: bigint; layout: Layout }>();

function balanceKey(holder: Address, slot: bigint, layout: Layout): Hex {
  return layout === "solidity"
    ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]))
    : keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, holder]));
}

async function tryKey(test: DemoTestClient, token: Address, holder: Address, key: Hex, amount: bigint): Promise<boolean> {
  const original = (await test.getStorageAt({ address: token, slot: key })) ?? pad("0x0");
  await test.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
  let bal: bigint | undefined;
  try {
    bal = await test.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  } catch {
    bal = undefined;
  }
  if (bal === amount) return true;
  await test.setStorageAt({ address: token, index: key, value: pad(original) });
  return false;
}

/**
 * Set `to`'s ERC-20 balance to exactly `amount` by writing the balanceOf mapping slot (anvil_setStorageAt).
 * Probes slots 0..30 with Solidity (`keccak(addr, slot)`) and Vyper (`keccak(slot, addr)`) layouts and
 * verifies via balanceOf. Works for DAI, USDC (proxy), UNI, wstETH. totalSupply is not adjusted.
 * Fallback: if `opts.holder` is given, impersonate it and transfer instead.
 */
export async function dealErc20(
  test: DemoTestClient,
  token: Address,
  to: Address,
  amount: bigint,
  opts: { maxSlot?: number; holder?: Address } = {},
): Promise<void> {
  const cacheKey = token.toLowerCase();
  const hit = found.get(cacheKey);
  if (hit && (await tryKey(test, token, to, balanceKey(to, hit.slot, hit.layout), amount))) return;

  // Use a sentinel value first so a pre-existing equal balance can't fool the probe.
  const probe = amount === 0n ? 1n : amount;
  for (let s = 0; s <= (opts.maxSlot ?? 30); s++) {
    for (const layout of ["solidity", "vyper"] as const) {
      const key = balanceKey(to, BigInt(s), layout);
      if (await tryKey(test, token, to, key, probe)) {
        if (probe !== amount) await test.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
        found.set(cacheKey, { slot: BigInt(s), layout });
        return;
      }
    }
  }

  if (!opts.holder) throw new Error(`dealErc20: could not find the balance slot of ${token}; pass opts.holder to transfer instead`);
  const holder = opts.holder;
  const current = await test.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (current >= amount) throw new Error(`dealErc20: fallback can only increase the balance of ${to}`);
  await test.impersonateAccount({ address: holder });
  try {
    const eth = await test.getBalance({ address: holder });
    await test.setBalance({ address: holder, value: eth + parseEther("1") });
    const hash = await test.sendUnsignedTransaction({
      from: holder,
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount - current] }),
    });
    const r = await test.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`dealErc20: transfer from ${holder} reverted`);
  } finally {
    await test.stopImpersonatingAccount({ address: holder });
  }
}
