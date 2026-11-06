import { bytesToHex, getAddress, labelhash, namehash, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ensPermissionedRegistryAbi, ensPermissionedResolverAbi, ensV1RegistryAbi } from "../abis.js";
import { ENS_ROLES, MAINNET } from "../mainnet.js";
import type { AssetAtRisk, Finding } from "../types.js";
import { clear, noKey, type Detector } from "./context.js";

/** ENSv1 .eth registrant NFT and NameWrapper (mainnet). */
export const ENS_V1 = {
  baseRegistrar: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85",
  nameWrapper: "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401",
} as const satisfies Record<string, Address>;

const erc721OwnerAbi = parseAbi(["function ownerOf(uint256 id) view returns (address)"]);
const nameAbi = parseAbi(["function name(bytes32 node) view returns (string)"]);

const R = ENS_ROLES.resolver;
const ROLE_NAMES: [bigint, string][] = [
  [R.ROLE_SET_ADDRESS, "ROLE_SET_ADDRESS"],
  [R.ROLE_SET_TEXT, "ROLE_SET_TEXT"],
  [R.ROLE_SET_CONTENTHASH, "ROLE_SET_CONTENTHASH"],
  [R.ROLE_SET_ADDRESS_ADMIN, "ROLE_SET_ADDRESS_ADMIN"],
  [R.ROLE_SET_TEXT << 128n, "ROLE_SET_TEXT_ADMIN"],
  [R.ROLE_SET_CONTENTHASH << 128n, "ROLE_SET_CONTENTHASH_ADMIN"],
];
const LOW_128 = (1n << 128n) - 1n;

export function roleNames(bits: bigint): string[] {
  const out: string[] = [];
  let rest = bits;
  for (const [bit, name] of ROLE_NAMES) {
    if (bits & bit) {
      out.push(name);
      rest &= ~bit;
    }
  }
  if (rest) out.push(`other roles 0x${rest.toString(16)}`);
  return out;
}

/**
 * EnhancedAccessControl: holding the admin bit (role << 128) lets an account grant / revoke both the role and its admin.
 * Returns the subset of `held` the holder can hand over and self-revoke.
 */
export function settableRoles(held: bigint): bigint {
  const admin = held & (LOW_128 << 128n);
  return held & (admin | (admin >> 128n));
}

/** DNS wire format, e.g. "alice.eth" → 0x05616c69636503657468 00. */
export function dnsEncode(name: string): Hex {
  const enc = new TextEncoder();
  const parts: number[] = [];
  for (const label of name.split(".").filter(Boolean)) {
    const b = enc.encode(label);
    if (b.length > 255) throw new Error(`label too long: ${label}`);
    parts.push(b.length, ...b);
  }
  parts.push(0);
  return bytesToHex(new Uint8Array(parts));
}

const norm = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");
/** "alice.eth" → "alice"; undefined for anything that isn't a 2LD .eth name (ENSv2 ETHRegistry scope). */
export const ethLabel = (name: string) => {
  const p = norm(name).split(".");
  return p.length === 2 && p[1] === "eth" && p[0] ? p[0] : undefined;
};

/** ENSv1 primary name via the reverse registrar (pure RPC: no CCIP-read, no gateway learns the address). */
export async function reverseName(client: PublicClient, address: Address): Promise<string | undefined> {
  try {
    const node = namehash(`${address.slice(2).toLowerCase()}.addr.reverse`);
    const resolver = await client.readContract({ address: MAINNET.ens.v1Registry, abi: ensV1RegistryAbi, functionName: "resolver", args: [node] });
    if (resolver === zeroAddress) return undefined;
    const name = await client.readContract({ address: resolver, abi: nameAbi, functionName: "name", args: [node] });
    return name ? norm(name) : undefined;
  } catch {
    return undefined;
  }
}

export interface Ensv2NameState {
  name: string;
  label: string;
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
}

