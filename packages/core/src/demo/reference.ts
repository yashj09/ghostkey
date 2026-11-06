// Port of GhostKeyFixture._migrationCalls: the reference "Complete migration" batch for the demo world.
// The product builder lives in src/fix.ts (buildMigration); this one keeps the demo + tests self-contained.
import { encodeFunctionData, encodePacked, pad, zeroAddress, type Hex } from "viem";
import { ensPermissionedRegistryAbi, ensPermissionedResolverAbi, erc20Abi, safeAbi } from "../abis.js";
import { PQDelegate } from "../generated.js";
import { MAINNET } from "../mainnet.js";
import type { Call } from "../types.js";
import { clientsFor } from "./clients.js";
import { DEMO_TOKENS, ENS_RESOLVER_ROLES, ETH_COIN_TYPE, type DemoWorld } from "./world.js";

/** Safe "approved hash / msg.sender is owner" signature (v = 1) for `owner`. */
export function safeSenderIsOwnerSig(owner: Hex): Hex {
  return encodePacked(["bytes32", "bytes32", "uint8"], [pad(owner), pad("0x0"), 1]);
}

/** The 12-call batch from the Solidity fixture, with balances read live from the fork. */
export async function referenceMigrationCalls(world: DemoWorld): Promise<Call[]> {
  const pc = clientsFor(world.rpcUrl).publicClient;
  const alice = world.alice.address;
  const pq = world.contracts.pqAccount;
  const { safe, resolver } = world.contracts;
  const balOf = (token: Hex) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [alice] });
  const transfer = async (token: Hex): Promise<Call> => ({
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [pq, await balOf(token)] }),
  });

  const swap = encodeFunctionData({ abi: safeAbi, functionName: "swapOwner", args: [MAINNET.safeSentinel, alice, pq] });
  const calls: Call[] = [
    // ERC-20s (covers ecrecover-only permits and Permit2 pulls: nothing is left)
    await transfer(DEMO_TOKENS.DAI),
    await transfer(DEMO_TOKENS.UNI),
    await transfer(DEMO_TOKENS.WSTETH),
    await transfer(DEMO_TOKENS.USDC),
    // Permit2: kill the standing approval
    { to: DEMO_TOKENS.USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MAINNET.permit2, 0n] }) },
    // Safe: swap the old key out for the PQ account
    {
      to: safe,
      value: 0n,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "execTransaction",
        args: [safe, 0n, swap, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, safeSenderIsOwnerSig(alice)],
      }),
    },
    // ENSv2: point the name at the PQ account, hand over resolver roles, move the token, self-revoke
    {
      to: resolver,
      value: 0n,
      data: encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "setAddress", args: [world.ens.dnsName, ETH_COIN_TYPE, pq] }),
    },
    { to: resolver, value: 0n, data: encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "grantRootRoles", args: [ENS_RESOLVER_ROLES, pq] }) },
    {
      to: MAINNET.ens.ethRegistry,
      value: 0n,
      data: encodeFunctionData({ abi: ensPermissionedRegistryAbi, functionName: "safeTransferFrom", args: [alice, pq, world.ens.tokenId, 1n, "0x"] }),
    },
    { to: resolver, value: 0n, data: encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "revokeRootRoles", args: [ENS_RESOLVER_ROLES, alice] }) },
    // ETH last (the relayer pays gas, so the EOA is swept to zero)
    { to: pq, value: await pc.getBalance({ address: alice }), data: "0x" },
    // and the wallet's own killswitch
    { to: alice, value: 0n, data: encodeFunctionData({ abi: PQDelegate.abi, functionName: "activateKillswitch" }) },
  ];
  return calls;
}
