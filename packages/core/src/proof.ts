import { bytesEqual, displayToInternal, hexToBytes } from './bytes.js';
import { inscriptionsFromTx, type Inscription } from './envelope.js';
import { parseHeader, checkProofOfWork, type BlockHeader } from './header.js';
import { parseInscriptionId } from './inscriptionId.js';
import { treeHeight, verifyMerkleBranch } from './merkle.js';
import { extractTapscript, parseControlBlock, verifyScriptPathCommitment } from './taproot.js';
import { isCoinbase, parseTx, type ParsedTx } from './tx.js';
import {
  computeWitnessCommitment,
  findWitnessCommitment,
  witnessReservedValue,
  ZERO32,
} from './witnesscommit.js';

/**
 * Proof bundles: self-contained, backend-independent evidence that inscription
 * content is authentic, at one of the verification levels defined in
 * docs/spec/SPEC-VERIFICATION.md:
 *
 *  - L2 "tapscript commitment": header + txid-merkle proof of the reveal tx +
 *    commit tx + BIP-341 control-block check. All ingredients are served by
 *    any esplora/electrum instance. Proves the content was committed by the
 *    taptree of the output the reveal spent — with documented caveats
 *    (multi-leaf trees, executed-leaf ambiguity) surfaced as `assurances`.
 *
 *  - L3 "witness commitment": additionally binds the exact reveal witness via
 *    the BIP-141 coinbase witness commitment (txid-merkle proof of coinbase +
 *    wtxid-merkle proof of the reveal). Equivalent to what a full node
 *    enforces; closes the L2 caveats.
 *
 * Header trust is delegated to the caller via `trustHeader` — core stays pure.
 */

export type VerificationLevel = 'L1' | 'L2' | 'L3';

export interface ProofBundleJson {
  version: 1;
  inscriptionId: string;
  level: 'L2' | 'L3';
  block: {
    height: number;
    /** display-order hash the server claims; recomputed and checked */
    hash: string;
    /** 160 hex chars */
    header: string;
    /** total number of transactions in the block (required: CVE-2017-12842 hardening) */
    txCount: number;
  };
  reveal: {
    hex: string;
    /** 0-based position in the block's tx list */
    pos: number;
    /** txid-tree merkle branch, display-order hex, bottom-up */
    txidBranch: string[];
  };
  /** required for L2 (and harmless in L3): the tx whose output the reveal input spends */
  commit?: { hex: string };
  /** required for L3 */
  witness?: {
    coinbaseHex: string;
    /** coinbase txid-tree branch (position 0), display-order hex */
    coinbaseTxidBranch: string[];
    /** wtxid-tree branch for the reveal at reveal.pos, display-order hex */
    wtxidBranch: string[];
  };
}

export interface L2Assurances {
  /** control block merkle path depth; 0 means the taptree provably has a single leaf */
  controlBlockDepth: number;
  /** taptree provably contains only the shown script (depth 0) */
  singleLeafTree: boolean;
  /** reveal tx has one input, pinning envelope indices given the shown script */
  singleInputReveal: boolean;
}

export interface VerifiedInscription {
  level: 'L2' | 'L3';
  inscriptionId: string;
  inscription: Inscription;
  /** every inscription parsed from the reveal tx */
  allInscriptions: Inscription[];
  header: BlockHeader;
  height: number;
  revealTx: ParsedTx;
  l2?: L2Assurances;
}

export interface VerifyOptions {
  /**
   * Anchor the header to a trusted view of the chain (checkpoints, multi-source
   * tip cross-check, header sync...). Throw to reject. When omitted the caller
   * accepts embedded-PoW-only anchoring (NOT recommended for adversarial
   * settings — a single header's work is cheap relative to valuable content).
   */
  trustHeader?: (header: BlockHeader, height: number) => void;
}

function parseHexTx(hex: string, label: string): ParsedTx {
  let tx: ParsedTx;
  try {
    tx = parseTx(hexToBytes(hex.trim()));
  } catch (e) {
    throw new Error(`${label}: cannot parse transaction: ${(e as Error).message}`);
  }
  if (tx.raw.length === 64) throw new Error(`${label}: 64-byte transactions are rejected (leaf/node ambiguity)`);
  return tx;
}

