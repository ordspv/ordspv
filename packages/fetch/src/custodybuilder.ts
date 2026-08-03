/**
 * Custody path building: turn "where is this inscription now?" into a
 * verifiable bundle by walking outspends from the reveal forward.
 *
 * Everything fetched here is UNTRUSTED input, exactly as in proofbuilder.ts:
 * the backend acts as a pathfinder (it knows which transaction spent which
 * outpoint), but every claim it makes is re-proven locally by
 * `verifyCustodyBundle` plus per-hop header anchoring. A lying backend can
 * withhold a path (availability) but cannot fabricate one (soundness).
 *
 * What no inclusion proof can express is that the final outpoint is STILL
 * unspent; `fetchCustody` therefore cross-checks the tip outspend across all
 * configured backends and reports the per-source answers rather than
 * pretending liveness is proven.
 */

import {
  parseTx,
  parseHeader,
  parseBlock,
  hexToBytes,
  bytesToHex,
  bytesEqual,
  displayToInternal,
  internalToDisplay,
  buildMerkleBranch,
  verifyMerkleBranch,
  inscriptionsFromTx,
  parseInscriptionId,
  genesisSatpoint,
  transferSatpoint,
  provenInputValues,
  formatSatpoint,
  verifyCustodyBundle,
  verifyEnvelopeBinding,
  verifyWitnessAnchoring,
  checkPowLimit,
  checkProofOfWork,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatPositionError,
  ZERO32,
  type CustodyBundleJson,
  type CustodyHopJson,
  type Satpoint,
  type VerifiedCustody,
  type Inscription,
  type ParsedTx,
} from '@ordspv/core';
import {
  EsploraBackend,
  type EsploraOutspend,
  type FetchFn,
  type BackendLimitsInit,
} from './backends.js';
import {
  makeHeaderTrust,
  MAINNET_CHECKPOINTS,
  type HeaderTrustReport,
} from './headertrust.js';
import { DEFAULT_ANCHOR_SOURCES, DEFAULT_ESPLORA } from './resolver.js';
import {
  sharedDomainRefusal,
  type DomainRefusal,
  type NoAnswer,
  type OnAttempt,
} from './failover.js';
import {
  isRecordableBuildRefusal,
  WitnessSectionUnavailableError,
  type WrapperCode,
} from './taxonomy.js';

/**
 * What a backend says about a block when asked for it directly.
 *
 * Only `tx_count` reaches the bundle. The other three are here because an
 * esplora `/block/<hash>` response carries them anyway, so checking them costs
 * no request and catches a backend contradicting itself for free.
 */
export interface BlockInfoAnswer {
  id?: string;
  height?: number;
  tx_count: number;
  merkle_root?: string;
}

/**
 * What it takes to anchor a transaction into a PoW-checked header. Shared with
 * the sat genealogy builder, which needs anchoring but no outspend pathfinding.
 */
export interface AnchorBackend {
  readonly baseUrl: string;
  getTxHex(txid: string): Promise<string>;
  getTxStatus(txid: string): Promise<{ confirmed: boolean; block_height?: number; block_hash?: string }>;
  getMerkleProof(txid: string): Promise<{ block_height: number; merkle: string[]; pos: number }>;
  getHeaderHex(blockHash: string): Promise<string>;
  /**
   * The block's own summary. `tx_count` is what the bundle carries; the other
   * three fields arrive in the same response an esplora backend has already
   * been paid for, and `checkHopAnswers` folds each one it is given against
   * the answers the same backend gave elsewhere. They are optional because
   * this interface describes what the builder needs rather than what esplora
   * happens to send, and a backend that omits one is simply not checked on it.
   */
  getBlockInfo(blockHash: string): Promise<BlockInfoAnswer>;
  /**
   * Optional: the raw block, used to build the reveal's wtxid proof on
   * multi-input reveals. A backend without it still builds bundles for
   * single-input reveals; a multi-input reveal needs the section from some
   * backend or the bundle cannot be verified at all.
   */
  getBlockRaw?(blockHash: string): Promise<Uint8Array>;
}

export interface CustodyBackend extends AnchorBackend {
  getOutspend(txid: string, vout: number): Promise<EsploraOutspend>;
}

export interface BuildCustodyResult {
  bundle: CustodyBundleJson;
  /** set when the walk stopped at an unconfirmed spend of the final satpoint */
  pendingSpendTxid?: string;
  /**
   * Every base URL that served bytes for this bundle: the backend that walked
   * the path and whichever one served the raw block behind the witness
   * section. All of them are barred from attesting to the bundle's headers,
   * the way `PooledEsploraBackend.usedBaseUrls` is on the genealogy side.
   */
  servedBaseUrls: Set<string>;
}

