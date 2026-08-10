/**
 * Property tests for the merkle core: packages/core/src/merkle.ts
 *
 * Four properties, each stated as something that must hold for ALL trees rather
 * than for a fixture:
 *
 *   1. BINDING          a branch built for leaf A never verifies leaf B
 *   2. BRANCH DEPTH     a branch whose length != ceil(log2(txCount)) is rejected
 *   3. ODD-LEVEL DUP    at an odd-width level the sibling must be the node itself
 *                       (CWE behind CVE-2012-2459: two distinct trees, one root)
 *   4. INDEX BOUNDS     an index outside [0, txCount) is rejected, and the
 *                       index bits must be fully consumed by the branch
 */

import { describe, it, expect } from 'vitest';
import {
  computeMerkleRoot,
  verifyMerkleBranch,
  buildMerkleBranch,
  treeHeight,
  bytesEqual,
} from '@ordspv/core';
import {
  rng, randInt, distinctLeaves, expectedHeight, forEachTreeSize,
  TREE_SIZES, mutateOne, rejects,
} from './gen.js';

describe('merkle: binding', () => {
  it('a branch built for one leaf never verifies a different leaf', () => {
    forEachTreeSize(TREE_SIZES.filter((n) => n >= 2), (size, seed) => {
      const r = rng(seed);
      const leaves = distinctLeaves(r, size);
      const root = computeMerkleRoot(leaves);

      // A handful of positions per tree, always including the ends.
      const positions = new Set<number>([0, size - 1, randInt(r, 0, size - 1)]);
      for (const pos of positions) {
        const branch = buildMerkleBranch(leaves, pos);

        // the honest case must verify, or the property below proves nothing
        const ok = verifyMerkleBranch(leaves[pos], branch, pos, size);
        expect(bytesEqual(ok.root, root), `honest branch at pos ${pos} must reproduce the root`).toBe(true);

        // Every OTHER leaf, through the same branch and position, must fail.
        // "Fail" is either a throw or a different root, and both mean the leaf did
        // not verify. Only reproducing the true root would break binding.
        for (let other = 0; other < size; other++) {
          if (other === pos) continue;
          let reproduced = false;
          try {
            reproduced = bytesEqual(verifyMerkleBranch(leaves[other], branch, pos, size).root, root);
          } catch {
            reproduced = false;
          }
          expect(
            reproduced,
            `leaf ${other} verified through the branch built for leaf ${pos}`,
          ).toBe(false);
        }
      }
    });
  });

  it('a branch with any sibling mutated does not reproduce the root', () => {
    forEachTreeSize(TREE_SIZES.filter((n) => n >= 4), (size, seed) => {
      const r = rng(seed);
      const leaves = distinctLeaves(r, size);
      const root = computeMerkleRoot(leaves);
      const pos = randInt(r, 0, size - 1);
      const branch = buildMerkleBranch(leaves, pos);

      for (let i = 0; i < branch.length; i++) {
        const tampered = branch.slice();
        tampered[i] = mutateOne(r, tampered[i]);
        let reproduced = false;
        try {
          reproduced = bytesEqual(verifyMerkleBranch(leaves[pos], tampered, pos, size).root, root);
        } catch {
          reproduced = false;
        }
        expect(reproduced, `mutating sibling ${i} still reproduced the root`).toBe(false);
      }
    });
  });
});

describe('merkle: branch depth', () => {
  it('treeHeight equals ceil(log2(txCount)) for every size', () => {
    for (const n of TREE_SIZES) {
      expect(treeHeight(n), `treeHeight(${n})`).toBe(expectedHeight(n));
    }
  });

  it('a branch whose sibling count differs from the tree height is rejected', () => {
    forEachTreeSize(TREE_SIZES.filter((n) => n >= 2), (size, seed) => {
      const r = rng(seed);
      const leaves = distinctLeaves(r, size);
      const pos = randInt(r, 0, size - 1);
      const branch = buildMerkleBranch(leaves, pos);
      expect(branch.length, 'the honest branch is the tree height').toBe(expectedHeight(size));

      // one too short
      expect(
        rejects(() => verifyMerkleBranch(leaves[pos], branch.slice(0, -1), pos, size)),
        'a branch one sibling short must be rejected',
      ).toBe(true);

      // one too long
      const longer = [...branch, new Uint8Array(32)];
      expect(
        rejects(() => verifyMerkleBranch(leaves[pos], longer, pos, size)),
        'a branch one sibling too long must be rejected',
      ).toBe(true);

      // empty, for a tree that has real depth
      if (branch.length > 0) {
        expect(
          rejects(() => verifyMerkleBranch(leaves[pos], [], pos, size)),
          'an empty branch must be rejected for a tree of depth > 0',
        ).toBe(true);
      }
    });
  });
});

