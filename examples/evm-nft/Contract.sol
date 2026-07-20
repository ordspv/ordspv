// SPDX-License-Identifier: ISC
pragma solidity ^0.8.24;

// ILLUSTRATIVE, NOT DEPLOYED. This file shows where the Bitcoin reference
// lives when an ERC-721's image is an ordinals inscription. There is no new
// on-chain machinery: the token returns an ordinary metadata URL, and the
// metadata document's "image" field carries an ord: URI with an integrity
// pin (see docs/CROSS-CHAIN.md and metadata.json next to this file):
//
//   "image": "ord:<64-hex-txid>i<n>/content#integrity=sha256-<64-hex>"
//
// The URI names WHAT the image is (an inscription id, forever) and the pin
// fixes WHICH BYTES it must be. Both ride inside the token's own metadata
// rather than in a hosted server's database, so every consumer can pick its
// trust level: rewrite to any gateway URL (L0), hash the fetched bytes
// against the pin with zero Bitcoin infrastructure (L1), or verify against
// Bitcoin proof of work with an SPV resolver such as @ordspv/fetch (L2/L3).
//
// Written against OpenZeppelin Contracts v5; for reading, not deployment.

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract SkullOnBitcoin is ERC721 {
    // One token, one frozen document. A collection would return per-id URLs,
    // or a data:application/json;base64 URI embedding the JSON wholesale;
    // the ord: URI is just a string and embeds cleanly either way.
    string private constant METADATA_URL =
        "https://ordspv.github.io/ordspv/examples/evm-nft/metadata.json";

    // Optional machine-readable linkage for indexers and on-chain consumers:
    // the three values every verification level bottoms out in (txid and
    // sha256 in display order, as explorers print them). The URI in the
    // metadata remains the source of truth; this deliberately does not
    // revive ERC-2477's parallel-field design (rationale in CROSS-CHAIN.md).
    bytes32 public constant REVEAL_TXID =
        0x6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799;
    uint32 public constant INSCRIPTION_INDEX = 0;
    bytes32 public constant BODY_SHA256 =
        0x846d05123db3601c8591bd144f474f1fbe7f873f3af04db4cab326db73f8d087;

    constructor() ERC721("Skull on Bitcoin", "SKULL") {
        _mint(msg.sender, 0);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return METADATA_URL;
    }
}
