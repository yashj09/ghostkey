// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice leanSphincs-s verifier (vendored from nconsigny/SPHINCS-).
interface ISphincsVerifier {
    function verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) external pure returns (bool);
}

struct Call {
    address to;
    uint256 value;
    bytes data;
}

/// @title PQAuth
/// @notice Shared post-quantum authorisation for GhostKey accounts. A batch of calls runs only
///         with a leanSphincs-s signature over (chainId, account, nonce, calls).
/// @dev The PQ public key and verifier are immutables. Under EIP-7702 the delegate's constructor
///      never runs for the EOA, but immutables live in code, so they still apply. The nonce
///      uses an ERC-7201 namespaced slot so it can't collide with storage left behind by an
///      earlier delegate.
abstract contract PQAuth {
    uint256 internal constant SPHINCS_SIG_LEN = 4164;
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_FAIL = 0xffffffff;
    bytes32 public constant EXECUTE_TYPEHASH = keccak256("GhostKeyExecute(uint256 chainId,address account,uint256 nonce,bytes32 callsHash)");

    ISphincsVerifier public immutable verifier;
    bytes32 public immutable pkSeed;
    bytes32 public immutable pkRoot;

    /// @custom:storage-location erc7201:ghostkey.pqauth
    struct PQAuthStorage {
        uint256 nonce;
        bool ownerKill;
    }

    // keccak256(abi.encode(uint256(keccak256("ghostkey.pqauth")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x59a129d4c1fe3db968f2ee16d36a031b581e86513845e8ec700c1b8ccebcf500;

    event Executed(uint256 indexed nonce, uint256 calls, bool pq);

    error BadPQSignature();
    error OnlySelf();
    error CallFailed(uint256 index, bytes reason);

    constructor(ISphincsVerifier verifier_, bytes32 pkSeed_, bytes32 pkRoot_) {
        verifier = verifier_;
        pkSeed = pkSeed_;
        pkRoot = pkRoot_;
    }

    function _s() internal pure returns (PQAuthStorage storage $) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            $.slot := slot
        }
    }

    function nonce() public view returns (uint256) {
        return _s().nonce;
    }

    /// @notice Digest the PQ key signs to authorise `calls` at the current nonce.
    function executeDigest(Call[] calldata calls) public view returns (bytes32) {
        return keccak256(abi.encode(EXECUTE_TYPEHASH, block.chainid, address(this), _s().nonce, keccak256(abi.encode(calls))));
    }

    function _pqValid(bytes32 digest, bytes calldata sig) internal view returns (bool) {
        return sig.length == SPHINCS_SIG_LEN && verifier.verify(pkSeed, pkRoot, digest, sig);
    }

    /// @notice Runs `calls` if `pqSig` is a valid leanSphincs-s signature. Anyone can relay it.
    function execute(Call[] calldata calls, bytes calldata pqSig) external payable {
        if (!_pqValid(executeDigest(calls), pqSig)) revert BadPQSignature();
        uint256 n = _s().nonce++;
        _run(calls);
        emit Executed(n, calls.length, true);
    }

    function _run(Call[] calldata calls) internal {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    // Token receivers: once an EOA is delegated it has code, so safe transfers check these hooks.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x150b7a02 || id == 0x4e2312e0 || id == 0x1626ba7e;
    }

    receive() external payable {}
}
