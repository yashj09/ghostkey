// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PQAuth, ISphincsVerifier, Call} from "./PQAuth.sol";

interface IQuantumCanary {
    function tripped() external view returns (bool);
}

/// @title PQDelegate
/// @notice EIP-7702 delegation target that turns an EOA into a "post-quantum wallet":
///         - `execute` runs calls with a leanSphincs-s signature (always allowed);
///         - `executeECDSA` and ECDSA ERC-1271 signatures work only until the killswitch trips;
///         - the killswitch trips when the QuantumCanary is claimed, or when the owner flips it
///           (one-way) from a PQ-signed batch.
/// @dev This is the "wallet-level killswitch" GhostKey demonstrates is NOT enough. The protocol
///      still accepts the EOA's ECDSA key as a tx signer and as a 7702 authority, and ecrecover-only
///      contracts never ask this code. See docs/architecture/surfaces.md.
///      Deploy one delegate per user: the PQ key is immutable, so 7702 never needs an init call
///      that someone could front-run.
contract PQDelegate is PQAuth {
    IQuantumCanary public immutable canary;

    event KillswitchActivated();

    error ECDSADisabled();

    constructor(ISphincsVerifier verifier_, bytes32 pkSeed_, bytes32 pkRoot_, IQuantumCanary canary_)
        PQAuth(verifier_, pkSeed_, pkRoot_)
    {
        canary = canary_;
    }

    /// @notice True once ECDSA should be refused: the canary tripped, or the owner killed it.
    function killswitch() public view returns (bool) {
        return _s().ownerKill || (address(canary) != address(0) && canary.tripped());
    }

    /// @notice One-way: disable this wallet's ECDSA paths. Call it from a PQ-signed `execute` batch.
    function activateKillswitch() external onlySelf {
        _s().ownerKill = true;
        emit KillswitchActivated();
    }

    /// @notice Convenience batch for the EOA key, i.e. a tx from the EOA to itself. Refused after the killswitch.
    function executeECDSA(Call[] calldata calls) external payable onlySelf {
        if (killswitch()) revert ECDSADisabled();
        uint256 n = _s().nonce++;
        _run(calls);
        emit Executed(n, calls.length, false);
    }

    /// @notice ERC-1271: PQ signatures always count; ECDSA from the EOA key counts only before the killswitch.
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length == SPHINCS_SIG_LEN) {
            return verifier.verify(pkSeed, pkRoot, hash, sig) ? ERC1271_MAGIC : ERC1271_FAIL;
        }
        if (sig.length == 65 && !killswitch()) {
            bytes32 r = bytes32(sig[0:32]);
            bytes32 s = bytes32(sig[32:64]);
            uint8 v = uint8(sig[64]);
            address signer = ecrecover(hash, v, r, s);
            if (signer != address(0) && signer == address(this)) return ERC1271_MAGIC;
        }
        return ERC1271_FAIL;
    }
}
