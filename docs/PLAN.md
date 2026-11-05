# GhostKey + Canary: Implementation Plan

## Context
Solo build at **ETHGlobal Mumbai 2026**, From Scratch track. Submissions close **Sat 7 Nov 09:00 IST**; we target 08:00. Finalist judging is a 4 min demo + 3 min Q&A, with protocol-heavy judges (Vitalik, Drake, Nethermind, Lion, Ledger).

**Problem.** EIP-7702 and frame transactions *install code* on an EOA, but they never switch the ECDSA key off.
- Nethermind (Ankushin): *"It installs code. The ECDSA key stays the root key… Contracts that call ecrecover directly, such as permit, still accept the old key."*
- EIP-8151 (Draft) names DAI permit and Permit2. EIP-7851 (Draft, not scheduled for any fork) would add key deactivation.
- Wallet-level PQ killswitches (Drake's 2018 canary, Kohaku's "PQ killswitch" roadmap item) only control what the *wallet* accepts.
- **No tool shows users their residual ECDSA authority.** Revoke.cash lists 7702 delegations and Permit2 allowances, but it doesn't probe permit capability or analyse post-migration authority (verified by code search).

**Product.** **GhostKey: "You migrated. Your old key didn't."**
- A scanner that classifies every way the old key can still move value.
- An atomic **"Complete migration"** to a fresh post-quantum account.
- A deterministic live drain demo on an anvil mainnet fork.
- The **Canary** is Act 1: a wallet-level killswitch trips. It blocks *some* paths (ERC-1271-aware ones) and misses the rest. GhostKey shows exactly which.

## Locked decisions

| Topic | Decision |
|---|---|
| Interface | Vite + React web app with two modes: **Scan** (any mainnet address, read-only) and **Live Demo** cockpit (local anvil fork) |
| PQ wallet | Own **`PQDelegate`** (7702 target, PQ key as immutables, nonce in an ERC-7201 slot). Neither Kohaku pq-account nor SphincsAccount works under 7702 (verified) |
| PQ crypto | EF SPHINCS- **`LeanSphincsSAsm`** verifier (MIT, vendored, credited; about 39k gas, 4,164 B signature). Signing uses the **Rust signer** `signers/leansphincs-s-keccak` (7–29 ms). Cargo 1.89 is present; Python lacks pycryptodome |
| Remediation | **Atomic batch** via the delegate, SPHINCS-signed: move assets to a **fresh PQAccount**, swap the Safe owner, transfer the ENSv2 name and revoke resolver roles, revoke Permit2 approvals. Re-run all attacks → **"$0 controlled by old key"** |
| Scan scope | Fork demo + read-only real-mainnet scan. **RPC-only**: curated ~200-token list via Multicall3, so no indexer learns the address |
| Stack | pnpm monorepo: `contracts/` (Foundry) · `packages/core` (TS/viem) · `apps/web` · `apps/demo-server` (Fastify, local only) · `tools/` (Rust: `sphincs-signer`, `bsgs`) |
| Canary | Stores its demo pubkey. A **Rust BSGS** binary (k256 + rayon) cracks a **36-bit** key live in under 1s (40-bit about 1–2s). The production design (a NUMS key from hash-to-curve) is explained, not cracked |
| Sponsors | **EF CROPS** (Security lead) · **Uniswap** (Permit2 residual-authority tooling) · **ENS** (ENSv2 EAC roles as a core surface) |
| Hosting | **IPFS + ENS contenthash** (canonical) **+ Vercel** (backup). Public links serve Scan mode; the cockpit runs locally |
| Repo | Public **github.com/yashj09/ghostkey**, MIT. All four research/idea files deleted; this plan becomes `docs/PLAN.md` |
| Fork | User's RPC key in a gitignored `.env`; `anvil --fork-url $RPC --fork-block-number <pinned> --hardfork osaka` (the default is Prague) |

## Key protocol insight that shapes the demo (verified)
After 7702 delegation, contracts that use SignatureChecker (**Permit2, USDC v2.2, stETH**) call the account's `isValidSignature`. So `PQDelegate.isValidSignature` accepts ECDSA **only while the killswitch is off**.

The canary therefore **does** protect 1271-aware paths, and the scan reports them as *"protected, until re-delegated"*. It **cannot** stop:

