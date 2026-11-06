// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PQSigner} from "../utils/PQSigner.sol";
import {LeanSphincsSAsm} from "../../src/vendor/sphincs/LeanSphincs-SAsm.sol";
import {ISphincsVerifier, Call} from "../../src/PQAuth.sol";
import {PQDelegate, IQuantumCanary} from "../../src/PQDelegate.sol";
import {PQAccount} from "../../src/PQAccount.sol";
import {QuantumCanary} from "../../src/QuantumCanary.sol";
import "./Mainnet.sol";

/// @notice Shared mainnet-fork world for GhostKey: Alice has value on every residual surface, then
///         "migrates" to a PQ wallet with 7702. Contains the attacks (old key) and the atomic fix (PQ key).
abstract contract GhostKeyFixture is PQSigner {
    bytes32 constant PQ_SEED = keccak256("ghostkey-demo-seed-1");
    uint256 constant CANARY_KEY = 0x9a3c51f2b; // ~36-bit demo key
    string constant ENS_LABEL = "ghostkeyalice";
    bytes constant ENS_DNS_NAME = hex"0d67686f73746b6579616c6963650365746800"; // ghostkeyalice.eth

    ISphincsVerifier verifier;
    QuantumCanary canary;
    PQDelegate delegateImpl;
    PQAccount pqAccount;
    ISafe safe;
    IPermissionedResolver resolver;
    uint256 ensTokenId;

    address alice;
    uint256 aliceKey;
    address attacker;
    address relayer;

    function _setUpWorld() internal {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), vm.envUint("FORK_BLOCK"));
        attacker = makeAddr("attacker");
        relayer = makeAddr("relayer");
        (alice, aliceKey) = makeAddrAndKey("alice-old-ecdsa-key");

        // Post-quantum side: verifier, Alice's leanSphincs-s key, the canary, her delegate and fresh account.
        verifier = ISphincsVerifier(address(new LeanSphincsSAsm()));
        (bytes32 pkSeed, bytes32 pkRoot) = _pqKeygen(PQ_SEED);
        Vm.Wallet memory cw = vm.createWallet(CANARY_KEY);
        canary = new QuantumCanary{value: 1 ether}(abi.encodePacked(cw.publicKeyX, cw.publicKeyY), "demo-36bit");
        delegateImpl = new PQDelegate(verifier, pkSeed, pkRoot, IQuantumCanary(address(canary)));
        pqAccount = new PQAccount(verifier, pkSeed, pkRoot);

        // Alice's pre-migration life on mainnet.
        vm.deal(alice, 3 ether);
        deal(Mainnet.DAI, alice, 5_000e18);
        deal(Mainnet.UNI, alice, 400e18);
        deal(Mainnet.USDC, alice, 10_100e6);
        deal(Mainnet.WSTETH, alice, 2e18);

        vm.startPrank(alice);
        IERC20(Mainnet.USDC).approve(Mainnet.PERMIT2, type(uint256).max); // standing Permit2 approval
        _setUpSafe();
        _setUpEns();
        vm.stopPrank();

        // The "migration" most wallets ship today: 7702-delegate to a PQ wallet.
        vm.signAndAttachDelegation(address(delegateImpl), aliceKey);
    }

    function _setUpSafe() private {
        address[] memory owners = new address[](1);
        owners[0] = alice;
        bytes memory init = abi.encodeCall(ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0))));
        safe = ISafe(ISafeProxyFactory(Mainnet.SAFE_FACTORY).createProxyWithNonce(Mainnet.SAFE_SINGLETON, init, uint256(keccak256("gk-safe"))));
        vm.deal(address(safe), 5 ether);
    }

    function _setUpEns() private {
        EnsGrant[] memory grants = new EnsGrant[](1);
        grants[0] = EnsGrant(alice, Mainnet.ENS_ROLE_SET_ADDRESS | Mainnet.ENS_ROLE_SET_ADDRESS_ADMIN);
        resolver = IPermissionedResolver(
            IVerifiableFactory(Mainnet.ENS_FACTORY).deployProxy(
                Mainnet.ENS_RESOLVER_IMPL, uint256(keccak256("gk-resolver")), abi.encodeCall(IPermissionedResolver.initialize, (grants, new bytes[](0)))
            )
        );
        IETHRegistrar reg = IETHRegistrar(Mainnet.ENS_REGISTRAR);
        bytes32 secret = keccak256("gk-secret");
        reg.commit(reg.makeCommitment(ENS_LABEL, alice, secret, address(0), address(resolver), 365 days, bytes32(0)));
        vm.warp(block.timestamp + 61);
        IERC20(Mainnet.USDC).approve(Mainnet.ENS_REGISTRAR, 100e6);
        ensTokenId = reg.register(ENS_LABEL, alice, secret, address(0), address(resolver), 365 days, Mainnet.USDC, bytes32(0));
        resolver.setAddress(ENS_DNS_NAME, Mainnet.ETH_COIN_TYPE, abi.encodePacked(alice));
        IERC20(Mainnet.USDC).approve(Mainnet.ENS_REGISTRAR, 0);
    }

    // ------------------------------------------------------------------ views

    function ensResolvesTo() public view returns (address) {
        return abi.decode(resolver.resolve(ENS_DNS_NAME, abi.encodeWithSignature("addr(bytes32)", bytes32(0))), (address));
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _tripCanary() internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CANARY_KEY, canary.claimDigest(attacker));
        canary.claim(payable(attacker), v, r, s);
    }

    // ------------------------------------------------------------------ attacks (the OLD ecdsa key)

    /// Surface 1: a plain tx signed by the EOA key.
    function _attackDirect() internal returns (uint256 ethTaken, uint256 uniTaken) {
        uint256 e = alice.balance;
        uint256 u = _bal(Mainnet.UNI, alice);
        vm.startPrank(alice);
        if (e > 0) payable(attacker).transfer(e);
        if (u > 0) IERC20(Mainnet.UNI).transfer(attacker, u);
        vm.stopPrank();
        return (e, u);
    }

    /// Surface 3: DAI's ecrecover-only permit never asks the wallet code.
    function _attackDaiPermit() internal returns (uint256 taken) {
        bytes32 th = keccak256("Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)");
        uint256 n = IERC20(Mainnet.DAI).nonces(alice);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", IERC20(Mainnet.DAI).DOMAIN_SEPARATOR(), keccak256(abi.encode(th, alice, attacker, n, 0, true))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, d);
        IDai(Mainnet.DAI).permit(alice, attacker, n, 0, true, v, r, s);
        taken = _bal(Mainnet.DAI, alice);
        vm.prank(attacker);
        IERC20(Mainnet.DAI).transferFrom(alice, attacker, taken);
    }

    /// Surfaces 2 + 4: Permit2 asks ERC-1271 while delegated, so first the old key clears the delegation.
    function _attackRedelegateThenPermit2() internal returns (uint256 taken) {
        vm.signAndAttachDelegation(address(0), aliceKey); // relayed re-delegation, signed by the old key
        uint256 amt = _bal(Mainnet.USDC, alice);
        if (amt == 0 || IERC20(Mainnet.USDC).allowance(alice, Mainnet.PERMIT2) < amt) return 0;
        IPermit2.PermitTransferFrom memory p = IPermit2.PermitTransferFrom(IPermit2.TokenPermissions(Mainnet.USDC, amt), 777, block.timestamp + 1 hours);
        bytes32 tp = keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), Mainnet.USDC, amt));
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"),
                tp,
                attacker,
                p.nonce,
                p.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", IPermit2(Mainnet.PERMIT2).DOMAIN_SEPARATOR(), sh)));
        vm.prank(attacker);
        IPermit2(Mainnet.PERMIT2).permitTransferFrom(p, IPermit2.SignatureTransferDetails(attacker, amt), alice, abi.encodePacked(r, s, v));
        return amt;
    }

    /// Surface 5: Safe checks owner sigs with ecrecover.
    function _attackSafe() internal returns (bool ok) {
        uint256 amt = address(safe).balance;
        bytes32 h = safe.getTransactionHash(attacker, amt, "", 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, h);
        vm.prank(attacker);
        try safe.execTransaction(attacker, amt, "", 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)) returns (bool res) {
            return res;
        } catch {
            return false;
        }
    }

    /// Surface 6: ENSv2 resolver roles belong to the old key, so it re-points the name.
    function _attackEns() internal returns (bool ok) {
        vm.prank(alice);
        try resolver.setAddress(ENS_DNS_NAME, Mainnet.ETH_COIN_TYPE, abi.encodePacked(attacker)) {
            return true;
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------ the fix (PQ-signed, atomic)

    /// GhostKey "Complete migration": one leanSphincs-s-signed batch run by Alice's delegated EOA.
    function _migrationCalls() internal view returns (Call[] memory c) {
        address pq = address(pqAccount);
        c = new Call[](12);
        uint256 i;
        // ERC-20s (covers ecrecover-only permits and Permit2 pulls, because nothing is left)
        c[i++] = Call(Mainnet.DAI, 0, abi.encodeCall(IERC20.transfer, (pq, _bal(Mainnet.DAI, alice))));
        c[i++] = Call(Mainnet.UNI, 0, abi.encodeCall(IERC20.transfer, (pq, _bal(Mainnet.UNI, alice))));
        c[i++] = Call(Mainnet.WSTETH, 0, abi.encodeCall(IERC20.transfer, (pq, _bal(Mainnet.WSTETH, alice))));
        c[i++] = Call(Mainnet.USDC, 0, abi.encodeCall(IERC20.transfer, (pq, _bal(Mainnet.USDC, alice))));
        // Permit2: kill the standing approval too
        c[i++] = Call(Mainnet.USDC, 0, abi.encodeCall(IERC20.approve, (Mainnet.PERMIT2, 0)));
        // Safe: swap the old key out for the PQ account (v=1 "msg.sender is owner" signature)
        bytes memory swap = abi.encodeCall(ISafe.swapOwner, (Mainnet.SAFE_SENTINEL, alice, pq));
        bytes memory ownerSig = abi.encodePacked(bytes32(uint256(uint160(alice))), bytes32(0), uint8(1));
        c[i++] = Call(address(safe), 0, abi.encodeCall(ISafe.execTransaction, (address(safe), 0, swap, 0, 0, 0, 0, address(0), payable(address(0)), ownerSig)));
        // ENSv2: point the name at the PQ account, hand over resolver roles, move the token, then self-revoke
        c[i++] = Call(address(resolver), 0, abi.encodeCall(IPermissionedResolver.setAddress, (ENS_DNS_NAME, Mainnet.ETH_COIN_TYPE, abi.encodePacked(pq))));
        c[i++] = Call(address(resolver), 0, abi.encodeCall(IPermissionedResolver.grantRootRoles, (Mainnet.ENS_ROLE_SET_ADDRESS | Mainnet.ENS_ROLE_SET_ADDRESS_ADMIN, pq)));
        c[i++] = Call(Mainnet.ENS_ETH_REGISTRY, 0, abi.encodeCall(IPermissionedRegistry.safeTransferFrom, (alice, pq, ensTokenId, 1, "")));
        c[i++] = Call(address(resolver), 0, abi.encodeCall(IPermissionedResolver.revokeRootRoles, (Mainnet.ENS_ROLE_SET_ADDRESS | Mainnet.ENS_ROLE_SET_ADDRESS_ADMIN, alice)));
        // ETH last (a relayer pays gas, so the EOA can be swept to zero)
        c[i++] = Call(pq, alice.balance, "");
        // and the wallet's own killswitch, for good measure
        c[i++] = Call(alice, 0, abi.encodeCall(PQDelegate.activateKillswitch, ()));
    }

    function _completeMigration() internal {
        Call[] memory calls = _migrationCalls();
        PQDelegate wallet = PQDelegate(payable(alice));
        bytes memory sig = _pqSign(PQ_SEED, wallet.executeDigest(calls));
        vm.prank(relayer);
        wallet.execute(calls, sig);
    }
}
