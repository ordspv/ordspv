/**
 * Sat genealogy building: turn "which sat is this inscription on?" into a
 * verifiable bundle by walking funding transactions backward to the coinbase
 * that mined the sat.
 *
 * Unlike custody, there is no pathfinding here and therefore nothing to
 * misdirect. Forward custody has to ASK a backend which transaction spent an
 * outpoint, because a transaction does not name its spender. Backward
 * ancestry names itself: every input carries the txid of its funding
 * transaction, so the walk is pure document retrieval against a hash chain. A
 * backend that serves the wrong bytes fails the txid check locally, and a
 * backend that serves nothing has withheld data rather than forged a lineage.
 *
 * Only the two endpoints need inclusion proofs: the reveal (so the envelope is
 * pinned to a block) and the terminal coinbase (whose height is what numbers
 * the sat). Every transaction in between is pinned by the txid its successor
 * already names.
 */

import {
  parseTx,
  parseHeader,
  hexToBytes,
  inscriptionsFromTx,
  parseInscriptionId,
  provenInputValues,
  containingInput,
  outputSpacePosition,
  coinbaseSatAt,
  isCoinbaseTx,
  verifySatGenealogy,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  type GenealogyStepJson,
  type SatGenealogyBundleJson,
  type VerifiedSatIdentity,
  type ParsedTx,
} from '@ordspv/core';
import {
  EsploraBackend,
  PooledEsploraBackend,
  type FetchFn,
  type BackendLimitsInit,
} from './backends.js';
import {
  assembleAnchoredHop,
  attachRevealWitnessSection,
  WitnessSectionUnavailableError,
  type AnchorBackend,
  type WitnessSectionMode,
} from './custodybuilder.js';
import { makeHeaderTrust, MAINNET_CHECKPOINTS, type HeaderTrustReport } from './headertrust.js';
import { DEFAULT_ANCHOR_SOURCES, DEFAULT_ESPLORA } from './resolver.js';

export class SatBuildError extends Error {}

/**
 * The walk hit its step cap. Separate from SatBuildError (which it extends, so
 * existing catch sites keep working) because the cap is deterministic and
 * identical on every backend: rewalking the whole ancestry against a second
 * one reaches the same step and costs another full walk.
 */
export class SatStepLimitError extends SatBuildError {}

/** funding steps the builder will walk before giving up (SPEC-SAT) */
export const DEFAULT_MAX_STEPS = 4096;

export interface BuildSatGenealogyResult {
  bundle: SatGenealogyBundleJson;
}

/**
 * Fetch prev txs for inputs 0, 1, 2, ... until their cumulative value covers
 * `position`, then resolve which input carried it. Large transactions are
 * common in this walk (exchange payouts, consolidations), so inputs past the
 * one that matters are never fetched.
 *
 * `existing` lets a caller pass prev txs already fetched for other reasons;
 * they are kept in the bundle so the verifier proves the same input values.
 */
async function prevTxsCovering(
  backend: AnchorBackend,
  tx: ParsedTx,
  position: bigint,
  existing: string[] = [],
): Promise<{ prevTxs: string[]; input: number; offsetInFunding: bigint }> {
  const prevTxs = existing.map((hex) => hex.trim());
  if (prevTxs.length > tx.inputs.length) {
    throw new SatBuildError(`${prevTxs.length} prev txs for ${tx.inputs.length} inputs`);
  }
  let covered = 0n;
  for (let i = 0; i < prevTxs.length; i++) {
    // running total over already-fetched inputs; validated authoritatively below
    const prev = parseTx(hexToBytes(prevTxs[i]));
    const out = prev.outputs[tx.inputs[i].vout];
    if (!out) throw new SatBuildError(`prev tx ${prev.txid} has no output ${tx.inputs[i].vout}`);
    covered += out.value;
  }
  for (let i = prevTxs.length; i < tx.inputs.length && covered <= position; i++) {
    const hex = (await backend.getTxHex(tx.inputs[i].prevTxid)).trim();
    prevTxs.push(hex);
    let prev: ParsedTx;
    try {
      prev = parseTx(hexToBytes(hex));
    } catch (e) {
      throw new SatBuildError(`prev tx for input ${i}: cannot parse: ${(e as Error).message}`);
    }
    const out = prev.outputs[tx.inputs[i].vout];
    if (!out) {
      throw new SatBuildError(`prev tx ${prev.txid} has no output ${tx.inputs[i].vout}`);
    }
    covered += out.value;
  }
  // authoritative check: every prev tx must hash to the txid its input names
  const values = provenInputValues(tx, prevTxs, prevTxs.length - 1);
  const step = containingInput(tx, values, position);
  return { prevTxs, input: step.input, offsetInFunding: step.offsetInFunding };
}

