# Architecture overview

```
                 ┌────────────────────────── apps/web (Vite + React + shadcn) ──────────────────────────┐
                 │  Scan tab ─ scanAccount() in the browser, straight to YOUR RPC (no backend, no indexer) │
                 │  Live demo tab ─ SSE ↔ apps/demo-server (local only)                                  │
                 └───────────────┬──────────────────────────────────────────────┬────────────────────────┘
                                 │ @ghostkey/core                                 │ /api/stream, /api/step/:id
┌────────────────────────────────▼───────────────────────┐      ┌────────────────▼────────────────────────────┐
│ packages/core (TypeScript, viem)                         │      │ apps/demo-server (Node, 127.0.0.1 only)      │
│  scan.ts + surfaces/*  → ResidualReport (6 surfaces)     │◄─────┤  spawns anvil mainnet fork (osaka, pinned)   │
│  fix.ts                → atomic migration Call[]          │      │  8-step state machine, snapshots, SSE hub    │
│  prices.ts             → Chainlink feeds via multicall   │      │  uses core/demo + core/node                  │
│  pq.ts                 → executeDigest, PQSigner         │      └──────────────────────────────────────────────┘
│  demo/*                → world setup, 5 attacks, fix exec │
│  node/*                → wraps tools/ Rust CLIs           │
└──────────────┬───────────────────────────────────────────┘
               │ ABIs + bytecode (scripts/gen-artifacts.ts)
┌──────────────▼──────────────────────┐   ┌──────────────────────────────────────────┐
│ contracts/ (Foundry)                 │   │ tools/ (Rust)                            │
│  PQAuth · PQDelegate · PQAccount     │   │  sphincs-signer: leanSphincs-s keygen/sign│
│  QuantumCanary · vendor/sphincs      │   │  bsgs: baby-step giant-step key cracker  │
│  fork tests prove every surface      │   └──────────────────────────────────────────┘
└──────────────────────────────────────┘
```

## Flows
- **Scan (product).** The browser calls `scanAccount(publicClient, address, hints)` against the user's own RPC. Detectors batch reads through Multicall3 and price assets with Chainlink feeds. Nothing else is contacted unless the user opts into the Safe Transaction Service lookup. Output is a `ResidualReport` with one finding per surface, a severity, and whether it can be fixed today.
- **Fix.** `buildMigration(report, destination)` turns a report into an ordered `Call[]` that the account runs as **one** `PQDelegate.execute(calls, leanSphincsSig)`:
  1. token transfers
  2. `approve(Permit2, 0)`
  3. Safe `swapOwner`
  4. ENSv2 `setAddress`, then `grantRootRoles`, then `safeTransferFrom`, then `revokeRootRoles`
  5. ETH sweep

  Anyone can relay it, so the EOA needs no gas and can be emptied completely.
- **Live demo.** `apps/demo-server` drives `@ghostkey/core/demo` step by step on a dedicated fork (port 8547) and streams state and log lines to the cockpit. Rewind and reset use anvil snapshots.

## Trust and safety notes
- The demo server binds `127.0.0.1` and only holds throwaway keys for a local fork.
- The web app ships no analytics. Fonts are self-hosted. The user chooses their RPC.
- The vendored SPHINCS- verifier is unaudited research code (EF, MIT). GhostKey is a hackathon prototype, not for production funds.
