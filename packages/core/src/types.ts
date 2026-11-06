import type { Address, Hex } from "viem";

/** The six ways an old ECDSA key keeps power after a 7702 / PQ migration. See docs/architecture/surfaces.md. */
export type SurfaceId =
  | "direct-tx" // 1. plain tx signed by the EOA key
  | "redelegation" // 2. new EIP-7702 authorization signed by the EOA key
  | "ecrecover-permit" // 3. ERC-2612 / DAI permits that only use ecrecover
  | "erc1271-sig" // 4. Permit2 / USDC-style sigs that ask the account code (safe only while delegated)
  | "safe-owner" // 5. Safe owner signatures (ecrecover)
  | "ens-roles"; // 6. ENS ownership / ENSv2 resolver roles

/**
 * - exposed: the old key can take it right now.
 * - conditional: blocked today, but one old-key action (e.g. re-delegation) re-opens it.
 * - protocol-only: no app-level fix; only moving value away (or EIP-7851) helps.
 * - clear: nothing at risk on this surface.
 */
export type Severity = "exposed" | "conditional" | "protocol-only" | "clear";

export interface AssetAtRisk {
  kind: "eth" | "erc20" | "safe" | "ens-name";
  /** token / safe / registry or resolver address */
  address: Address;
  symbol: string;
  /** raw amount (wei / token units); 1n for non-fungible items */
  amount: bigint;
  decimals: number;
  /** USD value, if priced (Chainlink, RPC-only) */
  usd?: number;
  /** extra context, e.g. "1 of 1 owners", "ROLE_SET_ADDRESS" */
  note?: string;
}

export interface Finding {
  surface: SurfaceId;
  severity: Severity;
  title: string;
  /** one-line explanation shown in the report */
  detail: string;
  assets: AssetAtRisk[];
  usdAtRisk: number;
  /** can GhostKey's atomic migration close it today? */
  fixable: boolean;
  /** how it gets closed (or why it can't) */
  fix: string;
}

export interface AccountState {
  address: Address;
  /** EIP-7702 delegate address, if the EOA is delegated */
  delegatedTo?: Address;
  ethBalance: bigint;
  nonce: number;
  /** if delegated to a GhostKey PQDelegate: is its killswitch on? */
  killswitch?: boolean;
}

export interface ResidualReport {
  account: AccountState;
  chainId: number;
  blockNumber: bigint;
  scannedAt: string;
  findings: Finding[];
  /** sum of USD the old key can move now (exposed + protocol-only), deduplicated by asset */
  usdControlledByOldKey: number;
  /** extra USD that one old-key action would expose (conditional) */
  usdConditional: number;
}

/** One call in a PQ-signed batch (matches `Call` in contracts/src/PQAuth.sol). */
export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** What the scanner needs to know about names / safes it can't discover on its own. */
export interface ScanHints {
  /** ENS names to check (DNS-encoded handled internally), e.g. ["ghostkeyalice.eth"] */
  ensNames?: string[];
  /** ENSv2 PermissionedResolver addresses the old key may hold roles on */
  ensResolvers?: Address[];
  /** Safe addresses to check in addition to the Safe Transaction Service lookup */
  safes?: Address[];
  /** extra ERC-20s to check beyond the curated list */
  extraTokens?: Address[];
  /** skip calls to the Safe Transaction Service (fully RPC-only mode) */
  rpcOnly?: boolean;
}
