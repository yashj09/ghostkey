# GhostKey 👻🔑

**You migrated. Your old key didn't.**

EIP-7702 and frame transactions *install code* on your account, but they never switch the old ECDSA key off. After you "upgrade" to a smart or post-quantum wallet, that key can still:

- send transactions straight from your EOA
- re-delegate your account to new code
- sign `permit`s on tokens that only use `ecrecover` (DAI, UNI, AAVE, wstETH, …)
- sign as an owner of your Safe
- use ENSv2 resolver roles to re-point your name to someone else

Wallet-level killswitches, like a quantum canary, can't stop any of these.

GhostKey finds every place your old key still has power, proves it with a live drain on a mainnet fork, and closes every hole that can be closed today in one atomic, post-quantum-signed migration.

> 🚧 Built solo at ETHGlobal Mumbai 2026. Work in progress. See [`docs/PLAN.md`](docs/PLAN.md).

## Repo layout

| Path | What |
|---|---|
| `contracts/` | Foundry: `QuantumCanary`, `PQDelegate` (7702 target), `PQAccount`, fork tests |
| `packages/core` | TS scanner, per-surface attacks, migration batch builder |
| `apps/web` | Scan any address, plus the Live Demo cockpit |
| `apps/demo-server` | Local-only server that drives the anvil fork, SPHINCS signer and canary cracker |
| `tools/` | Rust: SPHINCS- signer, BSGS canary cracker |
| `docs/` | Plan, architecture, decisions (ADRs), progress log, AI usage |

## Credits

- Post-quantum signatures use the leanSphincs-s verifier and signer from [nconsigny/SPHINCS-](https://github.com/nconsigny/SPHINCS-) (MIT, Ethereum Foundation).
- The problem framing comes from Daniil Ankushin's (Nethermind) write-up on 7702 PQ migration, the EIP-7851 / EIP-8151 discussions, and Justin Drake's 2018 *Cryptographic canaries and backups*.

## License

MIT
