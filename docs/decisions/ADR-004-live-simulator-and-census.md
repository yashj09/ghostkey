# ADR-004: Make it live: any-address Q-day simulator + 7702 census

**Status:** accepted · Fri 6 Nov 2026, 09:20 IST

## Context
The first version (scripted "Alice" story) worked end to end but **felt static**. The judge watches a fake world and clicks *next*. Nothing reacts to them or touches anything real. A full pivot was considered and rejected: about 24h remain, and the idea's assets would be thrown away. Those assets are a confirmed gap, live mainnet evidence (vitalik.eth, yashj09.eth) and three sponsor fits.

## Decision
Keep the idea, change the experience.

1. **Q-day Simulator (any address).**
   - Paste any address or ENS name. The local server forks mainnet at the **latest** block and scans it.
   - It drains every surface **impersonating the account's key**, the fork equivalent of the old key signing, and labels this as a simulation everywhere.
   - It then runs GhostKey's migration from the account and re-attacks.
   - It runs on its own anvil (port 8548), separate from the guided demo.
2. **7702 Census.**
   - Scan the last ~24h of mainnet blocks for type-4 transactions and recover every authority.
   - Keep the accounts that are *still* delegated and price them RPC-only.
   - Classify by delegate:
     - **smart-wallet upgrades:** delegate code ≥ 5 KB
     - **minimal delegates, bots and sweepers:** smaller delegates, which dominate the volume (one ~0.8 KB delegate had 2,052 of 2,367 authorities in a 120-block sample)
   - The headline uses smart-wallet upgrades only.
   - Published as a committed JSON snapshot, with a local refresh option.
3. **UI.** The landing is the census number, then "simulate Q-day on any address", then the live simulation. Scan stays. The scripted Alice story becomes "Guided demo", kept as the offline fallback.

## Consequences
- The simulator needs the local server, so judging runs on the presenter's laptop. Hosted builds show the census and Scan.
- Impersonation proves *what the key could do*. It is not a real signature, and the UI says so.
- Census numbers are a time-boxed snapshot (block range shown) with transparent classification rules.
