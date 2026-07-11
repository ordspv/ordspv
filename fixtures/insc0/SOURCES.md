# insc0 fixture provenance

Inscription 0 (genesis inscription), fetched 2026-07-11.

- reveal.hex: https://mempool.space/api/tx/6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799/hex
- commit.hex: https://mempool.space/api/tx/274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358/hex
- header-767430.hex: https://mempool.space/api/block/000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5/header
- merkle-proof.json: https://mempool.space/api/tx/6fb976.../merkle-proof (esplora txid-tree proof)
- expected.json: cross-checked against https://ordinals.com/r/inscription/6fb976...i0

Integrity does not depend on the fetch channel: tests recompute txids, header hash,
and merkle root from these bytes; any corruption fails loudly.
