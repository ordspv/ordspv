import { bytesEqual, concatBytes } from './bytes.js';
import { sha256d } from './hash.js';

/**
 * Bitcoin merkle trees (both the txid tree committed in the header and the
 * wtxid tree committed by the BIP-141 coinbase witness commitment).
 * All hashes here are in INTERNAL byte order.
 *
 * Security notes implemented here:
 * - CVE-2012-2459 (duplicate-node mutation): when building from a full leaf
 *   set we reject levels whose final two nodes are identical, mirroring
 *   Bitcoin Core's mutation check.
 * - Branch verification accepts an optional `txCount`; when provided, the
 *   branch length must match the tree height exactly and the position must be
 *   in range, which pins the leaf to a unique position in a uniquely-shaped
 *   tree. Callers should provide it whenever available.
 * - 64-byte "transactions" are ambiguous with inner nodes (leaf/node
 *   confusion); proof-bundle verification rejects them at a higher layer.
 */

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return sha256d(concatBytes(a, b));
}

/** Compute a merkle root from all leaves (internal byte order). */
export function computeMerkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error('cannot compute merkle root of zero leaves');
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      if (i + 1 < level.length && i + 2 >= level.length && bytesEqual(left, right)) {
        // Mirrors Core's CVE-2012-2459 mutation detection.
        throw new Error('duplicate final nodes in merkle level (mutated tree)');
      }
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0];
}

export interface MerkleBranchCheck {
  /** computed root, internal byte order */
  root: Uint8Array;
}

/**
 * Fold a merkle branch from a leaf up to the root.
 * @param leaf leaf hash, internal byte order
 * @param branch sibling hashes bottom-up, internal byte order
 * @param pos 0-based index of the leaf in the tree
 * @param txCount total leaf count, if known (strongly recommended)
 */
export function verifyMerkleBranch(
  leaf: Uint8Array,
  branch: Uint8Array[],
  pos: number,
  txCount?: number,
): MerkleBranchCheck {
  if (pos < 0 || !Number.isInteger(pos)) throw new Error('invalid merkle position');
  if (txCount !== undefined) {
    if (pos >= txCount) throw new Error(`merkle position ${pos} out of range for ${txCount} txs`);
    const expectedHeight = treeHeight(txCount);
    if (branch.length !== expectedHeight) {
      throw new Error(`merkle branch length ${branch.length} != expected height ${expectedHeight}`);
    }
  }
  let node = leaf;
  let index = pos;
  let width = txCount;
  for (let i = 0; i < branch.length; i++) {
    const sibling = branch[i];
    if (width !== undefined) {
      const isLastOdd = index === width - 1 && width % 2 === 1;
      if (isLastOdd && !bytesEqual(sibling, node)) {
        throw new Error(`merkle level ${i}: expected self-paired final node`);
      }
      if (!isLastOdd && bytesEqual(sibling, node) && index % 2 === 0 && index + 1 === width - 1) {
        // right sibling identical to node at the tree edge: mutated-tree shape
        throw new Error(`merkle level ${i}: duplicate sibling (possible mutation)`);
      }
      width = Math.ceil(width / 2);
    }
    node = index % 2 === 1 ? hashPair(sibling, node) : hashPair(node, sibling);
    index = Math.floor(index / 2);
  }
  if (index !== 0) throw new Error('merkle position exceeds branch length');
  return { root: node };
}

export function treeHeight(leafCount: number): number {
  if (leafCount <= 0) throw new Error('invalid leaf count');
  let height = 0;
  let width = leafCount;
  while (width > 1) {
    width = Math.ceil(width / 2);
    height++;
  }
  return height;
}

/** Build the sibling branch for leaf at `pos` from the full leaf set. */
export function buildMerkleBranch(leaves: Uint8Array[], pos: number): Uint8Array[] {
  if (pos < 0 || pos >= leaves.length) throw new Error('position out of range');
  const branch: Uint8Array[] = [];
  let level = leaves.slice();
  let index = pos;
  while (level.length > 1) {
    const siblingIndex = index % 2 === 1 ? index - 1 : index + 1;
    branch.push(siblingIndex < level.length ? level[siblingIndex] : level[index]);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(left, right));
    }
    level = next;
    index = Math.floor(index / 2);
  }
  return branch;
}