| # | Surface | Why the killswitch misses it | Fix in the atomic batch |
|---|---|---|---|
| 1 | Direct EOA tx | 7702 keeps the key a valid tx signer | Move all assets to PQAccount → nothing left (**protocol-only**: EIP-7851) |
| 2 | 7702 re-delegation | A new authorization overwrites the code. That also **re-opens surface 4** (code gone → raw ecrecover again) | Same; nothing left to take (**protocol-only**) |
| 3 | ecrecover-only permits: **DAI, UNI, AAVE, wstETH, ENA, USDe** | They never look at code | Move the tokens to PQAccount |
| 4 | Permit2 / USDC / stETH (1271-aware) | Protected only while delegated, so it falls to #2 | `approve(Permit2, 0)` + move |
| 5 | Safe owner (1/1) | Safe's ECDSA signature path (to verify in a spike) | `swapOwner(sentinel, old, PQAccount)` |
| 6 | **ENSv2 roles** | Resolver roles belong to the *account*, independent of the name token. Moving the money doesn't revoke them, so the old key can **re-point alice.eth → attacker** and steal future payments | Transfer the name token (registry roles move atomically) **and** `revokeRootRoles` on the PermissionedResolver after granting to PQAccount |

**Pitch line:** *"Moving your funds isn't enough. ENSv2 roles mean your old key can still redirect every future payment to alice.eth."* This is why ENS is central.

**Detection gotchas (verified):**
- UNI and COMP have no `DOMAIN_SEPARATOR`.
- AAVE uses `_nonces`.
- WETH's fallback returns `0x`, so always check the length of returned data.
- Permit2 `lockdown` only clears AllowanceTransfer allowances. SignatureTransfer needs the ERC-20 approval to Permit2 revoked.

## Architecture

```
ghostkey/
├─ contracts/                 Foundry (solc 0.8.28)
│  ├─ src/QuantumCanary.sol       demo pubkey stored; claim(sig over claimer) → tripped, bounty paid, event
│  ├─ src/PQDelegate.sol          7702 target: execute(calls, pqSig); executeECDSA(calls) if !killswitch;
│  │                               isValidSignature: PQ always, ECDSA only if !killswitch; killswitch = canary.tripped()||ownerKill
│  ├─ src/PQAccount.sol           fresh SPHINCS-only account (CREATE2), execute(calls, pqSig), isValidSignature PQ-only
│  ├─ src/vendor/sphincs/LeanSphincsSAsm.sol   (MIT, unmodified, credited)
│  ├─ script/DemoSetup.s.sol      fixture: Alice funded (DAI, UNI, USDC, wstETH), Permit2 approvals, Safe 1.4.1 1/1, ENSv2 name + PermissionedResolver
│  ├─ script/spikes/              7702, sphincs, ensv2, safe spikes
│  └─ test/                       unit + fork tests: each attack succeeds pre-fix, fails post-fix
├─ packages/core/             surfaces/{eoa,permit,permit2,safe,ensv2}.ts · scan.ts → ResidualReport · attacks/* · fix.ts · tokens.ts
├─ apps/demo-server/          anvil spawn/snapshot/revert · signer + cracker wrappers · routes + SSE log
├─ apps/web/                  Scan · Live Demo cockpit · Report (no analytics)
├─ tools/sphincs-signer (Rust, from SPHINCS- signer, MIT) · tools/bsgs (Rust, k256 + rayon)
└─ docs/  PLAN.md · architecture/{overview,contracts,surfaces}.md · decisions/ADR-00x-*.md · progress/log.md · AI_USAGE.md
   (+ README with CROPS section, FEEDBACK.md for Uniswap at repo root)
```