/** ETHRegistry.getState(uint256(labelhash(label))) for one name. */
export async function readEnsv2Name(client: PublicClient, name: string): Promise<Ensv2NameState | undefined> {
  const label = ethLabel(name);
  if (!label) return undefined;
  try {
    const s = await client.readContract({
      address: MAINNET.ens.ethRegistry,
      abi: ensPermissionedRegistryAbi,
      functionName: "getState",
      args: [BigInt(labelhash(label))],
    });
    return { name: norm(name), label, status: s.status, expiry: s.expiry, latestOwner: getAddress(s.latestOwner), tokenId: s.tokenId };
  } catch {
    return undefined;
  }
}

/** Surface 6: ENS names the old key owns, and ENSv2 resolver roles that survive a name transfer. */
export const detectEnsRoles: Detector = async (ctx) => {
  if (ctx.isContract) return noKey("ens-roles", "ENS names & resolver roles");
  const { client } = ctx;
  const me = getAddress(ctx.address);
  const names = new Set((ctx.hints.ensNames ?? []).map(norm).filter(Boolean));
  const primary = await reverseName(client, me);
  if (primary) names.add(primary);
  const nameList = [...names];
  const findings: Finding[] = [];
  const block = await client.getBlock().catch(() => undefined);
  const nowTs = block?.timestamp ?? BigInt(Math.floor(Date.now() / 1000));

  // Per-name reads: ENSv2 state + resolver, ENSv1 controller / resolver / registrant / wrapper owner.
  const perName = 6;
  const res = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: nameList.flatMap((name) => {
      const label = ethLabel(name) ?? "";
      const node = namehash(name);
      return [
        { address: MAINNET.ens.ethRegistry, abi: ensPermissionedRegistryAbi, functionName: "getState" as const, args: [BigInt(labelhash(label))] as const },
        { address: MAINNET.ens.ethRegistry, abi: ensPermissionedRegistryAbi, functionName: "getResolver" as const, args: [label] as const },
        { address: MAINNET.ens.v1Registry, abi: ensV1RegistryAbi, functionName: "owner" as const, args: [node] as const },
        { address: MAINNET.ens.v1Registry, abi: ensV1RegistryAbi, functionName: "resolver" as const, args: [node] as const },
        { address: ENS_V1.baseRegistrar, abi: erc721OwnerAbi, functionName: "ownerOf" as const, args: [BigInt(labelhash(label))] as const },
        { address: ENS_V1.nameWrapper, abi: erc721OwnerAbi, functionName: "ownerOf" as const, args: [BigInt(node)] as const },
      ];
    }),
  });

  const resolverNames = new Map<Address, Set<string>>();
  const linkResolver = (r: Address, name?: string) => {
    if (r === zeroAddress) return;
    const set = resolverNames.get(r) ?? new Set<string>();
    if (name) set.add(name);
    resolverNames.set(r, set);
  };
  for (const r of ctx.hints.ensResolvers ?? []) linkResolver(getAddress(r));

  nameList.forEach((name, i) => {
    const at = (k: number) => res[i * perName + k];
    const isEth2ld = !!ethLabel(name);
    // (a) ENSv2 registry ownership
    const st = at(0);
    if (isEth2ld && st?.status === "success") {
      const s = st.result as { status: number; expiry: bigint; latestOwner: Address; tokenId: bigint };
      if (getAddress(s.latestOwner) === me && s.expiry > nowTs) {
        findings.push({
          surface: "ens-roles",
          severity: "exposed",
          title: `Old key owns ${name} (ENSv2)`,
          detail: `The ENSv2 name token for ${name} sits with the old key: it can transfer the name or change its registry settings.`,
          assets: [{ kind: "ens-name", address: MAINNET.ens.ethRegistry, symbol: name, amount: 1n, decimals: 0, note: "ENSv2 registry owner" }],
          usdAtRisk: 0,
          fixable: true,
          fix: "Transfer the name token to the post-quantum account (registry roles move with it).",
        });
      }
    }
    const v2Resolver = at(1);
    if (isEth2ld && v2Resolver?.status === "success") linkResolver(getAddress(v2Resolver.result as Address), name);
    const v1Resolver = at(3);
    if (v1Resolver?.status === "success") linkResolver(getAddress(v1Resolver.result as Address), name);

    // (c) ENSv1: controller, .eth registrant, NameWrapper owner
    const roles: string[] = [];
    const v1Owner = at(2);
    if (v1Owner?.status === "success" && getAddress(v1Owner.result as Address) === me) roles.push("registry controller");
    const registrant = at(4);
    if (isEth2ld && registrant?.status === "success" && getAddress(registrant.result as Address) === me) roles.push(".eth registrant");
    const wrapped = at(5);
    if (wrapped?.status === "success" && getAddress(wrapped.result as Address) === me) roles.push("NameWrapper owner");
    if (roles.length) {
      findings.push({
        surface: "ens-roles",
        severity: "exposed",
        title: `Old key controls ${name} (ENSv1)`,
        detail: `The old key is the ${roles.join(" + ")} of ${name}: it can re-point the name or take it.`,
        assets: [{ kind: "ens-name", address: MAINNET.ens.v1Registry, symbol: name, amount: 1n, decimals: 0, note: `ENSv1 ${roles.join(", ")}` }],
        usdAtRisk: 0,
        fixable: false,
        fix: "Transfer the name (registrant and controller) to the post-quantum account in the ENS app.",
      });
    }
  });

  // (b) PermissionedResolver root roles held by the old key
  const resolvers = [...resolverNames.keys()];
  const rr = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: resolvers.map((r) => ({
      address: r,
      abi: ensPermissionedResolverAbi,
      functionName: "roles" as const,
      args: [ENS_ROLES.ROOT_RESOURCE, me] as const,
    })),
  });
  resolvers.forEach((r, i) => {
    const x = rr[i];
    if (x?.status !== "success") return; // not a PermissionedResolver
    const held = x.result as bigint;
    if (held === 0n) return;
    const linked = [...(resolverNames.get(r) ?? [])];
    const label = linked.length ? linked.join(", ") : `resolver ${r.slice(0, 8)}…`;
    const settable = settableRoles(held);
    const asset: AssetAtRisk = {
      kind: "ens-name",
      address: r,
      symbol: linked.length ? linked.join(", ") : "PermissionedResolver",
      amount: 1n,
      decimals: 0,
      note: roleNames(held).join(", "),
    };
    const canSetAddr = (held & R.ROLE_SET_ADDRESS) !== 0n;
    findings.push({
      surface: "ens-roles",
      severity: "exposed",
      title: `Old key can re-point ${label}`,
      detail:
        `The old key holds ${roleNames(held).join(", ")} on this ENSv2 resolver. Resolver roles belong to the account, not the name token, ` +
        `so they survive a name transfer${canSetAddr ? ": the old key can setAddress and redirect every payment to the name" : ""}.`,
      assets: [asset],
      usdAtRisk: 0,
      fixable: settable === held,
      fix:
        settable === held
          ? "In the batch: setAddress(name → post-quantum account), grantRootRoles(roles → post-quantum account), then revokeRootRoles from the old key."
          : `The old key lacks the admin bit for ${roleNames(held & ~settable).join(", ")}, so it can't hand them over or drop them; ask a resolver admin to revoke them.`,
    });
  });

  if (findings.length === 0) {
    const checked = nameList.length + resolvers.length;
    return clear(
      "ens-roles",
      "ENS names & resolver roles",
      checked
        ? `No ENS ownership or resolver roles found for ${[...nameList, ...resolvers.filter((r) => !resolverNames.get(r)?.size)].join(", ")}.`
        : "No ENS names supplied and no primary name set. Pass hints.ensNames / hints.ensResolvers (no indexer is queried).",
    );
  }
  return findings;
};
