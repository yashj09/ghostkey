# ADR-003: ENSv2 resolver roles are a core residual surface

**Status:** accepted · Fri 6 Nov 2026

## Context
The ENS prize asks for ENSv2 to be central. We first planned "transfer the name" as a fix step. Spike `EnsV2Spike.t.sol` (mainnet fork, the real ENSv2 `ETHRegistrar` and `PermissionedResolver`) showed something sharper:
- Registry roles move **atomically** with the name token: the old key ends with `roles == 0`.
- **PermissionedResolver roles are per account and are not touched by a name transfer.**
- So after Alice moves `ghostkeyalice.eth` to her new account, her old key can still `setAddress(name, 60, attacker)`. Every future payment to the name goes to the attacker.

## Decision
- Treat ENSv2 roles as surface #6.
- **Scan:** registry `roles(tokenId, oldKey)` and resolver `roles(ROOT_RESOURCE / coin resource, oldKey)` for names the old key owns or has resolver roles on.
- **Fix:** in the atomic batch, transfer the name token, grant the resolver roles to the new account, then `revokeRootRoles` from the old key.
- Pin interfaces to tag `v2-mainnet-deployment-1` of `ensdomains/contracts-v2`. That matches the mainnet bytecode (`setAddress(bytes name, …)`); `main` differs.

## Consequences
- ENS is central to the product: without ENSv2's role model, the "moving funds isn't enough" moment doesn't exist.
- Listing every name an address controls needs an indexer. Scan mode starts from names supplied by the user or the primary name, plus the resolver the user points at, so no third-party indexer is required.