export class CustodyBuildError extends Error {}

/**
 * One attempt's answers about a hop disagree with each other.
 *
 * A hop is assembled from four separate responses: the transaction's status,
 * its merkle proof, the block's header, and the block's transaction count.
 * Nothing forces a backend to make them agree, and the bundle verifier is what
 * proves they do. That verification runs after the build loop has been left,
 * so an answer that is well formed and wrong used to cost the whole walk and
 * then report the bundle invalid, with the other configured backends never
 * asked. `assembleAnchoredHop` therefore folds the hop against itself before
 * returning, and this class is what it raises.
 *
 * It is not a domain refusal. It says nothing about the chain, only that one
 * backend's answers do not describe one block on the chain this build is
 * configured for, or that the transaction those answers place there is one no
 * verifier will read. Everything that raises it is one backend's word failing:
 * answers that contradict each other, answers that agree on a block whose
 * header is under the configured proof-of-work floor or fails the target it
 * states itself, a block info field that disagrees with the status or the
 * header the same backend served, a transaction whose stripped serialization
 * is 64 bytes, a custody hop the backend places before the hop it spends, and
 * a reveal whose envelope does not bind to its commit output. The loops record
 * any of them as that attempt producing no usable answer and lead the next
 * attempt with another backend. It never reaches the CLI as a refusal.
 */
export class HopConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HopConsistencyError';
  }
}

/** Whether the builder attaches the reveal's witness section (SPEC-CUSTODY). */
export type WitnessSectionMode = 'always' | 'when-needed';

/**
 * Fold one hop's four answers against each other, naming which one failed.
 *
 * This covers every check `verifyAnchoredHop` runs on the same four answers,
 * in the order it runs them, through the same core primitives, so nothing here
 * is a second implementation of the rules and a hop that fails at build fails
 * at the place it would have failed at verification. The header hash match,
 * the proof-of-work floor, the header's own target, `txCount` validity and the
 * branch depth and fold are all here; the branch depth comes through
 * `verifyMerkleBranch`, which enforces it when `txCount` is passed. The one
 * thing `verifyAnchoredHop` does that this does not is call the caller's
 * `trustHeader` hook, which is anchoring rather than a check on the answers
 * and which the wrappers run over the finished bundle.
 *
 * The block info's other three fields are checked here too, and they have no
 * counterpart at verification because the bundle never carries them. They come
 * free in a response the build already made, and they catch one backend
 * contradicting itself across the answers it served. State the limit plainly,
 * since it is the part a later reader will overstate: they do not catch a
 * backend that lies consistently. A backend can name a real block hash at a
 * wrong height and keep its status, its merkle proof and its block info all
 * agreeing on that wrong height, and nothing inside the build can tell,
 * because a header commits to no height above the BIP34 coinbase push and the
 * build has no outside view. That case is caught by `makeHeaderTrust`'s
 * hash-at-height anchoring, which runs after the loop by design, and by
 * `verifySatGenealogy`'s BIP34 test on the terminal coinbase. Both are
 * terminal and neither rotates.
 *
 * What differs is when it runs and what a failure means: raised here it is one
 * backend's answers failing and the caller rotates, and raised there it is a
 * bundle that contradicts itself or the chain.
 */
