import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { Call } from "./types.js";

/** Signs 32-byte digests with a leanSphincs-s key. Node implementation: `createCliPQSigner` in ./node. */
export interface PQSigner {
  publicKey(): Promise<{ pkSeed: Hex; pkRoot: Hex }>;
  sign(digest: Hex): Promise<Hex>;
}

/** Recovers a weak secp256k1 key from its public key (the demo "quantum computer"). Node impl: `createBsgsCracker`. */
export interface Cracker {
  crack(pubkey: Hex, bits: number): Promise<{ privateKey: Hex; address: Address; ms: number }>;
}

export const EXECUTE_TYPEHASH = keccak256(
  new TextEncoder().encode("GhostKeyExecute(uint256 chainId,address account,uint256 nonce,bytes32 callsHash)"),
);

/** Mirrors PQAuth.executeDigest (contracts/src/PQAuth.sol), so batches can be signed off-chain. */
export function executeDigest(chainId: number, account: Address, nonce: bigint, calls: Call[]): Hex {
  const callsHash = keccak256(
    encodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
      [calls],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [EXECUTE_TYPEHASH, BigInt(chainId), account, nonce, callsHash],
    ),
  );
}
