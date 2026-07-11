import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  parseTx,
  serializeFull,
  sha256,
  verifyProofBundle,
  type ProofBundleJson,
  type VerifiedInscription,
} from '../src/index.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  l3Bundle,
  revealTx,
  taprootCommit,
} from './helpers.js';

/**
 * Malformed-bundle fuzz for verifyProofBundle, seeded and reproducible.
 *
 * The security property is ATTESTATION INVARIANCE, not "every mutation
 * throws": a mutation must either be rejected, or leave the returned
 * attestation (level, id, header hash, reveal txid, envelope index, content
 * hash) byte-identical to the baseline. A mutation that silently changes what
 * is attested is a P0 verifier bug.
 *
 * Deliberate exclusions, by design:
 *  - block.height is NOT integrity-bound by the bundle; it is anchored by the
 *    caller's trustHeader (checkpoints / multi-source agreement) — locked by
 *    its own test below.
 *  - At L2, witness bytes outside the tapscript+control block (e.g. the
 *    signature element) are NOT bound — that is the documented L2 gap that L3
 *    closes; the sig-flip pair below pins both sides of it.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const SEED = 0xb0bb1e;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: () => number, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: () => number, xs: T[]): T => xs[randInt(rng, xs.length)];

// ---------- baselines: real vendored bundles + one synthetic L3 ----------

function insc0Bundle(): ProofBundleJson {
  const dir = join(FIXTURES, 'insc0');
  const read = (f: string) => readFileSync(join(dir, f), 'utf8').trim();
  const proof = JSON.parse(read('merkle-proof.json'));
  return {
    version: 1,
    inscriptionId: '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0',
    level: 'L2',
    block: {
      height: 767430,
      hash: '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5',
      header: read('header-767430.hex'),
      txCount: 2332,
    },
    reveal: { hex: read('reveal.hex'), pos: proof.pos, txidBranch: proof.merkle },
    commit: { hex: read('commit.hex') },
  };
}

function extendedBundles(): ProofBundleJson[] {
  const ext = join(FIXTURES, 'extended');
  return readdirSync(ext)
    .filter((f) => f.endsWith('.bundle.json'))
    .map((f) => JSON.parse(readFileSync(join(ext, f), 'utf8')));
}

function syntheticL3(): { bundle: ProofBundleJson; revealRaw: Uint8Array } {
  const script = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['fuzz me'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  const block = buildBlock([reveal]);
  return { bundle: l3Bundle(block, 1, `${reveal.txid}i0`), revealRaw: reveal.raw };
}

function attestation(v: VerifiedInscription): string {
  return [
    v.level,
    v.inscriptionId,
    v.header.hash,
    v.revealTx.txid,
    v.inscription.index,
    v.inscription.contentType ?? '',
    v.inscription.body ? bytesToHex(sha256(v.inscription.body)) : 'ABSENT',
  ].join('|');
}

// ---------- path utilities over the bundle JSON ----------

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}
function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
  (target as Record<string, unknown>)[last] = value;
}
function deletePath(obj: unknown, path: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
  if (target) delete (target as Record<string, unknown>)[last];
}

const HEX_PATHS = ['block.header', 'block.hash', 'reveal.hex', 'commit.hex', 'witness.coinbaseHex'];
const BRANCH_PATHS = ['reveal.txidBranch', 'witness.coinbaseTxidBranch', 'witness.wtxidBranch'];
const REQUIRED_PATHS = [
  'version',
  'inscriptionId',
  'level',
  'block',
  'block.header',
  'block.hash',
  'block.txCount',
  'reveal',
  'reveal.hex',
  'reveal.pos',
  'reveal.txidBranch',
];

const HEX_ALPHABET = '0123456789abcdef';

type Mutator = (bundle: ProofBundleJson, rng: () => number) => string | undefined;

/** each mutator edits the (cloned) bundle in place and describes itself; undefined = not applicable */
const MUTATORS: Mutator[] = [
  function flipHexNibble(bundle, rng) {
    const paths = HEX_PATHS.filter((p) => typeof getPath(bundle, p) === 'string');
    const path = pick(rng, paths);
    const hex = getPath(bundle, path) as string;
    if (hex.length === 0) return undefined;
    const at = randInt(rng, hex.length);
    const replacement = pick(rng, [...HEX_ALPHABET].filter((c) => c !== hex[at].toLowerCase()));
    setPath(bundle, path, hex.slice(0, at) + replacement + hex.slice(at + 1));
    return `flip nibble ${at} of ${path}`;
  },
  function truncateHex(bundle, rng) {
    const paths = HEX_PATHS.filter((p) => typeof getPath(bundle, p) === 'string');
    const path = pick(rng, paths);
    const hex = getPath(bundle, path) as string;
    const cut = randInt(rng, 8) + 1;
    setPath(bundle, path, hex.slice(0, Math.max(0, hex.length - cut)));
    return `truncate ${path} by ${cut}`;
  },
  function branchTamper(bundle, rng) {
    const paths = BRANCH_PATHS.filter((p) => Array.isArray(getPath(bundle, p)));
    if (paths.length === 0) return undefined;
    const path = pick(rng, paths);
    const branch = [...(getPath(bundle, path) as string[])];
    const op = randInt(rng, 4);
    if (op === 0 && branch.length > 0) branch.pop();
    else if (op === 1 && branch.length > 0) branch.push(branch[branch.length - 1]);
    else if (op === 2 && branch.length > 1) branch.reverse();
    else if (branch.length > 0) {
      const el = randInt(rng, branch.length);
      const at = randInt(rng, branch[el].length);
      const replacement = pick(rng, [...HEX_ALPHABET].filter((c) => c !== branch[el][at].toLowerCase()));
      branch[el] = branch[el].slice(0, at) + replacement + branch[el].slice(at + 1);
    } else return undefined;
    setPath(bundle, path, branch);
    return `tamper ${path} (op ${op})`;
  },
  function txCountTamper(bundle, rng) {
    const original = bundle.block.txCount;
    const candidate = pick(rng, [0, 1, -5, original - 1, original + 1, original * 2, 2 ** 31]);
    if (candidate === original) return undefined;
    bundle.block.txCount = candidate;
    return `txCount ${original} -> ${candidate}`;
  },
  function posTamper(bundle, rng) {
    const original = bundle.reveal.pos;
    const candidate = pick(rng, [0, original + 1, Math.max(0, original - 1), bundle.block.txCount - 1]);
    if (candidate === original) return undefined;
    bundle.reveal.pos = candidate;
    return `pos ${original} -> ${candidate}`;
  },
  function idTxidTamper(bundle, rng) {
    // NOTE: only the txid half — changing the INDEX changes which envelope is
    // being asked about, which is a different (legitimate) question; that
    // re-addressing behavior is pinned by its own test below.
    const id = bundle.inscriptionId;
    const at = randInt(rng, 64);
    const replacement = pick(rng, [...HEX_ALPHABET].filter((c) => c !== id[at].toLowerCase()));
    bundle.inscriptionId = id.slice(0, at) + replacement + id.slice(at + 1);
    return `id txid nibble flip`;
  },
  function levelSwap(bundle) {
    bundle.level = bundle.level === 'L2' ? 'L3' : 'L2';
    return `level swap to ${bundle.level}`;
  },
  function keyDelete(bundle, rng) {
    const present = REQUIRED_PATHS.concat(
      bundle.level === 'L2' ? ['commit'] : ['witness', 'witness.coinbaseHex', 'witness.wtxidBranch'],
    ).filter((p) => getPath(bundle, p) !== undefined);
    const path = pick(rng, present);
    deletePath(bundle, path);
    return `delete ${path}`;
  },
  function typeSwap(bundle, rng) {
    const path = pick(
      rng,
      REQUIRED_PATHS.filter((p) => getPath(bundle, p) !== undefined),
    );
    setPath(bundle, path, pick(rng, [12345, null, {}, ['x'], true] as unknown[]));
    return `type-swap ${path}`;
  },
];

