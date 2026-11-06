import { useEffect, useState } from "react";

export interface Census {
  generatedAt: string;
  blocks: { from: number; to: number; count: number };
  rules: Record<string, string>;
  totals: { type4Txs: number; authorizations: number; uniqueAuthorities: number; stillDelegated: number; usd: number };
  wallet: { accounts: number; withValue: number; usd: number; topDelegates: { address: string; codeSize: number; accounts: number; usd: number }[] };
  minimal: { accounts: number; withValue: number; usd: number; topDelegates: { address: string; codeSize: number; accounts: number; usd: number }[] };
  topAccounts: { address: string; delegate: string; usd: number }[];
}

/** The 7702 census snapshot, shipped as a static file next to the app (no API, works on IPFS). */
export function useCensus() {
  const [census, setCensus] = useState<Census | null>(null);
  useEffect(() => {
    fetch("./census.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setCensus)
      .catch(() => setCensus(null));
  }, []);
  return census;
}
