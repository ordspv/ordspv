# examples

## verify-inscription-0.html

Open the file. That's it. A single self-contained page (inline bundle of
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

Rebuild after changing `src/`: `npx tsx scripts/build-demo.ts`
(the committed HTML is the artifact; viewers need no tooling).
