import type { AssetAtRisk, Finding } from "../types.js";
import { clear, ethAsset, fmtUsd, noKey, sumUsd, tokenAsset, type Detector, type ScanContext } from "./context.js";

/** Everything the EOA key can move with a plain tx: ETH + every held token. */
function heldAssets(ctx: ScanContext): AssetAtRisk[] {
  const out: AssetAtRisk[] = [];
  if (ctx.account.ethBalance > 0n) out.push(ethAsset(ctx));
  for (const t of ctx.tokens) if (t.balance > 0n) out.push(tokenAsset(t));
  return out;
}

/** Surface 1: the ECDSA key stays a valid tx signer after (and despite) EIP-7702 delegation. */
export const detectDirectTx: Detector = async (ctx) => {
  if (ctx.isContract) return noKey("direct-tx", "Direct transactions");
  const assets = heldAssets(ctx);
  const usd = sumUsd(assets);
  const how = ctx.delegated
    ? "EIP-7702 keeps the EOA key a valid transaction signer: a wallet-level killswitch cannot refuse it."
    : "Plain EOA: the ECDSA key signs any transaction.";
  return {
    surface: "direct-tx",
    severity: "protocol-only",
    title: "Old key can send any transaction",
    detail: assets.length ? `${how} It can move ${fmtUsd(usd)} directly.` : `${how} Nothing is left on the account to take.`,
    assets,
    usdAtRisk: usd,
    fixable: true,
    fix: "Move everything to a key-less post-quantum account (the atomic migration). Only a protocol change such as EIP-7851 (deactivate the EOA key) closes the surface itself.",
  };
};

/** Surface 2: the old key can sign a new 7702 authorization and replace the wallet code at any time. */
export const detectRedelegation: Detector = async (ctx) => {
  if (ctx.isContract) return noKey("redelegation", "7702 re-delegation");
  if (!ctx.delegated) {
    return clear(
      "redelegation",
      "7702 re-delegation",
      "Not delegated: there is no wallet code to swap out (the key already has full control via direct transactions).",
    );
  }
  // The assets that only wallet code protects: ERC-1271-aware tokens and anything Permit2 can pull.
  const assets: AssetAtRisk[] = [];
  for (const t of ctx.tokens) {
    if (t.balance === 0n) continue;
    if (t.permit === "erc1271") assets.push(tokenAsset(t, "ERC-1271 permit (asks the wallet code)"));
    else if (t.permit2Allowance > 0n) assets.push(tokenAsset(t, "Permit2 approval (asks the wallet code)"));
  }
  const usd = sumUsd(assets);
  const ks =
    ctx.account.killswitch === undefined
      ? ""
      : ctx.account.killswitch
        ? " The GhostKey killswitch is ON, but a new authorization replaces the code that enforces it."
        : " The GhostKey killswitch is off.";
  const res: Finding = {
    surface: "redelegation",
    severity: "protocol-only",
    title: "Old key can replace the wallet code",
    detail:
      `Delegated to ${ctx.account.delegatedTo}. Anyone can relay a new EIP-7702 authorization signed by the old key; ` +
      `that clears the wallet code and re-opens every ERC-1271 path (${fmtUsd(usd)} protected only by the code today).${ks}`,
    assets,
    usdAtRisk: usd,
    fixable: true,
    fix: "Move the value the code protects to a key-less post-quantum account. The protocol fix is EIP-7851 (the key can no longer sign authorizations).",
  };
  return res;
};
