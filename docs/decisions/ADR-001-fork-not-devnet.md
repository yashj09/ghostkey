# ADR-001: Demo on an anvil mainnet fork, not the EIP-8141 alt-mempool devnet

**Status:** accepted · Fri 6 Nov 2026

## Context
The first concept, a Quantum Canary wallet on EIP-8141 frame transactions, needed the EF alt-mempool devnet (chain 1337). A live check on Nov 6 showed:
- The faucet is empty.
- The devnet "can be reset at any time".
- The sidecar enforces `MAX_VERIFY_GAS = 100000` for every sender, staked or not.

The canary mechanism itself is prior art (Drake 2018), and a rational attacker never trips it.

## Decision
- Pivot to **GhostKey**: measure and remove *residual ECDSA authority* after a 7702 / PQ migration.
- Run everything on a pinned **anvil mainnet fork** (`--hardfork osaka`). The demo uses real mainnet contracts: DAI, UNI, USDC, Permit2, Safe 1.4.1 and ENSv2.
- Keep the canary as **Act 1 of the demo**: a wallet-level killswitch that trips, blocks only the ERC-1271-aware paths, and misses the rest.

## Consequences
- The demo is deterministic and offline-safe, with a pinned block and snapshot/revert.
- We lose the EF alt-mempool prize track and target EF CROPS, Uniswap and ENS instead.
- Frame transactions and EIP-8151 precompile behaviour are discussed but not demoed (`vm.etch` refuses precompiles).
