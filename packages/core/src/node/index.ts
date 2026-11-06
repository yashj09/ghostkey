// Node-only helpers: wrap the Rust CLIs in tools/. Not for the browser bundle.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Address, Hex } from "viem";
import type { Cracker, PQSigner } from "../pq.js";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const DEFAULT_SIGNER_BIN = resolve(repoRoot, "tools/sphincs-signer/target/release/sphincs-signer");
export const DEFAULT_BSGS_BIN = resolve(repoRoot, "tools/bsgs/target/release/bsgs");

async function runJson<T>(bin: string, args: string[]): Promise<T> {
  const { stdout } = await run(bin, args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

/** leanSphincs-s signer backed by tools/sphincs-signer. One seed = one key (Light tier). */
export function createCliPQSigner(seed: Hex, bin = DEFAULT_SIGNER_BIN): PQSigner {
  let pk: { pkSeed: Hex; pkRoot: Hex } | undefined;
  return {
    async publicKey() {
      pk ??= await runJson<{ pkSeed: Hex; pkRoot: Hex }>(bin, ["keygen", "--seed", seed]);
      return pk;
    },
    async sign(digest: Hex) {
      const out = await runJson<{ sig: Hex }>(bin, ["sign", "--seed", seed, "--msg", digest]);
      return out.sig;
    },
  };
}

/** Baby-step giant-step solver backed by tools/bsgs. */
export function createBsgsCracker(bin = DEFAULT_BSGS_BIN): Cracker {
  return {
    async crack(pubkey: Hex, bits: number) {
      return runJson<{ privateKey: Hex; address: Address; ms: number }>(bin, ["crack", "--pubkey", pubkey, "--bits", String(bits)]);
    },
  };
}

/** Generate a weak demo canary key with tools/bsgs (deterministic if seed given). */
export async function generateWeakKey(bits: number, seed?: number, bin = DEFAULT_BSGS_BIN) {
  const args = ["gen", "--bits", String(bits)];
  if (seed !== undefined) args.push("--seed", String(seed));
  return runJson<{ privateKey: Hex; pubkey: Hex; address: Address }>(bin, args);
}
