// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title QuantumCanary
/// @notice A bounty locked to a secp256k1 key whose private key nobody should know. Claiming it
///         proves that someone can solve ECDLP for that key, and permanently sets `tripped`.
///         Wallets subscribe by reading `tripped()` to switch off their ECDSA paths.
/// @dev The idea is Justin Drake's "Cryptographic canaries and backups" (ethresear.ch, 2018).
///      In production the key is a nothing-up-my-sleeve point (hash-to-curve of a public seed),
///      so nobody holds the private key. The GhostKey demo deploys it with a deliberately weak
///      ~36-bit key so a laptop BSGS solver can play the "quantum computer" on stage.
///      The claim binds the recipient, so a mempool watcher can't front-run a claim.
contract QuantumCanary {
    /// @notice Ethereum address of the canary key (keccak of `pubkey`).
    address public immutable canaryAddress;
    /// @notice Uncompressed public key (x ‖ y, 64 bytes), which is all an attacker gets.
    bytes public pubkey;
    /// @notice Human label, e.g. "demo-36bit" or "nums-v1".
    string public label;

    bool public tripped;
    address public trippedBy;
    uint64 public trippedAt;

    event Funded(address indexed from, uint256 amount);
    event Tripped(address indexed claimer, uint256 bounty, uint64 at);

    error AlreadyTripped();
    error BadSignature();
    error BadPubkey();

    constructor(bytes memory pubkey_, string memory label_) payable {
        if (pubkey_.length != 64) revert BadPubkey();
        pubkey = pubkey_;
        label = label_;
        canaryAddress = address(uint160(uint256(keccak256(pubkey_))));
        if (msg.value > 0) emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Message the canary key must sign to send the bounty to `to`.
    function claimDigest(address to) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode("GhostKey QuantumCanary claim", block.chainid, address(this), to));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// @notice Trip the canary. This needs a signature from the canary key, which means its discrete log was solved.
    function claim(address payable to, uint8 v, bytes32 r, bytes32 s) external {
        if (tripped) revert AlreadyTripped();
        address signer = ecrecover(claimDigest(to), v, r, s);
        if (signer == address(0) || signer != canaryAddress) revert BadSignature();
        tripped = true;
        trippedBy = to;
        trippedAt = uint64(block.timestamp);
        uint256 bounty = address(this).balance;
        emit Tripped(to, bounty, trippedAt);
        if (bounty > 0) {
            (bool ok,) = to.call{value: bounty}("");
            ok; // the bounty is best-effort; the trip is what matters
        }
    }
}
