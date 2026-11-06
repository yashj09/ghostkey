# Contracts

All contracts are in `contracts/src` (Foundry, solc 0.8.30, EVM prague; tests fork mainnet with `--hardfork osaka`).

```
PQAuth (abstract)        leanSphincs-s auth: execute(calls, pqSig), executeDigest, nonce (ERC-7201 slot), token receivers
 ├─ PQDelegate           EIP-7702 target for the EOA: + executeECDSA (self-call), ECDSA-aware ERC-1271, killswitch
 └─ PQAccount            fresh PQ-only account: ERC-1271 accepts PQ only; destination of "Complete migration"
QuantumCanary            bounty locked to a secp256k1 pubkey; claim(to, sig) → tripped (one-way)
vendor/sphincs/LeanSphincsSAsm   EF SPHINCS- verifier (MIT, unmodified)
```

## PQAuth
- The **digest** is `keccak256(abi.encode(EXECUTE_TYPEHASH, chainid, address(this), nonce, keccak256(abi.encode(calls))))`. It binds the chain, the account (the EOA address under 7702), the nonce and the exact batch.
- **Replay:** the nonce increments before the calls run, and a reused signature fails.
- **Storage:** an ERC-7201 namespace (`ghostkey.pqauth`), so delegating over an EOA that used another wallet before can't collide with old storage.
- The **PQ key is immutable**: one delegate per user. Under 7702 there is no constructor run for the EOA, and an `initialize()` call could be front-run. Immutables avoid both problems.

## PQDelegate: the "wallet-level killswitch"
| Path | Before trip | After trip |
|---|---|---|
| `execute(calls, pqSig)` | ✅ | ✅ |
| `executeECDSA(calls)` (EOA → self) | ✅ | ❌ `ECDSADisabled` |
| `isValidSignature` with ECDSA | ✅ magic | ❌ `0xffffffff` |
| `isValidSignature` with PQ | ✅ | ✅ |
| **Plain tx signed by the EOA key** | ✅ | ✅ ← *protocol, not wallet* |
| **New 7702 authorization by the EOA key** | ✅ | ✅ ← *protocol* |
| **ecrecover-only permits / Safe owner sigs** | ✅ | ✅ ← *never ask the wallet* |

`killswitch() = ownerKill || canary.tripped()`. `activateKillswitch()` is one-way and only callable by the account itself, so in practice from a PQ-signed batch. That's why an ECDSA batch can't turn it back off.

## QuantumCanary
- `claim(to, v, r, s)` needs a signature from the canary key over `claimDigest(to)`, which binds the recipient (no front-running). It sets `tripped` forever and pays the bounty.
- The production key is meant to be a nothing-up-my-sleeve point. The demo uses a ~36-bit key cracked live by `tools/bsgs`.
- Credit: Justin Drake, *Cryptographic canaries and backups* (ethresear.ch, 2018).

## Tests
- `test/GhostKeyCore.t.sol`: unit tests, with live SPHINCS signatures via FFI, including `test_delegate_killswitchDoesNotStopTheEOAKey`.
- `test/Sphincs.t.sol`: verifier fixture tests.
- `test/spikes/*`: mainnet-fork proofs of every surface (see [surfaces.md](surfaces.md)).
