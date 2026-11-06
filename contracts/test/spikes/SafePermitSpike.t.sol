// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";

interface ISafe {
    function setup(address[] calldata, uint256, address, bytes calldata, address, address, uint256, address payable) external;
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes calldata signatures) external payable returns (bool);
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) external view returns (bytes32);
    function nonce() external view returns (uint256);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce) external returns (address);
}

interface IERC20P {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

interface IDai {
    function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s) external;
}

interface IPermit2 {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }
    struct SignatureTransferDetails { address to; uint256 requestedAmount; }
    function permitTransferFrom(PermitTransferFrom calldata, SignatureTransferDetails calldata, address owner, bytes calldata signature) external;
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// Stand-in for a PQ wallet whose killswitch has tripped: it rejects every ERC-1271 signature.
contract RejectingDelegate {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
    receive() external payable {}
}

/// Spike (d): after the EOA delegates to a wallet that rejects ECDSA, which paths still accept the old key?
contract SafePermitSpike is Test {
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a; // 1.4.1
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant DAI_PERMIT_TYPEHASH = keccak256("Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)");
    bytes32 constant EIP2612_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_TRANSFER_FROM_TYPEHASH =
        keccak256("PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)");

    address alice;
    uint256 aliceKey;
    address attacker = makeAddr("attacker");
    RejectingDelegate pqWallet;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), vm.envUint("FORK_BLOCK"));
        (alice, aliceKey) = makeAddrAndKey("alice-old-key");
        pqWallet = new RejectingDelegate();
        deal(DAI, alice, 1_000e18);
        deal(USDC, alice, 1_000e6);
        vm.prank(alice);
        IERC20P(USDC).approve(PERMIT2, type(uint256).max); // standing Permit2 approval, like most users
        vm.signAndAttachDelegation(address(pqWallet), aliceKey); // Alice "migrates"
        assertGt(alice.code.length, 0, "alice is delegated");
    }

    function _digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function test_spike_daiPermit_stillWorks() public {
        bytes32 sh = keccak256(abi.encode(DAI_PERMIT_TYPEHASH, alice, attacker, IERC20P(DAI).nonces(alice), 0, true));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, _digest(IERC20P(DAI).DOMAIN_SEPARATOR(), sh));
        IDai(DAI).permit(alice, attacker, IERC20P(DAI).nonces(alice), 0, true, v, r, s);
        vm.prank(attacker);
        IERC20P(DAI).transferFrom(alice, attacker, 1_000e18);
        assertEq(IERC20P(DAI).balanceOf(attacker), 1_000e18, "RESIDUAL: DAI drained via ecrecover permit");
    }

    function test_spike_usdcPermit_blockedWhileDelegated() public {
        bytes32 sh = keccak256(abi.encode(EIP2612_TYPEHASH, alice, attacker, 1_000e6, IERC20P(USDC).nonces(alice), block.timestamp + 1 hours));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, _digest(IERC20P(USDC).DOMAIN_SEPARATOR(), sh));
        vm.expectRevert();
        IERC20P(USDC).permit(alice, attacker, 1_000e6, block.timestamp + 1 hours, v, r, s);
    }

    function _permit2Sig(uint256 nonce) internal view returns (IPermit2.PermitTransferFrom memory p, bytes memory sig) {
        p = IPermit2.PermitTransferFrom(IPermit2.TokenPermissions(USDC, 1_000e6), nonce, block.timestamp + 1 hours);
        bytes32 sh = keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, USDC, 1_000e6)), attacker, nonce, p.deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, _digest(IPermit2(PERMIT2).DOMAIN_SEPARATOR(), sh));
        sig = abi.encodePacked(r, s, v);
    }

    function test_spike_permit2_blockedThenReopenedByRedelegation() public {
        (IPermit2.PermitTransferFrom memory p, bytes memory sig) = _permit2Sig(1);
        vm.prank(attacker);
        vm.expectRevert();
        IPermit2(PERMIT2).permitTransferFrom(p, IPermit2.SignatureTransferDetails(attacker, 1_000e6), alice, sig);

        // The old key clears the delegation, so Permit2 falls back to raw ecrecover.
        vm.signAndAttachDelegation(address(0), aliceKey);
        assertEq(alice.code.length, 0, "delegation cleared by old key");
        vm.prank(attacker);
        IPermit2(PERMIT2).permitTransferFrom(p, IPermit2.SignatureTransferDetails(attacker, 1_000e6), alice, sig);
        assertEq(IERC20P(USDC).balanceOf(attacker), 1_000e6, "RESIDUAL: re-delegation reopens Permit2");
    }

    function test_spike_safeOwner_stillWorks() public {
        address[] memory owners = new address[](1);
        owners[0] = alice;
        bytes memory init = abi.encodeCall(ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0))));
        ISafe safe = ISafe(ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, 1));
        vm.deal(address(safe), 10 ether);

        bytes32 h = safe.getTransactionHash(attacker, 10 ether, "", 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, h);
        vm.prank(attacker); // anyone can submit once the old key has signed
        safe.execTransaction(attacker, 10 ether, "", 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v));
        assertEq(attacker.balance, 10 ether, "RESIDUAL: Safe drained by old owner key");
    }
}