function checkHopAnswers(
  baseUrl: string,
  tx: ParsedTx,
  blockHash: string,
  blockHeight: number,
  proof: { block_height: number; merkle: string[]; pos: number },
  headerHex: string,
  blockInfo: BlockInfoAnswer,
  powLimitBits: number | null | undefined,
): void {
  const txCount = blockInfo.tx_count;
  let header;
  try {
    header = parseHeader(hexToBytes(headerHex.trim()));
  } catch (e) {
    throw new HopConsistencyError(
      `${baseUrl}: header for block ${blockHash} does not parse: ${(e as Error).message}`,
    );
  }
  if (header.hash !== blockHash.toLowerCase()) {
    throw new HopConsistencyError(
      `${baseUrl}: served a header hashing to ${header.hash} for block ${blockHash}, ` +
        `which the status of ${tx.txid} named`,
    );
  }
  try {
    checkPowLimit(header, powLimitBits, `${baseUrl}: header for block ${blockHash}`);
  } catch (e) {
    throw new HopConsistencyError((e as Error).message);
  }
  if (!checkProofOfWork(header)) {
    throw new HopConsistencyError(
      `${baseUrl}: header for block ${blockHash} fails the proof-of-work target it states itself`,
    );
  }
  if (!Number.isInteger(txCount) || txCount < 1) {
    throw new HopConsistencyError(
      `${baseUrl}: block ${blockHash} has no valid transaction count (got ${txCount})`,
    );
  }
  if (proof.block_height !== blockHeight) {
    throw new HopConsistencyError(
      `${baseUrl}: merkle proof for ${tx.txid} says height ${proof.block_height}, ` +
        `its status says height ${blockHeight}`,
    );
  }
  if (blockInfo.id !== undefined && blockInfo.id.toLowerCase() !== blockHash.toLowerCase()) {
    throw new HopConsistencyError(
      `${baseUrl}: block info for ${blockHash} identifies itself as ${blockInfo.id}, ` +
        `and the status of ${tx.txid} named ${blockHash}`,
    );
  }
  if (blockInfo.height !== undefined && blockInfo.height !== blockHeight) {
    throw new HopConsistencyError(
      `${baseUrl}: block info for ${blockHash} says height ${blockInfo.height}, ` +
        `its status says height ${blockHeight}`,
    );
  }
  if (blockInfo.merkle_root !== undefined) {
    let served: Uint8Array;
    try {
      served = displayToInternal(blockInfo.merkle_root);
    } catch (e) {
      throw new HopConsistencyError(
        `${baseUrl}: block info for ${blockHash} carries an unreadable merkle root ` +
          `${blockInfo.merkle_root}: ${(e as Error).message}`,
      );
    }
    if (!bytesEqual(served, header.merkleRootLE)) {
      throw new HopConsistencyError(
        `${baseUrl}: block info for ${blockHash} says merkle root ${blockInfo.merkle_root}, ` +
          `and the header it served for that block carries ` +
          `${internalToDisplay(header.merkleRootLE)}`,
      );
    }
  }
  let root: Uint8Array;
  try {
    ({ root } = verifyMerkleBranch(
      tx.txidLE,
      proof.merkle.map(displayToInternal),
      proof.pos,
      txCount,
    ));
  } catch (e) {
    throw new HopConsistencyError(
      `${baseUrl}: merkle proof for ${tx.txid} at position ${proof.pos} of ${txCount} ` +
        `does not fold: ${(e as Error).message}`,
    );
  }
  if (!bytesEqual(root, header.merkleRootLE)) {
    throw new HopConsistencyError(
      `${baseUrl}: merkle proof for ${tx.txid} at position ${proof.pos} folds to a root ` +
        `the header of block ${blockHash} does not carry`,
    );
  }
}

/**
 * Refuse a transaction whose stripped serialization is 64 bytes.
 *
 * Both verifiers apply this rule to every transaction a bundle carries in a
 * proven position: `parseHopTx` in `custody.ts` to each custody hop, and
 * `parseHexTxChecked` in `satnumber.ts` to the genealogy endpoints and every
 * funding step. Nothing in the build applied it, so a backend serving such a
 * transaction bought a whole bundle that the verifier then refused after the
 * loop had been left, with the other configured backends never asked.
 *
 * The reason is `parseHopTx`'s: the txid-tree leaf preimage is the stripped
 * serialization, so a 64-byte stripped transaction can be read as an inner
 * node of that tree, and the ambiguity class is stripped length 64 whether or
 * not the transaction carries a witness.
 *
 * Raised as `HopConsistencyError` naming the backend, so the loops record it
 * as that backend producing no usable answer and lead the next attempt.
 */
export function checkTxNotAmbiguous(baseUrl: string, tx: ParsedTx, label: string): void {
  if (tx.strippedRaw.length === 64) {
    throw new HopConsistencyError(
      `${baseUrl}: ${label} has a 64-byte stripped serialization, which is rejected ` +
        `for leaf/node ambiguity in the txid tree`,
    );
  }
}

/**
 * Anchor a transaction: fetch its inclusion proof, header, and block tx count,
 * plus the prev txs for inputs 0..prevTxsUpTo (pass -1 for none, as a coinbase
 * needs).
 *
 * Nothing here is trusted, and the bundle verifier re-proves all of it. What
 * the verifier cannot do is rotate, because it runs after the build loop has
 * been left, so the hop is checked against itself here as well, through
 * `checkHopAnswers`, which covers every check `verifyAnchoredHop` runs on the
 * same answers and adds the block info fields the bundle does not carry. A
 * failure is one backend's answers failing (`HopConsistencyError`), which the
 * loops rotate on instead of spending the rest of the walk on it, and a hop
 * that fails here would have failed there.
 *
 * The rest of the parity with verification lives at the callers, because it
 * needs data this function is not given: `checkTxNotAmbiguous` on every
 * transaction a bundle will carry in a proven position, `bindRevealEnvelope`
 * on the reveal once its envelope and prev txs are in hand, and the custody
 * walk's own chain-order test on each hop it appends.
 *
 * `powLimitBits` is the floor `checkPowLimit` applies, in the convention
 * `makeHeaderTrust` uses: `undefined` is the mainnet limit and `null` disables
 * it. Pass the caller's own option, so the build refuses at the same bar the
 * caller's verification will.
 */
