// The GhostKey demo world on an anvil mainnet fork. TypeScript port of
// contracts/test/fork/GhostKeyFixture.sol `_setUpWorld` (minus the 7702 delegation, see steps.ts).
import {
  encodeFunctionData,
  encodePacked,
  getAddress,
  keccak256,
  maxUint256,
  parseEther,
  parseEventLogs,
  toBytes,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ensEthRegistrarAbi,
  ensPermissionedRegistryAbi,
  ensPermissionedResolverAbi,
  ensVerifiableFactoryAbi,
  erc20Abi,
  safeAbi,
  safeProxyFactoryAbi,
} from "../abis.js";
import { LeanSphincsSAsm, PQAccount, PQDelegate, QuantumCanary } from "../generated.js";
import { ENS_ROLES, MAINNET } from "../mainnet.js";
import { generateWeakKey } from "../node/index.js";
import type { PQSigner } from "../pq.js";
import { clientsFor, waitOk } from "./clients.js";
import { dealErc20 } from "./deal.js";

export const DEMO_TOKENS = {
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
} as const satisfies Record<string, Address>;

/** Alice's starting position (mirrors GhostKeyFixture). */
export const DEMO_AMOUNTS = {
  aliceEth: parseEther("3"),
  safeEth: parseEther("5"),
  canaryBounty: parseEther("1"),
  DAI: 5_000n * 10n ** 18n,
  UNI: 400n * 10n ** 18n,
  USDC: 10_100n * 10n ** 6n,
  WSTETH: 2n * 10n ** 18n,
} as const;

export const ETH_COIN_TYPE = 60n;
export const ENS_RESOLVER_ROLES = ENS_ROLES.resolver.ROLE_SET_ADDRESS | ENS_ROLES.resolver.ROLE_SET_ADDRESS_ADMIN;

export interface DemoKey {
  address: Address;
  privateKey: Hex;
}

export interface DemoWorld {
  rpcUrl: string;
  chainId: number;
  /** the OLD ecdsa key (fresh random key: anvil's default keys are already 7702-delegated on mainnet) */
  alice: DemoKey;
  attacker: DemoKey;
  /** pays gas for contract deploys, the 7702 migration, and PQ-signed batches */
  relayer: DemoKey;
  pqSeed: Hex;
  pk: { pkSeed: Hex; pkRoot: Hex };
  /** pubkey is 0x04 || x || y (the contract stores x || y) */
  canary: { address: Address; pubkey: Hex; bits: number; label: string };
  contracts: { verifier: Address; delegate: Address; pqAccount: Address; safe: Address; resolver: Address };
  ens: { label: string; name: string; dnsName: Hex; tokenId: bigint };
}

/** DNS wire-format name encoding, e.g. "ghostkeyalice.eth" -> 0x0d67686f73746b6579616c6963650365746800. */
export function dnsEncode(name: string): Hex {
  const parts: number[] = [];
  for (const label of name.split(".").filter(Boolean)) {
    const b = toBytes(label);
    if (b.length > 63) throw new Error(`dnsEncode: label too long: ${label}`);
    parts.push(b.length, ...b);
  }
  parts.push(0);
  return toHex(Uint8Array.from(parts));
}

