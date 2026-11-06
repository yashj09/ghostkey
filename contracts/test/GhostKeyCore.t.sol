// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PQSigner} from "./utils/PQSigner.sol";
import {LeanSphincsSAsm} from "../src/vendor/sphincs/LeanSphincs-SAsm.sol";
import {ISphincsVerifier, Call, PQAuth} from "../src/PQAuth.sol";
import {PQDelegate, IQuantumCanary} from "../src/PQDelegate.sol";
import {PQAccount} from "../src/PQAccount.sol";
import {QuantumCanary} from "../src/QuantumCanary.sol";

/// Unit tests (no fork) for the canary, the 7702 PQ delegate and the fresh PQ account.
contract GhostKeyCoreTest is PQSigner {
    bytes32 constant PQ_SEED = keccak256("ghostkey-demo-seed-1");
    uint256 constant CANARY_KEY = 0x9a3c51f2b; // ~36-bit demo key (in the demo it is cracked by BSGS)

    ISphincsVerifier verifier;
    bytes32 pkSeed;
    bytes32 pkRoot;
    QuantumCanary canary;
    PQDelegate delegateImpl;
    address alice;
    uint256 aliceKey;
    address bob = makeAddr("bob");

    function setUp() public {
        verifier = ISphincsVerifier(address(new LeanSphincsSAsm()));
        (pkSeed, pkRoot) = _pqKeygen(PQ_SEED);
        Vm.Wallet memory cw = vm.createWallet(CANARY_KEY);
        canary = new QuantumCanary{value: 1 ether}(abi.encodePacked(cw.publicKeyX, cw.publicKeyY), "demo-36bit");
        delegateImpl = new PQDelegate(verifier, pkSeed, pkRoot, IQuantumCanary(address(canary)));
        (alice, aliceKey) = makeAddrAndKey("alice");
        vm.deal(alice, 10 ether);
        vm.signAndAttachDelegation(address(delegateImpl), aliceKey);
    }

    function _wallet() internal view returns (PQDelegate) {
        return PQDelegate(payable(alice));
    }

    function _pay(address to, uint256 amt) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call(to, amt, "");
    }

    function _trip() internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CANARY_KEY, canary.claimDigest(bob));
        canary.claim(payable(bob), v, r, s);
    }

    // ---------------------------------------------------------------- canary

    function test_canary_addressMatchesPubkey() public view {
        assertEq(canary.canaryAddress(), vm.addr(CANARY_KEY));
    }

    function test_canary_claimTripsAndPays() public {
        _trip();
        assertTrue(canary.tripped());
        assertEq(canary.trippedBy(), bob);
        assertEq(bob.balance, 1 ether);
    }

    function test_canary_claimIsBoundToRecipient() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CANARY_KEY, canary.claimDigest(bob));
        vm.expectRevert(QuantumCanary.BadSignature.selector);
        canary.claim(payable(makeAddr("frontrunner")), v, r, s);
    }

    function test_canary_wrongKeyAndDoubleClaimRevert() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(123), canary.claimDigest(bob));
        vm.expectRevert(QuantumCanary.BadSignature.selector);
        canary.claim(payable(bob), v, r, s);
        _trip();
        vm.expectRevert(QuantumCanary.AlreadyTripped.selector);
        canary.claim(payable(bob), v, r, s);
    }

    // ---------------------------------------------------------------- PQ delegate (7702)

    function test_delegate_pqExecuteWorks_andBadSigReverts() public {
        Call[] memory calls = _pay(bob, 1 ether);
        bytes memory sig = _pqSign(PQ_SEED, _wallet().executeDigest(calls));
        _wallet().execute(calls, sig);
        assertEq(bob.balance, 1 ether);
        assertEq(_wallet().nonce(), 1);
        // replay at the new nonce fails
        vm.expectRevert(PQAuth.BadPQSignature.selector);
        _wallet().execute(calls, sig);
    }

    function test_delegate_ecdsaPath_untilCanaryTrips() public {
        vm.prank(alice);
        _wallet().executeECDSA(_pay(bob, 1 ether));
        assertEq(bob.balance, 1 ether);

        _trip();
        assertTrue(_wallet().killswitch());
        vm.prank(alice);
        vm.expectRevert(PQDelegate.ECDSADisabled.selector);
        _wallet().executeECDSA(_pay(bob, 1 ether));
    }

    function test_delegate_erc1271_ecdsaOnlyBeforeKillswitch() public {
        bytes32 h = keccak256("some permit");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, h);
        bytes memory ecdsaSig = abi.encodePacked(r, s, v);
        assertEq(_wallet().isValidSignature(h, ecdsaSig), bytes4(0x1626ba7e));
        _trip();
        assertEq(_wallet().isValidSignature(h, ecdsaSig), bytes4(0xffffffff));
        assertEq(_wallet().isValidSignature(h, _pqSign(PQ_SEED, h)), bytes4(0x1626ba7e));
    }

    function test_delegate_ownerKillswitch_isPQOnlyAndOneWay() public {
        vm.expectRevert(PQAuth.OnlySelf.selector);
        _wallet().activateKillswitch();

        Call[] memory calls = new Call[](1);
        calls[0] = Call(alice, 0, abi.encodeCall(PQDelegate.activateKillswitch, ()));
        _wallet().execute(calls, _pqSign(PQ_SEED, _wallet().executeDigest(calls)));
        assertTrue(_wallet().killswitch());
    }

    /// The point of GhostKey: the killswitch is on, yet the old key still moves the money.
    function test_delegate_killswitchDoesNotStopTheEOAKey() public {
        _trip();
        vm.prank(alice); // in a real tx: signed by Alice's ECDSA key, still a valid tx signer under 7702
        (bool ok,) = bob.call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(bob.balance, 1 ether + 5 ether); // 1 bounty + 5 drained
    }

    // ---------------------------------------------------------------- fresh PQ account

    function test_pqAccount_onlyPQ() public {
        PQAccount acct = new PQAccount(verifier, pkSeed, pkRoot);
        vm.deal(address(acct), 1 ether);
        bytes32 h = keccak256("x");
        assertEq(acct.isValidSignature(h, _pqSign(PQ_SEED, h)), bytes4(0x1626ba7e));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, h);
        assertEq(acct.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));

        Call[] memory calls = _pay(bob, 1 ether);
        acct.execute(calls, _pqSign(PQ_SEED, acct.executeDigest(calls)));
        assertEq(bob.balance, 1 ether);
    }
}