export async function assembleAnchoredHop(
  backend: AnchorBackend,
  tx: ParsedTx,
  hex: string,
  prevTxsUpTo: number,
  powLimitBits?: number | null,
): Promise<CustodyHopJson> {
  const status = await backend.getTxStatus(tx.txid);
  if (!status.confirmed || !status.block_hash || status.block_height === undefined) {
    throw new CustodyBuildError(`${tx.txid} is not confirmed`);
  }
  const [proof, headerHex, blockInfo] = await Promise.all([
    backend.getMerkleProof(tx.txid),
    backend.getHeaderHex(status.block_hash),
    backend.getBlockInfo(status.block_hash),
  ]);
  checkHopAnswers(
    backend.baseUrl,
    tx,
    status.block_hash,
    status.block_height,
    proof,
    headerHex,
    blockInfo,
    powLimitBits,
  );
  const prevTxs: string[] = [];
  for (let i = 0; i <= prevTxsUpTo; i++) {
    prevTxs.push(await backend.getTxHex(tx.inputs[i].prevTxid));
  }
  return {
    block: {
      height: status.block_height,
      hash: status.block_hash,
      header: headerHex.trim(),
      txCount: blockInfo.tx_count,
    },
    tx: { hex: hex.trim(), pos: proof.pos, txidBranch: proof.merkle },
    prevTxs,
  };
}

/**
 * Bind the reveal's envelope to txid-committed data at build time, through
 * `verifyEnvelopeBinding`, which both verifiers run over the same three
 * arguments. A backend serving a reveal whose witness was rewritten under a
 * matching txid otherwise buys a whole bundle and dies at verification, after
 * the build loop has been left and with no other backend asked.
 *
 * A failure is `HopConsistencyError`, recorded as that backend producing no
 * usable answer, and the loop leads the next attempt. The reasoning lands
 * differently from the one the ninth run applied to `SatPositionError`. At
 * build the reveal's witness is unbound, so a binding failure cannot be
 * attributed to the chain and the honest move is to ask another backend.
 * `SatPositionError` needed a row per output context because a verifier raises
 * it too, over a pointer the bundle had bound, where it means a forgery. A
 * binding failure has no such second life here: the verifier's own binding
 * failure already surfaces through `VERIFY_FAILED`. When every backend fails
 * this way, no refusal was recorded, `sharedDomainRefusal` returns undefined,
 * and the caller gets `BUILD_FAILED`, which reports INCOMPLETE, says nothing
 * was verified and names `--esplora`.
 */
export function bindRevealEnvelope(
  baseUrl: string,
  reveal: ParsedTx,
  inscription: Inscription,
  prevTxs: string[],
): void {
  try {
    verifyEnvelopeBinding(reveal, inscription, prevTxs, 'hop 0 (reveal)');
  } catch (e) {
    throw new HopConsistencyError(`${baseUrl}: ${(e as Error).message}`);
  }
}

/**
 * Attach the reveal's wtxid proof to its hop, so the verifier can prove the
 * envelope's index through the block's BIP-141 witness commitment. The whole
 * added cost is one raw block request, the same request `buildProofBundle`
 * makes for L3.
 *
 * `mode` decides which reveals get one. `'when-needed'`, the default, attaches
 * it to multi-input reveals only, since a single-input reveal proves its own
 * numbering; those bundles stay byte-identical to what earlier builders
 * emitted. `'always'` attaches it to every reveal, which is what a caller
 * needs when the inscriber is inside its threat model: only a wtxid anchor
 * shows the witness the chain executed.
 *
 * Each candidate section is folded against the block's own BIP-141 commitment
 * before it is attached, through `verifyWitnessAnchoring`, the function the
 * verifier runs on it. A backend can serve a block whose header hashes right
 * and whose reveal sits at the right position while every witness in it has
 * been rewritten, since a txid commits to no witness byte, and such a section
 * is that backend's bad answer rather than a bundle to hand on.
 *
 * A missing section is fatal at verification for a multi-input reveal, and it
 * is what the caller asked for under `'always'`, so failure is reported rather
 * than swallowed. Each backend is tried in the order the caller supplied them
 * and its cause recorded, and when none can serve the block this throws
 * `WitnessSectionUnavailableError` naming every backend and why it failed. A
 * rate limit and an unprovable reveal are different facts, and the caller has
 * to be able to tell them apart. No unverifiable bundle is emitted.
 *
 * Returns the base URL of the backend that served the block, so the caller can
 * bar it from attesting to the header it just helped fill in, and undefined
 * when no section was needed.
 */
