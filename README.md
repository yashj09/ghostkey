# GhostKey 👻🔑

**You migrated. Your old key didn't.**

EIP-7702 and EIP-8141 frame transactions *install code* on your account. They never switch the old ECDSA key off. So after you "upgrade" to a smart or post-quantum wallet, the key you thought you'd retired can still:

| # | Surface | What the old key can still do | Can a wallet-level killswitch stop it? |
|---|---|---|---|
| 1 | Direct transactions | sign any tx from your EOA | ❌ protocol-level |
| 2 | 7702 re-delegation | replace your wallet code (and re-open #4) | ❌ protocol-level |
| 3 | ecrecover-only permits | DAI, UNI, AAVE, wstETH, ENA, USDe never ask your wallet | ❌ |
| 4 | Permit2 / ERC-1271 sigs | USDC, stETH, Permit2 *do* ask your wallet… | ✅ until #2 |
| 5 | Safe ownership | Safe checks owner signatures with `ecrecover` | ❌ |
| 6 | ENSv2 roles | resolver roles belong to the account, so they **survive a name transfer**: re-point `you.eth` to the attacker | ❌ |

A post-quantum **canary** (Drake, 2018) or a PQ killswitch only changes what your *wallet code* accepts. GhostKey shows what it misses:

> On a mainnet fork, Alice migrates to a leanSphincs-s post-quantum wallet. The canary trips and her killswitch turns **ON**.
> Her old key still steals **$41,248**: DAI by permit, USDC by re-delegation + Permit2, ETH/UNI/wstETH directly, her Safe's 5 ETH, and it redirects `ghostkeyalice.eth`.
> GhostKey builds **one post-quantum-signed batch** (11 calls, 538k gas). After it runs, the same attacks get **$0**.

This isn't hypothetical. Scan `vitalik.eth` with the deployed app: the account is EIP-7702-delegated today, and its original ECDSA key still directly controls the account's funds and the `vitalik.eth` name (ENSv1). That's not a bug in anyone's wallet. **It's how EIP-7702 works**, and it's exactly what EIP-7851 / EIP-8151 are trying to fix.

## What's in the box

- **Scan** (the product): enter any address or ENS name. GhostKey runs **in your browser against the RPC you choose** and returns a per-surface report of residual ECDSA authority in USD, priced on-chain via Chainlink. No backend, no indexer, no analytics.
- **Complete migration**: builds the atomic batch that closes every fixable surface. It moves value to a fresh key-less PQ account, revokes Permit2, swaps Safe owners, hands over ENSv2 roles, and has the old key **revoke its own** resolver roles.
- **Live demo**: an 8-step, presenter-driven story on a local mainnet fork, with real contracts (DAI, USDC, Permit2, Safe 1.4.1, ENSv2), real signatures, and a live BSGS crack of a 44-bit canary key in about 0.3 s.

## How it works

```
contracts/        Foundry: PQAuth · PQDelegate (7702 target + canary killswitch) · PQAccount · QuantumCanary
                  + vendored EF leanSphincs-s verifier (~39-43k gas) · fork tests proving every surface
packages/core     TypeScript (viem): scanAccount() · buildMigration() · Chainlink prices · demo world + attacks
apps/web          Vite + React + shadcn/ui: Scan + Live Demo cockpit (no trackers, self-hosted fonts)
apps/demo-server  local-only: spawns the anvil fork, runs the 8 steps, streams state over SSE
tools/            Rust: sphincs-signer (leanSphincs-s keygen/sign) · bsgs (baby-step giant-step cracker)
docs/             plan, architecture, surfaces, decisions (ADRs), progress log, AI usage
```

More detail: [`docs/architecture/overview.md`](docs/architecture/overview.md) · [`docs/architecture/surfaces.md`](docs/architecture/surfaces.md) (what was verified, and how) · [`docs/architecture/contracts.md`](docs/architecture/contracts.md) · [`docs/decisions/`](docs/decisions).

## Run it

**Prerequisites:** Node ≥ 22, pnpm 10, Foundry (anvil/forge/cast), Rust (cargo), and a mainnet RPC with historical state (Alchemy / Infura / QuickNode).

```bash
git clone --recursive https://github.com/yashj09/ghostkey && cd ghostkey
cp .env.example .env            # set MAINNET_RPC_URL (FORK_BLOCK=26352043 is the pinned demo block)
pnpm bootstrap                  # pnpm install + build the Rust tools + forge build
pnpm demo                       # demo server (anvil fork on :8547) + web app on http://localhost:5173
```

- **Scan** works without the demo server. Open the app, paste an address or ENS name, and pick your RPC under *Advanced*.
- **Live demo**: the *Live demo* tab. Press → / Space / a presentation clicker to advance.
- **Tests:**
  ```bash
  pnpm contracts:test   # reads .env: unit + mainnet-fork tests (25)
  # core tests expect an anvil fork on :8545 (demo) and :8546 (scanner):
  anvil --fork-url $MAINNET_RPC_URL --fork-block-number 26352043 --hardfork osaka --port 8545 &
  anvil --fork-url $MAINNET_RPC_URL --fork-block-number 26352043 --hardfork osaka --port 8546 &
  pnpm --filter @ghostkey/core test
  ```

## CROPS

GhostKey's lead property is **Security**: it finds and removes the authority an old key keeps after a "migration". The other three hold as follows.

- **C (Censorship resistance):** there's no GhostKey server. The Scan app is a static bundle (IPFS + ENS contenthash, with a Vercel mirror) that talks only to the RPC *you* configure. If our domain disappears, the IPFS build or a local `pnpm build` works the same. The migration batch is PQ-signed and **relayable by anyone**, so no relayer of ours can refuse it.
- **O (Open source):** MIT. Everything builds and runs from this repo alone: contracts, the TS core, both apps and the Rust tools. Vendored code (EF SPHINCS- verifier and signer) is MIT and unmodified.
- **P (Privacy):**
  - Your RPC provider learns which address you scanned. That's unavoidable without private RPC, so point it at your own node.
  - Nobody else sees anything: no analytics, no trackers, self-hosted fonts, prices from Chainlink via your RPC.
  - The Safe Transaction Service lookup is **off by default**. If you enable it, safe.global sees the address.
- **S (Security):**
  - The scan is read-only and never asks for a key.
  - The migration batch is signed with your post-quantum key on your device. GhostKey never holds keys.
  - The demo server binds 127.0.0.1 and only holds throwaway keys for a local fork.
  - **Trust assumptions:** the SPHINCS- verifier is unaudited research code. Surfaces 1–2 can only be fully closed by a protocol change (EIP-7851 / EIP-8151); GhostKey makes sure nothing is left behind them.

## Sponsor notes

- **Ethereum Foundation (CROPS):** see above. The project is a tool where Security is the reason it exists, and it ships with a live demo of the moment that matters: the killswitch is ON and the money still leaves.
- **Uniswap Foundation:**
  - Permit2 is one of GhostKey's residual-authority surfaces. Detection is `allowance(owner, Permit2)` × balance, plus the ERC-1271 behaviour of `SignatureTransfer` once the owner is delegated.
  - The attack lives in `attackRedelegateThenPermit2` in [`packages/core/src/demo/steps.ts`](packages/core/src/demo/steps.ts).
  - The fix (`approve(Permit2, 0)` + move) lives in [`packages/core/src/fix.ts`](packages/core/src/fix.ts).
  - See [`FEEDBACK.md`](FEEDBACK.md).
- **ENS:** ENSv2's account-scoped `PermissionedResolver` roles are surface #6 and the strongest "moving funds isn't enough" moment.
  - Scan: `surfaces/ens.ts` checks registry ownership, root resolver roles, and ENSv1 control.
  - Fix: `setAddress`, then `grantRootRoles`, then `safeTransferFrom`, then a self-`revokeRootRoles` by the old key.
  - Proven against the mainnet ENSv2 deployment in [`contracts/test/spikes/EnsV2Spike.t.sol`](contracts/test/spikes/EnsV2Spike.t.sol).

## Credits & prior art

- Problem framing:
  - Daniil Ankushin (Nethermind), *7702 / frame-tx PQ migration leaves the ECDSA key as root*.
  - The [EIP-8151](https://ethereum-magicians.org/t/eip-8151-ecdsa-authority-deactivation-aware-ecrecover/27690) and EIP-7851 discussions.
  - Justin Drake, [*Cryptographic canaries and backups*](https://ethresear.ch/t/cryptographic-canaries-and-backups/1235) (2018).
- Post-quantum signatures: [nconsigny/SPHINCS-](https://github.com/nconsigny/SPHINCS-) leanSphincs-s verifier and signer (MIT, Ethereum Foundation), building on Tom Wambsgans' leanSphincs.
- AI assistance is documented in [`docs/AI_USAGE.md`](docs/AI_USAGE.md).

⚠️ Hackathon prototype (ETHGlobal Mumbai 2026). Unaudited. Don't use with real funds.

## License

MIT
