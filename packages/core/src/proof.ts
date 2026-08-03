import { bytesEqual, displayToInternal, hexToBytes } from './bytes.js';
import { inscriptionsFromTx, type Inscription } from './envelope.js';
import {
  parseHeader,
  checkProofOfWork,
  checkPowLimit,
  type BlockHeader,
  type HeaderAttestation,
} from './header.js';
import { parseInscriptionId } from './inscriptionId.js';
import { treeHeight, verifyMerkleBranch } from './merkle.js';
import { extractTapscript, parseControlBlock, verifyScriptPathCommitment } from './taproot.js';
import { parseTx, type ParsedTx } from './tx.js';
import { verifyWitnessAnchoring, type WitnessSectionJson } from './witnesscommit.js';

/**
 * Proof bundles: self-contained, backend-independent evidence that inscription
 * content is authentic, at one of the verification levels defined in
 * docs/spec/SPEC-VERIFICATION.md:
 *
 *  - L2 "tapscript commitment": header + txid-merkle proof of the reveal tx +
 *    commit tx + BIP-341 control-block check. All ingredients are served by
 *    any esplora/electrum instance. Proves the content was committed by the
 *    taptree of the output the reveal spent, with documented caveats
 *    (multi-leaf trees, executed-leaf ambiguity) surfaced as `assurances`.
 *
 *  - L3 "witness commitment": additionally binds the exact reveal witness via
 *    the BIP-141 coinbase witness commitment (txid-merkle proof of coinbase +
 *    wtxid-merkle proof of the reveal). Equivalent to what a full node
 *    enforces; closes the L2 caveats.
 *
 * Header trust is delegated to the caller via `trustHeader`; core stays pure.
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
  /** required for L3; refused on an L2 bundle, where nothing reads it */
  witness?: WitnessSectionJson;
}

/**
 * What L2 established, and what it did not. Both fields are statements about
 * what was COMMITTED. Neither proves the observed tapscript was the script the
 * reveal executed: a single-leaf P2TR output is spendable by key path too, and
 * the txid commits to neither the witness nor the spend path chosen, so the
 * commit output's author can spend by key path, revealing no inscription, and
 * serve the script-path witness afterwards. Only L3 shows the witness the
 * chain saw, because the BIP-141 commitment covers the exact serialization.
 */
export interface L2Assurances {
  /** control block merkle path depth; 0 means the taptree provably committed a single leaf */
  controlBlockDepth: number;
  /** the taptree provably committed only the shown script (depth 0) */
  singleLeafTree: boolean;
  /** reveal tx has one input, so no other input can contribute an envelope */
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
   * settings: a single header's work is cheap relative to valuable content).
   *
   * Returning `'hash-at-height'` asserts that this block hash is the chain's
   * hash at this height, which binds the header to the height. Returning
   * nothing keeps the hook rejection-only, which is all this verifier needs:
   * content proofs read no height out of the hook. `verifySatGenealogy` does,
   * and refuses a sub-BIP34 coinbase height without the assertion.
   */
  trustHeader?: (header: BlockHeader, height: number) => HeaderAttestation;
  /**
   * Compact-bits proof-of-work floor applied to the bundle's header before its
   * own PoW check counts for anything. Defaults to the mainnet limit
   * (0x1d00ffff); pass another chain's limit, or null to disable it.
   */
  powLimitBits?: number | null;
}

function parseHexTx(hex: string, label: string): ParsedTx {
  let tx: ParsedTx;
  try {
    tx = parseTx(hexToBytes(hex.trim()));
  } catch (e) {
    throw new Error(`${label}: cannot parse transaction: ${(e as Error).message}`);
  }
  // the txid-tree leaf preimage is the STRIPPED serialization, so the
  // leaf/node ambiguity class is stripped==64, witness or not
  if (tx.strippedRaw.length === 64) {
    throw new Error(`${label}: 64-byte transactions are rejected (leaf/node ambiguity)`);
  }
  return tx;
}

/** Verify a proof bundle. Throws with a precise reason on any failure. */
export function verifyProofBundle(bundle: ProofBundleJson, opts: VerifyOptions = {}): VerifiedInscription {
  if (bundle.version !== 1) throw new Error(`unsupported proof bundle version ${(bundle as { version: unknown }).version}`);
  // a bundle is untrusted JSON, so an absent field must name itself rather
  // than surface as a TypeError that reads as an internal fault
  if (typeof bundle.inscriptionId !== 'string') {
    throw new Error('bundle field inscriptionId is missing or not a string');
  }
  if (typeof bundle.block !== 'object' || bundle.block === null) {
    throw new Error('bundle field block is missing or not an object');
  }
  if (typeof bundle.reveal !== 'object' || bundle.reveal === null) {
    throw new Error('bundle field reveal is missing or not an object');
  }
  const id = parseInscriptionId(bundle.inscriptionId);

  // ---- header ----
  const header = parseHeader(hexToBytes(bundle.block.header));
  if (header.hash !== bundle.block.hash.toLowerCase()) {
    throw new Error(`header hashes to ${header.hash}, bundle claims ${bundle.block.hash}`);
  }
  checkPowLimit(header, opts.powLimitBits);
  if (!checkProofOfWork(header)) throw new Error('header fails proof of work');
  if (!Number.isInteger(bundle.block.txCount) || bundle.block.txCount < 1) {
    throw new Error('bundle missing valid txCount');
  }
  // a bundle is untrusted JSON, so a string height would flow into the
  // trustHeader hook and the verified report a --json consumer reads
  if (!Number.isInteger(bundle.block.height) || bundle.block.height < 0) {
    throw new Error('bundle missing valid block height');
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
    // presence, not truth: nothing at L2 reads the section, so a bundle
    // carrying one would look witness-carrying to a reader of the JSON while
    // this verifier checked none of it
    if ((bundle as { witness?: unknown }).witness !== undefined) {
      throw new Error('witness section on an L2 bundle; L3 is the level that reads one');
    }
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

  // coinbase inclusion + witness commitment, shared with custody/genealogy
  verifyWitnessAnchoring({
    witness: bundle.witness,
    header,
    txCount: bundle.block.txCount,
    reveal,
    pos: bundle.reveal.pos,
  });

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
