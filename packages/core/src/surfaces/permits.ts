import type { AssetAtRisk, Finding } from "../types.js";
import { clear, fmtUsd, noKey, sumUsd, tokenAsset, type Detector } from "./context.js";

/** Surface 3: ERC-2612 / DAI permits verified with raw ecrecover never ask the account's code. */
export const detectEcrecoverPermit: Detector = async (ctx) => {
  if (ctx.isContract) return noKey("ecrecover-permit", "ecrecover-only permits");
  const assets: AssetAtRisk[] = [];
  for (const t of ctx.tokens) {
    if (t.balance === 0n) continue;
    if (t.permit === "ecrecover") assets.push(tokenAsset(t, "ERC-2612 permit (ecrecover)"));
    else if (t.permit === "dai") assets.push(tokenAsset(t, "DAI-style permit (ecrecover)"));
    else if (t.permit === "ecrecover-probed") assets.push(tokenAsset(t, "permit detected by probe (assumed ecrecover)"));
  }
  if (assets.length === 0) return clear("ecrecover-permit", "ecrecover-only permits", "No balance in tokens whose permit uses raw ecrecover.");
  const usd = sumUsd(assets);
  return {
    surface: "ecrecover-permit",
    severity: "exposed",
    title: "Off-chain permits the wallet can't refuse",
    detail:
      `${assets.map((a) => a.symbol).join(", ")} verify permits with raw ecrecover, so they never ask the wallet code. ` +
      `One off-chain signature from the old key hands ${fmtUsd(usd)} to an attacker${ctx.delegated ? ", killswitch or not" : ""}.`,
    assets,
    usdAtRisk: usd,
    fixable: true,
    fix: "Move these tokens to the post-quantum account (a permit can only pull what is still there).",
  };
};

/** Surface 4: ERC-1271-aware signatures (USDC v2.2, stETH, Permit2). Safe while delegated, re-opened by surface 2. */
export const detectErc1271Sig: Detector = async (ctx) => {
  if (ctx.isContract) return noKey("erc1271-sig", "ERC-1271-aware signatures");
  const assets: AssetAtRisk[] = [];
  for (const t of ctx.tokens) {
    const viaPermit2 = t.permit2Allowance > 0n;
    if (t.permit === "erc1271" && t.balance > 0n) {
      assets.push(tokenAsset(t, viaPermit2 ? "ERC-1271 permit + Permit2 approval" : "ERC-1271 permit"));
    } else if (viaPermit2) {
      assets.push(tokenAsset(t, t.balance > 0n ? "Permit2 approval" : "standing Permit2 approval (balance 0 today)"));
    }
  }
  if (assets.length === 0) {
    return clear("erc1271-sig", "ERC-1271-aware signatures", "No ERC-1271-permit balances and no Permit2 approvals.");
  }
  const usd = sumUsd(assets);
  const permit2 = assets.filter((a) => a.note?.includes("Permit2")).map((a) => a.symbol);
  const base: Omit<Finding, "severity" | "detail"> = {
    surface: "erc1271-sig",
    title: ctx.delegated ? "Protected only while delegated" : "Signature transfers the old key can sign",
    assets,
    usdAtRisk: usd,
    fixable: true,
    fix:
      (permit2.length ? `Revoke the Permit2 approval (approve(Permit2, 0)) for ${permit2.join(", ")} and move` : "Move") +
      " the tokens to the post-quantum account.",
  };
  if (ctx.delegated) {
    return {
      ...base,
      severity: "conditional",
      detail:
        `These paths ask the wallet's isValidSignature, so they are blocked today. One re-delegation signed by the old key ` +
        `clears the code, and raw ecrecover then accepts its signatures again (${fmtUsd(usd)}).`,
    };
  }
  return {
    ...base,
    severity: "exposed",
    detail: `The account has no code, so USDC / stETH / Permit2 fall back to raw ecrecover: the old key can sign away ${fmtUsd(usd)} off-chain.`,
  };
};