export async function attachRevealWitnessSection(
  backends: AnchorBackend[],
  reveal: ParsedTx,
  hop: CustodyHopJson,
  mode: WitnessSectionMode = 'when-needed',
): Promise<string | undefined> {
  if (mode === 'when-needed' && reveal.inputs.length === 1) return undefined;
  const causes: string[] = [];
  for (const backend of backends) {
    if (!backend.getBlockRaw) {
      causes.push(`${backend.baseUrl}: backend serves no raw blocks`);
      continue;
    }
    try {
      const raw = await backend.getBlockRaw(hop.block.hash);
      const block = parseBlock(raw);
      if (block.header.hash !== hop.block.hash.toLowerCase()) {
        causes.push(
          `${backend.baseUrl}: served a block hashing to ${block.header.hash}, not ${hop.block.hash}`,
        );
        continue;
      }
      const pos = block.txs.findIndex((t) => t.txid === reveal.txid);
      if (pos !== hop.tx.pos) {
        causes.push(
          `${backend.baseUrl}: reveal is at position ${pos} in the served block, proof says ${hop.tx.pos}`,
        );
        continue;
      }
      // the two tests above constrain txids and nothing else, and a txid
      // commits to no witness byte, so every transaction in the served block
      // can carry a rewritten witness and still pass them. The count is
      // checked here so a disagreement is named for what it is; inside the
      // fold it surfaces as a branch depth and names the wrong thing
      if (block.txs.length !== hop.block.txCount) {
        causes.push(
          `${backend.baseUrl}: served a block of ${block.txs.length} transaction(s) for ` +
            `${hop.block.hash}, whose block info says ${hop.block.txCount}`,
        );
        continue;
      }
      // the section carries this coinbase's bytes, and `verifyWitnessAnchoring`
      // applies the same 64-byte rule to them. A cause and the next backend is
      // this loop's contract, so the rule is applied the same way here
      try {
        checkTxNotAmbiguous(
          backend.baseUrl,
          block.txs[0],
          `the coinbase of block ${hop.block.hash}`,
        );
      } catch (e) {
        causes.push((e as Error).message);
        continue;
      }
      const txids = block.txs.map((t) => t.txidLE);
      const wtxids = block.txs.map((t, i) => (i === 0 ? ZERO32 : t.wtxidLE));
      const section = {
        coinbaseHex: bytesToHex(block.txs[0].raw),
        coinbaseTxidBranch: buildMerkleBranch(txids, 0).map(internalToDisplay),
        wtxidBranch: buildMerkleBranch(wtxids, pos).map(internalToDisplay),
      };
      // fold the section against the block's own BIP-141 commitment before it
      // is attached, through the function the verifier runs on it. Attaching
      // first would put an unverifiable section into a bundle the verifier
      // then refuses after this loop has been left, with the remaining
      // backends never asked
      try {
        verifyWitnessAnchoring({
          witness: section,
          header: parseHeader(hexToBytes(hop.block.header.trim())),
          txCount: hop.block.txCount,
          reveal,
          pos,
        });
      } catch (e) {
        causes.push(
          `${backend.baseUrl}: the witness section built from its block ${hop.block.hash} ` +
            `does not fold against that block's own commitment: ${(e as Error).message}`,
        );
        continue;
      }
      hop.witness = section;
      return backend.baseUrl;
    } catch (e) {
      causes.push(`${backend.baseUrl}: ${(e as Error).message}`);
    }
  }
  throw new WitnessSectionUnavailableError(
    `reveal ${reveal.txid} spends ${reveal.inputs.length} input(s) and its witness section ` +
      `was requested (${mode}), and no backend served block ${hop.block.hash}:\n` +
      causes.join('\n'),
  );
}

/**
 * Build a custody bundle for an inscription by walking confirmed outspends
 * from its reveal. The result is UNVERIFIED; callers must run
 * `verifyCustodyBundle` (fetchCustody does both).
 */
