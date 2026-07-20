# examples

## verify-inscription-0.html

Open the file. A single self-contained page (inline bundle of
`@ordspv/core`, ~55 KB) that fetches inscription 0 from public esplora
instances (mempool.space, blockstream.info failover; both serve
`Access-Control-Allow-Origin: *`) and verifies it client-side at L2:

1. reveal tx bytes hash to the inscription id (txids are self-certifying)
2. envelope parse (content-type + body from the tapscript witness)
3. header proof-of-work plus the one pinned checkpoint (block 767430, the single
   trust anchor, checkable against any explorer)
4. txid merkle inclusion against the header
5. BIP-341: the commit output's taproot key commits to the envelope script

then renders the PNG and prints the stored-bytes sha256 as a copy-pasteable
`#integrity=` pin. The page refuses to render anything that fails a step.

## evm-nft/

The cross-chain demo (docs/CROSS-CHAIN.md made clickable): `metadata.json` is a
realistic ERC-721 token document whose `image` is an
`ord:<id>/content#integrity=sha256-…` URI, `Contract.sol` is the illustrative
(not deployed) Solidity side, and `index.html` extracts the URI from the token
metadata, resolves it, and verifies the image exactly like the page above,
plus the cross-chain step: the stored bytes must hash to the integrity pin
embedded in the token's own metadata. Same rules: open the file.

Rebuild after changing `src/` or `evm-nft/metadata.json`:
`npx tsx scripts/build-demo.ts` (the committed HTML files are the artifact;
viewers need no tooling).
