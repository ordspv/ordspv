import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  computeMerkleRoot,
  buildMerkleBranch,
  verifyMerkleBranch,
  parseTx,
  serializeFull,
  sha256,
  tapLeafHash,
  verifyProofBundle,
  type ProofBundleJson,
} from '../src/index.js';
import {
  buildBlock,
  commitTx,
  dummyTx,
  envelopeScript,
  l3Bundle,
  revealTx,
  taprootCommit,
  DUMMY_CONTROL_BLOCK,
  NO_POW_FLOOR,
} from './helpers.js';

const te = new TextEncoder();

describe('synthetic merkle trees', () => {
  it('verifies odd-count trees with self-paired final nodes', () => {
    const leaves = Array.from({ length: 5 }, (_, i) => sha256(te.encode(`leaf${i}`)));
    const root = computeMerkleRoot(leaves);
    for (let pos = 0; pos < 5; pos++) {
      const branch = buildMerkleBranch(leaves, pos);
      const { root: folded } = verifyMerkleBranch(leaves[pos], branch, pos, 5);
      expect(bytesToHex(folded)).toBe(bytesToHex(root));
    }
  });

  it('rejects branches with wrong depth for the tx count', () => {
    const leaves = Array.from({ length: 5 }, (_, i) => sha256(te.encode(`leaf${i}`)));
    const branch = buildMerkleBranch(leaves, 1);
    expect(() => verifyMerkleBranch(leaves[1], branch.slice(0, 2), 1, 5)).toThrow(/branch length/);
  });
});

