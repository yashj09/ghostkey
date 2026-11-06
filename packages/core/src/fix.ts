import { concat, encodeFunctionData, getAddress, pad, parseAbi, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { ensPermissionedRegistryAbi, ensPermissionedResolverAbi, erc20Abi, safeAbi } from "./abis.js";
import { PQDelegate } from "./generated.js";
import { ENS_ROLES, MAINNET, TOKENS } from "./mainnet.js";
import { fmtAmount } from "./surfaces/context.js";
import { dnsEncode, readEnsv2Name, roleNames, settableRoles } from "./surfaces/ens.js";
import type { Call, ResidualReport, SurfaceId } from "./types.js";

const safeRemoveOwnerAbi = parseAbi(["function removeOwner(address prevOwner, address owner, uint256 _threshold)"]);
const ETH_COIN_TYPE = 60n;

export interface MigrationStep {
  surface: SurfaceId;
  description: string;
}

export interface Migration {
  /** calls the account executes on itself (PQDelegate.execute), in order */
  calls: Call[];
  /** steps[i] describes calls[i] */
  steps: MigrationStep[];
}

/** Safe "approved by msg.sender" signature: r = owner, s = 0, v = 1. */
export function safeOwnerSignature(owner: Address): Hex {
  return concat([pad(owner.toLowerCase() as Hex, { size: 32 }), zeroHash, "0x01"]);
}

/** Safe owners are a linked list starting at SENTINEL (0x…01): prev of owners[i] is owners[i-1]. */
export function safePrevOwner(owners: Address[], owner: Address): Address {
  const i = owners.findIndex((o) => getAddress(o) === getAddress(owner));
  if (i < 0) throw new Error(`${owner} is not an owner`);
  return i === 0 ? MAINNET.safeSentinel : getAddress(owners[i - 1]!);
}

/**
 * Build the atomic "complete migration" batch for a scanned account, mirroring GhostKeyFixture._migrationCalls:
 *   ERC-20 transfers → approve(Permit2, 0) → Safe swapOwner(s) → ENS (setAddress, grantRootRoles, safeTransferFrom,
 *   revokeRootRoles) → ETH sweep → PQDelegate.activateKillswitch().
 * Balances, allowances, Safe owners and ENS roles are re-read at build time (the report may be stale).
 * The ETH sweep moves the full balance: a relayer pays the gas for PQDelegate.execute.
 */
export async function buildMigration(
  client: PublicClient,
  report: ResidualReport,
  destination: Address,
  opts: { activateKillswitch?: boolean } = {},
): Promise<Migration> {
  const account = getAddress(report.account.address);
  const dest = getAddress(destination);
  const calls: Call[] = [];
  const steps: MigrationStep[] = [];
  const push = (surface: SurfaceId, description: string, call: Call) => {
    calls.push(call);
    steps.push({ surface, description });
  };

  // ---- 1. ERC-20s: every curated token plus any token the report flagged (extra / probed tokens)
  const tokenMeta = new Map<Address, { symbol: string; decimals: number }>();
  for (const t of TOKENS) tokenMeta.set(getAddress(t.address), { symbol: t.symbol, decimals: t.decimals });
  for (const f of report.findings) {
    for (const a of f.assets) {
      if (a.kind === "erc20" && !tokenMeta.has(getAddress(a.address))) tokenMeta.set(getAddress(a.address), { symbol: a.symbol, decimals: a.decimals });
    }
  }
  const tokenAddrs = [...tokenMeta.keys()];
  const tr = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: tokenAddrs.flatMap((address) => [
      { address, abi: erc20Abi, functionName: "balanceOf" as const, args: [account] as const },
      { address, abi: erc20Abi, functionName: "allowance" as const, args: [account, MAINNET.permit2] as const },
    ]),
  });
  const permit2Tokens: Address[] = [];
  tokenAddrs.forEach((token, i) => {
    const b = tr[2 * i];
    const a = tr[2 * i + 1];
    const bal = b?.status === "success" ? (b.result as bigint) : 0n;
    const { symbol, decimals } = tokenMeta.get(token)!;
    if (bal > 0n) {
      push("direct-tx", `Move ${fmtAmount(bal, decimals)} ${symbol} to the post-quantum account`, {
        to: token,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, bal] }),
      });
    }
    if (a?.status === "success" && (a.result as bigint) > 0n) permit2Tokens.push(token);
  });

  // ---- 2. Permit2: kill standing approvals (SignatureTransfer pulls stay possible until the ERC-20 approval is gone)
  for (const token of permit2Tokens) {
    push("erc1271-sig", `Revoke the Permit2 approval for ${tokenMeta.get(token)!.symbol}`, {
      to: token,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MAINNET.permit2, 0n] }),
    });
  }

  // ---- 3. Safes where the old key alone is enough (threshold 1)
  const safes = [
    ...new Set(
      report.findings
        .filter((f) => f.surface === "safe-owner" && f.severity !== "clear")
        .flatMap((f) => f.assets.filter((a) => a.kind === "safe").map((a) => getAddress(a.address))),
    ),
  ];
  if (safes.length) {
    const sr = await client.multicall({
      multicallAddress: MAINNET.multicall3,
      allowFailure: true,
      contracts: safes.flatMap((address) => [
        { address, abi: safeAbi, functionName: "getOwners" as const },
        { address, abi: safeAbi, functionName: "getThreshold" as const },
      ]),
    });
    safes.forEach((safe, i) => {
      const o = sr[2 * i];
      const t = sr[2 * i + 1];
      if (o?.status !== "success" || t?.status !== "success") return;
      const owners = (o.result as readonly Address[]).map((x) => getAddress(x));
      if (!owners.includes(account) || (t.result as bigint) !== 1n) return; // threshold > 1: needs co-signers
      const prev = safePrevOwner(owners, account);
      const inner = owners.includes(dest)
        ? encodeFunctionData({ abi: safeRemoveOwnerAbi, functionName: "removeOwner", args: [prev, account, 1n] })
        : encodeFunctionData({ abi: safeAbi, functionName: "swapOwner", args: [prev, account, dest] });
      push(
        "safe-owner",
        owners.includes(dest)
          ? `Remove the old key from Safe ${safe} (the post-quantum account is already an owner)`
          : `Swap the old key for the post-quantum account as owner of Safe ${safe}`,
        {
          to: safe,
          value: 0n,
          data: encodeFunctionData({
            abi: safeAbi,
            functionName: "execTransaction",
            args: [safe, 0n, inner, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, safeOwnerSignature(account)],
          }),
        },
      );
    });
  }

  // ---- 4. ENS: setAddress → grantRootRoles → name transfers → revokeRootRoles (old key drops its roles last)
  const ensAssets = report.findings.filter((f) => f.surface === "ens-roles" && f.severity !== "clear").flatMap((f) => f.assets);
  const v2Names = [...new Set(ensAssets.filter((a) => getAddress(a.address) === getAddress(MAINNET.ens.ethRegistry)).map((a) => a.symbol))];
  const resolvers = new Map<Address, string[]>();
  for (const a of ensAssets) {
    const addr = getAddress(a.address);
    if (addr === getAddress(MAINNET.ens.ethRegistry) || addr === getAddress(MAINNET.ens.v1Registry)) continue;
    const names = a.symbol === "PermissionedResolver" ? [] : a.symbol.split(",").map((s) => s.trim()).filter(Boolean);
    resolvers.set(addr, [...new Set([...(resolvers.get(addr) ?? []), ...names])]);
  }
  const resolverList = [...resolvers.keys()];
  const rolesRes = await client.multicall({
    multicallAddress: MAINNET.multicall3,
    allowFailure: true,
    contracts: resolverList.map((r) => ({
      address: r,
      abi: ensPermissionedResolverAbi,
      functionName: "roles" as const,
      args: [ENS_ROLES.ROOT_RESOURCE, account] as const,
    })),
  });
  const handover: { resolver: Address; bits: bigint }[] = [];
  resolverList.forEach((resolver, i) => {
    const r = rolesRes[i];
    if (r?.status !== "success") return;
    const held = r.result as bigint;
    const bits = settableRoles(held);
    if (held & ENS_ROLES.resolver.ROLE_SET_ADDRESS) {
      for (const name of resolvers.get(resolver)!) {
        push("ens-roles", `Point ${name} at the post-quantum account`, {
          to: resolver,
          value: 0n,
          data: encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "setAddress", args: [dnsEncode(name), ETH_COIN_TYPE, dest] }),
        });
      }
    }
    if (bits === 0n) return;
    handover.push({ resolver, bits });
    push("ens-roles", `Grant ${roleNames(bits).join(", ")} on resolver ${resolver} to the post-quantum account`, {
      to: resolver,
      value: 0n,
      data: encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "grantRootRoles", args: [bits, dest] }),
    });
  });
  const nowTs = (await client.getBlock()).timestamp;
  for (const name of v2Names) {
    const s = await readEnsv2Name(client, name);
    if (!s || s.latestOwner !== account || s.expiry <= nowTs) continue;
    push("ens-roles", `Transfer ${name} (ENSv2) to the post-quantum account`, {
      to: MAINNET.ens.ethRegistry,
      value: 0n,
      data: encodeFunctionData({ abi: ensPermissionedRegistryAbi, functionName: "safeTransferFrom", args: [account, dest, s.tokenId, 1n, "0x"] }),
    });
  }
  for (const { resolver, bits } of handover) {
    push("ens-roles", `Revoke the old key's ${roleNames(bits).join(", ")} on resolver ${resolver}`, {
      to: resolver,
      value: 0n,
      data: encodeFunctionData({ abi: ensPermissionedResolverAbi, functionName: "revokeRootRoles", args: [bits, account] }),
    });
  }

  // ---- 5. ETH last: the relayer pays gas, so the full balance can move
  const eth = await client.getBalance({ address: account });
  if (eth > 0n) push("direct-tx", `Move ${fmtAmount(eth, 18)} ETH to the post-quantum account`, { to: dest, value: eth, data: "0x" });

  // ---- 6. The wallet's own killswitch (GhostKey PQDelegate only, one-way)
  if (report.account.killswitch === false && opts.activateKillswitch !== false) {
    push("redelegation", "Activate the PQDelegate killswitch (ECDSA paths of this wallet off for good)", {
      to: account,
      value: 0n,
      data: encodeFunctionData({ abi: PQDelegate.abi, functionName: "activateKillswitch" }),
    });
  }

  return { calls, steps };
}
