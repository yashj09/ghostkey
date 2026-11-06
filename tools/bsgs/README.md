# bsgs — GhostKey weak-key cracker

Recovers a secp256k1 private key whose scalar is known to be `< 2^N` (N ≤ 40)
from its public key, using **baby-step giant-step**. Powers the GhostKey demo:
"our quantum computer is a laptop."

```sh
cargo build --release
./target/release/bsgs gen   --bits 36 [--seed 42]          # make a weak canary key
./target/release/bsgs crack --pubkey 0x04<x><y> --bits 36  # recover it
```

`crack` accepts a 65-byte uncompressed (`0x04..`) or 33-byte compressed pubkey
and prints one JSON line: `{"privateKey","address","ms","bits"}` (exit 0), or
`{"error":...}` with a non-zero exit if the key is not in range.

BSGS splits `k = i·m + j` with `m = 2^ceil(N/2)`: a table of baby steps `j·G`
is matched against giant steps `P − i·(m·G)`, so brute force over `2^N` keys
collapses to **~O(2^(N/2))** group operations. Table build and giant scan are
parallelised with rayon and use projective arithmetic with batch normalization.
On an M-series laptop: 36-bit ≈ 20 ms, 40-bit ≈ 80 ms, peak RSS ≈ 75 MB.
