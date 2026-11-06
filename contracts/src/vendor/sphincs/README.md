# Vendored: leanSphincs-S (keccak256) verifier

- Source: https://github.com/nconsigny/SPHINCS- (Nicolas Consigny, Ethereum Foundation)
- Commit: `4c76aaf113d326df9adede63d015f3b394ab84f4`
- File: `src/keccak/LeanSphincs-SAsm.sol` -> `LeanSphincs-SAsm.sol` (no imports)
- License: MIT (see `LICENSE`, copied from the upstream repo root)
- Status: **unmodified** (byte-identical to upstream)

The matching Rust signer (upstream `signers/leansphincs-s-keccak`, itself MIT, derived from Tom Wambsgans'
leanSphincs crate, see its `LICENSE.upstream`) is vendored at `tools/sphincs-signer/`, with our extra
`sphincs-signer` CLI binary added (`src/bin/sphincs-signer.rs`); the library sources are unmodified.

Gas note: upstream compiles with `via_ir = true` (verify frame ~38.9k gas). Our default profile (no via_ir)
measures ~42.6k for the same signature.
