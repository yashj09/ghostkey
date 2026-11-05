# AI usage

ETHGlobal asks for clear attribution of AI-assisted work. This file is updated as the project goes.

## Tools
- **Claude Code** (Anthropic): research, planning, and most of the code under the human's direction.

## How it was used
| Area | AI role | Human role |
|---|---|---|
| Idea research & selection | Ran web research on prior art, sponsor fit, and protocol status; drafted comparisons | Chose the direction, challenged assumptions, picked the final idea and scope |
| Architecture & plan ([`docs/PLAN.md`](PLAN.md)) | Drafted the plan and surface analysis | Answered the architecture questions, approved every major decision |
| Contracts, TS packages, web app | Generated code and tests | Reviewed, ran, demoed |

The planning artefacts that directed the AI are committed: `docs/PLAN.md` and `docs/decisions/*`.

## Vendored, non-AI code
- `contracts/src/vendor/sphincs/`: leanSphincs-s verifier from [nconsigny/SPHINCS-](https://github.com/nconsigny/SPHINCS-) (MIT), unmodified.