function key(): DemoKey {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export interface SetupWorldOptions {
  rpcUrl: string;
  pqSigner: PQSigner;
  /** recorded in the world; the signer itself owns the seed */
  pqSeed?: Hex;
  /** weak canary key size for the live BSGS crack (default 44) */
  canaryBits?: number;
  /** deterministic canary key (tools/bsgs gen --seed) */
  canarySeed?: number;
  /** ENSv2 label to register (default "ghostkeyalice"); must be available on the fork */
  ensLabel?: string;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * Deploy GhostKey's contracts and give a fresh "Alice" value on every residual surface:
 * ETH, DAI/UNI/USDC/wstETH, a standing USDC->Permit2 approval, a 1/1 Safe 1.4.1 with 5 ETH,
 * and `ghostkeyalice.eth` on ENSv2 with her own PermissionedResolver pointing at her.
 * All of Alice's actions are real txs signed by her ECDSA key. Funding uses anvil cheats.
 * Alice's ETH is reset to exactly 3 ETH at the end (she gets extra up front for setup gas).
 */
export async function setupWorld(opts: SetupWorldOptions): Promise<DemoWorld> {
  const log = opts.log ?? (() => {});
  const { rpcUrl } = opts;
  const { publicClient: pc, testClient: test, wallet } = clientsFor(rpcUrl);
  const chainId = await pc.getChainId();
  const bits = opts.canaryBits ?? 44;
  const label = opts.ensLabel ?? "ghostkeyalice";
  const name = `${label}.eth`;
  const dnsName = dnsEncode(name);

  const reg = MAINNET.ens.ethRegistrar;
  if (!(await pc.readContract({ address: reg, abi: ensEthRegistrarAbi, functionName: "isAvailable", args: [label] })))
    throw new Error(`setupWorld: ${name} is already registered on this fork (revert to a clean snapshot, or pass ensLabel)`);

  // ---- keys + funding (anvil cheats are fine for setup)
  const alice = key();
  const attacker = key();
  const relayer = key();
  await test.setBalance({ address: alice.address, value: DEMO_AMOUNTS.aliceEth + parseEther("1") });
  await test.setBalance({ address: attacker.address, value: parseEther("1") });
  await test.setBalance({ address: relayer.address, value: parseEther("100") });
  log("funded fresh keys", { alice: alice.address, attacker: attacker.address, relayer: relayer.address });

  // ---- post-quantum side: verifier, canary, delegate, fresh PQ account (deployed by the relayer)
  const rw = wallet(relayer.privateKey);
  const deployed = async (what: string, hash: Hex) => {
    const r = await waitOk(pc, hash, `deploy ${what}`);
    if (!r.contractAddress) throw new Error(`deploy ${what}: no contract address`);
    log(`deployed ${what}`, { address: r.contractAddress });
    return getAddress(r.contractAddress);
  };
  const pk = await opts.pqSigner.publicKey();
  const weak = await generateWeakKey(bits, opts.canarySeed);
  const canaryLabel = `demo-${bits}bit`;
  const verifier = await deployed("LeanSphincsSAsm", await rw.deployContract({ abi: LeanSphincsSAsm.abi, bytecode: LeanSphincsSAsm.bytecode }));
  const canary = await deployed(
    "QuantumCanary",
    await rw.deployContract({
      abi: QuantumCanary.abi,
      bytecode: QuantumCanary.bytecode,
      args: [`0x${weak.pubkey.slice(4)}`, canaryLabel],
      value: DEMO_AMOUNTS.canaryBounty,
    }),
  );
  const delegate = await deployed(
    "PQDelegate",
    await rw.deployContract({ abi: PQDelegate.abi, bytecode: PQDelegate.bytecode, args: [verifier, pk.pkSeed, pk.pkRoot, canary] }),
  );
  const pqAccount = await deployed(
    "PQAccount",
    await rw.deployContract({ abi: PQAccount.abi, bytecode: PQAccount.bytecode, args: [verifier, pk.pkSeed, pk.pkRoot] }),
  );

  // ---- Alice's pre-migration life on mainnet
  await dealErc20(test, DEMO_TOKENS.DAI, alice.address, DEMO_AMOUNTS.DAI);
  await dealErc20(test, DEMO_TOKENS.UNI, alice.address, DEMO_AMOUNTS.UNI);
  await dealErc20(test, DEMO_TOKENS.USDC, alice.address, DEMO_AMOUNTS.USDC);
  await dealErc20(test, DEMO_TOKENS.WSTETH, alice.address, DEMO_AMOUNTS.WSTETH);
  log("dealt tokens to alice", { DAI: "5000", UNI: "400", USDC: "10100", wstETH: "2" });

  const aw = wallet(alice.privateKey);
  const aliceTx = async (what: string, to: Address, data: Hex) => {
    const hash = await aw.sendTransaction({ to, data });
    const r = await waitOk(pc, hash, what);
    log(`alice: ${what}`, { tx: hash });
    return r;
  };

  await aliceTx(
    "approve USDC -> Permit2 (max)",
    DEMO_TOKENS.USDC,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MAINNET.permit2, maxUint256] }),
  );

  // Safe 1.4.1, 1/1 owned by Alice
  const init = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [[alice.address], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  const safeRcpt = await aliceTx(
    "create Safe 1.4.1 (1/1)",
    MAINNET.safeProxyFactory141,
    encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [MAINNET.safeSingleton141, init, BigInt(keccak256(toHex("gk-safe")))],
    }),
  );
  const created = parseEventLogs({ abi: safeProxyFactoryAbi, eventName: "ProxyCreation", logs: safeRcpt.logs });
  if (!created[0]) throw new Error("setupWorld: no ProxyCreation event");
  const safe = getAddress(created[0].args.proxy);
  await test.setBalance({ address: safe, value: DEMO_AMOUNTS.safeEth });
  log("safe funded", { safe, eth: "5" });

  // ENSv2: Alice's own PermissionedResolver (VerifiableFactory proxy) with address roles
  const resRcpt = await aliceTx(
    "deploy ENSv2 PermissionedResolver",
    MAINNET.ens.verifiableFactory,
    encodeFunctionData({
      abi: ensVerifiableFactoryAbi,
      functionName: "deployProxy",
      args: [
        MAINNET.ens.permissionedResolverImpl,
        BigInt(keccak256(encodePacked(["string", "address"], ["gk-resolver", alice.address]))),
        encodeFunctionData({
          abi: ensPermissionedResolverAbi,
          functionName: "initialize",
          args: [[{ account: alice.address, roleBitmap: ENS_RESOLVER_ROLES }], []],
        }),
      ],
    }),
  );
  const proxyEvt = parseEventLogs({ abi: ensVerifiableFactoryAbi, eventName: "ProxyDeployed", logs: resRcpt.logs });
  if (!proxyEvt[0]) throw new Error("setupWorld: no ProxyDeployed event");
  const resolver = getAddress(proxyEvt[0].args.proxyAddress);

  // ENSv2 ETHRegistrar: commit -> wait 61s -> pay USDC -> register
  const secret = keccak256(toHex("gk-secret"));
  const duration = 365n * 24n * 3600n;
  const commitment = await pc.readContract({
    address: reg,
    abi: ensEthRegistrarAbi,
    functionName: "makeCommitment",
    args: [label, alice.address, secret, zeroAddress, resolver, duration, zeroHash],
  });
  await aliceTx("ENS commit", reg, encodeFunctionData({ abi: ensEthRegistrarAbi, functionName: "commit", args: [commitment] }));
  await test.increaseTime({ seconds: 61 });
  await test.mine({ blocks: 1 });
  await aliceTx("approve USDC -> ETHRegistrar", DEMO_TOKENS.USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reg, 100_000_000n] }));
  await aliceTx(
    `ENS register ${name}`,
    reg,
    encodeFunctionData({
      abi: ensEthRegistrarAbi,
      functionName: "register",
      args: [label, alice.address, secret, zeroAddress, resolver, duration, DEMO_TOKENS.USDC, zeroHash],
    }),
  );
  await aliceTx(
    `resolver.setAddress(${name}, ETH, alice)`,
    resolver,
    encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "setAddress", args: [dnsName, ETH_COIN_TYPE, alice.address] }),
  );
  await aliceTx("revoke USDC -> ETHRegistrar", DEMO_TOKENS.USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reg, 0n] }));
  const state = await pc.readContract({
    address: MAINNET.ens.ethRegistry,
    abi: ensPermissionedRegistryAbi,
    functionName: "getState",
    args: [BigInt(keccak256(toHex(label)))],
  });
  if (state.latestOwner.toLowerCase() !== alice.address.toLowerCase()) throw new Error(`setupWorld: ${name} not owned by alice`);

  // Exact, readable starting balance (setup gas came out of the extra 1 ETH).
  await test.setBalance({ address: alice.address, value: DEMO_AMOUNTS.aliceEth });

  const world: DemoWorld = {
    rpcUrl,
    chainId,
    alice,
    attacker,
    relayer,
    pqSeed: opts.pqSeed ?? zeroHash,
    pk,
    canary: { address: getAddress(canary), pubkey: weak.pubkey, bits, label: canaryLabel },
    contracts: { verifier, delegate, pqAccount, safe, resolver },
    ens: { label, name, dnsName, tokenId: state.tokenId },
  };
  log("world ready", { contracts: world.contracts, ens: { name, tokenId: state.tokenId.toString() } });
  return world;
}
