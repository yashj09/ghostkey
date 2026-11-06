#!/usr/bin/env bash
# Spike (a): a 7702-delegated EOA keeps full ECDSA power. Run against a local anvil mainnet fork:
#   anvil --fork-url $MAINNET_RPC_URL --fork-block-number $FORK_BLOCK --hardfork osaka
set -euo pipefail
R=${RPC:-http://127.0.0.1:8545}
SPONSOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil #0
# NB: never use anvil's default keys as "Alice" on a mainnet fork; they are already 7702-delegated by sweeper bots.
J=$(cast wallet new --json); AK=$(echo "$J" | jq -r '.[0].private_key'); A=$(echo "$J" | jq -r '.[0].address')
cast rpc anvil_setBalance "$A" 0x56BC75E2D63100000 -r "$R" >/dev/null

echo "1) self-sponsored delegation (cast signs the auth with nonce+1)"
cast send "$A" --auth 0xcA11bde05977b3631167028862bE2a173976CA11 --private-key "$AK" -r "$R" --gas-limit 100000 >/dev/null || true
echo "   code: $(cast code "$A" -r "$R")"

echo "2) the delegated EOA still sends a plain tx"
cast send 0x000000000000000000000000000000000000dEaD --value 1ether --private-key "$AK" -r "$R" --json | jq -r '"   status " + .status'

echo "3) an attacker relays a re-delegation signed by the old key"
AUTH=$(cast wallet sign-auth 0x000000000022D473030F116dDEE9F6B43aC78BA3 --private-key "$AK" --nonce "$(cast nonce "$A" -r "$R")" -r "$R")
cast send 0x0000000000000000000000000000000000000000 --auth "$AUTH" --private-key "$SPONSOR_KEY" -r "$R" >/dev/null
echo "   code: $(cast code "$A" -r "$R")"