describe('verifyProofBundle malformed-bundle fuzz (seeded, reproducible)', () => {
  const synthetic = syntheticL3();
  const baselines: ProofBundleJson[] = [insc0Bundle(), ...extendedBundles(), synthetic.bundle];

  it('all baselines verify (fuzz preconditions)', () => {
    for (const bundle of baselines) expect(() => verifyProofBundle(bundle)).not.toThrow();
    expect(baselines.length).toBeGreaterThanOrEqual(9);
  });

  it('no mutation ever changes the attestation without being rejected', () => {
    const rng = mulberry32(SEED);
    let thrown = 0;
    let applied = 0;
    for (const baseline of baselines) {
      const expected = attestation(verifyProofBundle(baseline));
      for (const mutator of MUTATORS) {
        for (let variant = 0; variant < 8; variant++) {
          const clone = structuredClone(baseline);
          const desc = mutator(clone, rng);
          if (!desc) continue;
          applied++;
          let result: VerifiedInscription | undefined;
          try {
            result = verifyProofBundle(clone);
          } catch {
            thrown++;
            continue;
          }
          expect(attestation(result), `${baseline.inscriptionId}: ${desc} changed the attestation silently`).toBe(expected);
        }
      }
    }
    expect(applied).toBeGreaterThan(500);
    // tripwire: the mutators must actually be destructive most of the time
    expect(thrown / applied).toBeGreaterThan(0.9);
  });

  it('cross-bundle splices are rejected', () => {
    const rng = mulberry32(SEED ^ 0x5);
    const l2s = baselines.filter((b) => b.level === 'L2');
    for (let i = 0; i < 20; i++) {
      const a = pick(rng, l2s);
      const b = pick(rng, l2s);
      if (a.inscriptionId === b.inscriptionId) continue;
      const spliced = structuredClone(a);
      spliced.block = structuredClone(b.block);
      expect(() => verifyProofBundle(spliced), `block of ${b.inscriptionId} into ${a.inscriptionId}`).toThrow();
    }
  });

  it('non-bundle garbage always throws', () => {
    const garbage: unknown[] = [null, undefined, 0, 42, 'bundle', [], {}, { version: 1 }, { version: 2 }, () => {}];
    for (const g of garbage) {
      expect(() => verifyProofBundle(g as ProofBundleJson)).toThrow();
    }
  });

  it('changing the id INDEX re-addresses honestly: attests that envelope or throws', () => {
    // the multi-envelope vendored bundle (23 envelopes in the reveal tx)
    const base = baselines.find((b) => b.inscriptionId.endsWith('012500bi1'))!;
    const reveal = parseTx(hexToBytes(base.reveal.hex));
    const all = verifyProofBundle(base).allInscriptions;
    for (const index of [0, 2, 22, 23, 1000]) {
      const clone = structuredClone(base);
      clone.inscriptionId = `${clone.inscriptionId.slice(0, 64)}i${index}`;
      const expected = all.find((i) => i.index === index);
      if (!expected) {
        expect(() => verifyProofBundle(clone), `i${index} absent`).toThrow(/not present/);
        continue;
      }
      const result = verifyProofBundle(clone);
      expect(result.inscription.index).toBe(index);
      expect(result.revealTx.txid).toBe(reveal.txid);
      expect(bytesToHex(result.inscription.body ?? new Uint8Array(0))).toBe(
        bytesToHex(expected.body ?? new Uint8Array(0)),
      );
    }
  });

  it('height is NOT integrity-bound (trustHeader owns it) — attestation is unchanged', () => {
    const bundle = structuredClone(insc0Bundle());
    const expected = attestation(verifyProofBundle(bundle));
    bundle.block.height = 999999;
    const result = verifyProofBundle(bundle);
    expect(attestation(result)).toBe(expected);
    expect(result.height).toBe(999999); // caller-visible, checkpoint check would reject it
  });

  it('L2 does not bind the signature witness element; L3 does (the documented gap)', () => {
    // flip a bit inside input 0's signature (witness[0]) — txid unchanged
    const flipSig = (revealHex: string): string => {
      const tx = parseTx(hexToBytes(revealHex));
      const witness = tx.inputs[0].witness.map((w) => Uint8Array.from(w));
      witness[0][witness[0].length - 1] ^= 0x01;
      return bytesToHex(
        serializeFull({
          version: tx.version,
          inputs: tx.inputs.map((input, i) => ({ ...input, witness: i === 0 ? witness : input.witness })),
          outputs: tx.outputs,
          locktime: tx.locktime,
        }),
      );
    };

    // L2: verifies, attestation identical (content untouched — known, documented gap)
    const l2 = structuredClone(insc0Bundle());
    const expected = attestation(verifyProofBundle(l2));
    l2.reveal.hex = flipSig(l2.reveal.hex);
    expect(attestation(verifyProofBundle(l2))).toBe(expected);

    // L3: the same flip must be rejected by the witness commitment
    const { bundle } = syntheticL3();
    const l3 = structuredClone(bundle);
    l3.reveal.hex = flipSig(l3.reveal.hex);
    expect(() => verifyProofBundle(l3)).toThrow(/witness commitment/);
  });
});