describe('L3 proof bundles (synthetic blocks)', () => {
  const inscriptionScript = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['hello L3'] },
    { checksigPrefix: true },
  );

  it('verifies a reveal adjacent to the coinbase (pos 1, minimal block)', () => {
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([reveal]);
    const bundle = l3Bundle(block, 1, `${reveal.txid}i0`);
    const result = verifyProofBundle(bundle, NO_POW_FLOOR);
    expect(result.level).toBe('L3');
    expect(new TextDecoder().decode(result.inscription.body)).toBe('hello L3');
  });

  it('refuses a header easier than the proof-of-work floor by default', () => {
    // the block's merkle structure and the header's own PoW are both valid;
    // what the floor objects to is how little that PoW cost
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([reveal]);
    const bundle = l3Bundle(block, 1, `${reveal.txid}i0`);
    expect(() => verifyProofBundle(bundle)).toThrow(/proof-of-work limit/);
    expect(() => verifyProofBundle(bundle)).toThrow(/0x207fffff/);
    expect(() => verifyProofBundle(bundle)).toThrow(/0x1d00ffff/);
    // an explicit floor of the chain's own limit accepts it, as does null
    expect(verifyProofBundle(bundle, { powLimitBits: 0x207fffff }).level).toBe('L3');
    expect(verifyProofBundle(bundle, NO_POW_FLOOR).level).toBe('L3');
  });

  it('verifies a reveal deeper in a larger block', () => {
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([dummyTx(), reveal, dummyTx(), dummyTx()]);
    const bundle = l3Bundle(block, 2, `${reveal.txid}i0`);
    const result = verifyProofBundle(bundle, NO_POW_FLOOR);
    expect(result.level).toBe('L3');
    expect(result.inscription.contentType).toBe('text/plain');
  });

  it('detects forged witness content (txid unchanged, wtxid diverges)', () => {
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([dummyTx(), reveal, dummyTx()]);

    // forge: same tx, different envelope in the witness
    const forgedScript = envelopeScript(
      { fields: [[1, 'text/plain']], body: ['EVIL CONTENT'] },
      { checksigPrefix: true },
    );
    const forged = parseTx(
      serializeFull({
        version: reveal.version,
        inputs: reveal.inputs.map((inp) => ({
          ...inp,
          witness: [inp.witness[0], forgedScript, inp.witness[2]],
        })),
        outputs: reveal.outputs,
        locktime: reveal.locktime,
      }),
    );
    expect(forged.txid).toBe(reveal.txid); // txid does NOT commit to the witness
    expect(forged.wtxid).not.toBe(reveal.wtxid);

    const bundle = l3Bundle(block, 2, `${reveal.txid}i0`);
    bundle.reveal.hex = bytesToHex(forged.raw);
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);
  });

  it('rejects a bundle claiming a nonexistent envelope index', () => {
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([reveal]);
    const bundle = l3Bundle(block, 1, `${reveal.txid}i5`);
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(/index 5 not present/);
  });

  it('rejects wrong txCount (depth hardening)', () => {
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([dummyTx(), reveal, dummyTx()]);
    const bundle = l3Bundle(block, 2, `${reveal.txid}i0`);
    bundle.block.txCount = 100;
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(/branch depth|tree height/);
  });

  it('rejects reveals whose STRIPPED serialization is 64 bytes (leaf/node ambiguity)', () => {
    const cat = (...parts: Uint8Array[]): Uint8Array => {
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    };
    const u32 = (n: number): Uint8Array => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n, true);
      return b;
    };
    // stripped: version(4) inCount(1) outpoint(36) scriptSigLen(1)=0 seq(4)
    //           outCount(1) value(8) spkLen(1) spk(4) locktime(4) = 64 bytes
    const stripped = cat(
      u32(2),
      new Uint8Array([1]),
      new Uint8Array(36),
      new Uint8Array([0]),
      u32(0xffffffff),
      new Uint8Array([1]),
      new Uint8Array(8),
      new Uint8Array([4, 0x51, 0x51, 0x51, 0x51]),
      u32(0),
    );
    expect(stripped.length).toBe(64);
    // segwit-wrap it with a one-item witness stack: the raw length grows past
    // 64 while the txid preimage stays exactly 64
    const raw = cat(
      stripped.slice(0, 4),
      new Uint8Array([0x00, 0x01]),
      stripped.slice(4, 60),
      new Uint8Array([1, 1, 0x00]),
      stripped.slice(60),
    );
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([reveal]);
    const bundle = l3Bundle(block, 1, `${reveal.txid}i0`);
    bundle.reveal.hex = bytesToHex(raw);
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(/64-byte/);
    bundle.reveal.hex = bytesToHex(stripped);
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(/64-byte/);
  });

  it('invokes the header trust hook', () => {
    const reveal = revealTx([{ script: inscriptionScript, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const block = buildBlock([reveal]);
    const bundle = l3Bundle(block, 1, `${reveal.txid}i0`);
    expect(() =>
      verifyProofBundle(bundle, {
        ...NO_POW_FLOOR,
        trustHeader: () => {
          throw new Error('header not on my chain');
        },
      }),
    ).toThrow(/header not on my chain/);
  });
});

describe('L2 proof bundles (tapscript commitment)', () => {
  function l2Setup(path: Uint8Array[] = []) {
    const script = envelopeScript(
      { fields: [[1, 'text/plain']], body: ['hello L2'] },
      { checksigPrefix: true },
    );
    const { scriptPubKey, controlBlock } = taprootCommit(script, path);
    const commit = commitTx(scriptPubKey);
    const reveal = revealTx([{ script, controlBlock }], { prevTxidLE: commit.txidLE, vout: 0 });
    const block = buildBlock([dummyTx(), reveal]);
    const bundle: ProofBundleJson = {
      version: 1,
      inscriptionId: `${reveal.txid}i0`,
      level: 'L2',
      block: { height: 100, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
      reveal: { hex: bytesToHex(reveal.raw), pos: 2, txidBranch: block.txidBranch(2) },
      commit: { hex: bytesToHex(commit.raw) },
    };
    return { bundle, script, commit, reveal, block };
  }

  it('verifies a single-leaf commit (strongest L2 assurance)', () => {
    const { bundle } = l2Setup();
    const result = verifyProofBundle(bundle, NO_POW_FLOOR);
    expect(result.level).toBe('L2');
    expect(result.l2).toEqual({
      controlBlockDepth: 0,
      singleLeafTree: true,
      singleInputReveal: true,
    });
    expect(new TextDecoder().decode(result.inscription.body)).toBe('hello L2');
  });

  it('verifies but downgrades assurance for multi-leaf trees', () => {
    const sibling = tapLeafHash(envelopeScript({ fields: [[1, 'text/plain']], body: ['other leaf'] }), 0xc0);
    const { bundle } = l2Setup([sibling]);
    const result = verifyProofBundle(bundle, NO_POW_FLOOR);
    expect(result.l2?.singleLeafTree).toBe(false);
    expect(result.l2?.controlBlockDepth).toBe(1);
  });

  it('documents the L2 gap: a sibling leaf also verifies at the same outpoint', () => {
    // inscriber commits a tree with two envelope leaves, reveals A, serves B
    const scriptA = envelopeScript({ fields: [[1, 'text/plain']], body: ['real'] }, { checksigPrefix: true });
    const scriptB = envelopeScript({ fields: [[1, 'text/plain']], body: ['fake'] }, { checksigPrefix: true });
    const leafA = tapLeafHash(scriptA, 0xc0);
    const leafB = tapLeafHash(scriptB, 0xc0);

    const commitA = taprootCommit(scriptA, [leafB]);
    const commitB = taprootCommit(scriptB, [leafA]);
    // same output key: both leaves live in one tree
    expect(bytesToHex(commitA.scriptPubKey)).toBe(bytesToHex(commitB.scriptPubKey));

    const commit = commitTx(commitA.scriptPubKey);
    const revealA = revealTx([{ script: scriptA, controlBlock: commitA.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    const revealB = revealTx([{ script: scriptB, controlBlock: commitB.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    // block contains revealA; that's what ord indexed
    const block = buildBlock([revealA]);

    // the two reveals differ ONLY in witness bytes, so their txids are
    // identical. That txid/witness non-commitment is the entire L2 gap:
    expect(revealB.txid).toBe(revealA.txid);
    expect(revealB.wtxid).not.toBe(revealA.wtxid);

    // a bundle carrying revealB's bytes under revealA's inscription id
    // VERIFIES at L2 (txid matches, tapscript proof valid for leaf B)...
    const l2: ProofBundleJson = {
      version: 1,
      inscriptionId: `${revealA.txid}i0`,
      level: 'L2',
      block: { height: 100, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
      reveal: { hex: bytesToHex(revealB.raw), pos: 1, txidBranch: block.txidBranch(1) },
      commit: { hex: bytesToHex(commit.raw) },
    };
    const forged = verifyProofBundle(l2, NO_POW_FLOOR);
    expect(new TextDecoder().decode(forged.inscription.body)).toBe('fake'); // L2 accepts...
    expect(forged.l2?.singleLeafTree).toBe(false); // ...but flags the multi-leaf tree

    // ...while L3 rejects it: the block's witness commitment pins revealA's witness
    const l3 = l3Bundle(block, 1, `${revealA.txid}i0`);
    l3.reveal.hex = bytesToHex(revealB.raw);
    expect(() => verifyProofBundle(l3, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);
  });

  it('rejects a commit tx that does not match the spent outpoint', () => {
    const { bundle } = l2Setup();
    const wrongCommit = commitTx(new Uint8Array([0x51, 0x20, ...sha256(te.encode('other'))]));
    bundle.commit = { hex: bytesToHex(wrongCommit.raw) };
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(/commit tx hashes to/);
  });

  it('refuses a bundle without inscriptionId by naming the field', () => {
    const { bundle } = l2Setup();
    delete (bundle as unknown as Record<string, unknown>).inscriptionId;
    let err: Error | undefined;
    try {
      verifyProofBundle(bundle, NO_POW_FLOOR);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe('bundle field inscriptionId is missing or not a string');
  });

  it('refuses a witness section on an L2 bundle, and verifies the same bundle without one', () => {
    const { bundle } = l2Setup();
    expect(verifyProofBundle(bundle, NO_POW_FLOOR).level).toBe('L2');
    // presence, not truth: nothing at L2 reads the section, so any value at
    // all would make the file look witness-carrying while nothing checks it
    (bundle as { witness?: unknown }).witness = { coinbaseHex: 'ff' };
    expect(() => verifyProofBundle(bundle, NO_POW_FLOOR)).toThrow(
      /witness section on an L2 bundle/,
    );
  });
});
