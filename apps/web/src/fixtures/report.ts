import type { ResidualReport } from "@ghostkey/core";

/** Dev fixture shaped like the fork demo after "migrate + canary trip" (Act 2). */
export const demoReportFixture: ResidualReport = {
  account: {
    address: "0x5aE1b2C3d4E5f60718293a4B5c6D7e8F9012aBcD",
    delegatedTo: "0x1234567890aBcdEF1234567890abCDef12345678",
    ethBalance: 3_000000000000000000n,
    nonce: 6,
    killswitch: true,
  },
  chainId: 1,
  blockNumber: 26352043n,
  scannedAt: new Date().toISOString(),
  usdControlledByOldKey: 31_470,
  usdConditional: 10_090,
  findings: [
    { surface: "direct-tx", severity: "protocol-only", title: "Direct transactions", detail: "The old key can still sign any transaction from this EOA.", assets: [{ kind: "eth", address: "0x0000000000000000000000000000000000000000", symbol: "ETH", amount: 3_000000000000000000n, decimals: 18, usd: 6_697 }], usdAtRisk: 6_697, fixable: true, fix: "Move everything to a key-less PQ account (EIP-7851 would be the protocol fix)." },
    { surface: "redelegation", severity: "protocol-only", title: "7702 re-delegation", detail: "One signed authorization replaces your PQ wallet code.", assets: [], usdAtRisk: 0, fixable: true, fix: "Nothing left to re-open once value has moved." },
    { surface: "ecrecover-permit", severity: "exposed", title: "ecrecover-only permits", detail: "DAI and UNI accept the old key's signature directly.", assets: [{ kind: "erc20", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", amount: 5000_000000000000000000n, decimals: 18, usd: 4_998 }, { kind: "erc20", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", amount: 400_000000000000000000n, decimals: 18, usd: 2_731 }], usdAtRisk: 7_729, fixable: true, fix: "Move tokens to the PQ account." },
    { surface: "erc1271-sig", severity: "conditional", title: "Permit2 / ERC-1271", detail: "USDC + Permit2 approval are blocked by your wallet, until re-delegation.", assets: [{ kind: "erc20", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", amount: 10_091_999979n, decimals: 6, usd: 10_090, note: "Permit2 approval: unlimited" }], usdAtRisk: 10_090, fixable: true, fix: "Revoke the Permit2 approval and move tokens." },
    { surface: "safe-owner", severity: "exposed", title: "Safe ownership", detail: "1-of-1 owner: the old key can take the whole Safe.", assets: [{ kind: "safe", address: "0x9999999999999999999999999999999999999999", symbol: "Safe 0x9999…9999", amount: 1n, decimals: 0, usd: 11_161, note: "1 of 1 owners · 5 ETH" }], usdAtRisk: 11_161, fixable: true, fix: "swapOwner(old key → PQ account)." },
    { surface: "ens-roles", severity: "exposed", title: "ENSv2 resolver roles", detail: "ghostkeyalice.eth: the old key holds ROLE_SET_ADDRESS and can redirect payments.", assets: [{ kind: "ens-name", address: "0x8888888888888888888888888888888888888888", symbol: "ghostkeyalice.eth", amount: 1n, decimals: 0, note: "ROLE_SET_ADDRESS (+admin)" }], usdAtRisk: 0, fixable: true, fix: "Grant roles to the PQ account, transfer the name, self-revoke." },
  ],
};