export async function buildCustodyBundle(
  inscriptionId: string,
  backend: CustodyBackend,
  options: {
    maxHops?: number;
    witnessBackends?: AnchorBackend[];
    witnessSection?: WitnessSectionMode;
    /**
     * Proof-of-work floor for every hop header, in `checkPowLimit`'s
     * convention: `undefined` is the mainnet limit and `null` disables it.
     * The caller's verification applies the same floor, so passing it here is
     * what lets a header under it cost one attempt instead of the whole walk.
     */
    powLimitBits?: number | null;
  } = {},
): Promise<BuildCustodyResult> {
  const maxHops = options.maxHops ?? 64;
  const id = parseInscriptionId(inscriptionId);

  const revealHex = await backend.getTxHex(id.txid);
  const reveal = parseTx(hexToBytes(revealHex.trim()));
  // the inscription id commits to the reveal's stripped hash, and every later
  // hop checks the served bytes against the outpoint chain. The root gets the
  // same check: bytes hashing to some other transaction are this backend's
  // wrong answer, recorded as no usable answer, and never a domain refusal
  // derived from them
  if (reveal.txid !== id.txid) {
    throw new CustodyBuildError(`backend served ${reveal.txid} for requested ${id.txid}`);
  }
  checkTxNotAmbiguous(backend.baseUrl, reveal, `reveal ${reveal.txid}`);
  const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
  if (!inscription) {
    throw new CustodyBuildError(`reveal ${id.txid} has no envelope with index ${id.index}`);
  }

  const revealHop = await assembleAnchoredHop(
    backend,
    reveal,
    revealHex,
    inscription.input,
    options.powLimitBits,
  );
  bindRevealEnvelope(backend.baseUrl, reveal, inscription, revealHop.prevTxs);
  // the walker has served bytes by now, and the raw-block server serves more
  const servedBaseUrls = new Set<string>([backend.baseUrl]);
  const witnessServer = await attachRevealWitnessSection(
    options.witnessBackends ?? [backend],
    reveal,
    revealHop,
    options.witnessSection,
  );
  if (witnessServer !== undefined) servedBaseUrls.add(witnessServer);
  const hops: CustodyHopJson[] = [revealHop];

  // working (unverified) satpoint to know which outpoint to walk next
  let current: Satpoint = genesisSatpoint(
    reveal,
    inscription,
    provenInputValues(reveal, revealHop.prevTxs, inscription.input),
    revealHop.block.height,
  );
  let pendingSpendTxid: string | undefined;

  for (let h = 1; ; h++) {
    const outspend = await backend.getOutspend(current.txid, current.vout);
    if (!outspend.spent) break;
    if (!outspend.txid) throw new CustodyBuildError('outspend reports spent without a txid');
    if (!outspend.status?.confirmed) {
      pendingSpendTxid = outspend.txid;
      break;
    }
    // the cap bounds how many transfers the walk will follow; it only fires
    // when a further confirmed spend exists, so a path that COMPLETES at
    // exactly maxHops transfers still builds
    if (h > maxHops) throw new CustodyBuildError(`custody path exceeds ${maxHops} hops`);
    const hex = await backend.getTxHex(outspend.txid);
    const tx = parseTx(hexToBytes(hex.trim()));
    checkTxNotAmbiguous(backend.baseUrl, tx, `hop ${h} transaction ${tx.txid}`);
    const j = tx.inputs.findIndex((inp) => inp.prevTxid === current.txid && inp.vout === current.vout);
    if (j === -1) {
      throw new CustodyBuildError(
        `${outspend.txid} claimed to spend ${formatSatpoint(current)} but does not`,
      );
    }
    const hop = await assembleAnchoredHop(backend, tx, hex, j, options.powLimitBits);
    // `verifyCustodyBundle` requires strict chain order, increasing height or
    // equal height with strictly increasing position, and SPEC-CUSTODY states
    // it as a MUST on verifiers. The walk follows a backend's own outspend
    // answers, so a backend can point it at a spend it places before the hop
    // it spends. Checked here the pair costs one attempt; checked only at
    // verification it costs the walk and a bundle refused after the loop
    const previous = hops[hops.length - 1];
    if (
      hop.block.height < previous.block.height ||
      (hop.block.height === previous.block.height && hop.tx.pos <= previous.tx.pos)
    ) {
      throw new HopConsistencyError(
        `${backend.baseUrl}: hop ${h} sits at height ${hop.block.height} position ` +
          `${hop.tx.pos} and hop ${h - 1} at height ${previous.block.height} position ` +
          `${previous.tx.pos}, so the spend does not come after what it spends`,
      );
    }
    hops.push(hop);
    current = transferSatpoint(
      tx,
      provenInputValues(tx, hop.prevTxs, j),
      current,
      hop.block.height,
    );
  }

  return {
    bundle: {
      version: 1,
      inscriptionId: inscriptionId.toLowerCase(),
      hops,
      finalSatpoint: formatSatpoint(current),
    },
    pendingSpendTxid,
    servedBaseUrls,
  };
}

