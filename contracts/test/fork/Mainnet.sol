// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Mainnet addresses and minimal interfaces used by the GhostKey fork fixture.
/// ENSv2 interfaces match tag `v2-mainnet-deployment-1` of ensdomains/contracts-v2.
library Mainnet {
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant UNI = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a; // 1.4.1
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_SENTINEL = address(0x1);
    address constant ENS_REGISTRAR = 0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81;
    address constant ENS_ETH_REGISTRY = 0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2;
    address constant ENS_RESOLVER_IMPL = 0x565b0F456a04Ac9b48758190e90030623Cff57C5;
    address constant ENS_FACTORY = 0x77510ba162dfeA3d8989E3f0928a691B345730D2;

    uint256 constant ENS_ROLE_SET_ADDRESS = 1 << 0;
    uint256 constant ENS_ROLE_SET_ADDRESS_ADMIN = ENS_ROLE_SET_ADDRESS << 128;
    uint256 constant ETH_COIN_TYPE = 60;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
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

interface ISafe {
    function setup(address[] calldata, uint256, address, bytes calldata, address, address, uint256, address payable) external;
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes calldata signatures) external payable returns (bool);
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) external view returns (bytes32);
    function nonce() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function isOwner(address) external view returns (bool);
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce) external returns (address);
}

struct EnsGrant {
    address account;
    uint256 roleBitmap;
}

struct EnsRegState {
    uint8 status;
    uint64 expiry;
    address latestOwner;
    uint256 tokenId;
    uint256 resource;
}

interface IETHRegistrar {
    function commit(bytes32 commitment) external;
    function makeCommitment(string calldata, address, bytes32, address, address, uint64, bytes32) external pure returns (bytes32);
    function register(string calldata, address, bytes32, address, address, uint64, address, bytes32) external returns (uint256);
}

interface IPermissionedRegistry {
    function getState(uint256 anyId) external view returns (EnsRegState memory);
    function roles(uint256 anyId, address account) external view returns (uint256);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}

interface IPermissionedResolver {
    function initialize(EnsGrant[] calldata grants, bytes[] calldata calls) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}