/**
 * Build a sat genealogy bundle for an inscription. The result is UNVERIFIED;
 * callers must run `verifySatGenealogy` (fetchSatIdentity does both).
 */
export async function buildSatGenealogyBundle(
  inscriptionId: string,
  backend: AnchorBackend,
  options: {
    maxSteps?: number;
    witnessBackends?: AnchorBackend[];
    witnessSection?: WitnessSectionMode;
  } = {},
): Promise<BuildSatGenealogyResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const id = parseInscriptionId(inscriptionId);

  const revealHex = (await backend.getTxHex(id.txid)).trim();
  const reveal = parseTx(hexToBytes(revealHex));
  const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
  if (!inscription) {
    throw new SatBuildError(`reveal ${id.txid} has no envelope with index ${id.index}`);
  }
  const k = inscription.input;

  const revealHop = await assembleAnchoredHop(backend, reveal, revealHex, k);
  await attachRevealWitnessSection(
    options.witnessBackends ?? [backend],
    reveal,
    revealHop,
    options.witnessSection,
  );
  const revealValues = provenInputValues(reveal, revealHop.prevTxs, k);
  if (inscription.unboundByEvenField || revealValues[k] === 0n) {
    throw new CustodyUnsupportedError(
      'inscription is unbound at reveal (zero-value envelope input or unrecognized even field); it has no sat identity to trace',
      revealHop.block.height,
    );
  }

  // start position in the reveal's sat stream: first sat of the envelope's
  // input, or the pointer, which indexes output space (identical to input
  // space, since outputs are a prefix slice of the concatenated inputs)
  let totalOut = 0n;
  for (const o of reveal.outputs) totalOut += o.value;
  let position: bigint;
  if (inscription.pointer !== undefined && inscription.pointer < totalOut) {
    position = inscription.pointer;
  } else {
    position = 0n;
    for (let i = 0; i < k; i++) position += revealValues[i];
  }

  // a pointer can land past the envelope input, so the reveal may need prev
  // txs for inputs beyond k; the verifier accepts and uses them
  const start = await prevTxsCovering(backend, reveal, position, revealHop.prevTxs);
  revealHop.prevTxs = start.prevTxs;

  const funding: GenealogyStepJson[] = [];
  let expectTxid = reveal.inputs[start.input].prevTxid;
  let expectVout = reveal.inputs[start.input].vout;
  let offset = start.offsetInFunding;

  for (let step = 0; ; step++) {
    if (step > maxSteps) {
      throw new SatStepLimitError(
        `genealogy exceeds ${maxSteps} funding steps; raise the cap with --max-steps ` +
          `(or the maxSteps option) if the ancestry really is this deep`,
      );
    }
    const hex = (await backend.getTxHex(expectTxid)).trim();
    let tx: ParsedTx;
    try {
      tx = parseTx(hexToBytes(hex));
    } catch (e) {
      throw new SatBuildError(`${expectTxid}: cannot parse transaction: ${(e as Error).message}`);
    }
    if (tx.txid !== expectTxid) {
      throw new SatBuildError(`backend served ${tx.txid} for requested ${expectTxid}`);
    }

    if (isCoinbaseTx(tx)) {
      const coinbaseHop = await assembleAnchoredHop(backend, tx, hex, -1);
      const pos = outputSpacePosition(tx, expectVout, offset);
      // throws CustodyUnsupportedError for fee-tail positions, before the
      // caller spends anything on verification
      const sat = coinbaseSatAt(tx, pos, coinbaseHop.block.height);
      return {
        bundle: {
          version: 1,
          inscriptionId: inscriptionId.toLowerCase(),
          reveal: revealHop,
          funding,
          coinbase: coinbaseHop,
          claimedSat: sat.toString(),
        },
      };
    }

    const pos = outputSpacePosition(tx, expectVout, offset);
    const next = await prevTxsCovering(backend, tx, pos);
    funding.push({ tx: { hex }, prevTxs: next.prevTxs });
    expectTxid = tx.inputs[next.input].prevTxid;
    expectVout = tx.inputs[next.input].vout;
    offset = next.offsetInFunding;
  }
}

// ---------------------------------------------------------------------------
// High-level: build, verify, anchor both endpoints, with failover
// ---------------------------------------------------------------------------

