// Shared fork helpers for scan*.test.ts / fix*.test.ts. Runs against our own anvil mainnet fork
// (SCAN_RPC_URL, default :8546, block 26352043, --hardfork osaka). Every test runs between
// evm_snapshot / evm_revert, and a cross-process lock keeps test files from interleaving snapshots.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { ensEthRegistrarAbi, ensPermissionedResolverAbi, ensVerifiableFactoryAbi, erc20Abi, safeAbi, safeProxyFactoryAbi } from "../src/abis.js";
import { PQDelegate } from "../src/generated.js";
import { ENS_ROLES, MAINNET } from "../src/mainnet.js";
import { dnsEncode } from "../src/surfaces/ens.js";

export const RPC = process.env.SCAN_RPC_URL ?? "http://127.0.0.1:8546";
const transport = http(RPC, { timeout: 60_000 });
// cacheTime 0: snapshots/reverts move the head backwards, a cached block number would be stale
export const pub = createPublicClient({ chain: mainnet, transport, cacheTime: 0 });
export const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport });
export const wallet = createWalletClient({ chain: mainnet, transport });

export const T = {
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  COMP: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
} as const satisfies Record<string, Address>;

// ---------------------------------------------------------------- fork lock + snapshots

const LOCK = join(tmpdir(), `ghostkey-scan-fork-${RPC.replace(/\W/g, "_")}.lock`);
export async function acquireForkLock(timeoutMs = 600_000) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > timeoutMs) rmSync(LOCK, { recursive: true, force: true });
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${LOCK}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
export function releaseForkLock() {
  rmSync(LOCK, { recursive: true, force: true });
}

export const snapshot = () => testClient.snapshot();
export const revert = (id: Hex) => testClient.revert({ id });

// ---------------------------------------------------------------- accounts & balances

export async function freshAccount(eth = 0n): Promise<PrivateKeyAccount> {
  const a = privateKeyToAccount(generatePrivateKey());
  if (eth > 0n) await testClient.setBalance({ address: a.address, value: eth });
  return a;
}

