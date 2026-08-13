import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  formatSatpoint,
  hexToBytes,
  parseTx,
  treeHeight,
  verifyCustodyBundle,
  type CustodyBundleJson,
  type CustodyVerifyOptions,
  type VerifiedCustody,
} from '@ordspv/core';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  NO_POW_FLOOR,
} from './helpers.js';
import { buildLegacyTx, mutateHex, rng, randInt, pick } from './gen.js';

/**
 * Malformed-bundle fuzz for verifyCustodyBundle, seeded and reproducible.
 *
 * The property is the one proofbundle.fuzz.test.ts states for attestations,
 * read for a custody path: a mutation must either be REJECTED, or leave the
 * answer (id, genesis, every satpoint on the path, hop count, taptree
 * assurance, index proof) byte-identical. A mutation that survives and moves
 * the sat is a P0 verifier bug, because every hash in such a bundle still
 * folds and the reader is told the inscription sits where it does not.
 *
 * A mutation that survives and changes NOTHING is the second half of the
 * property: it says the bytes it touched are not load-bearing. Three regions
 * legitimately are not, and each is named rather than tolerated:
 *
 *  - block.height is anchored by the caller's trustHeader hook, not by the
 *    bundle. Nothing inside a custody bundle binds a header to a height, which
 *    is the same exclusion proofbundle.fuzz.test.ts carries.
 *  - witness bytes outside the tapscript and the control block are not
 *    committed by a txid, so a transaction a bundle carries only by txid (a
 *    prev tx, or a hop tx on a hop with no witness section) can differ there.
 *    That is the documented L2 gap; the wtxid-anchored baseline closes it and
 *    the signature-flip pair below pins both sides.
 *  - block.txCount is not committed by the header either. What makes it
 *    load-bearing is the branch-depth check (CVE-2017-12842 hardening), so a
 *    count that implies the same tree height and the same odd-width
 *    duplications along the proven path cannot be told from the true one. A
 *    survivor whose tree height moved would mean the depth check did not bite,
 *    and that is a failure rather than an exclusion.
 *
 * Any other surviving mutation fails the run and names the path it touched.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');

/**
 * FUZZ_ITERS / FUZZ_SEED: the same contract as envelope.fuzz.test.ts and
 * proofbundle.fuzz.test.ts, so one knob drives the whole heavy-fuzz run
 * (.github/workflows/fuzz.yml). Unset, this file runs its fixed-seed baseline.
 */
const BASE_ITERS = 400;
const FUZZ_ITERS = Math.max(BASE_ITERS, Number(process.env.FUZZ_ITERS) || BASE_ITERS);
const SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) >>> 0 : 0xc0570d1e;

// ---------- baselines ----------

interface Baseline {
  name: string;
  bundle: CustodyBundleJson;
  opts: CustodyVerifyOptions;
}

/** The vendored inscription 0 bundle: real mainnet header, real merkle branch. */
function insc0Bundle(): CustodyBundleJson {
  const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf8').trim();
  const proof = JSON.parse(read('merkle-proof.json')) as { merkle: string[]; pos: number };
  const expected = JSON.parse(read('expected.json')) as {
    revealTxid: string;
    blockHash: string;
    blockHeight: number;
  };
  return {
    version: 1,
    inscriptionId: `${expected.revealTxid}i0`,
    hops: [
      {
        block: {
          height: expected.blockHeight,
          hash: expected.blockHash,
          header: read('header-767430.hex'),
          txCount: 2332,
        },
        tx: { hex: read('reveal.hex'), pos: proof.pos, txidBranch: proof.merkle },
        prevTxs: [read('commit.hex')],
      },
    ],
    finalSatpoint: `${expected.revealTxid}:0:0`,
  };
}

