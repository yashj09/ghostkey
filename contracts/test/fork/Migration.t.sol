// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {GhostKeyFixture} from "./GhostKeyFixture.sol";
import {PQDelegate} from "../../src/PQDelegate.sol";
import {PQAuth, Call} from "../../src/PQAuth.sol";
import "./Mainnet.sol";

/// End-to-end story on a mainnet fork:
///   Act 1: Alice "migrates" to a PQ wallet, and the canary trips, so the killswitch is ON.
///   Act 2: the old ECDSA key still drains every surface.
///   Act 3: GhostKey's PQ-signed atomic migration, after which every attack fails or gets $0.
/// Run: MAINNET_RPC_URL=... FORK_BLOCK=... forge test --match-path test/fork/Migration.t.sol -vv
contract MigrationForkTest is GhostKeyFixture {
    function setUp() public {
        _setUpWorld();
        _tripCanary();
        assertTrue(PQDelegate(payable(alice)).killswitch(), "killswitch on");
    }

    function test_act2_killswitchOn_oldKeyStillDrainsEverything() public {
        uint256 daiTaken = _attackDaiPermit();
        assertEq(daiTaken, 5_000e18, "DAI via ecrecover permit");

        assertTrue(_attackSafe(), "Safe drained by old owner key");
        assertEq(address(safe).balance, 0);

        assertTrue(_attackEns(), "ENS redirected by old resolver role");
        assertEq(ensResolvesTo(), attacker);

        (uint256 ethTaken, uint256 uniTaken) = _attackDirect();
        assertEq(ethTaken, 3 ether, "ETH via direct tx");
        assertEq(uniTaken, 400e18, "UNI via direct tx");

        uint256 usdcTaken = _attackRedelegateThenPermit2();
        assertEq(usdcTaken, 10_100e6 - 8_000_021, "USDC via re-delegation + Permit2 (minus the ENS fee)");
        console2.log("attacker DAI", _bal(Mainnet.DAI, attacker) / 1e18);
        console2.log("attacker USDC", _bal(Mainnet.USDC, attacker) / 1e6);
    }

    function test_act3_afterMigration_oldKeyControlsNothing() public {
        uint256 usdcBefore = _bal(Mainnet.USDC, alice);
        _completeMigration();

        // Everything now sits with the PQ account.
        assertEq(_bal(Mainnet.DAI, address(pqAccount)), 5_000e18);
        assertEq(_bal(Mainnet.UNI, address(pqAccount)), 400e18);
        assertEq(_bal(Mainnet.USDC, address(pqAccount)), usdcBefore);
        assertEq(_bal(Mainnet.WSTETH, address(pqAccount)), 2e18);
        assertEq(address(pqAccount).balance, 3 ether);
        assertTrue(safe.isOwner(address(pqAccount)) && !safe.isOwner(alice), "safe owner swapped");
        assertEq(ensResolvesTo(), address(pqAccount));
        EnsRegState memory st = IPermissionedRegistry(Mainnet.ENS_ETH_REGISTRY).getState(uint256(keccak256(bytes(ENS_LABEL))));
        assertEq(st.latestOwner, address(pqAccount), "ens name moved");

        // Act 2 replayed. The protocol still accepts the old key, but there is nothing left to take.
        assertEq(_attackDaiPermit(), 0, "DAI: permit works, balance is 0");
        assertFalse(_attackSafe(), "Safe: old key no longer an owner");
        assertFalse(_attackEns(), "ENS: old key's resolver roles revoked");
        assertEq(ensResolvesTo(), address(pqAccount));
        (uint256 e, uint256 u) = _attackDirect();
        assertEq(e + u, 0, "direct tx: nothing left");
        assertEq(_attackRedelegateThenPermit2(), 0, "Permit2: no balance, no allowance");

        assertEq(_bal(Mainnet.DAI, attacker) + _bal(Mainnet.USDC, attacker) + _bal(Mainnet.UNI, attacker), 0, "attacker got $0");
    }

    function test_migrationRequiresThePQKey() public {
        Call[] memory calls = _migrationCalls();
        PQDelegate wallet = PQDelegate(payable(alice));
        bytes memory badSig = _pqSign(keccak256("not-alice"), wallet.executeDigest(calls));
        vm.expectRevert(PQAuth.BadPQSignature.selector);
        wallet.execute(calls, badSig);
    }
}