/** Verify a proof bundle. Throws with a precise reason on any failure. */
export function verifyProofBundle(bundle: ProofBundleJson, opts: VerifyOptions = {}): VerifiedInscription {
  if (bundle.version !== 1) throw new Error(`unsupported proof bundle version ${(bundle as { version: unknown }).version}`);
  const id = parseInscriptionId(bundle.inscriptionId);

  // ---- header ----
  const header = parseHeader(hexToBytes(bundle.block.header));
  if (header.hash !== bundle.block.hash.toLowerCase()) {
    throw new Error(`header hashes to ${header.hash}, bundle claims ${bundle.block.hash}`);
  }
  if (!checkProofOfWork(header)) throw new Error('header fails proof of work');
  if (!Number.isInteger(bundle.block.txCount) || bundle.block.txCount < 1) {
    throw new Error('bundle missing valid txCount');
  }
  opts.trustHeader?.(header, bundle.block.height);

  // ---- reveal inclusion (txid tree) ----
  const reveal = parseHexTx(bundle.reveal.hex, 'reveal');
  if (reveal.txid !== id.txid) {
    throw new Error(`reveal tx hashes to ${reveal.txid}, inscription id says ${id.txid}`);
  }
  const txidBranch = bundle.reveal.txidBranch.map(displayToInternal);
  const expectedHeight = treeHeight(bundle.block.txCount);
  if (txidBranch.length !== expectedHeight) {
    throw new Error(`reveal txid branch depth ${txidBranch.length} != tree height ${expectedHeight}`);
  }
  const { root: txidRoot } = verifyMerkleBranch(reveal.txidLE, txidBranch, bundle.reveal.pos, bundle.block.txCount);
  if (!bytesEqual(txidRoot, header.merkleRootLE)) {
    throw new Error('reveal txid merkle proof does not match header merkle root');
  }

  // ---- envelope ----
  const allInscriptions = inscriptionsFromTx(reveal);
  const inscription = allInscriptions.find((i) => i.index === id.index);
  if (!inscription) {
    throw new Error(`reveal tx contains ${allInscriptions.length} envelope(s); index ${id.index} not present`);
  }

  if (bundle.level === 'L2') {
    if (!bundle.commit) throw new Error('L2 bundle missing commit tx');
    const commit = parseHexTx(bundle.commit.hex, 'commit');
    const input = reveal.inputs[inscription.input];
    if (commit.txid !== input.prevTxid) {
      throw new Error(`commit tx hashes to ${commit.txid}, reveal input spends ${input.prevTxid}`);
    }
    const spent = commit.outputs[input.vout];
    if (!spent) throw new Error(`commit tx has no output ${input.vout}`);
    const tapscript = extractTapscript(input.witness);
    if (!tapscript) throw new Error('reveal input witness is not a script-path spend');
    verifyScriptPathCommitment({
      script: tapscript.script,
      controlBlock: tapscript.controlBlock,
      scriptPubKey: spent.scriptPubKey,
    });
    const depth = parseControlBlock(tapscript.controlBlock).path.length;
    return {
      level: 'L2',
      inscriptionId: bundle.inscriptionId.toLowerCase(),
      inscription,
      allInscriptions,
      header,
      height: bundle.block.height,
      revealTx: reveal,
      l2: {
        controlBlockDepth: depth,
        singleLeafTree: depth === 0,
        singleInputReveal: reveal.inputs.length === 1,
      },
    };
  }

  if (bundle.level !== 'L3') throw new Error(`unknown proof level ${(bundle as { level: string }).level}`);
  if (!bundle.witness) throw new Error('L3 bundle missing witness section');

  // ---- coinbase inclusion (txid tree, position 0) ----
  const coinbase = parseHexTx(bundle.witness.coinbaseHex, 'coinbase');
  if (!isCoinbase(coinbase)) throw new Error('claimed coinbase is not a coinbase transaction');
  const cbBranch = bundle.witness.coinbaseTxidBranch.map(displayToInternal);
  if (cbBranch.length !== expectedHeight) {
    throw new Error(`coinbase branch depth ${cbBranch.length} != tree height ${expectedHeight}`);
  }
  const { root: cbRoot } = verifyMerkleBranch(coinbase.txidLE, cbBranch, 0, bundle.block.txCount);
  if (!bytesEqual(cbRoot, header.merkleRootLE)) {
    throw new Error('coinbase txid merkle proof does not match header merkle root');
  }

  // ---- witness commitment ----
  const commitment = findWitnessCommitment(coinbase);
  if (!commitment) throw new Error('coinbase has no BIP-141 witness commitment output');
  const reserved = witnessReservedValue(coinbase);
  const wtxidBranch = bundle.witness.wtxidBranch.map(displayToInternal);
  if (wtxidBranch.length !== expectedHeight) {
    throw new Error(`wtxid branch depth ${wtxidBranch.length} != tree height ${expectedHeight}`);
  }
  if (bundle.reveal.pos === 1 && !bytesEqual(wtxidBranch[0], ZERO32)) {
    throw new Error('wtxid branch sibling at position 1 must be the zeroed coinbase leaf');
  }
  if (bundle.reveal.pos === 0) throw new Error('reveal tx cannot be the coinbase');
  const { root: witnessRoot } = verifyMerkleBranch(
    reveal.wtxidLE,
    wtxidBranch,
    bundle.reveal.pos,
    bundle.block.txCount,
  );
  const expectedCommitment = computeWitnessCommitment(witnessRoot, reserved);
  if (!bytesEqual(expectedCommitment, commitment)) {
    throw new Error('witness commitment mismatch: reveal witness is not the one committed in this block');
  }

  return {
    level: 'L3',
    inscriptionId: bundle.inscriptionId.toLowerCase(),
    inscription,
    allInscriptions,
    header,
    height: bundle.block.height,
    revealTx: reveal,
  };
}