describe('merkle: odd-level duplication (CVE-2012-2459 class)', () => {
  it('at an odd-width level the proven path must self-pair, and any other sibling is rejected', () => {
    // Odd sizes put the last leaf on a self-paired node at level 0.
    forEachTreeSize(TREE_SIZES.filter((n) => n >= 3 && n % 2 === 1), (size, seed) => {
      const r = rng(seed);
      const leaves = distinctLeaves(r, size);
      const pos = size - 1;                       // the self-paired final node
      const branch = buildMerkleBranch(leaves, pos);

      expect(
        bytesEqual(branch[0], leaves[pos]),
        'the honest branch self-pairs the final node of an odd level',
      ).toBe(true);

      // Supplying anything else as that sibling must be rejected outright.
      const forged = branch.slice();
      forged[0] = mutateOne(r, leaves[pos]);
      expect(
        rejects(() => verifyMerkleBranch(leaves[pos], forged, pos, size)),
        'a sibling other than the duplicated node itself must be rejected',
      ).toBe(true);
    });
  });

  it('computeMerkleRoot refuses a level whose final two nodes are equal', () => {
    // The construction the CVE turns on: duplicate the last leaf so the tree
    // has an even width whose final pair is identical. Bitcoin Core rejects
    // this shape because it produces the same root as the odd tree without it.
    for (const size of [3, 5, 7, 9, 11]) {
      const r = rng(0xc0ffee + size);
      const leaves = distinctLeaves(r, size);
      const mutated = [...leaves, leaves[leaves.length - 1]];   // even, equal final pair

      expect(
        rejects(() => computeMerkleRoot(mutated)),
        `a tree of ${size} leaves with the last duplicated must be refused`,
      ).toBe(true);
    }
  });

  it('the duplicated-tail tree cannot be passed off as the honest tree', () => {
    // The full attack shape, end to end: honest tree of N leaves versus the
    // N+1-leaf tree with the tail duplicated. If both computed a root, they
    // would compute the SAME one, and a proof for one would verify the other.
    for (const size of [3, 5, 7, 9]) {
      const r = rng(0xbadbad + size);
      const leaves = distinctLeaves(r, size);
      const honestRoot = computeMerkleRoot(leaves);

      let mutatedRoot: Uint8Array | null = null;
      try {
        mutatedRoot = computeMerkleRoot([...leaves, leaves[leaves.length - 1]]);
      } catch {
        mutatedRoot = null;   // refused, which is the defence working
      }

      if (mutatedRoot !== null) {
        expect(
          bytesEqual(mutatedRoot, honestRoot),
          'two distinct leaf sets produced one root and neither was refused',
        ).toBe(false);
      }
    }
  });
});

describe('merkle: index bounds', () => {
  it('an index outside [0, txCount) is rejected', () => {
    forEachTreeSize(TREE_SIZES, (size, seed) => {
      const r = rng(seed);
      const leaves = distinctLeaves(r, size);
      const branch = buildMerkleBranch(leaves, 0);

      expect(rejects(() => verifyMerkleBranch(leaves[0], branch, size, size)),
             `pos == txCount (${size}) must be rejected`).toBe(true);
      expect(rejects(() => verifyMerkleBranch(leaves[0], branch, size + 1, size)),
             'pos > txCount must be rejected').toBe(true);
      expect(rejects(() => verifyMerkleBranch(leaves[0], branch, -1, size)),
             'a negative pos must be rejected').toBe(true);
      expect(rejects(() => verifyMerkleBranch(leaves[0], branch, 1.5, size)),
             'a non-integer pos must be rejected').toBe(true);
    });
  });

  it('the index bits are fully consumed by the branch', () => {
    // Without txCount there is no length check, so the only thing standing
    // between a caller and a silently-wrong answer is that the fold must end
    // with index === 0. A position carrying more bits than the branch has
    // levels must therefore be rejected even with no txCount supplied.
    forEachTreeSize(TREE_SIZES.filter((n) => n >= 4), (size, seed) => {
      const r = rng(seed);
      const leaves = distinctLeaves(r, size);
      const height = expectedHeight(size);
      const branch = buildMerkleBranch(leaves, 0);
      const tooManyBits = 1 << height;    // needs height+1 levels to reach 0

      expect(
        rejects(() => verifyMerkleBranch(leaves[0], branch, tooManyBits, undefined)),
        `pos ${tooManyBits} has more index bits than a ${height}-level branch consumes`,
      ).toBe(true);
    });
  });

  it('treeHeight rejects a non-positive leaf count', () => {
    expect(rejects(() => treeHeight(0)), 'treeHeight(0)').toBe(true);
    expect(rejects(() => treeHeight(-1)), 'treeHeight(-1)').toBe(true);
  });

  it('computeMerkleRoot rejects an empty leaf set', () => {
    expect(rejects(() => computeMerkleRoot([])), 'computeMerkleRoot([])').toBe(true);
  });
});
