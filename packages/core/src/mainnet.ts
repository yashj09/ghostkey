import type { Address } from "viem";

/** Mainnet addresses (verified on a fork at block 26352043). */
export const MAINNET = {
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  safeSingleton141: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  safeProxyFactory141: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  safeSentinel: "0x0000000000000000000000000000000000000001",
  safeTxService: "https://api.safe.global/tx-service/eth/api/v2",
  ens: {
    v1Registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    // ENSv2 (tag v2-mainnet-deployment-1 of ensdomains/contracts-v2)
    rootRegistry: "0x2553c09bE6447BeFfdB86FA622ad41fB8f77A91e",
    ethRegistry: "0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2",
    ethRegistrar: "0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81",
    universalResolverV2: "0x06Fdd07F007ADaC667177b46aB2EB9A75132Cfd5",
    permissionedResolverImpl: "0x565b0F456a04Ac9b48758190e90030623Cff57C5",
    verifiableFactory: "0x77510ba162dfeA3d8989E3f0928a691B345730D2",
  },
} as const satisfies Record<string, unknown>;

/** ENSv2 role bits (PermissionedRegistry / PermissionedResolver, mainnet build). */
export const ENS_ROLES = {
  registry: {
    ROLE_SET_SUBREGISTRY: 1n << 20n,
    ROLE_SET_RESOLVER: 1n << 24n,
    ROLE_CAN_TRANSFER_ADMIN: (1n << 28n) << 128n,
  },
  resolver: {
    ROLE_SET_ADDRESS: 1n << 0n,
    ROLE_SET_TEXT: 1n << 4n,
    ROLE_SET_CONTENTHASH: 1n << 8n,
    ROLE_SET_ADDRESS_ADMIN: (1n << 0n) << 128n,
  },
  ROOT_RESOURCE: 0n,
} as const;

/**
 * How a token's off-chain signature path behaves after the holder's EOA gets 7702 code.
 * - ecrecover: permit verified with raw ecrecover, never asks the account (residual!)
 * - dai: DAI-style permit(holder, spender, nonce, expiry, allowed), ecrecover
 * - erc1271: permit uses SignatureChecker, so it asks the account's isValidSignature (protected while delegated)
 * - none: no signature-based transfer path
 */
export type PermitKind = "ecrecover" | "dai" | "erc1271" | "none";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  permit: PermitKind;
  /** Chainlink USD feed (8 decimals), or how to derive the price */
  price: { feed: Address } | { via: "wsteth" } | { fixedUsd: number } | null;
  /** verified on fork vs. assumed from source / docs */
  permitSource: "fork-verified" | "source" | "probe";
}

const FEED = {
  ETH: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  DAI: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
  USDC: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  USDT: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
  UNI: "0x553303d460EE0afB37EdFf9bE42922D8FF63220e",
  STETH: "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8",
  LINK: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c",
  AAVE: "0x547a514d5e3769680Ce22B2361c10Ea13619e8a9",
} as const satisfies Record<string, Address>;

export const ETH_USD_FEED = FEED.ETH;

/** Curated token list for the RPC-only scan. Unknown tokens can be probed via ScanHints.extraTokens. */
export const TOKENS: TokenInfo[] = [
  { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18, permit: "dai", price: { feed: FEED.DAI }, permitSource: "fork-verified" },
  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, permit: "erc1271", price: { feed: FEED.USDC }, permitSource: "fork-verified" },
  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, permit: "none", price: { feed: FEED.USDT }, permitSource: "source" },
  { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", decimals: 18, permit: "ecrecover", price: { feed: FEED.UNI }, permitSource: "source" },
  { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", symbol: "wstETH", decimals: 18, permit: "ecrecover", price: { via: "wsteth" }, permitSource: "source" },
  { address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", symbol: "stETH", decimals: 18, permit: "erc1271", price: { feed: FEED.STETH }, permitSource: "source" },
  { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", symbol: "AAVE", decimals: 18, permit: "ecrecover", price: { feed: FEED.AAVE }, permitSource: "source" },
  { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18, permit: "none", price: { feed: FEED.LINK }, permitSource: "source" },
  { address: "0x57e114B691Db790C35207b2e685D4A43181e6061", symbol: "ENA", decimals: 18, permit: "ecrecover", price: null, permitSource: "source" },
  { address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", symbol: "USDe", decimals: 18, permit: "ecrecover", price: { fixedUsd: 1 }, permitSource: "source" },
  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18, permit: "none", price: { feed: FEED.ETH }, permitSource: "source" },
];
