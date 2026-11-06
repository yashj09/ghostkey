// End-to-end demo world on the shared anvil mainnet fork (http://127.0.0.1:8545, override with DEMO_RPC_URL).
// Mirrors contracts/test/fork/Migration.t.sol with real signed txs from fresh keys.
import { keccak256, parseEther, toHex, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { erc20Abi, safeAbi } from "../src/abis.js";
import { PQDelegate } from "../src/generated.js";
import {
  attackDaiPermit,
  attackDirect,
  attackEns,
  attackRedelegateThenPermit2,
  attackSafe,
  clientsFor,
  completeMigration,
  crackAndTripCanary,
  DEMO_TOKENS,
  dnsEncode,
  ensResolvesTo,
  migrateTo7702,
  referenceMigrationCalls,
  revert,
  setupWorld,
  snapshot,
  type DemoWorld,
  type StepResult,
} from "../src/demo/index.js";
import { createBsgsCracker, createCliPQSigner } from "../src/node/index.js";

const RPC = process.env.DEMO_RPC_URL ?? "http://127.0.0.1:8545";
const PQ_SEED = keccak256(toHex("ghostkey-demo-seed-1"));
const pqSigner = createCliPQSigner(PQ_SEED);
const cracker = createBsgsCracker();
const { publicClient: pc } = clientsFor(RPC);

const bal = (token: Hex, who: Hex) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const show = (r: StepResult) => console.log(`[${r.step}] ${r.ok ? "OK " : "NO "} ${r.ms}ms  ${r.detail}`);

async function act1(): Promise<DemoWorld> {
  const t0 = performance.now();
  const world = await setupWorld({ rpcUrl: RPC, pqSigner, pqSeed: PQ_SEED, canarySeed: 7 });
  console.log(`[setupWorld] ${Math.round(performance.now() - t0)}ms`);
  const m = await migrateTo7702(world);
  show(m);
  expect(m.ok, m.detail).toBe(true);
  const c = await crackAndTripCanary(world, cracker);
  show(c);
  expect(c.ok, c.detail).toBe(true);
  expect(c.data?.bounty).toBe(parseEther("1"));
  expect(await pc.readContract({ address: world.alice.address, abi: PQDelegate.abi, functionName: "killswitch" })).toBe(true);
  return world;
}

let snap: Hex;
beforeEach(async () => {
  snap = await snapshot(RPC);
});
afterEach(async () => {
  await revert(RPC, snap);
});

describe("dnsEncode", () => {
  it("encodes ghostkeyalice.eth", () => {
    expect(dnsEncode("ghostkeyalice.eth")).toBe("0x0d67686f73746b6579616c6963650365746800");
  });
});

describe("demo world (mainnet fork)", () => {
  it("act 2: killswitch ON, the old key still drains every surface", { timeout: 180_000 }, async () => {
    const w = await act1();
    expect(await ensResolvesTo(w)).toBe(w.alice.address);

    const dai = await attackDaiPermit(w);
    show(dai);
    expect(dai.ok, dai.detail).toBe(true);
    expect(dai.data?.taken).toBe(5_000n * 10n ** 18n);

    const safe = await attackSafe(w);
    show(safe);
    expect(safe.ok, safe.detail).toBe(true);
    expect(safe.data?.taken).toBe(parseEther("5"));
    expect(await pc.getBalance({ address: w.contracts.safe })).toBe(0n);

    const ens = await attackEns(w);
    show(ens);
    expect(ens.ok, ens.detail).toBe(true);
    expect(await ensResolvesTo(w)).toBe(w.attacker.address);

    const direct = await attackDirect(w);
    show(direct);
    expect(direct.ok, direct.detail).toBe(true);
    expect(direct.data?.uniTaken).toBe(400n * 10n ** 18n);
    expect(direct.data?.ethTaken as bigint).toBeGreaterThan(parseEther("2.99")); // 3 ETH minus Alice's own gas
    expect(direct.data?.ethLeft).toBe(0n);

    const usdc = await attackRedelegateThenPermit2(w);
    show(usdc);
    expect(usdc.ok, usdc.detail).toBe(true);
    expect(usdc.data?.taken).toBe(10_100_000_000n - 8_000_021n); // minus the ENS registration fee
    expect(usdc.data?.delegationAfter).toBeUndefined();

    expect(await bal(DEMO_TOKENS.DAI, w.attacker.address)).toBe(5_000n * 10n ** 18n);
    expect(await bal(DEMO_TOKENS.UNI, w.attacker.address)).toBe(400n * 10n ** 18n);
    expect(await bal(DEMO_TOKENS.USDC, w.attacker.address)).toBe(10_100_000_000n - 8_000_021n);
  });

  it("act 3: after the PQ-signed migration, the old key controls nothing", { timeout: 180_000 }, async () => {
    const w = await act1();
    const pq = w.contracts.pqAccount;
    const usdcBefore = await bal(DEMO_TOKENS.USDC, w.alice.address);

    const fix = await completeMigration(w, await referenceMigrationCalls(w), pqSigner);
    show(fix);
    expect(fix.ok, fix.detail).toBe(true);

    expect(await bal(DEMO_TOKENS.DAI, pq)).toBe(5_000n * 10n ** 18n);
    expect(await bal(DEMO_TOKENS.UNI, pq)).toBe(400n * 10n ** 18n);
    expect(await bal(DEMO_TOKENS.USDC, pq)).toBe(usdcBefore);
    expect(await bal(DEMO_TOKENS.WSTETH, pq)).toBe(2n * 10n ** 18n);
    expect(await pc.getBalance({ address: pq })).toBe(parseEther("3"));
    expect(await pc.readContract({ address: w.contracts.safe, abi: safeAbi, functionName: "isOwner", args: [pq] })).toBe(true);
    expect(await pc.readContract({ address: w.contracts.safe, abi: safeAbi, functionName: "isOwner", args: [w.alice.address] })).toBe(false);
    expect(await ensResolvesTo(w)).toBe(pq);

    const dai = await attackDaiPermit(w);
    show(dai);
    expect(dai.ok).toBe(false);
    expect(dai.data?.taken).toBe(0n);

    const safe = await attackSafe(w);
    show(safe);
    expect(safe.ok).toBe(false);
    expect(await pc.getBalance({ address: w.contracts.safe })).toBe(parseEther("5"));

    const ens = await attackEns(w);
    show(ens);
    expect(ens.ok).toBe(false);
    expect(await ensResolvesTo(w)).toBe(pq);

    const direct = await attackDirect(w);
    show(direct);
    expect(direct.ok).toBe(false);

    const usdc = await attackRedelegateThenPermit2(w);
    show(usdc);
    expect(usdc.ok).toBe(false);
    expect(usdc.data?.taken).toBe(0n);

    const total =
      (await bal(DEMO_TOKENS.DAI, w.attacker.address)) +
      (await bal(DEMO_TOKENS.USDC, w.attacker.address)) +
      (await bal(DEMO_TOKENS.UNI, w.attacker.address));
    expect(total).toBe(0n);
  });
});
