import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensPermissionedRegistryAbi, ensPermissionedResolverAbi, erc20Abi, safeAbi } from "../src/abis.js";
import { buildMigration, safeOwnerSignature, safePrevOwner } from "../src/fix.js";
import { PQDelegate } from "../src/generated.js";
import { ENS_ROLES, MAINNET } from "../src/mainnet.js";
import { scanAccount } from "../src/scan.js";
import { dnsEncode } from "../src/surfaces/ens.js";
import {
  T,
  acquireForkLock,
  createSafe,
  delegate,
  deployPQDelegate,
  freshAccount,
  pub,
  registerEnsName,
  releaseForkLock,
  resolvedAddr,
  revert,
  setEth,
  setUpAlice,
  snapshot,
  testClient,
  wallet,
} from "./scanFixture.js";

const ETH = 10n ** 18n;
const ADDR_ROLES = ENS_ROLES.resolver.ROLE_SET_ADDRESS | ENS_ROLES.resolver.ROLE_SET_ADDRESS_ADMIN;

let snap: Hex;
beforeAll(() => acquireForkLock(), 600_000);
afterAll(() => releaseForkLock());
beforeEach(async () => {
  snap = await snapshot();
});
afterEach(async () => {
  await revert(snap);
});

describe("helpers", () => {
  it("Safe prevOwner walks the linked list from SENTINEL", () => {
    const a = getAddress("0x00000000000000000000000000000000000000aa");
    const b = getAddress("0x00000000000000000000000000000000000000bb");
    expect(safePrevOwner([a, b], a)).toBe(MAINNET.safeSentinel);
    expect(safePrevOwner([a, b], b)).toBe(a);
    expect(() => safePrevOwner([a], b)).toThrow();
  });
  it("Safe v=1 signature = owner ‖ 0 ‖ 0x01", () => {
    const s = safeOwnerSignature("0x00000000000000000000000000000000000000aa");
    expect(s).toBe(`0x${"00".repeat(31)}aa${"00".repeat(32)}01`);
  });
});

