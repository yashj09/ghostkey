// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {LeanSphincsSAsm} from "../src/vendor/sphincs/LeanSphincs-SAsm.sol";

/// @notice Spike: a leanSphincs-S (keccak) signature from our CLI (tools/sphincs-signer) verifies on-chain.
/// Fixture regeneration (from repo root):
///   cargo build --release --manifest-path tools/sphincs-signer/Cargo.toml
///   tools/sphincs-signer/target/release/sphincs-signer sign \
///     --seed $(cast keccak "ghostkey-demo-seed-1") --msg $(cast keccak "ghostkey sphincs fixture") \
///     > contracts/test/fixtures/sphincs_fixture.json
contract SphincsTest is Test {
    LeanSphincsSAsm verifier;

    bytes32 pkSeed;
    bytes32 pkRoot;
    bytes32 message;
    bytes sig;

    function setUp() public {
        verifier = new LeanSphincsSAsm();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/sphincs_fixture.json"));
        pkSeed = vm.parseJsonBytes32(json, ".pkSeed");
        pkRoot = vm.parseJsonBytes32(json, ".pkRoot");
        message = vm.parseJsonBytes32(json, ".message");
        sig = vm.parseJsonBytes(json, ".sig");
    }

    function test_sigLength() public view {
        assertEq(sig.length, 4164);
        // canonical key words: low 128 bits zero
        assertEq(uint256(pkSeed) & type(uint128).max, 0);
        assertEq(uint256(pkRoot) & type(uint128).max, 0);
    }

    /// Gas: the callee-frame figure is shown in the -vvvv trace as [N] on LeanSphincsSAsm::verify.
    /// (vm.lastCallGas() is not used: the installed forge-std Vm.Gas struct is newer than the forge binary.)
    function test_validSignatureVerifies() public view {
        (bytes32 s_, bytes32 r_, bytes32 m_, bytes memory sg_) = (pkSeed, pkRoot, message, sig); // off the meter
        uint256 g = gasleft();
        bool ok = verifier.verify(s_, r_, m_, sg_);
        uint256 outer = g - gasleft();
        assertTrue(ok, "valid sig rejected");
        console2.log("verify gas (gasleft delta incl. CALL + abi encode of 4164 B):", outer);
    }

    function test_flippedSigByteFails() public view {
        uint256[4] memory offsets = [uint256(0), 1000, 2720, 4163]; // rho, FORS, counter, last auth node
        for (uint256 i = 0; i < offsets.length; i++) {
            bytes memory bad = bytes.concat(sig);
            bad[offsets[i]] = bad[offsets[i]] ^ 0x01;
            assertFalse(verifier.verify(pkSeed, pkRoot, message, bad), "tampered sig accepted");
        }
    }

    function test_differentMessageFails() public view {
        assertFalse(verifier.verify(pkSeed, pkRoot, keccak256("other message"), sig));
        assertFalse(verifier.verify(pkSeed, pkRoot, message ^ bytes32(uint256(1)), sig));
    }

    function test_wrongKeyFails() public view {
        bytes32 bit = bytes32(uint256(1) << 128); // lowest bit of the (high-aligned) 16-byte value
        assertFalse(verifier.verify(pkSeed ^ bit, pkRoot, message, sig));
        assertFalse(verifier.verify(pkSeed, pkRoot ^ bit, message, sig));
    }

    function test_badLengthReverts() public {
        vm.expectRevert(bytes("Invalid sig length"));
        verifier.verify(pkSeed, pkRoot, message, bytes.concat(sig, hex"00"));
    }

    function test_nonCanonicalKeyReverts() public {
        vm.expectRevert();
        verifier.verify(pkSeed | bytes32(uint256(1)), pkRoot, message, sig);
    }
}
