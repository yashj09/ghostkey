// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PQAuth, ISphincsVerifier} from "./PQAuth.sol";

/// @title PQAccount
/// @notice A fresh smart account controlled only by a leanSphincs-s key. It has no ECDSA key
///         anywhere, so there is nothing for an ECDSA-breaking attacker to recover. GhostKey's
///         "Complete migration" moves everything here.
contract PQAccount is PQAuth {
    constructor(ISphincsVerifier verifier_, bytes32 pkSeed_, bytes32 pkRoot_) PQAuth(verifier_, pkSeed_, pkRoot_) {}

    /// @notice ERC-1271: accepts only post-quantum signatures.
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return _pqValid(hash, sig) ? ERC1271_MAGIC : ERC1271_FAIL;
    }
}