// ---------------------------------------------------------------------------
// High-level: build, verify, anchor, and tip-check with failover
// ---------------------------------------------------------------------------

export interface FetchCustodyOptions {
  esplora?: string[];
  /** header attesters (default `DEFAULT_ANCHOR_SOURCES`); see HeaderTrustOptions */
  anchorSources?: string[];
  fetchFn?: FetchFn;
  limits?: BackendLimitsInit;
  maxHops?: number;
  /**
   * Whether the reveal hop carries its wtxid proof. `'when-needed'` (default)
   * attaches it to multi-input reveals only, which is what verification
   * requires and keeps single-input bundles byte-identical to before the
   * option existed. `'always'` attaches it to every reveal, at one raw block
   * request, so the bundle verifies at `indexProof: 'wtxid'` and carries no
   * executed-leaf residual.
   */
  witnessSection?: WitnessSectionMode;
  /** see HeaderTrustOptions; defaults mirror the resolver */
  minHeaderAgreement?: number;
  minConfirmations?: number;
  checkpoints?: Map<number, string>;
  powLimitBits?: number | null;
  /**
   * Anchor every hop header instead of `makeHeaderTrust`. Throw to reject.
   * Custody verification reads no height out of the hook, so a rejection-only
   * anchor is enough here; the `attests` field matters to `fetchSatIdentity`,
   * where a sub-BIP34 coinbase height rests on it.
   */
  trustHeader?: (header: import('@ordspv/core').BlockHeader, height: number) => Promise<HeaderTrustReport>;
  /**
   * Called once per build attempt, before it runs, with the backend leading it
   * and what ended the attempt before. A rotation can cost a whole second walk,
   * so a caller that shows progress has to be told one happened.
   */
  onAttempt?: OnAttempt;
}

export interface CustodyTipSource {
  source: string;
  /** 'unspent' | 'spent' | 'error' */
  state: 'unspent' | 'spent' | 'error';
  detail?: string;
}

export interface FetchCustodyResult {
  custody: VerifiedCustody;
  /** anchoring report for each hop, in hop order */
  headerTrust: HeaderTrustReport[];
  /** per-source outspend answers for the final satpoint (liveness, not proof) */
  tip: CustodyTipSource[];
  /** set when a confirmed-but-unproven spend was pending at build time */
  pendingSpendTxid?: string;
}

export class CustodyError extends Error {
  constructor(
    public readonly code: WrapperCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyError';
  }
}

