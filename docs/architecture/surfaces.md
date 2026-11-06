# Residual-authority surfaces

A **surface** is any way the old ECDSA key can still move value or identity after the account "migrates", e.g. by 7702-delegating to a post-quantum wallet. For each surface, GhostKey needs to know three things:
- how to **detect** it (scan)
- how to **prove** it (attack, fork only)
- how to **close** it (atomic migration batch)

**Status legend:** ✅ verified by a spike on a mainnet fork (block 26352043, `--hardfork osaka`) · 🔜 planned.

Spike sources:
- [`contracts/script/spikes/eip7702.sh`](../../contracts/script/spikes/eip7702.sh)
- [`contracts/test/spikes/EnsV2Spike.t.sol`](../../contracts/test/spikes/EnsV2Spike.t.sol)
- [`contracts/test/spikes/SafePermitSpike.t.sol`](../../contracts/test/spikes/SafePermitSpike.t.sol)

| # | Surface | Does a wallet-level killswitch stop it? | Evidence |
|---|---|---|---|
| 1 | **Direct EOA tx** | ❌ No. 7702 keeps the key a valid tx signer | ✅ `eip7702.sh` step 2 |
| 2 | **7702 re-delegation** | ❌ No. Anyone can relay a new authorization the old key signed | ✅ `eip7702.sh` step 3 |
| 3 | **ecrecover-only permits** (DAI, UNI, AAVE, wstETH, ENA, USDe) | ❌ No. These never look at account code | ✅ `test_spike_daiPermit_stillWorks` |
| 4 | **ERC-1271-aware sigs** (USDC v2.2, Permit2, stETH) | ✅ Yes, *while delegated*, because they ask `isValidSignature` | ✅ `test_spike_usdcPermit_blockedWhileDelegated` |
| 4b | …but re-delegation reopens them | ❌ Clearing the delegation brings back raw ecrecover | ✅ `test_spike_permit2_blockedThenReopenedByRedelegation` |
| 5 | **Safe owner** (1.4.1) | ❌ No. Safe uses ecrecover for v = 27/28 | ✅ `test_spike_safeOwner_stillWorks` |
| 6 | **ENSv2 resolver roles** | ❌ No. They belong to the account, not the name token | ✅ `test_spike_ensv2_residualResolverRole` |

## The ENSv2 finding
1. Alice registers `ghostkeyalice.eth` on mainnet ENSv2 (the real `ETHRegistrar`, paying 8 USDC) and deploys her own `PermissionedResolver` via `VerifiableFactory`.
2. She transfers the name token to her new account. The **registry** roles move with the token: old key `0`, new account gets the registration bitmap.
3. Her **resolver** roles (`ROLE_SET_ADDRESS` + admin) stay with the old key. The old key calls `setAddress`, and the name now resolves to the attacker.
4. **Fix:** grant the resolver roles to the new account, then the old key revokes its own roles (`revokeRootRoles`). After that, the old key reverts on `setAddress`.

Moving your money and your name is therefore **not** enough. The migration must also revoke resolver roles.

## Detection notes
- Probing for permit support:
  - UNI and COMP expose `nonces()` but no `DOMAIN_SEPARATOR()`.
  - AAVE uses `_nonces()`.
  - WETH's fallback returns `0x` for anything, so always check the length of returned data.
- Permit2's `lockdown` only clears AllowanceTransfer allowances. SignatureTransfer pulls stay possible until the ERC-20 approval to Permit2 is revoked, or the funds move.
- Anvil's default keys are **already 7702-delegated on mainnet** (sweeper bots). Demo accounts must use fresh keys.
- The mainnet ENSv2 build matches tag `v2-mainnet-deployment-1` of `ensdomains/contracts-v2`, not `main`. For example, it has `setAddress(bytes name, …)` rather than `setAddr(bytes32, …)`.