/** One synthetic reveal, reused by the two-hop and the wtxid-anchored baselines. */
function syntheticReveal() {
  const script = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['custody fuzz'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  return { commit, reveal, block: buildBlock([reveal]) };
}

/** Reveal plus one transfer, the shape a custody path actually has. */
function twoHopBundle(): Baseline {
  const { commit, reveal, block } = syntheticReveal();
  const spend = buildLegacyTx([{ txid: reveal.txid, vout: 0 }], [500n]);
  const spendBlock = buildBlock([spend.tx]);
  return {
    name: 'synthetic two-hop',
    opts: NO_POW_FLOOR,
    bundle: {
      version: 1,
      inscriptionId: `${reveal.txid}i0`,
      hops: [
        {
          block: { height: 800_000, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
          tx: { hex: bytesToHex(reveal.raw), pos: 1, txidBranch: block.txidBranch(1) },
          prevTxs: [bytesToHex(commit.raw)],
        },
        {
          block: {
            height: 800_010,
            hash: spendBlock.blockHash,
            header: spendBlock.headerHex,
            txCount: spendBlock.txCount,
          },
          tx: { hex: spend.hex, pos: 1, txidBranch: spendBlock.txidBranch(1) },
          prevTxs: [bytesToHex(reveal.raw)],
        },
      ],
      finalSatpoint: `${spend.tx.txid}:0:0`,
    },
  };
}

/** The same reveal with its whole witness anchored through the block commitment. */
function wtxidBundle(): Baseline {
  const { commit, reveal, block } = syntheticReveal();
  return {
    name: 'wtxid-anchored reveal',
    opts: NO_POW_FLOOR,
    bundle: {
      version: 1,
      inscriptionId: `${reveal.txid}i0`,
      hops: [
        {
          block: { height: 800_000, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
          tx: { hex: bytesToHex(reveal.raw), pos: 1, txidBranch: block.txidBranch(1) },
          prevTxs: [bytesToHex(commit.raw)],
          witness: {
            coinbaseHex: bytesToHex(block.txs[0].raw),
            coinbaseTxidBranch: block.txidBranch(0),
            wtxidBranch: block.wtxidBranch(1),
          },
        },
      ],
      finalSatpoint: `${reveal.txid}:0:0`,
    },
  };
}

/**
 * What the bundle attests. block.height is deliberately absent: it is the
 * caller-anchored field, and a mutation that moves it is checked separately.
 */
function answer(v: VerifiedCustody): string {
  return [
    v.inscriptionId,
    formatSatpoint(v.genesis),
    v.path.map(formatSatpoint).join(','),
    formatSatpoint(v.satpoint),
    v.hops,
    v.controlBlockDepth,
    v.singleLeafTree,
    v.singleInputReveal,
    v.indexProof,
  ].join('|');
}

// ---------- paths into the bundle JSON ----------

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
  (target as Record<string, unknown>)[last] = value;
}

/** Every hex string in the bundle, by path. */
function hexPaths(bundle: CustodyBundleJson): string[] {
  const paths: string[] = [];
  bundle.hops.forEach((hop, h) => {
    paths.push(`hops.${h}.block.header`, `hops.${h}.block.hash`, `hops.${h}.tx.hex`);
    hop.tx.txidBranch.forEach((_, i) => paths.push(`hops.${h}.tx.txidBranch.${i}`));
    hop.prevTxs.forEach((_, i) => paths.push(`hops.${h}.prevTxs.${i}`));
    if (hop.witness) {
      paths.push(`hops.${h}.witness.coinbaseHex`);
      hop.witness.coinbaseTxidBranch.forEach((_, i) =>
        paths.push(`hops.${h}.witness.coinbaseTxidBranch.${i}`),
      );
      hop.witness.wtxidBranch.forEach((_, i) => paths.push(`hops.${h}.witness.wtxidBranch.${i}`));
    }
  });
  return paths;
}

/** Every number in the bundle, by path, including the ones inside strings. */
function numericPaths(bundle: CustodyBundleJson): string[] {
  const paths = ['version', 'inscriptionId.index', 'finalSatpoint.vout', 'finalSatpoint.offset'];
  bundle.hops.forEach((_, h) => {
    paths.push(`hops.${h}.block.height`, `hops.${h}.block.txCount`, `hops.${h}.tx.pos`);
  });
  return paths;
}

/** Flip one byte of a hex field, or nudge one number by one. */
function mutate(bundle: CustodyBundleJson, path: string, r: () => number): void {
  const delta = pick(r, [1, -1]);
  if (path === 'inscriptionId.index') {
    const [txid, index] = bundle.inscriptionId.split('i');
    bundle.inscriptionId = `${txid}i${Number(index) + delta}`;
    return;
  }
  if (path === 'finalSatpoint.vout' || path === 'finalSatpoint.offset') {
    const [txid, vout, offset] = bundle.finalSatpoint.split(':');
    bundle.finalSatpoint =
      path === 'finalSatpoint.vout'
        ? `${txid}:${Number(vout) + delta}:${offset}`
        : `${txid}:${vout}:${BigInt(offset) + BigInt(delta)}`;
    return;
  }
  const current = getPath(bundle, path);
  if (typeof current === 'number') {
    setPath(bundle, path, current + delta);
    return;
  }
  setPath(bundle, path, mutateHex(r, current as string));
}

/** The stripped serialization of a tx hex, or undefined when it stops parsing. */
function stripped(hex: unknown): string | undefined {
  try {
    return bytesToHex(parseTx(hexToBytes((hex as string).trim())).strippedRaw);
  } catch {
    return undefined;
  }
}

/**
 * Why a mutation is allowed to survive with the answer unchanged, or undefined
 * when nothing excuses it. Only the two documented regions qualify.
 */
function unboundRegion(
  baseline: CustodyBundleJson,
  mutated: CustodyBundleJson,
  path: string,
): string | undefined {
  if (/^hops\.\d+\.block\.height$/.test(path)) return 'caller-anchored height';
  if (/^hops\.\d+\.block\.txCount$/.test(path)) {
    const before = getPath(baseline, path) as number;
    const after = getPath(mutated, path) as number;
    return treeHeight(before) === treeHeight(after) ? 'tx count at the same tree height' : undefined;
  }
  const hop = /^hops\.(\d+)\.(tx\.hex|prevTxs\.\d+)$/.exec(path);
  if (!hop) return undefined;
  // a witness section anchors the hop transaction's whole witness, so nothing
  // in it is free to move; without one the txid is the only thing binding it
  const isHopTx = hop[2] === 'tx.hex';
  if (isHopTx && mutated.hops[Number(hop[1])].witness !== undefined) return undefined;
  const before = stripped(getPath(baseline, path));
  const after = stripped(getPath(mutated, path));
  if (before === undefined || after === undefined || before !== after) return undefined;
  return 'witness bytes outside the txid';
}

// ---------- the run ----------

describe(`verifyCustodyBundle malformed-bundle fuzz (seed=0x${SEED.toString(16)}, iters=${FUZZ_ITERS})`, () => {
  const baselines: Baseline[] = [
    { name: 'vendored inscription 0', bundle: insc0Bundle(), opts: {} },
    twoHopBundle(),
    wtxidBundle(),
  ];

  it('all baselines verify (fuzz preconditions)', () => {
    for (const b of baselines) {
      expect(() => verifyCustodyBundle(b.bundle, b.opts), b.name).not.toThrow();
    }
    // the real one clears the mainnet proof-of-work floor with no options at
    // all; the synthetic headers are mined at regtest difficulty
    expect(verifyCustodyBundle(baselines[0].bundle).indexProof).toBe('single-input');
    expect(verifyCustodyBundle(baselines[1].bundle, NO_POW_FLOOR).hops).toBe(2);
    expect(verifyCustodyBundle(baselines[2].bundle, NO_POW_FLOOR).indexProof).toBe('wtxid');
  });

  for (const baseline of baselines) {
    it(`no single mutation moves the answer of the ${baseline.name} bundle`, () => {
      const verified = verifyCustodyBundle(baseline.bundle, baseline.opts);
      const expectedAnswer = answer(verified);
      const paths = [...hexPaths(baseline.bundle), ...numericPaths(baseline.bundle)];
      const r = rng(SEED ^ baseline.name.length);
      const survivors = new Map<string, number>();
      let rejected = 0;

      for (let i = 0; i < FUZZ_ITERS; i++) {
        const path = paths[i % paths.length];
        const mutated = JSON.parse(JSON.stringify(baseline.bundle)) as CustodyBundleJson;
        mutate(mutated, path, r);
        const where = `${baseline.name}: mutation ${i} at ${path} (seed 0x${SEED.toString(16)})`;

        let result: VerifiedCustody;
        try {
          result = verifyCustodyBundle(mutated, baseline.opts);
        } catch {
          rejected++;
          continue;
        }
        // a survivor must not have moved the sat, whatever else it did
        expect(answer(result), `${where} verified with a DIFFERENT answer`).toBe(expectedAnswer);
        const excuse = unboundRegion(baseline.bundle, mutated, path);
        expect(excuse, `${where} survived unchanged and nothing binds it`).toBeTypeOf('string');
        survivors.set(excuse!, (survivors.get(excuse!) ?? 0) + 1);
      }

      // the run has to have done work: mutations that are all rejected would
      // pass the property vacuously if the mutators had quietly stopped biting
      expect(rejected, `${baseline.name}: nothing was rejected`).toBeGreaterThan(0);
      expect(
        survivors.get('caller-anchored height') ?? 0,
        `${baseline.name}: the height exclusion must be exercised`,
      ).toBeGreaterThan(0);
    });
  }

  it('measures both sides of the L2 witness gap on the same reveal', () => {
    // the signature element is witness bytes outside the tapscript and the
    // control block: the txid does not cover it, the block's witness
    // commitment does
    const anchored = wtxidBundle();
    const bare = JSON.parse(JSON.stringify(anchored.bundle)) as CustodyBundleJson;
    delete bare.hops[0].witness;

    const before = verifyCustodyBundle(bare, NO_POW_FLOOR);
    expect(before.indexProof, 'the same reveal proves its index by being single-input').toBe(
      'single-input',
    );

    // find the 64-byte signature element the reveal helper writes
    const raw = hexToBytes(anchored.bundle.hops[0].tx.hex);
    let sigAt = -1;
    for (let i = 0; i + 64 <= raw.length; i++) {
      if (raw.slice(i, i + 64).every((b) => b === 7)) {
        sigAt = i;
        break;
      }
    }
    expect(sigAt, 'the signature element must be locatable').toBeGreaterThan(0);
    const flipped = raw.slice();
    flipped[sigAt + 5] ^= 0xff;
    const flippedHex = bytesToHex(flipped);
    expect(stripped(flippedHex), 'the flip must leave the txid preimage alone').toBe(
      stripped(anchored.bundle.hops[0].tx.hex),
    );

    // without the section the flip is invisible, and the answer is identical
    const bareFlipped = JSON.parse(JSON.stringify(bare)) as CustodyBundleJson;
    bareFlipped.hops[0].tx.hex = flippedHex;
    expect(answer(verifyCustodyBundle(bareFlipped, NO_POW_FLOOR))).toBe(answer(before));

    // with it, the same flip is refused: the wtxid the block committed moved
    const anchoredFlipped = JSON.parse(JSON.stringify(anchored.bundle)) as CustodyBundleJson;
    anchoredFlipped.hops[0].tx.hex = flippedHex;
    expect(() => verifyCustodyBundle(anchoredFlipped, NO_POW_FLOOR)).toThrow(
      /witness|wtxid|commitment/i,
    );
  });

  it('a mutated prev tx witness is invisible, and its stripped bytes are not', () => {
    // the other half of the same rule: a prev tx is carried by txid alone, so
    // its witness is free and everything the txid covers is not
    const baseline = twoHopBundle();
    const prevHex = baseline.bundle.hops[1].prevTxs[0];
    const raw = hexToBytes(prevHex);
    const expected = answer(verifyCustodyBundle(baseline.bundle, NO_POW_FLOOR));

    let sigAt = -1;
    for (let i = 0; i + 64 <= raw.length; i++) {
      if (raw.slice(i, i + 64).every((b) => b === 7)) {
        sigAt = i;
        break;
      }
    }
    expect(sigAt, 'the prev tx signature element must be locatable').toBeGreaterThan(0);
    const witnessFlip = raw.slice();
    witnessFlip[sigAt + 1] ^= 0x0f;
    const inWitness = JSON.parse(JSON.stringify(baseline.bundle)) as CustodyBundleJson;
    inWitness.hops[1].prevTxs[0] = bytesToHex(witnessFlip);
    expect(answer(verifyCustodyBundle(inWitness, NO_POW_FLOOR))).toBe(expected);

    // a byte inside the stripped serialization changes the txid, and the input
    // that names it no longer matches
    const r = rng(0x9e3779b9);
    const inStripped = JSON.parse(JSON.stringify(baseline.bundle)) as CustodyBundleJson;
    const strippedRaw = parseTx(raw).strippedRaw;
    const at = randInt(r, 4, strippedRaw.length - 5);
    const valueFlip = raw.slice();
    // the first four bytes are the version, shared by both serializations
    valueFlip[at] ^= 0xff;
    if (stripped(bytesToHex(valueFlip)) !== stripped(prevHex)) {
      inStripped.hops[1].prevTxs[0] = bytesToHex(valueFlip);
      expect(() => verifyCustodyBundle(inStripped, NO_POW_FLOOR)).toThrow();
    }
  });
});
