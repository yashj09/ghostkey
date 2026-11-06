# Progress log (IST)

- **Fri 05:25:** idea locked: GhostKey + Canary. Plan approved (`docs/PLAN.md`).
- **Fri 05:27:** repo skeleton: pnpm workspace, Foundry (`solc 0.8.30`, `evm prague`), MIT, docs tree.
- **Fri ~05:30:** spikes on a mainnet fork (block 26352043), all green. See [`architecture/surfaces.md`](../architecture/surfaces.md).
  - 7702: a delegated EOA still sends txs, and an attacker can relay a re-delegation.
  - SPHINCS-: the vendored leanSphincs-s verifier passes 7 tests, about 39–43k gas, with a Rust CLI signer at ~0.07 s per signature.
  - ENSv2: real mainnet registrar + resolver. **Resolver roles survive a name transfer**, so the old key can redirect the name. The fix (grant, then self-revoke) works.
  - Safe 1/1 and DAI permit stay drainable after delegation. USDC and Permit2 are blocked by ERC-1271 until the old key clears the delegation.
  - Gate check (planned for 08:00, cleared early): **no fallbacks needed**. All 6 surfaces stay in scope.
- **Fri ~05:34:** core contracts in: `PQAuth`, `PQDelegate` (7702 target with the canary killswitch), `PQAccount`, `QuantumCanary`. 10 unit tests with live SPHINCS signatures via FFI. Rust `bsgs` cracks a 40-bit canary key in about 80 ms.
- **Fri ~05:37:** end-to-end mainnet-fork story green (`test/fork/Migration.t.sol`):
  - **Act 2** (killswitch ON): the old key still takes 5,000 DAI (permit), 10,091 USDC (re-delegate + Permit2), 3 ETH + 400 UNI (direct tx), the Safe's 5 ETH, and redirects `ghostkeyalice.eth`.
  - **Act 3**: one PQ-signed atomic batch, then the same attacks get **$0**. The Safe owner is swapped and the ENS resolver roles are revoked.
  - 25/25 tests pass.
- **Fri ~06:05:** TypeScript core done (scanner: 13 tests, demo world: 3 tests), and a **local demo server + Live Demo cockpit** that runs the whole story on its own fork:
  - Act 1: canary cracked (44-bit) in ~290 ms.
  - Act 2: scan finds $41,249 exposed; the old key steals $41,248 with the killswitch ON.
  - Act 3: an 11-call leanSphincs-s-signed batch (538k gas). Re-attack yields $0.
  - Canary strength raised to 44 bits: ~0.4 s to crack, ~240 MB of memory.
