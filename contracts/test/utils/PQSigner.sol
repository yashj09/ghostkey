// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Test helper: leanSphincs-s keygen and signing through the Rust CLI (tools/sphincs-signer) via FFI.
///         Build it first: `cargo build --release --manifest-path tools/sphincs-signer/Cargo.toml`.
abstract contract PQSigner is Test {
    function _signerBin() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../tools/sphincs-signer/target/release/sphincs-signer");
    }

    function _pqKeygen(bytes32 seed) internal returns (bytes32 pkSeed, bytes32 pkRoot) {
        string[] memory cmd = new string[](4);
        (cmd[0], cmd[1], cmd[2], cmd[3]) = (_signerBin(), "keygen", "--seed", vm.toString(seed));
        string memory out = string(vm.ffi(cmd));
        pkSeed = vm.parseJsonBytes32(out, ".pkSeed");
        pkRoot = vm.parseJsonBytes32(out, ".pkRoot");
    }

    function _pqSign(bytes32 seed, bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](6);
        (cmd[0], cmd[1], cmd[2], cmd[3], cmd[4], cmd[5]) = (_signerBin(), "sign", "--seed", vm.toString(seed), "--msg", vm.toString(digest));
        return vm.parseJsonBytes(string(vm.ffi(cmd)), ".sig");
    }
}