export async function fetchCustody(
  inscriptionId: string,
  options: FetchCustodyOptions = {},
): Promise<FetchCustodyResult> {
  const fetchFn = options.fetchFn;
  const backends = (options.esplora ?? DEFAULT_ESPLORA).map(
    (u) => new EsploraBackend(u, fetchFn, options.limits ?? {}),
  );
  const anchors = (options.anchorSources ?? DEFAULT_ANCHOR_SOURCES).map(
    (u) => new EsploraBackend(u, fetchFn, options.limits ?? {}),
  );

  // build with failover
  let built: BuildCustodyResult | undefined;
  let source: EsploraBackend | undefined;
  const buildErrors: string[] = [];
  const refusals: DomainRefusal[] = [];
  // attempts that ended some other way, which is a transport failure or a walk
  // that could not be completed; a refusal reported over these says they
  // produced no usable answer rather than claiming they agreed
  const noAnswer: NoAnswer[] = [];
  let lastCause: Error | undefined;
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i];
    options.onAttempt?.({
      baseUrl: backend.baseUrl,
      attempt: i,
      total: backends.length,
      cause: lastCause,
    });
    try {
      built = await buildCustodyBundle(inscriptionId, backend, {
        maxHops: options.maxHops,
        witnessSection: options.witnessSection,
        // the same floor the verification below applies, so a header under it
        // costs one attempt rather than the walk plus a refused bundle
        powLimitBits: options.powLimitBits,
        // the witness section is worth every backend's attempt, not just the
        // one walking the path; a refusal here means none of them served it
        witnessBackends: backends,
      });
      source = backend;
      break;
    } catch (e) {
      // a build-time refusal is terminal only when it was derived from data
      // the txid commits. This one is: the reveal's input count is inside the
      // txid, so every backend serving that reveal reports the same thing.
      // No builder raises the class today, since a reveal that cannot prove its
      // numbering is refused at verification rather than during the walk. The
      // arm is the terminal side of the rule with no live build-time example,
      // and it stays so the next reader does not read its absence as an
      // oversight
      if (e instanceof EnvelopeIndexUnprovenError) throw e;
      // the rest came out of bytes nothing has bound, and which classes those
      // are is the taxonomy table's committedAtBuild answer rather than a
      // list kept here: a v1-domain refusal is read out of the served
      // witness, and an unavailable witness section out of the block hash
      // and the position this backend's own status and merkle proof named,
      // either of which a hostile backend can point at a real but wrong
      // block. Record it and ask the next backend; the verifier's own
      // refusal, after the bundle proved its witness, stays terminal.
      // `SatPositionError` stays beside the predicate by name so both build
      // loops classify the same condition the same way, and because it
      // carries no build-time facts row of its own. Its row lives in the CLI
      // table, keyed by output context: a verifier raising it reports INVALID
      // because the bundle bound the pointer it then failed, and a build loop
      // raising it reports UNPROVEN because the reveal txid commits to no
      // witness byte. The custody walk computes no sat-space position of its
      // own, so nothing in it raises the class today
      if (isRecordableBuildRefusal(e) || e instanceof SatPositionError) {
        refusals.push({ baseUrl: backend.baseUrl, error: e });
      } else {
        // everything else is this backend producing no usable answer, which
        // now includes a hop whose own answers disagreed (HopConsistencyError):
        // that says nothing about the chain, so it must never be recorded as a
        // refusal, and the next backend gets the walk
        noAnswer.push({ baseUrl: backend.baseUrl, error: e as Error });
      }
      lastCause = e as Error;
      buildErrors.push(`${backend.baseUrl}: ${(e as Error).message}`);
    }
  }
  if (!built || !source) {
    const shared = sharedDomainRefusal(refusals, backends.length, noAnswer);
    if (shared) throw shared;
    throw new CustodyError('BUILD_FAILED', `all backends failed:\n${buildErrors.join('\n')}`);
  }

  // structural verification (sync, trustless)
  let custody: VerifiedCustody;
  try {
    custody = verifyCustodyBundle(built.bundle, { powLimitBits: options.powLimitBits });
  } catch (e) {
    // an unprovable index is a property of the reveal, not a forged bundle;
    // callers distinguish it the way they distinguish CustodyUnsupportedError
    if (e instanceof EnvelopeIndexUnprovenError) throw e;
    // raised HERE the domain refusal is terminal and unwrapped: the bundle
    // bound its witness before the verifier read a satpoint out of it, so the
    // path really does leave what v1 proves
    if (e instanceof CustodyUnsupportedError) throw e;
    throw new CustodyError('VERIFY_FAILED', (e as Error).message);
  }

  // anchor every hop header; the builder cannot attest to its own headers
  const trust =
    options.trustHeader ??
    makeHeaderTrust({
      esploras: anchors,
      minAgreement: options.minHeaderAgreement,
      minConfirmations: options.minConfirmations,
      checkpoints: options.checkpoints ?? MAINNET_CHECKPOINTS,
      // every backend that served bytes is barred, not just the walker: any
      // configured backend may have served the raw block behind the witness
      // section, and a server vouching for a header it helped build is a
      // self-vote whichever bytes it contributed
      proofSources: built.servedBaseUrls,
      powLimitBits: options.powLimitBits,
    });
  const headerTrust: HeaderTrustReport[] = [];
  for (const hop of built.bundle.hops) {
    const header = parseHeader(hexToBytes(hop.block.header));
    try {
      headerTrust.push(await trust(header, hop.block.height));
    } catch (e) {
      throw new CustodyError(
        'HEADER_TRUST',
        `hop at height ${hop.block.height}: ${(e as Error).message}`,
      );
    }
  }

  // tip liveness: every source answers independently; disagreement is surfaced
  const final = custody.satpoint;
  const tip: CustodyTipSource[] = await Promise.all(
    backends.map(async (backend): Promise<CustodyTipSource> => {
      try {
        const o = await backend.getOutspend(final.txid, final.vout);
        return {
          source: backend.baseUrl,
          state: o.spent ? 'spent' : 'unspent',
          detail: o.spent ? o.txid : undefined,
        };
      } catch (e) {
        return { source: backend.baseUrl, state: 'error', detail: (e as Error).message };
      }
    }),
  );

  return { custody, headerTrust, tip, pendingSpendTxid: built.pendingSpendTxid };
}
