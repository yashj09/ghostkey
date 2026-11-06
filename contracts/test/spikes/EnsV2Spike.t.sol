// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";

// Minimal ENSv2 interfaces, matching the `v2-mainnet-deployment-1` tag of ensdomains/contracts-v2.
struct Grant {
    address account;
    uint256 roleBitmap;
}

struct RegState {
    uint8 status; // 0 AVAILABLE, 1 RESERVED, 2 REGISTERED
    uint64 expiry;
    address latestOwner;
    uint256 tokenId;
    uint256 resource;
}

interface IETHRegistrar {
    function commit(bytes32 commitment) external;
    function makeCommitment(string calldata, address, bytes32, address, address, uint64, bytes32) external pure returns (bytes32);
    function register(string calldata, address, bytes32, address, address, uint64, address, bytes32) external returns (uint256);
    function getRegisterPrice(string calldata, uint64, address) external view returns (uint256, uint256);
}

interface IPermissionedRegistry {
    function getState(uint256 anyId) external view returns (RegState memory);
    function roles(uint256 anyId, address account) external view returns (uint256);
    function isEmancipated() external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function unsafeTransfer(address to, uint256 tokenId, bytes calldata data) external;
}

interface IPermissionedResolver {
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
}

/// Spike (c): can we set up ENSv2 on a mainnet fork, and does the old key keep resolver
/// authority after the name token moves to a new account?
contract EnsV2Spike is Test {
    IETHRegistrar constant REGISTRAR = IETHRegistrar(0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81);
    IPermissionedRegistry constant ETH_REGISTRY = IPermissionedRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    address constant RESOLVER_IMPL = 0x565b0F456a04Ac9b48758190e90030623Cff57C5;
    IVerifiableFactory constant FACTORY = IVerifiableFactory(0x77510ba162dfeA3d8989E3f0928a691B345730D2);
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    uint256 constant ROLE_SET_ADDRESS = 1 << 0;
    uint256 constant ROLE_SET_ADDRESS_ADMIN = ROLE_SET_ADDRESS << 128;
    uint256 constant ETH_COIN = 60;

    string constant LABEL = "ghostkeyalice";
    bytes constant DNS_NAME = hex"0d67686f73746b6579616c6963650365746800"; // \x0dghostkeyalice\x03eth\x00

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), vm.envUint("FORK_BLOCK"));
    }

    function _resolveAddr(IPermissionedResolver r) internal view returns (address) {
        bytes memory out = r.resolve(DNS_NAME, abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
        return abi.decode(out, (address));
    }

    function test_spike_ensv2_residualResolverRole() public {
        address alice = makeAddr("alice-old-key");
        address pqAccount = makeAddr("alice-new-pq-account");
        address attacker = makeAddr("attacker");
        deal(USDC, alice, 100e6);

        vm.startPrank(alice);
        // 1. Alice deploys her own PermissionedResolver and holds the address-setting roles.
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(alice, ROLE_SET_ADDRESS | ROLE_SET_ADDRESS_ADMIN);
        IPermissionedResolver resolver = IPermissionedResolver(
            FACTORY.deployProxy(RESOLVER_IMPL, uint256(keccak256("gk-salt")), abi.encodeCall(IPermissionedResolver.initialize, (grants, new bytes[](0))))
        );

        // 2. Register ghostkeyalice.eth with commit-reveal, paying in USDC.
        bytes32 secret = keccak256("secret");
        uint64 duration = 365 days;
        REGISTRAR.commit(REGISTRAR.makeCommitment(LABEL, alice, secret, address(0), address(resolver), duration, bytes32(0)));
        vm.warp(block.timestamp + 61);
        IERC20(USDC).approve(address(REGISTRAR), type(uint256).max);
        uint256 tokenId = REGISTRAR.register(LABEL, alice, secret, address(0), address(resolver), duration, USDC, bytes32(0));
        resolver.setAddress(DNS_NAME, ETH_COIN, abi.encodePacked(alice));
        vm.stopPrank();

        assertEq(_resolveAddr(resolver), alice, "resolves to alice");
        console2.log("registered tokenId", tokenId);
        console2.log("registry emancipated?", ETH_REGISTRY.isEmancipated());

        // 3. Alice "migrates": she moves the name token to her new PQ account.
        bool emancipated = ETH_REGISTRY.isEmancipated();
        vm.prank(alice);
        if (emancipated) {
            ETH_REGISTRY.safeTransferFrom(alice, pqAccount, tokenId, 1, "");
        } else {
            ETH_REGISTRY.unsafeTransfer(pqAccount, tokenId, "");
        }
        RegState memory st = ETH_REGISTRY.getState(uint256(keccak256(bytes(LABEL))));
        assertEq(st.latestOwner, pqAccount, "name moved to pq account");
        console2.log("registry roles old key", ETH_REGISTRY.roles(st.tokenId, alice));
        console2.log("registry roles new acct", ETH_REGISTRY.roles(st.tokenId, pqAccount));

        // 4. Q-day: the OLD key re-points the name to the attacker. The resolver roles never moved.
        vm.prank(alice);
        resolver.setAddress(DNS_NAME, ETH_COIN, abi.encodePacked(attacker));
        assertEq(_resolveAddr(resolver), attacker, "RESIDUAL: old key redirected the name");

        // 5. Fix: grant the roles to the PQ account, then the old key revokes its own roles.
        vm.startPrank(alice);
        resolver.setAddress(DNS_NAME, ETH_COIN, abi.encodePacked(pqAccount));
        resolver.grantRootRoles(ROLE_SET_ADDRESS | ROLE_SET_ADDRESS_ADMIN, pqAccount);
        resolver.revokeRootRoles(ROLE_SET_ADDRESS | ROLE_SET_ADDRESS_ADMIN, alice);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert();
        resolver.setAddress(DNS_NAME, ETH_COIN, abi.encodePacked(attacker));
        assertEq(_resolveAddr(resolver), pqAccount, "after fix: old key can no longer redirect");
    }
}
