# ADR-002: Our own PQDelegate with SPHINCS- leanSphincs-s, not an existing PQ account

**Status:** accepted · Fri 6 Nov 2026

## Context
The demo needs a believable "post-quantum wallet" that an EOA migrates to through EIP-7702. We considered:
- **Kohaku `pq-account`:** keys and entry point are set in the constructor and stored in storage. Under 7702 the constructor never runs, so the storage is empty. Not usable.
- **SPHINCS- `SphincsAccount`:** owner and PQ key are in constructor-set storage, and execution is EntryPoint-only. Not usable as a 7702 target.
- **Falcon / ML-DSA verifiers:** 447k–8M gas. They would work on a fork, but are slow and heavy for a live demo.

## Decision
- Vendor the EF's **leanSphincs-s** verifier (MIT, unmodified; about 39–43k gas, 4,164-byte signatures) and its Rust signer.
- Write a small `PQAuth` base with two subclasses:
  - `PQDelegate`: the 7702 target, with the ECDSA convenience path plus the killswitch.
  - `PQAccount`: a fresh PQ-only account.
- Put the PQ key in **immutables** (one delegate per user) and the nonce in an **ERC-7201 slot**.

## Consequences
- Real PQ signatures are verified on chain in the demo, so judges can't call it a mock.
- Each user deploys their own delegate. A product version would use a CREATE2 factory.
- Signing needs the Rust CLI. It's locally fast (~0.07s per signature), and tests reach it via FFI.
