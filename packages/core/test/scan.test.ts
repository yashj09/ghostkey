import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensPermissionedRegistryAbi } from "../src/abis.js";
import { MAINNET, TOKENS } from "../src/mainnet.js";
import { getUsdPrices } from "../src/prices.js";
import { scanAccount } from "../src/scan.js";
import { probePermit } from "../src/surfaces/context.js";
import type { Finding, ResidualReport, SurfaceId } from "../src/types.js";
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
  revert,
  send,
  setEth,
  setTokenBalance,
  setUpAlice,
  snapshot,
} from "./scanFixture.js";

const ETH = 10n ** 18n;
const one = (r: ResidualReport, s: SurfaceId): Finding => {
  const f = r.findings.filter((x) => x.surface === s);
  expect(f, `exactly one ${s} finding`).toHaveLength(1);
  return f[0]!;
};
const symbols = (f: Finding) => f.assets.map((a) => a.symbol).sort();

let snap: Hex;
beforeAll(() => acquireForkLock(), 600_000);
afterAll(() => releaseForkLock());
beforeEach(async () => {
  snap = await snapshot();
});
afterEach(async () => {
  await revert(snap);
});

/** USD of Alice's standard holdings (3 ETH + DAI/UNI/USDC/wstETH) at fork prices. */
async function aliceUsd(amounts: Record<"DAI" | "UNI" | "USDC" | "WSTETH", bigint>, ethWei: bigint) {
  const p = await getUsdPrices(pub, TOKENS);
  const px = (a: Address) => p.byToken.get(getAddress(a))!;
  return {
    p,
    eth: (Number(ethWei) / 1e18) * p.eth,
    dai: (Number(amounts.DAI) / 1e18) * px(T.DAI),
    uni: (Number(amounts.UNI) / 1e18) * px(T.UNI),
    usdc: (Number(amounts.USDC) / 1e6) * px(T.USDC),
    wsteth: (Number(amounts.WSTETH) / 1e18) * px(T.WSTETH),
  };
}

describe("prices", () => {
  it("reads Chainlink (and wstETH via stETH × stEthPerToken) on the fork", { timeout: 60_000 }, async () => {
    const p = await getUsdPrices(pub, TOKENS);
    expect(p.eth).toBeGreaterThan(500);
    expect(p.byToken.get(getAddress(T.USDC))).toBeGreaterThan(0.9);
    expect(p.byToken.get(getAddress(T.USDC))).toBeLessThan(1.1);
    const st = p.byToken.get(getAddress("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"))!;
    expect(p.byToken.get(getAddress(T.WSTETH))!).toBeGreaterThan(st); // wstETH > stETH
    expect(p.byToken.get(getAddress("0x4c9EDD5852cd905f086C759E8383e09bff1E68B3"))).toBe(1); // USDe fixedUsd
    expect(p.byToken.has(getAddress("0x57e114B691Db790C35207b2e685D4A43181e6061"))).toBe(false); // ENA: null
  });
});