const slotCache = new Map<string, bigint>();
/** Set an ERC-20 balance by probing the balances-mapping slot (Solidity layout keccak(holder, slot)). */
export async function setTokenBalance(token: Address, holder: Address, amount: bigint) {
  const key = (slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));
  const tryOne = async (slot: bigint) => {
    const k = key(slot);
    const before = await pub.getStorageAt({ address: token, slot: k });
    await testClient.setStorageAt({ address: token, index: k, value: pad(toHex(amount), { size: 32 }) });
    const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    if (bal === amount) return true;
    await testClient.setStorageAt({ address: token, index: k, value: before ?? zeroHash });
    return false;
  };
  const cached = slotCache.get(token);
  if (cached !== undefined && (await tryOne(cached))) return;
  for (let s = 0n; s < 64n; s++) {
    if (await tryOne(s)) {
      slotCache.set(token, s);
      return;
    }
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

export async function send(account: PrivateKeyAccount, to: Address, data: Hex, value = 0n) {
  const hash = await wallet.sendTransaction({ account, to, data, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx to ${to} reverted`);
  return r;
}

// ---------------------------------------------------------------- 7702 / PQDelegate

/** Deploy a GhostKey PQDelegate (dummy verifier, no canary): enough for killswitch() / executeECDSA. */
export async function deployPQDelegate(): Promise<Address> {
  const deployer = await freshAccount(10n ** 18n);
  const hash = await wallet.deployContract({
    account: deployer,
    abi: PQDelegate.abi,
    bytecode: PQDelegate.bytecode as Hex,
    args: ["0x000000000000000000000000000000000000dEaD", keccak256(toHex("seed")), keccak256(toHex("root")), zeroAddress],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

/** EIP-7702: `who` signs an authorization, a separate relayer sends it. */
export async function delegate(who: PrivateKeyAccount, to: Address) {
  const relayer = await freshAccount(10n ** 18n);
  const authorization = await wallet.signAuthorization({ account: who, contractAddress: to });
  const hash = await wallet.sendTransaction({ account: relayer, to: relayer.address, data: "0x", authorizationList: [authorization] });
  await pub.waitForTransactionReceipt({ hash });
}

// ---------------------------------------------------------------- Safe

export async function createSafe(from: PrivateKeyAccount, owners: Address[], threshold: bigint, salt = BigInt(Date.now())): Promise<Address> {
  const init = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [owners, threshold, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  const r = await send(
    from,
    MAINNET.safeProxyFactory141,
    encodeFunctionData({ abi: safeProxyFactoryAbi, functionName: "createProxyWithNonce", args: [MAINNET.safeSingleton141, init, salt] }),
  );
  const [ev] = parseEventLogs({ abi: safeProxyFactoryAbi, eventName: "ProxyCreation", logs: r.logs });
  return ev!.args.proxy;
}

// ---------------------------------------------------------------- ENSv2

/** Register `<label>.eth` on the real ENSv2 ETHRegistrar (paid in USDC), with a fresh PermissionedResolver
 *  where `who` holds ROLE_SET_ADDRESS + admin, and point the name at `who`. Mirrors GhostKeyFixture._setUpEns. */
export async function registerEnsName(who: PrivateKeyAccount, label: string): Promise<{ resolver: Address; tokenId: bigint; name: string }> {
  const R = ENS_ROLES.resolver;
  const initData = encodeFunctionData({
    abi: ensPermissionedResolverAbi,
    functionName: "initialize",
    args: [[{ account: who.address, roleBitmap: R.ROLE_SET_ADDRESS | R.ROLE_SET_ADDRESS_ADMIN }], []],
  });
  const dr = await send(
    who,
    MAINNET.ens.verifiableFactory,
    encodeFunctionData({ abi: ensVerifiableFactoryAbi, functionName: "deployProxy", args: [MAINNET.ens.permissionedResolverImpl, BigInt(keccak256(toHex(label))), initData] }),
  );
  const [pd] = parseEventLogs({ abi: ensVerifiableFactoryAbi, eventName: "ProxyDeployed", logs: dr.logs });
  const resolver = pd!.args.proxyAddress;

  const reg = MAINNET.ens.ethRegistrar;
  const secret = keccak256(toHex(`secret-${label}`));
  const duration = 365n * 24n * 3600n;
  const commitment = await pub.readContract({
    address: reg,
    abi: ensEthRegistrarAbi,
    functionName: "makeCommitment",
    args: [label, who.address, secret, zeroAddress, resolver, duration, zeroHash],
  });
  await send(who, reg, encodeFunctionData({ abi: ensEthRegistrarAbi, functionName: "commit", args: [commitment] }));
  await testClient.increaseTime({ seconds: 61 });
  await testClient.mine({ blocks: 1 });
  const [base, premium] = await pub.readContract({ address: reg, abi: ensEthRegistrarAbi, functionName: "getRegisterPrice", args: [label, duration, T.USDC] });
  await send(who, T.USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reg, base + premium] }));
  const rr = await send(
    who,
    reg,
    encodeFunctionData({ abi: ensEthRegistrarAbi, functionName: "register", args: [label, who.address, secret, zeroAddress, resolver, duration, T.USDC, zeroHash] }),
  );
  await send(who, T.USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reg, 0n] }));
  const name = `${label}.eth`;
  await send(who, resolver, encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "setAddress", args: [dnsEncode(name), 60n, who.address] }));
  void rr;
  const st = await pub.readContract({
    address: MAINNET.ens.ethRegistry,
    abi: parseAbi(["struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }", "function getState(uint256) view returns (State)"]),
    functionName: "getState",
    args: [BigInt(keccak256(toHex(label)))],
  });
  return { resolver, tokenId: st.tokenId, name };
}

/** Resolve `name`'s ETH address through its PermissionedResolver (addr(bytes32) via resolve()). */
export async function resolvedAddr(resolver: Address, name: string): Promise<Address> {
  const data = encodeFunctionData({ abi: parseAbi(["function addr(bytes32) view returns (address)"]), functionName: "addr", args: [zeroHash] });
  const out = await pub.readContract({ address: resolver, abi: ensPermissionedResolverAbi, functionName: "resolve", args: [dnsEncode(name), data] });
  return `0x${out.slice(-40)}` as Address;
}

// ---------------------------------------------------------------- the "Alice" world

export interface AliceWorld {
  alice: PrivateKeyAccount;
  amounts: Record<"DAI" | "UNI" | "USDC" | "WSTETH", bigint>;
}

/** Alice: 3 ETH, 5k DAI, 400 UNI, 10.1k USDC, 2 wstETH, a standing USDC → Permit2 approval. */
export async function setUpAlice(): Promise<AliceWorld> {
  const alice = await freshAccount(10n ** 18n);
  const amounts = { DAI: 5_000n * 10n ** 18n, UNI: 400n * 10n ** 18n, USDC: 10_100n * 10n ** 6n, WSTETH: 2n * 10n ** 18n };
  await setTokenBalance(T.DAI, alice.address, amounts.DAI);
  await setTokenBalance(T.UNI, alice.address, amounts.UNI);
  await setTokenBalance(T.USDC, alice.address, amounts.USDC);
  await setTokenBalance(T.WSTETH, alice.address, amounts.WSTETH);
  await send(alice, T.USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MAINNET.permit2, 2n ** 256n - 1n] }));
  return { alice, amounts };
}

export const setEth = (address: Address, value: bigint) => testClient.setBalance({ address, value });