**Data sources for Scan mode (all through the user's RPC unless noted):**
- Multicall3 `0xcA11…CA11`
- Permit2 `0x0000…8BA3`
- Safe singleton 1.4.1 `0x4167…461a` and factory `0x4e1D…ec67`
- Safe Tx Service `api.safe.global/tx-service/eth/api/v2/owners/{a}/safes/` (no key, rate-limited; disclosed under CROPS "P")
- ENSv2 mainnet: RootRegistry `0x2553…a91e`, ETHRegistry `0xf60a…85e2`, UniversalResolverV2 `0x06fd…cfd5`

## Demo flow (2:45 video / 4:00 live)
1. **Setup** (pinned fork): Alice holds DAI, UNI, USDC and wstETH; has a Permit2 approval; is 1/1 Safe owner; owns `alice.eth` on ENSv2 with a resolver.
2. **Migrate:** Alice 7702-delegates to PQDelegate → *"Quantum-safe ✅"*.
3. **Canary:** BSGS cracks the demo key live → `claim()` → killswitch ON → *"ECDSA disabled ✅"*.
4. **GhostKey scan:** green = *"Permit2 / USDC protected (until re-delegated)"*; red = **"$X still controlled by your old key"**, broken down by surfaces 1, 2, 3, 5 and 6.
5. **Q-day:** the attacker uses the old key to:
   - drain DAI and UNI via permit;
   - send a tx straight from the EOA;
   - **re-delegate**, then drain USDC via Permit2;
   - take over the Safe;
   - **redirect alice.eth**.
6. **Rewind** (anvil revert) → **Complete migration** (one SPHINCS-signed batch).
7. **Re-attack** → every attack fails or finds $0, and `alice.eth` can't be redirected. Report: **"$0 controlled by old key"**. Surfaces 1–2 are labelled *"neutralised; protocol fix = EIP-7851/8151"*.

## Build order and checkpoints (IST)

| When | Work | Commit |
|---|---|---|
| 05:45–06:30 | Delete the 4 old files; `git init`; pnpm workspace; Foundry; MIT; README stub; docs tree; create and push the public repo | `init repo + workspace skeleton` |
| 06:30–08:00 | **Spikes** on the fork, each a short script plus notes in `docs/progress/log.md`:<br>(a) 7702 delegate, direct tx and re-delegation via `cast --auth` (sender nonce + 1)<br>(b) Rust SPHINCS signer → `LeanSphincsSAsm.verify` true on the fork<br>(c) ENSv2: register or impersonate on the fork; resolver role grant/revoke; transfer-then-`setAddress` by the old key<br>(d) Safe 1/1 ECDSA `execTransaction` works from a delegated EOA owner<br>(e) BSGS: 36-bit key in under 2s | `spikes: 7702, sphincs, ensv2, safe, bsgs` |
| **08:00 GATE** | If ENSv2 fails → use a UserRegistry, or the Sepolia ENSv2 deployment for the ENS surface (keep the ENS prize). If the Safe path fails → drop surface 5. If SPHINCS fails → keep PQ behind an interface and fix by 12:00 | — |
| 08:00–10:30 | QuantumCanary + PQDelegate + PQAccount + unit tests | `canary + pq delegate/account + tests` |
| 10:30–13:00 | DemoSetup fixture + fork tests (attack before, fail after, for each surface) | `fork fixture + attack/fix tests` |
| 13:00–15:30 | `packages/core`: detectors (with the gotchas), report, attacks, fix builder | `core: scanner, attacks, fix builder` |
| **15:30 GATE** | Full end-to-end by CLI on the fork? If not, cut in this order: Safe → the resolver half of ENS → real-mainnet scan polish | — |
| 15:30–17:00 | demo-server (anvil, signer, cracker, SSE) | `demo server` |
| 17:00–20:30 | Web: Scan, Live Demo cockpit, Report | `web: scan + demo cockpit` |
| 20:30–22:00 | Real-mainnet scan check (e.g. vitalik.eth); README + **CROPS** section; `FEEDBACK.md`; `AI_USAGE.md`; ADRs; architecture docs | `docs, crops, feedback` |
| 22:00–02:00 | **Sleep** | — |
| 02:00–04:30 | Fixes; IPFS + eth.limo + Vercel deploy; rehearse 3×; backup screen capture | `deploy + polish` |
| 04:30–07:00 | 2:45 video (720p+, own voice); submission form; partners EF, Uniswap, ENS; Uniswap feedback form | — |
| 07:00–08:00 | Buffer → **submit by 08:00** | `final touches` |

## Risks & fallbacks
- **ENSv2 is "deployed ahead of launch" on mainnet** (docs). Spike (c); fallbacks as in the gate.
- **The fork RPC must serve historical state.** Use the user's key; drpc works keyless as a backup. Pin the block.
- **EIP-8151 precompile prototype is out of scope.** `vm.etch` refuses precompiles. It's mentioned as future work, possibly an `eth_simulateV1` `movePrecompileToAddress` demo if Foundry is ≥1.9 (stretch only).
- **Live demo failure** → everything is local on a pinned fork, with a Reset (revert) button and a pre-recorded backup.
- **Scope** → the cut order above. Surfaces 1–4 + 6 are the core story.

## Verification
- `forge test --fork-url $RPC --fork-block-number N`: canary claim and killswitch semantics; `isValidSignature` ECDSA rejected after the trip; each attack succeeds before the fix and fails after; PQ batch rejects a bad SPHINCS signature.
- `pnpm -F core test`: detector snapshot on the fork fixture; smoke-scan a known real mainnet address.
- `pnpm demo:e2e`: setup → migrate → crack → scan → attack → revert → fix → re-attack; asserts residual == $0.
- Manual: the cockpit full run twice back-to-back; the eth.limo link loads Scan mode with no third-party requests except the user's RPC and the Safe API (checked in the network tab).
