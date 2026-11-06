# Progress log (IST)

- **Fri 05:25:** idea locked: GhostKey + Canary. Plan approved (`docs/PLAN.md`).
- **Fri 05:35:** repo skeleton: pnpm workspace, Foundry (`solc 0.8.30`, `evm prague`), MIT, docs tree.
- **Fri 06:00–07:00:** spikes on a mainnet fork (block 26352043), all green. See [`architecture/surfaces.md`](../architecture/surfaces.md).
  - 7702: a delegated EOA still sends txs, and an attacker can relay a re-delegation.
  - SPHINCS-: the vendored leanSphincs-s verifier passes 7 tests, about 39–43k gas, with a Rust CLI signer at ~0.07 s per signature.
  - ENSv2: real mainnet registrar + resolver. **Resolver roles survive a name transfer**, so the old key can redirect the name. The fix (grant, then self-revoke) works.
  - Safe 1/1 and DAI permit stay drainable after delegation. USDC and Permit2 are blocked by ERC-1271 until the old key clears the delegation.
  - Gate 08:00: **no fallbacks needed**. All 6 surfaces stay in scope.