export interface FetchSatIdentityOptions {
  esplora?: string[];
  /** header attesters (default `DEFAULT_ANCHOR_SOURCES`); see HeaderTrustOptions */
  anchorSources?: string[];
  fetchFn?: FetchFn;
  limits?: BackendLimitsInit;
  /** funding steps the walk will follow (default `DEFAULT_MAX_STEPS`) */
  maxSteps?: number;
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
  trustHeader?: (
    header: import('@ordspv/core').BlockHeader,
    height: number,
  ) => Promise<HeaderTrustReport>;
}

export interface FetchSatIdentityResult {
  identity: VerifiedSatIdentity;
  /** anchoring reports for the two proven endpoints */
  headerTrust: { reveal: HeaderTrustReport; coinbase: HeaderTrustReport };
  /** the bundle, so callers can persist an offline-verifiable artifact */
  bundle: SatGenealogyBundleJson;
}

export class SatIdentityError extends Error {
  constructor(
    public readonly code: 'BUILD_FAILED' | 'VERIFY_FAILED' | 'HEADER_TRUST',
    message: string,
  ) {
    super(message);
    this.name = 'SatIdentityError';
  }
}

export async function fetchSatIdentity(
  inscriptionId: string,
  options: FetchSatIdentityOptions = {},
): Promise<FetchSatIdentityResult> {
  // one pool, one walk: a mid-walk failure rotates to another member and
  // retries that request, instead of restarting thousands of steps from the
  // reveal against the next backend
  const pool = new PooledEsploraBackend(
    (options.esplora ?? DEFAULT_ESPLORA).map(
      (u) => new EsploraBackend(u, options.fetchFn, options.limits ?? {}),
    ),
  );
  const anchors = (options.anchorSources ?? DEFAULT_ANCHOR_SOURCES).map(
    (u) => new EsploraBackend(u, options.fetchFn, options.limits ?? {}),
  );

  let built: BuildSatGenealogyResult;
  try {
    built = await buildSatGenealogyBundle(inscriptionId, pool, {
      maxSteps: options.maxSteps,
      witnessSection: options.witnessSection,
      // the pool already rotates every member for the raw block request and
      // names each one's cause, so it is the whole witness-backend list
      witnessBackends: [pool],
    });
  } catch (e) {
    // a v1-domain refusal is a property of the ancestry, not of the backend
    if (e instanceof CustodyUnsupportedError) throw e;
    // no backend served the raw block, with each cause named; retrying later
    // may succeed, which is why this is not the verifier's refusal class
    if (e instanceof WitnessSectionUnavailableError) throw e;
    // a reveal whose numbering no backend could prove, with each cause named
    if (e instanceof EnvelopeIndexUnprovenError) throw e;
    // the step cap is deterministic: every backend walks to the same step
    if (e instanceof SatStepLimitError) throw e;
    throw new SatIdentityError('BUILD_FAILED', (e as Error).message);
  }

  const trust =
    options.trustHeader ??
    makeHeaderTrust({
      esploras: anchors,
      minAgreement: options.minHeaderAgreement,
      minConfirmations: options.minConfirmations,
      checkpoints: options.checkpoints ?? MAINNET_CHECKPOINTS,
      // every pool member that served bytes is barred from attesting
      proofSources: pool.usedBaseUrls,
      powLimitBits: options.powLimitBits,
    });

  const anchor = async (
    hop: SatGenealogyBundleJson['reveal'],
    label: string,
  ): Promise<HeaderTrustReport> => {
    const header = parseHeader(hexToBytes(hop.block.header));
    try {
      return await trust(header, hop.block.height);
    } catch (e) {
      throw new SatIdentityError(
        'HEADER_TRUST',
        `${label} at height ${hop.block.height}: ${(e as Error).message}`,
      );
    }
  };

  // both endpoint headers are anchored BEFORE the offline verification, so a
  // coinbase below the BIP34 boundary has its claimed height attested by the
  // time verifySatGenealogy asks. The core hook is synchronous and cannot
  // await an attesting round trip, so the hook it receives reports the work
  // this function already did.
  const headerTrust = {
    reveal: await anchor(built.bundle.reveal, 'reveal'),
    coinbase: await anchor(built.bundle.coinbase, 'coinbase'),
  };

  let identity: VerifiedSatIdentity;
  try {
    identity = verifySatGenealogy(built.bundle, {
      powLimitBits: options.powLimitBits,
      trustHeader: () => {},
    });
  } catch (e) {
    if (e instanceof CustodyUnsupportedError) throw e;
    // an unprovable index is a property of the reveal, not a forged bundle
    if (e instanceof EnvelopeIndexUnprovenError) throw e;
    throw new SatIdentityError('VERIFY_FAILED', (e as Error).message);
  }

  return { identity, headerTrust, bundle: built.bundle };
}
