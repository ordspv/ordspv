import { secp256k1 } from '@noble/curves/secp256k1.js';
import { beBytesToBigInt, bytesEqual, ByteWriter, concatBytes } from './bytes.js';
import { taggedHash } from './hash.js';

/**
 * BIP-341 script-path commitment verification.
 *
 * Given a tapscript, its control block (both from a reveal input's witness),
 * and the scriptPubKey of the output being spent (from the commit tx, which is
 * txid-committed data), verify that the script is committed by the taproot
 * output key. This binds envelope bytes to the commit output without needing
 * the block's wtxid tree; see the verification spec for exactly what this
 * does and does not prove (L2 vs L3).
 */

const TAPROOT_ANNEX_PREFIX = 0x50;
const N = secp256k1.Point.Fn.ORDER; // curve order

export interface ControlBlock {
  leafVersion: number;
  /** parity of the output key's y coordinate (0 = even, 1 = odd) */
  outputKeyParity: number;
  /** 32-byte x-only internal key */
  internalKey: Uint8Array;
  /** merkle path, sequence of 32-byte node hashes */
  path: Uint8Array[];
}

export function parseControlBlock(bytes: Uint8Array): ControlBlock {
  if (bytes.length < 33 || (bytes.length - 33) % 32 !== 0) {
    throw new Error(`invalid control block length ${bytes.length}`);
  }
  const depth = (bytes.length - 33) / 32;
  if (depth > 128) throw new Error('control block merkle path too deep');
  const path: Uint8Array[] = [];
  for (let i = 0; i < depth; i++) {
    path.push(bytes.slice(33 + i * 32, 33 + (i + 1) * 32));
  }
  return {
    leafVersion: bytes[0] & 0xfe,
    outputKeyParity: bytes[0] & 0x01,
    internalKey: bytes.slice(1, 33),
    path,
  };
}

/** hash_TapLeaf(leaf_version || compact_size(script) || script) */
export function tapLeafHash(script: Uint8Array, leafVersion = 0xc0): Uint8Array {
  const w = new ByteWriter();
  w.writeU8(leafVersion);
  w.writeVarInt(script.length);
  w.writeBytes(script);
  return taggedHash('TapLeaf', w.toBytes());
}

function tapBranch(a: Uint8Array, b: Uint8Array): Uint8Array {
  // lexicographic ordering of the pair
  let swap = false;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) {
      swap = a[i] > b[i];
      break;
    }
  }
  return swap ? taggedHash('TapBranch', concatBytes(b, a)) : taggedHash('TapBranch', concatBytes(a, b));
}

/** Fold a TapLeaf hash up the path to the taproot merkle root. */
export function tapMerkleRoot(leafHash: Uint8Array, path: Uint8Array[]): Uint8Array {
  let k = leafHash;
  for (const node of path) k = tapBranch(k, node);
  return k;
}

export interface ScriptPathCheck {
  /** x-only output key from the scriptPubKey */
  outputKey: Uint8Array;
  leafHash: Uint8Array;
  merkleRoot: Uint8Array;
}

/** True if spk is a P2TR output (OP_1 <32 bytes>). */
export function isP2TR(spk: Uint8Array): boolean {
  return spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
}

/**
 * Verify Q == P + hash_TapTweak(P || merkle_root)·G and the output-key parity
 * bit. Throws with a reason on failure; returns derived hashes on success.
 */
export function verifyScriptPathCommitment(args: {
  script: Uint8Array;
  controlBlock: Uint8Array | ControlBlock;
  /** scriptPubKey of the spent (commit) output; must be P2TR */
  scriptPubKey: Uint8Array;
}): ScriptPathCheck {
  const { script, scriptPubKey } = args;
  if (!isP2TR(scriptPubKey)) throw new Error('spent output is not P2TR');
  const outputKey = scriptPubKey.slice(2, 34);

  const cb =
    args.controlBlock instanceof Uint8Array ? parseControlBlock(args.controlBlock) : args.controlBlock;

  const leafHash = tapLeafHash(script, cb.leafVersion);
  const merkleRoot = tapMerkleRoot(leafHash, cb.path);

  const tweak = beBytesToBigInt(taggedHash('TapTweak', concatBytes(cb.internalKey, merkleRoot)));
  if (tweak >= N) throw new Error('tap tweak >= curve order');

  // lift_x(internalKey): x-only key is implicitly even-y
  let P;
  try {
    P = secp256k1.Point.fromBytes(concatBytes(new Uint8Array([0x02]), cb.internalKey));
  } catch {
    throw new Error('internal key is not a valid x-only point');
  }
  const Q = P.add(secp256k1.Point.BASE.multiply(tweak));
  if (Q.is0()) throw new Error('derived output key is point at infinity');

  const qBytes = Q.toBytes(true); // compressed: 0x02/0x03 || x
  const parity = qBytes[0] === 0x03 ? 1 : 0;
  if (!bytesEqual(qBytes.slice(1), outputKey)) {
    throw new Error('taproot commitment mismatch: derived output key != scriptPubKey key');
  }
  if (parity !== cb.outputKeyParity) {
    throw new Error('taproot commitment mismatch: output key parity');
  }
  return { outputKey, leafHash, merkleRoot };
}

/**
 * Extract {script, controlBlock} from a taproot script-path witness stack,
 * ignoring any annex (last item starting 0x50 when >1 items, per BIP-341).
 * Returns undefined for key-path spends (single-element stack).
 */
export function extractTapscript(
  witness: Uint8Array[],
): { script: Uint8Array; controlBlock: Uint8Array } | undefined {
  let stack = witness;
  if (stack.length >= 2 && stack[stack.length - 1].length > 0 && stack[stack.length - 1][0] === TAPROOT_ANNEX_PREFIX) {
    stack = stack.slice(0, -1);
  }
  if (stack.length < 2) return undefined;
  return {
    script: stack[stack.length - 2],
    controlBlock: stack[stack.length - 1],
  };
}
