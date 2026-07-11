import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  bytesToHex,
  buildMerkleBranch,
  computeMerkleRoot,
  computeWitnessCommitment,
  computeWitnessRootFromWtxids,
  concatBytes,
  hexToBytes,
  internalToDisplay,
  parseTx,
  serializeFull,
  sha256,
  tapLeafHash,
  tapMerkleRoot,
  checkProofOfWork,
  parseHeader,
  ZERO32,
  type ParsedTx,
  type ProofBundleJson,
} from '../src/index.js';

/** minimal push encoding */
export function push(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (bytes.length === 0) return new Uint8Array([0x00]);
  if (bytes.length <= 75) return concatBytes(new Uint8Array([bytes.length]), bytes);
  if (bytes.length <= 0xff) return concatBytes(new Uint8Array([0x4c, bytes.length]), bytes);
  if (bytes.length <= 0xffff)
    return concatBytes(new Uint8Array([0x4d, bytes.length & 0xff, bytes.length >> 8]), bytes);
  throw new Error('push too large for test helper');
}

/** assemble a script from opcodes (numbers) and pushes (bytes/strings) */
export function script(...items: (number | Uint8Array | string)[]): Uint8Array {
  return concatBytes(
    ...items.map((item) => (typeof item === 'number' ? new Uint8Array([item]) : push(item))),
  );
}

export interface EnvelopeSpec {
  fields?: [number | Uint8Array, Uint8Array | string][];
  body?: (Uint8Array | string)[];
}

/** standard envelope script: OP_FALSE OP_IF "ord" fields [OP_0 body...] OP_ENDIF */
export function envelopeScript(spec: EnvelopeSpec, extra: { checksigPrefix?: boolean } = {}): Uint8Array {
  const parts: (number | Uint8Array | string)[] = [];
  if (extra.checksigPrefix) {
    // realistic reveal scripts start <pubkey> OP_CHECKSIG
    parts.push(sha256(new TextEncoder().encode('key')), 0xac);
  }
  parts.push(0x00, 0x63, 'ord');
  for (const [tag, value] of spec.fields ?? []) {
    parts.push(typeof tag === 'number' ? new Uint8Array([tag]) : tag);
    parts.push(typeof value === 'string' ? value : value);
  }
  if (spec.body) {
    parts.push(new Uint8Array(0));
    for (const chunk of spec.body) parts.push(chunk);
  }
  parts.push(0x68);
  return script(...parts);
}

let txSeed = 0;

/** a unique dummy segwit tx (not a reveal) */
export function dummyTx(): ParsedTx {
  txSeed++;
  const prev = sha256(new TextEncoder().encode(`prev${txSeed}`));
  const raw = serializeFull({
    version: 2,
    inputs: [
      {
        prevTxidLE: prev,
        prevTxid: internalToDisplay(prev),
        vout: 0,
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
        witness: [sha256(new TextEncoder().encode(`wit${txSeed}`))],
      },
    ],
    outputs: [{ value: 1000n, scriptPubKey: new Uint8Array([0x51]) }],
    locktime: 0,
  });
  return parseTx(raw);
}

/** a reveal-style tx: one input per script, witness [sig, script, controlBlock] */
export function revealTx(
  tapscripts: { script: Uint8Array; controlBlock: Uint8Array }[],
  spend?: { prevTxidLE: Uint8Array; vout: number },
): ParsedTx {
  txSeed++;
  const raw = serializeFull({
    version: 1,
    inputs: tapscripts.map((ts, i) => {
      const prev = spend && i === 0 ? spend.prevTxidLE : sha256(new TextEncoder().encode(`rprev${txSeed}-${i}`));
      return {
        prevTxidLE: prev,
        prevTxid: internalToDisplay(prev),
        vout: spend && i === 0 ? spend.vout : 0,
        scriptSig: new Uint8Array(0),
        sequence: 0xfffffffd,
        witness: [new Uint8Array(64).fill(7), ts.script, ts.controlBlock],
      };
    }),
    outputs: [{ value: 546n, scriptPubKey: new Uint8Array([0x51]) }],
    locktime: 0,
  });
  return parseTx(raw);
}

export const DUMMY_CONTROL_BLOCK = concatBytes(new Uint8Array([0xc0]), sha256(new Uint8Array([1])));

/**
 * Real BIP-341 commit: derive the P2TR scriptPubKey committing to `leafScript`
 * (internal key = G), optionally with sibling leaf hashes in the tree path.
 */