describe("buildMigration (GhostKey world: delegated Alice, tokens, Permit2, 1/1 Safe, ENSv2)", () => {
  it("mirrors GhostKeyFixture._migrationCalls and leaves $0 to the old key", { timeout: 300_000 }, async () => {
    const { alice } = await setUpAlice();
    const label = `gkfix${Date.now().toString(36)}`;
    const { resolver, tokenId, name } = await registerEnsName(alice, label);
    const safe = await createSafe(alice, [alice.address], 1n, 42n);
    await setEth(safe, 5n * ETH);
    await setEth(alice.address, 3n * ETH);
    const impl = await deployPQDelegate();
    await delegate(alice, impl);

    const hints = { rpcOnly: true, safes: [safe], ensNames: [name] };
    const report = await scanAccount(pub, alice.address, hints);
    expect(report.account.killswitch).toBe(false);
    expect(report.usdControlledByOldKey).toBeGreaterThan(0);

    const pq = (await freshAccount()).address;
    const { calls, steps } = await buildMigration(pub, report, pq);
    expect(steps).toHaveLength(calls.length);

    const usdc = await pub.readContract({ address: T.USDC, abi: erc20Abi, functionName: "balanceOf", args: [alice.address] });
    const shape = calls.map((c) => {
      const to = getAddress(c.to);
      if (c.data === "0x") return { to, fn: "eth", value: c.value };
      const abi =
        to === getAddress(safe)
          ? safeAbi
          : to === getAddress(resolver)
            ? ensPermissionedResolverAbi
            : to === getAddress(MAINNET.ens.ethRegistry)
              ? ensPermissionedRegistryAbi
              : to === alice.address
                ? PQDelegate.abi
                : erc20Abi;
      const d = decodeFunctionData({ abi, data: c.data }) as { functionName: string; args?: readonly unknown[] };
      return { to, fn: d.functionName, args: d.args, value: c.value };
    });

    expect(shape.map((s) => [s.to, s.fn])).toEqual([
      [getAddress(T.DAI), "transfer"],
      [getAddress(T.USDC), "transfer"],
      [getAddress(T.UNI), "transfer"],
      [getAddress(T.WSTETH), "transfer"],
      [getAddress(T.USDC), "approve"],
      [getAddress(safe), "execTransaction"],
      [getAddress(resolver), "setAddress"],
      [getAddress(resolver), "grantRootRoles"],
      [getAddress(MAINNET.ens.ethRegistry), "safeTransferFrom"],
      [getAddress(resolver), "revokeRootRoles"],
      [pq, "eth"],
      [alice.address, "activateKillswitch"],
    ]);
    expect(shape[1]!.args).toEqual([pq, usdc]);
    expect(shape[4]!.args).toEqual([MAINNET.permit2, 0n]);
    // Safe: execTransaction(safe, 0, swapOwner(SENTINEL, alice, pq), CALL, …, v=1 sig)
    const exec = shape[5]!.args!;
    expect(exec[0]).toBe(getAddress(safe));
    expect(exec[2]).toBe(encodeFunctionData({ abi: safeAbi, functionName: "swapOwner", args: [MAINNET.safeSentinel, alice.address, pq] }));
    expect(exec[9]).toBe(safeOwnerSignature(alice.address));
    expect(shape[6]!.args).toEqual([dnsEncode(name), 60n, pq.toLowerCase()]);
    expect(shape[7]!.args).toEqual([ADDR_ROLES, pq]);
    expect(shape[8]!.args).toEqual([alice.address, pq, tokenId, 1n, "0x"]);
    expect(shape[9]!.args).toEqual([ADDR_ROLES, alice.address]);
    expect(shape[10]!.value).toBe(3n * ETH);

    // Opt-out of the killswitch
    const noKs = await buildMigration(pub, report, pq, { activateKillswitch: false });
    expect(noKs.calls).toHaveLength(calls.length - 1);

    // Execute it as the account (executeECDSA = same call semantics as the PQ-signed execute), zero gas price
    // so the full-balance ETH sweep fits, like a relayer paying gas.
    await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
    const hash = await wallet.sendTransaction({
      account: alice,
      to: alice.address,
      data: encodeFunctionData({ abi: PQDelegate.abi, functionName: "executeECDSA", args: [calls] }),
      gas: 3_000_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");

    expect(await pub.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" })).toEqual([pq]);
    expect(await resolvedAddr(resolver, name)).toBe(pq.toLowerCase());
    expect(await pub.readContract({ address: resolver, abi: ensPermissionedResolverAbi, functionName: "roles", args: [0n, alice.address] })).toBe(0n);
    expect(await pub.readContract({ address: resolver, abi: ensPermissionedResolverAbi, functionName: "roles", args: [0n, pq] })).toBe(ADDR_ROLES);
    expect(await pub.getBalance({ address: pq })).toBe(3n * ETH);

    const after = await scanAccount(pub, alice.address, hints);
    expect(after.account.killswitch).toBe(true);
    expect(after.usdControlledByOldKey).toBe(0);
    expect(after.usdConditional).toBe(0);
    for (const f of after.findings) {
      if (f.surface === "direct-tx" || f.surface === "redelegation") {
        expect(f.severity).toBe("protocol-only"); // neutralised: nothing left to take
        expect(f.assets).toHaveLength(0);
      } else expect(f.severity, `${f.surface}: ${f.detail}`).toBe("clear");
    }
    // Rebuilding on the migrated account does nothing (the killswitch is already on)
    expect((await buildMigration(pub, after, pq)).calls).toHaveLength(0);
  });

  it("plain EOA (not GhostKey-delegated): no killswitch call, 2-of-N Safe skipped", { timeout: 120_000 }, async () => {
    const { alice } = await setUpAlice();
    const bob = await freshAccount();
    const multi = await createSafe(alice, [bob.address, alice.address], 2n, 7n);
    await setEth(alice.address, ETH);
    const report = await scanAccount(pub, alice.address, { rpcOnly: true, safes: [multi] });
    const pq = (await freshAccount()).address;
    const { calls, steps } = await buildMigration(pub, report, pq);
    expect(calls.some((c) => getAddress(c.to) === getAddress(multi))).toBe(false);
    expect(calls.some((c) => getAddress(c.to) === alice.address)).toBe(false);
    expect(steps.at(-1)!.description).toMatch(/ETH/);
    expect(calls.at(-1)!.value).toBe(ETH);
  });
});
