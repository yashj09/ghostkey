# Uniswap developer feedback (GhostKey, ETHGlobal Mumbai 2026)

GhostKey integrates **Permit2** as a residual-authority surface. It detects, exploits on a fork, and closes the ways an old ECDSA key can still move funds through Permit2 after the owner migrates with EIP-7702.

## What we built on
- `Permit2.permitTransferFrom` (SignatureTransfer). The attack path is in `packages/core/src/demo/steps.ts` → `attackRedelegateThenPermit2`.
- ERC-20 `allowance(owner, PERMIT2)` plus `Permit2.allowance(owner, token, spender)`. Detection is in `packages/core/src/surfaces/permits.ts`.
- `approve(PERMIT2, 0)` in the migration batch, in `packages/core/src/fix.ts`.
- Fork proof: `contracts/test/spikes/SafePermitSpike.t.sol` → `test_spike_permit2_blockedThenReopenedByRedelegation`.

## What worked well
- Permit2 uses `SignatureVerification` with the ERC-1271 fallback. Once the owner's EOA has 7702 code, a fresh ECDSA signature is checked against the **account's** `isValidSignature`. A wallet with a PQ killswitch can therefore *refuse* old-key Permit2 signatures. That's genuinely better than tokens with raw `ecrecover` permits, like DAI.
- `DOMAIN_SEPARATOR()` and the typed-data layout are stable and easy to reproduce off-chain with viem.

## Friction / gaps we hit
1. **The 1271 protection is only as strong as the delegation.** The old key can sign a 7702 authorization to `address(0)` (anyone can relay it). The account then has no code again, Permit2 falls back to `ecrecover`, and the old key can drain everything with a standing approval. That isn't Permit2's bug, but it isn't documented anywhere. A note in the Permit2 docs about 7702 / account-abstraction migrations would help wallets.
2. **`lockdown()` only clears AllowanceTransfer allowances.** SignatureTransfer pulls stay possible until the *ERC-20* approval to Permit2 is revoked. Users and wallets often assume "lockdown" means "Permit2 can't touch my tokens". A `lockdownSignatureTransfer`, or clearer naming and docs, would prevent that misunderstanding.
3. **No way to enumerate outstanding Permit2 authority without an indexer.** We read `allowance(owner, Permit2)` per token, which covers SignatureTransfer exposure. AllowanceTransfer spenders need event indexing. A view helper, or an official lightweight indexer, would make privacy-preserving (RPC-only) scanners like ours more complete.
4. **Nonce bitmap invalidation:** `invalidateUnorderedNonces` can't invalidate signatures the user doesn't know about (an attacker holding the old key can mint new ones). For key-compromise or migration scenarios, the only real fix is revoking the ERC-20 approval. Spell that out in the security docs.

## Suggestion
A short "**migrating an EOA that uses Permit2**" checklist in the docs: revoke ERC-20 approvals to Permit2 from the old key, or move the funds, *before* relying on a smart-account / PQ wallet's `isValidSignature`.