export function taprootCommit(
  leafScript: Uint8Array,
  path: Uint8Array[] = [],
): { scriptPubKey: Uint8Array; controlBlock: Uint8Array } {
  const px = secp256k1.Point.BASE.toBytes(true).slice(1); // G.x, even y
  const leaf = tapLeafHash(leafScript, 0xc0);
  const root = tapMerkleRoot(leaf, path);
  const tweakHash = tapTweakBigInt(px, root);
  const Q = secp256k1.Point.BASE.add(secp256k1.Point.BASE.multiply(tweakHash));
  const qBytes = Q.toBytes(true);
  const parity = qBytes[0] === 0x03 ? 1 : 0;
  return {
    scriptPubKey: concatBytes(new Uint8Array([0x51, 0x20]), qBytes.slice(1)),
    controlBlock: concatBytes(new Uint8Array([0xc0 | parity]), px, ...path),
  };
}

function tapTweakBigInt(px: Uint8Array, root: Uint8Array): bigint {
  // matches taggedHash('TapTweak', px || root) interpreted BE
  const th = sha256(new TextEncoder().encode('TapTweak'));
  const digest = sha256(concatBytes(th, th, px, root));
  let v = 0n;
  for (const b of digest) v = (v << 8n) | BigInt(b);
  return v;
}

/** a plausible commit tx paying to the given taproot output */
export function commitTx(scriptPubKey: Uint8Array): ParsedTx {
  txSeed++;
  const prev = sha256(new TextEncoder().encode(`cprev${txSeed}`));
  const raw = serializeFull({
    version: 2,
    inputs: [
      {
        prevTxidLE: prev,
        prevTxid: internalToDisplay(prev),
        vout: 1,
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
        witness: [new Uint8Array(64).fill(9)],
      },
    ],
    outputs: [{ value: 10_000n, scriptPubKey }],
    locktime: 0,
  });
  return parseTx(raw);
}

export interface TestBlock {
  headerHex: string;
  blockHash: string;
  txs: ParsedTx[];
  txCount: number;
  txidBranch(pos: number): string[];
  wtxidBranch(pos: number): string[];
}

/** Build a consensus-shaped block: coinbase with witness commitment + mined header. */
export function buildBlock(nonCoinbaseTxs: ParsedTx[]): TestBlock {
  const reserved = sha256(new TextEncoder().encode('reserved'));
  const wtxids = [ZERO32, ...nonCoinbaseTxs.map((t) => t.wtxidLE)];
  const witnessRoot = computeWitnessRootFromWtxids(wtxids);
  const commitment = computeWitnessCommitment(witnessRoot, reserved);

  const coinbaseRaw = serializeFull({
    version: 1,
    inputs: [
      {
        prevTxidLE: new Uint8Array(32),
        prevTxid: '0'.repeat(64),
        vout: 0xffffffff,
        scriptSig: new Uint8Array([0x03, 0x01, 0x02, 0x03]),
        sequence: 0xffffffff,
        witness: [reserved],
      },
    ],
    outputs: [
      { value: 312_500_000n, scriptPubKey: new Uint8Array([0x51]) },
      { value: 0n, scriptPubKey: concatBytes(hexToBytes('6a24aa21a9ed'), commitment) },
    ],
    locktime: 0,
  });
  const coinbase = parseTx(coinbaseRaw);
  const txs = [coinbase, ...nonCoinbaseTxs];
  const txids = txs.map((t) => t.txidLE);
  const txidRoot = computeMerkleRoot(txids);

  // mine a regtest-difficulty header
  const bits = 0x207fffff;
  let headerBytes: Uint8Array | undefined;
  for (let nonce = 0; nonce < 100_000; nonce++) {
    const h = new Uint8Array(80);
    const view = new DataView(h.buffer);
    view.setInt32(0, 4, true);
    // prev block: zeros
    h.set(txidRoot, 36);
    view.setUint32(68, 1_700_000_000, true);
    view.setUint32(72, bits, true);
    view.setUint32(76, nonce, true);
    if (checkProofOfWork(parseHeader(h))) {
      headerBytes = h;
      break;
    }
  }
  if (!headerBytes) throw new Error('failed to mine test header');
  const header = parseHeader(headerBytes);

  const wtxidLeaves = wtxids;
  return {
    headerHex: bytesToHex(headerBytes),
    blockHash: header.hash,
    txs,
    txCount: txs.length,
    txidBranch: (pos: number) => buildMerkleBranch(txids, pos).map(internalToDisplay),
    wtxidBranch: (pos: number) => buildMerkleBranch(wtxidLeaves, pos).map(internalToDisplay),
  };
}

/** Assemble an L3 bundle for the reveal at `pos` in `block`. */
export function l3Bundle(block: TestBlock, pos: number, inscriptionId: string): ProofBundleJson {
  return {
    version: 1,
    inscriptionId,
    level: 'L3',
    block: { height: 100, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
    reveal: {
      hex: bytesToHex(block.txs[pos].raw),
      pos,
      txidBranch: block.txidBranch(pos),
    },
    witness: {
      coinbaseHex: bytesToHex(block.txs[0].raw),
      coinbaseTxidBranch: block.txidBranch(0),
      wtxidBranch: block.wtxidBranch(pos),
    },
  };
}
