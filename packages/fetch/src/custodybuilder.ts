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
  internalToDisplay,
  buildMerkleBranch,
  inscriptionsFromTx,
  parseInscriptionId,
  genesisSatpoint,
  transferSatpoint,
  provenInputValues,
  formatSatpoint,
  verifyCustodyBundle,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatPositionError,
  ZERO32,
  type CustodyBundleJson,
  type CustodyHopJson,
  type Satpoint,
  type VerifiedCustody,
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
import { sharedDomainRefusal, type DomainRefusal, type OnAttempt } from './failover.js';

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
  getBlockInfo(blockHash: string): Promise<{ tx_count: number }>;
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
 * No backend could serve the raw block the reveal's witness section is built
 * from. This is an availability failure and retrying elsewhere or later may
 * well succeed, which is exactly what `EnvelopeIndexUnprovenError` does not
 * mean: that class is the verifier's refusal of a reveal whose numbering
 * cannot be proven at all. The message names every backend tried and its
 * cause, including a backend that exposes no raw-block method.
 */
export class WitnessSectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessSectionUnavailableError';
  }
}

/** Whether the builder attaches the reveal's witness section (SPEC-CUSTODY). */
export type WitnessSectionMode = 'always' | 'when-needed';

/**
 * Anchor a transaction: fetch its inclusion proof, header, and block tx count,
 * plus the prev txs for inputs 0..prevTxsUpTo (pass -1 for none, as a coinbase
 * needs). Nothing here is trusted; the bundle verifier re-proves all of it.
 */
export async function assembleAnchoredHop(
  backend: AnchorBackend,
  tx: ParsedTx,
  hex: string,
  prevTxsUpTo: number,
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
      const txids = block.txs.map((t) => t.txidLE);
      const wtxids = block.txs.map((t, i) => (i === 0 ? ZERO32 : t.wtxidLE));
      hop.witness = {
        coinbaseHex: bytesToHex(block.txs[0].raw),
        coinbaseTxidBranch: buildMerkleBranch(txids, 0).map(internalToDisplay),
        wtxidBranch: buildMerkleBranch(wtxids, pos).map(internalToDisplay),
      };
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
  } = {},
): Promise<BuildCustodyResult> {
  const maxHops = options.maxHops ?? 64;
  const id = parseInscriptionId(inscriptionId);

  const revealHex = await backend.getTxHex(id.txid);
  const reveal = parseTx(hexToBytes(revealHex.trim()));
  const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
  if (!inscription) {
    throw new CustodyBuildError(`reveal ${id.txid} has no envelope with index ${id.index}`);
  }

  const revealHop = await assembleAnchoredHop(backend, reveal, revealHex, inscription.input);
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
    const j = tx.inputs.findIndex((inp) => inp.prevTxid === current.txid && inp.vout === current.vout);
    if (j === -1) {
      throw new CustodyBuildError(
        `${outspend.txid} claimed to spend ${formatSatpoint(current)} but does not`,
      );
    }
    const hop = await assembleAnchoredHop(backend, tx, hex, j);
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
    public readonly code: 'BUILD_FAILED' | 'VERIFY_FAILED' | 'HEADER_TRUST',
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
  // attempts that ended some other way, which is a transport failure; a
  // refusal reported over these says so rather than claiming they agreed
  const unreachable: string[] = [];
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
        // the witness section is worth every backend's attempt, not just the
        // one walking the path; a refusal here means none of them served it
        witnessBackends: backends,
      });
      source = backend;
      break;
    } catch (e) {
      // a build-time refusal is terminal only when it was derived from data
      // the txid commits. This one is: the reveal's input count is inside the
      // txid, so every backend serving that reveal reports the same thing
      if (e instanceof EnvelopeIndexUnprovenError) throw e;
      // the rest came out of bytes nothing has bound. A v1-domain refusal is
      // read out of the served witness, and an unavailable witness section is
      // read out of the block hash and the position this backend's own status
      // and merkle proof named, either of which a hostile backend can point at
      // a real but wrong block. Record it and ask the next backend; the
      // verifier's own refusal, after the bundle proved its witness, stays
      // terminal
      // `SatPositionError` is listed so both build loops classify the same
      // condition the same way. The custody walk computes no sat-space
      // position of its own, so nothing in it raises the class today
      if (
        e instanceof CustodyUnsupportedError ||
        e instanceof SatPositionError ||
        e instanceof WitnessSectionUnavailableError
      ) {
        refusals.push({ baseUrl: backend.baseUrl, error: e });
      } else {
        unreachable.push(backend.baseUrl);
      }
      lastCause = e as Error;
      buildErrors.push(`${backend.baseUrl}: ${(e as Error).message}`);
    }
  }
  if (!built || !source) {
    const shared = sharedDomainRefusal(refusals, backends.length, unreachable);
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