describe("scanAccount on the fork", () => {
  it("plain EOA: every surface is open, Permit2/USDC exposed (no code)", { timeout: 120_000 }, async () => {
    const { alice, amounts } = await setUpAlice();
    await setEth(alice.address, 3n * ETH);
    const r = await scanAccount(pub, alice.address, { rpcOnly: true });
    const u = await aliceUsd(amounts, 3n * ETH);

    expect(r.chainId).toBe(1);
    expect(r.account.delegatedTo).toBeUndefined();
    expect(r.account.ethBalance).toBe(3n * ETH);

    const direct = one(r, "direct-tx");
    expect(direct.severity).toBe("protocol-only");
    expect(direct.fixable).toBe(true);
    expect(symbols(direct)).toEqual(["DAI", "ETH", "UNI", "USDC", "wstETH"]);
    expect(direct.assets.find((a) => a.symbol === "DAI")!.amount).toBe(amounts.DAI);
    expect(direct.usdAtRisk).toBeCloseTo(u.eth + u.dai + u.uni + u.usdc + u.wsteth, 2);

    expect(one(r, "redelegation").severity).toBe("clear");

    const perm = one(r, "ecrecover-permit");
    expect(perm.severity).toBe("exposed");
    expect(symbols(perm)).toEqual(["DAI", "UNI", "wstETH"]);
    expect(perm.usdAtRisk).toBeCloseTo(u.dai + u.uni + u.wsteth, 2);

    const s1271 = one(r, "erc1271-sig");
    expect(s1271.severity).toBe("exposed");
    expect(symbols(s1271)).toEqual(["USDC"]);
    expect(s1271.fix).toMatch(/Permit2/);

    expect(one(r, "safe-owner").severity).toBe("clear");
    expect(one(r, "ens-roles").severity).toBe("clear");

    expect(r.usdControlledByOldKey).toBeCloseTo(u.eth + u.dai + u.uni + u.usdc + u.wsteth, 2);
    expect(r.usdConditional).toBe(0);
  });

  it("delegated to a GhostKey PQDelegate: Permit2/USDC become conditional, re-delegation is protocol-only", { timeout: 120_000 }, async () => {
    const { alice, amounts } = await setUpAlice();
    await setEth(alice.address, 3n * ETH);
    const impl = await deployPQDelegate();
    await delegate(alice, impl);

    const r = await scanAccount(pub, alice.address, { rpcOnly: true });
    const u = await aliceUsd(amounts, 3n * ETH);
    expect(r.account.delegatedTo).toBe(getAddress(impl));
    expect(r.account.killswitch).toBe(false);

    expect(one(r, "direct-tx").severity).toBe("protocol-only");
    const re = one(r, "redelegation");
    expect(re.severity).toBe("protocol-only");
    expect(symbols(re)).toEqual(["USDC"]);
    expect(re.detail).toMatch(/killswitch is off/);

    expect(one(r, "ecrecover-permit").severity).toBe("exposed"); // killswitch can't help
    const s1271 = one(r, "erc1271-sig");
    expect(s1271.severity).toBe("conditional");
    expect(s1271.usdAtRisk).toBeCloseTo(u.usdc, 2);

    // USDC is already counted by direct-tx: nothing extra is conditional
    expect(r.usdControlledByOldKey).toBeCloseTo(u.eth + u.dai + u.uni + u.usdc + u.wsteth, 2);
    expect(r.usdConditional).toBe(0);
  });

  it("delegated to some other contract: no killswitch reading", { timeout: 60_000 }, async () => {
    const a = await freshAccount(ETH);
    await delegate(a, MAINNET.multicall3);
    const r = await scanAccount(pub, a.address, { rpcOnly: true });
    expect(r.account.delegatedTo).toBe(getAddress(MAINNET.multicall3));
    expect(r.account.killswitch).toBeUndefined();
    expect(one(r, "redelegation").severity).toBe("protocol-only");
  });

  it("a real contract has no key: everything clear", { timeout: 60_000 }, async () => {
    const r = await scanAccount(pub, MAINNET.permit2, { rpcOnly: true, safes: [], ensNames: [] });
    expect(r.findings.every((f) => f.severity === "clear")).toBe(true);
    expect(r.usdControlledByOldKey).toBe(0);
  });

  it("Safe owner: 1/1 exposed and fixable, 2-of-2 conditional and not fixable", { timeout: 120_000 }, async () => {
    const alice = await freshAccount(ETH);
    const bob = await freshAccount();
    const solo = await createSafe(alice, [alice.address], 1n, 1n);
    const multi = await createSafe(alice, [bob.address, alice.address], 2n, 2n);
    const other = await createSafe(alice, [bob.address], 1n, 3n); // not alice's
    await setEth(solo, 5n * ETH);
    await setEth(multi, 1n * ETH);
    await setTokenBalance(T.DAI, solo, 1_000n * ETH);
    await setEth(alice.address, 0n);

    const r = await scanAccount(pub, alice.address, { rpcOnly: true, safes: [solo, multi, other, T.DAI /* not a Safe */] });
    const p = await getUsdPrices(pub, TOKENS);
    const safes = r.findings.filter((f) => f.surface === "safe-owner");
    expect(safes).toHaveLength(2);
    const fSolo = safes.find((f) => f.assets[0]!.address === getAddress(solo))!;
    const fMulti = safes.find((f) => f.assets[0]!.address === getAddress(multi))!;
    expect(fSolo.severity).toBe("exposed");
    expect(fSolo.fixable).toBe(true);
    expect(fSolo.usdAtRisk).toBeCloseTo(5 * p.eth + 1000 * p.byToken.get(getAddress(T.DAI))!, 2);
    expect(fMulti.severity).toBe("conditional");
    expect(fMulti.fixable).toBe(false);
    expect(fMulti.title).toMatch(/1 of 2/);
    expect(fMulti.usdAtRisk).toBeCloseTo(p.eth, 2);

    expect(r.usdControlledByOldKey).toBeCloseTo(fSolo.usdAtRisk, 2); // alice holds nothing herself
    expect(r.usdConditional).toBeCloseTo(fMulti.usdAtRisk, 2);
  });

  it("ENSv2: the name moves with the token, the resolver role does not", { timeout: 180_000 }, async () => {
    const alice = await freshAccount(ETH);
    await setTokenBalance(T.USDC, alice.address, 100n * 10n ** 6n);
    const label = `gkscan${Date.now().toString(36)}`;
    const { resolver, tokenId, name } = await registerEnsName(alice, label);

    const r1 = await scanAccount(pub, alice.address, { rpcOnly: true, ensNames: [name] });
    const ens1 = r1.findings.filter((f) => f.surface === "ens-roles");
    expect(ens1.map((f) => f.severity)).toEqual(["exposed", "exposed"]);
    const owned = ens1.find((f) => f.assets[0]!.address === getAddress(MAINNET.ens.ethRegistry))!;
    expect(owned.assets[0]!.symbol).toBe(name);
    const roles = ens1.find((f) => f.assets[0]!.address === getAddress(resolver))!;
    expect(roles.assets[0]!.symbol).toBe(name); // linked via ETHRegistry.getResolver(label)
    expect(roles.assets[0]!.note).toBe("ROLE_SET_ADDRESS, ROLE_SET_ADDRESS_ADMIN");
    expect(roles.fixable).toBe(true);

    // Alice "migrates" the name only: transfer the token to a new account.
    const fresh = await freshAccount();
    await send(
      alice,
      MAINNET.ens.ethRegistry,
      encodeFunctionData({ abi: ensPermissionedRegistryAbi, functionName: "safeTransferFrom", args: [alice.address, fresh.address, tokenId, 1n, "0x"] }),
    );
    const r2 = await scanAccount(pub, alice.address, { rpcOnly: true, ensNames: [name] });
    const ens2 = r2.findings.filter((f) => f.surface === "ens-roles");
    expect(ens2).toHaveLength(1); // ownership gone…
    expect(ens2[0]!.severity).toBe("exposed"); // …but the old key can still re-point the name
    expect(ens2[0]!.assets[0]!.address).toBe(getAddress(resolver));
    expect(ens2[0]!.detail).toMatch(/survive a name transfer/);

    // Resolver passed only as a hint (no name): still found
    const r3 = await scanAccount(pub, alice.address, { rpcOnly: true, ensResolvers: [resolver] });
    expect(r3.findings.find((f) => f.surface === "ens-roles")!.severity).toBe("exposed");
  });

  it("extra tokens: permit probe checks return-data length (WETH fallback ≠ permit)", { timeout: 60_000 }, async () => {
    const holder = await freshAccount();
    const probe = await probePermit(pub, [T.WETH, T.COMP, T.DAI, T.UNI], holder.address);
    expect(probe.get(getAddress(T.WETH))).toBe(false);
    expect(probe.get(getAddress(T.COMP))).toBe(true);
    expect(probe.get(getAddress(T.DAI))).toBe(true);
    expect(probe.get(getAddress(T.UNI))).toBe(true);

    await setTokenBalance(T.COMP, holder.address, 7n * ETH);
    const r = await scanAccount(pub, holder.address, { rpcOnly: true, extraTokens: [T.COMP, T.WETH /* curated: ignored */] });
    const perm = one(r, "ecrecover-permit");
    expect(perm.severity).toBe("exposed");
    const comp = perm.assets.find((a) => a.address === getAddress(T.COMP))!;
    expect(comp.symbol).toBe("COMP");
    expect(comp.amount).toBe(7n * ETH);
    expect(comp.note).toMatch(/probe/);
    expect(comp.usd).toBeUndefined(); // no curated price feed
  });
});

describe("read-only smoke scan of a real mainnet address", () => {
  it("vitalik.eth (RPC-only)", { timeout: 120_000 }, async () => {
    const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const r = await scanAccount(pub, addr, { rpcOnly: true });
    expect(r.account.address).toBe(addr);
    expect(r.chainId).toBe(1);
    expect(typeof r.blockNumber).toBe("bigint");
    expect(new Date(r.scannedAt).toString()).not.toBe("Invalid Date");
    const surfaces = new Set(r.findings.map((f) => f.surface));
    for (const s of ["direct-tx", "redelegation", "ecrecover-permit", "erc1271-sig", "safe-owner", "ens-roles"] as const) expect(surfaces.has(s)).toBe(true);
    for (const f of r.findings) {
      expect(["exposed", "conditional", "protocol-only", "clear"]).toContain(f.severity);
      expect(Number.isFinite(f.usdAtRisk)).toBe(true);
    }
    expect(r.usdControlledByOldKey).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.usdConditional)).toBe(true);
  });
});
