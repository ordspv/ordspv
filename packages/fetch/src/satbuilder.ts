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
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatPositionError,
  SatStepLimitError,
  type BlockHeader,
  type GenealogyStepJson,
  type HeaderAttestation,
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
  type AnchorBackend,
  type WitnessSectionMode,
} from './custodybuilder.js';
import { isRecordableBuildRefusal, type WrapperCode } from './taxonomy.js';
import { makeHeaderTrust, MAINNET_CHECKPOINTS, type HeaderTrustReport } from './headertrust.js';
import { DEFAULT_ANCHOR_SOURCES, DEFAULT_ESPLORA } from './resolver.js';
import {
  sharedDomainRefusal,
  type DomainRefusal,
  type NoAnswer,
  type OnAttempt,
} from './failover.js';

export class SatBuildError extends Error {}

/**
 * A failure that rests on data the backend leading the attempt served.
 *
 * Four requests decide the domain refusals the walk can raise: the reveal's
 * tx hex, its status, its merkle proof, and the terminal coinbase's status,
 * whose block_height is the height that places the traced position against
 * the subsidy boundary. `fetchSatIdentity` makes them against the leading
 * member alone instead of through the pool: a refusal recorded under a
 * backend's name has to rest on data that backend served itself.
 *
 * The class covers a phase, not a request list. Any failure raised while the
 * build assembles from lead-served data, from the reveal fetch through the
 * reveal hop's assembly, prev-tx coverage and start-position derivation, and
 * again through the terminal coinbase hop's assembly, is one member's
 * failure, whether the request itself failed or the value it returned did:
 * an unconfirmed status, a missing envelope, a named prev-tx output that
 * does not exist. The wrapper records it as that member's cause and leads
 * the next attempt with the next member. The recordable refusal classes,
 * `SatPositionError`, and the terminal `EnvelopeIndexUnprovenError` pass
 * through the span unwrapped, since each already has its own arm in the
 * loop. Pool exhaustion on a pooled request outside the span still ends the
 * whole build, because that throw already means every member failed the
 * request.
 */
export class RevealSourceError extends SatBuildError {}

/**
 * The walk hit its step cap, so a caller can tell an ancestry that is merely
 * deeper than the cap from a backend that failed.
 *
 * The class is defined in `@ordspv/core` and re-exported here, because the
 * verifier refuses an over-deep bundle on the same ground and a caller that
 * discriminates on the class has to see one class from both sides. It is
 * therefore an `Error` rather than a `SatBuildError`; nothing catches the
 * builder's base class to reach it.
 *
 * The depth that reached the cap is a function of the start position, and that
 * position is read out of a reveal witness the builder has not bound, so one
 * backend can produce this refusal where another does not. `fetchSatIdentity`
 * therefore records it as that backend's cause and leads the next attempt with
 * another member, at the cost of a second full walk.
 */
export { SatStepLimitError };

/**
 * A traced position that does not land in a transaction's sat space, re-exported
 * from `@ordspv/core` for the same reason the step cap is: the verifier refuses
 * on the same ground and a caller discriminating on the class has to see one
 * class from both sides.
 *
 * The phase is doing the work again. Raised by a builder the position came out
 * of a pointer and an envelope input read from a reveal witness nothing has
 * bound, so it is one backend's word and both build loops rotate on it. Raised
 * by a verifier the bundle had already bound its witness, so the document is
 * invalid and the CLI reports it that way.
 */
export { SatPositionError };

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
    /**
     * The backend the walk's deciding requests are made against: the
     * reveal's tx hex, its status, its merkle proof, and the terminal
     * coinbase's status, whose answers decide every domain refusal the walk
     * can raise. Everything checked against bytes a txid already fixes
     * (prev txs, headers, block info, the funding walk) stays on `backend`,
     * where pool fallover cannot change a domain decision, and the raw block
     * keeps its deliberate rotation through `witnessBackends`. A failure of
     * one of the four requests throws `RevealSourceError` so the caller can
     * tell one member's failure from pool exhaustion. Defaults to `backend`,
     * unwrapped.
     */
    revealSource?: AnchorBackend;
  } = {},
): Promise<BuildSatGenealogyResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const id = parseInscriptionId(inscriptionId);

  const lead = options.revealSource;
  const leadOnly = async <T>(what: string, call: (m: AnchorBackend) => Promise<T>): Promise<T> => {
    if (!lead) return call(backend);
    try {
      return await call(lead);
    } catch (e) {
      throw new RevealSourceError(
        `${what} failed at the leading backend ${lead.baseUrl}: ${(e as Error).message}`,
      );
    }
  };
  // the phase rule behind RevealSourceError: any failure raised inside a span
  // whose decisions rest on lead-served data is one member's failure, whether
  // the request failed or the value it returned did, so the wrapper records
  // it as that member's cause and leads the next attempt with another member.
  // What passes through unwrapped already has its own arm in the loop: the
  // classes the taxonomy marks recordable, SatPositionError beside them, the
  // terminal EnvelopeIndexUnprovenError, and a failure the leadOnly wrapper
  // classified itself
  const leadDerived = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    if (!lead) return fn();
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof RevealSourceError ||
        isRecordableBuildRefusal(e) ||
        e instanceof SatPositionError ||
        e instanceof EnvelopeIndexUnprovenError
      ) {
        throw e;
      }
      throw new RevealSourceError(
        `${what} failed at the leading backend ${lead.baseUrl}: ${(e as Error).message}`,
      );
    }
  };

  // the lead-derived span opens here and closes after the start position is
  // resolved into the reveal's prev-tx coverage; the funding walk below runs
  // outside it against bytes a txid already fixes
  const { reveal, revealHop, start } = await leadDerived('reveal hop assembly', async () => {
    // the inscription id commits to the reveal's stripped hash, and every
    // funding step checks the served bytes against the txid its input names.
    // The root of that chain gets the same check here: bytes hashing to some
    // other transaction are the lead's wrong answer, thrown through the
    // RevealSourceError path so the loop records no usable answer and the
    // next member leads, rather than a domain refusal derived from them
    const { revealHex, reveal } = await leadOnly(`reveal tx ${id.txid}`, async (m) => {
      const hex = (await m.getTxHex(id.txid)).trim();
      const tx = parseTx(hexToBytes(hex));
      if (tx.txid !== id.txid) {
        throw new SatBuildError(`backend served ${tx.txid} for requested ${id.txid}`);
      }
      return { revealHex: hex, reveal: tx };
    });
    const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
    if (!inscription) {
      throw new SatBuildError(`reveal ${id.txid} has no envelope with index ${id.index}`);
    }
    const k = inscription.input;

    // the reveal hop's status and merkle proof come from the lead alone; the
    // header, the block info and the prev txs stay pooled, since none of them
    // can move a domain decision once the reveal bytes are the lead's
    const revealAnchor: AnchorBackend = lead
      ? {
          baseUrl: backend.baseUrl,
          getTxHex: (t) => backend.getTxHex(t),
          getTxStatus: (t) => leadOnly(`reveal status ${t}`, (m) => m.getTxStatus(t)),
          getMerkleProof: (t) => leadOnly(`reveal merkle proof ${t}`, (m) => m.getMerkleProof(t)),
          getHeaderHex: (h) => backend.getHeaderHex(h),
          getBlockInfo: (h) => backend.getBlockInfo(h),
        }
      : backend;
    const revealHop = await assembleAnchoredHop(revealAnchor, reveal, revealHex, k);
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
    return { reveal, revealHop, start };
  });

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
      // the lead-derived span reopens for the terminal hop: the coinbase's
      // status is the fourth lead-only deciding request, its block_height is
      // the height coinbaseSatAt reads below, which decides the subsidy
      // boundary and with it the fee-tail refusal. The hop's other requests
      // stay pooled, since the header, the block info, the merkle proof and
      // the coinbase bytes themselves are bound by the anchoring the
      // verifier re-checks, and none of them moves a domain decision
      const { coinbaseHop, sat } = await leadDerived('coinbase hop assembly', async () => {
        const coinbaseAnchor: AnchorBackend = lead
          ? {
              baseUrl: backend.baseUrl,
              getTxHex: (t) => backend.getTxHex(t),
              getTxStatus: (t) => leadOnly(`coinbase status ${t}`, (m) => m.getTxStatus(t)),
              getMerkleProof: (t) => backend.getMerkleProof(t),
              getHeaderHex: (h) => backend.getHeaderHex(h),
              getBlockInfo: (h) => backend.getBlockInfo(h),
            }
          : backend;
        const coinbaseHop = await assembleAnchoredHop(coinbaseAnchor, tx, hex, -1);
        const pos = outputSpacePosition(tx, expectVout, offset);
        // throws CustodyUnsupportedError for fee-tail positions, before the
        // caller spends anything on verification
        const sat = coinbaseSatAt(tx, pos, coinbaseHop.block.height);
        return { coinbaseHop, sat };
      });
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
  /**
   * Anchor both endpoint headers instead of `makeHeaderTrust`. Throw to
   * reject. The report's `attests` field is passed to the core verifier, so a
   * hook that returns `'hash-at-height'` there lets a terminal coinbase below
   * the BIP34 boundary be accepted, and a rejection-only hook leaves such a
   * bundle refused with `CoinbaseHeightUnprovenError`.
   */
  trustHeader?: (
    header: import('@ordspv/core').BlockHeader,
    height: number,
  ) => Promise<HeaderTrustReport>;
  /**
   * Called once per build attempt, before it runs, with the member leading it
   * and what ended the attempt before. An attempt here is a whole walk, which
   * on a deep ancestry is thousands of requests, so a caller that shows
   * progress has to be told a rotation happened.
   */
  onAttempt?: OnAttempt;
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
    public readonly code: WrapperCode,
    message: string,
  ) {
    super(message);
    this.name = 'SatIdentityError';
  }
}

/**
 * The core `trustHeader` hook an already-anchored build hands the verifier.
 *
 * It answers per header rather than per call: each anchored endpoint reports
 * its own verdict, so a rule that reads an attestation at a hop other than the
 * one the caller had in mind gets that hop's answer instead of another's. A
 * header no endpoint here anchored is a question this hook cannot answer, and
 * it throws rather than guessing.
 *
 * The key is the hash and the height together, because the value says hash at
 * height and nothing weaker. An anchor establishes that this hash is the block
 * at that height, so answering the same verdict for the same hash presented at
 * another height would hand back an attestation of a pair nobody attested to.
 *
 * The core hook is synchronous and cannot await an attesting round trip, which
 * is why the anchoring runs first and this reports what it found.
 */
export function perHeaderAttestation(
  endpoints: { hash: string; height: number; report: HeaderTrustReport }[],
): (header: BlockHeader, height: number) => HeaderAttestation {
  const key = (hash: string, height: number): string => `${hash.toLowerCase()}@${height}`;
  const byHashHeight = new Map(endpoints.map((e) => [key(e.hash, e.height), e.report]));
  return (header, height) => {
    const report = byHashHeight.get(key(header.hash, height));
    if (report) return report.attests;
    throw new Error(
      `verifier asked about header ${header.hash} at height ${height}, which this ` +
        `build anchored neither endpoint for at that height`,
    );
  };
}

export async function fetchSatIdentity(
  inscriptionId: string,
  options: FetchSatIdentityOptions = {},
): Promise<FetchSatIdentityResult> {
  const members = (options.esplora ?? DEFAULT_ESPLORA).map(
    (u) => new EsploraBackend(u, options.fetchFn, options.limits ?? {}),
  );
  const anchors = (options.anchorSources ?? DEFAULT_ANCHOR_SOURCES).map(
    (u) => new EsploraBackend(u, options.fetchFn, options.limits ?? {}),
  );

  // One pool, one walk: a mid-walk failure rotates to another member and
  // retries that request, instead of restarting thousands of steps from the
  // reveal. A domain refusal is the one failure rotation cannot answer,
  // because it comes out of a reveal witness nothing has bound rather than out
  // of a failed request, so each attempt leads with a different member and
  // pays for the whole walk again. The deciding requests go to member i
  // alone (`revealSource` below), so a refusal recorded under member i's
  // name rests on data that member served itself rather than on whatever
  // the pool fell over to.
  let built: BuildSatGenealogyResult | undefined;
  let pool: PooledEsploraBackend | undefined;
  let leadBaseUrl = '';
  const buildErrors: string[] = [];
  const refusals: DomainRefusal[] = [];
  // the attempt that ended some other way, which here is a pool-wide transport
  // failure or a walk that could not be completed; a refusal reported over it
  // says it produced no usable answer rather than claiming the whole pool
  // agreed with the refusal
  const noAnswer: NoAnswer[] = [];
  // members the break below skipped. They led nothing and stand behind
  // nothing, and counting them is what keeps the three groups summing to the
  // configured count, so a refusal reported over them is non-unanimous by
  // construction rather than dropped for not adding up
  const neverLed: string[] = [];
  let lastCause: Error | undefined;
  for (let i = 0; i < members.length; i++) {
    const attempt = new PooledEsploraBackend([...members.slice(i), ...members.slice(0, i)]);
    options.onAttempt?.({
      baseUrl: members[i].baseUrl,
      attempt: i,
      total: members.length,
      cause: lastCause,
    });
    try {
      built = await buildSatGenealogyBundle(inscriptionId, attempt, {
        maxSteps: options.maxSteps,
        witnessSection: options.witnessSection,
        // the pool already rotates every member for the raw block request and
        // names each one's cause, so it is the whole witness-backend list
        witnessBackends: [attempt],
        // the deciding requests, the reveal's three and the terminal
        // coinbase's status, come from the leading member alone, so a
        // refusal recorded under members[i] is members[i]'s word
        revealSource: members[i],
      });
      pool = attempt;
      leadBaseUrl = members[i].baseUrl;
      break;
    } catch (e) {
      // a build-time refusal is terminal only when it was derived from data
      // the txid commits. This one is: the reveal's input count is inside the
      // txid, so leading with another member cannot change the answer. No
      // builder raises the class today, since a reveal that cannot prove its
      // numbering is refused at verification rather than during the walk. The
      // arm is the terminal side of the rule with no live build-time example,
      // and it stays so the next reader does not read its absence as an
      // oversight
      if (e instanceof EnvelopeIndexUnprovenError) throw e;
      // the rest came out of bytes nothing has bound, and which classes those
      // are is the taxonomy table's committedAtBuild answer rather than a
      // list kept here: a v1-domain refusal and a step cap are read out of
      // the served envelope, and an unavailable witness section out of the
      // block hash and the position the leading member's own status and
      // merkle proof named, which a hostile member can point at a real but
      // wrong block. `SatPositionError` stays beside the predicate by name:
      // the CLI table excludes it because a verifier raising it is a
      // forgery, and at build it comes from the pointer and the envelope
      // input in that same unbound witness, so the loop rotates on it too.
      // Record the refusal and lead the next attempt with another member
      if (isRecordableBuildRefusal(e) || e instanceof SatPositionError) {
        refusals.push({ baseUrl: members[i].baseUrl, error: e });
        lastCause = e as Error;
        buildErrors.push(`${members[i].baseUrl}: ${(e as Error).message}`);
        continue;
      }
      // a deciding reveal request failed at the leading member alone, which
      // says nothing about the rest of the pool: it is this member's failure,
      // recorded as producing no usable answer, and the next attempt leads
      // with the next member. It must not reach the break below, whose
      // premise is that every member already failed
      if (e instanceof RevealSourceError) {
        buildErrors.push(`${members[i].baseUrl}: ${(e as Error).message}`);
        noAnswer.push({ baseUrl: members[i].baseUrl, error: e as Error });
        lastCause = e as Error;
        continue;
      }
      // a transport failure on a pooled request ends the whole build here,
      // and the reason is structural. This walk runs through a
      // PooledEsploraBackend whose `run` throws only after every member
      // failed that request (backends.ts), so the throw already means the
      // pool failed, and a fresh lead member would walk to the same wall. The
      // custody side builds through one EsploraBackend per attempt, where a
      // transport failure is one backend's and advancing is right.
      //
      // What the pool does not rotate on is a content failure: a member
      // serving bytes that hash wrong is caught outside `run`, at the txid
      // check below the walk's getTxHex and inside provenInputValues, so one
      // member serving garbage for one mid-walk request ends the build. That
      // is availability only, because that check is what makes the walk sound.
      //
      // The members this loop now skips were never led, so a refusal already
      // recorded is reported over this one only when the two together account
      // for every configured member. Otherwise the build failure stands.
      buildErrors.push(`${members[i].baseUrl}: ${(e as Error).message}`);
      noAnswer.push({ baseUrl: members[i].baseUrl, error: e as Error });
      for (const skipped of members.slice(i + 1)) neverLed.push(skipped.baseUrl);
      break;
    }
  }
  if (!built || !pool) {
    const shared = sharedDomainRefusal(refusals, members.length, noAnswer, neverLed);
    if (shared) throw shared;
    throw new SatIdentityError('BUILD_FAILED', `build failed:\n${buildErrors.join('\n')}`);
  }

  const trust =
    options.trustHeader ??
    makeHeaderTrust({
      esploras: anchors,
      minAgreement: options.minHeaderAgreement,
      minConfirmations: options.minConfirmations,
      checkpoints: options.checkpoints ?? MAINNET_CHECKPOINTS,
      // every pool member that served bytes is barred from attesting, and
      // the successful attempt's lead is barred by name: the deciding
      // requests do not pass through the pool, so a lead that served only
      // them would never enter usedBaseUrls and could vote on the bytes it
      // chose
      proofSources: new Set([...pool.usedBaseUrls, leadBaseUrl]),
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
  // the two anchor() calls below already did.
  const headerTrust = {
    reveal: await anchor(built.bundle.reveal, 'reveal'),
    coinbase: await anchor(built.bundle.coinbase, 'coinbase'),
  };

  const marker = perHeaderAttestation([
    {
      hash: built.bundle.reveal.block.hash,
      height: built.bundle.reveal.block.height,
      report: headerTrust.reveal,
    },
    {
      hash: built.bundle.coinbase.block.hash,
      height: built.bundle.coinbase.block.height,
      report: headerTrust.coinbase,
    },
  ]);

  let identity: VerifiedSatIdentity;
  try {
    identity = verifySatGenealogy(built.bundle, {
      // the caller's cap is the bound on both sides of this build. The walk
      // stops at it and the verifier reads under it, so a raised cap that
      // built a deep ancestry is not refused by the verifier's own default
      maxSteps: options.maxSteps,
      powLimitBits: options.powLimitBits,
      trustHeader: marker,
    });
  } catch (e) {
    if (e instanceof CustodyUnsupportedError) throw e;
    // a bundle deeper than the cap is a refusal to read rather than a claim
    // that it is forged, and the caller raises the cap to read it. The walk
    // and this read now run under one bound, so nothing this build produced
    // reaches it; the arm is the class's terminal side, the way the envelope
    // numbering arm above is
    if (e instanceof SatStepLimitError) throw e;
    // an unprovable index is a property of the reveal, not a forged bundle
    if (e instanceof EnvelopeIndexUnprovenError) throw e;
    // an unanchored sub-BIP34 height likewise: the bundle may be honest and
    // simply lacks the attestation that binds its height, which is a different
    // fact from a forgery and the caller has to be able to tell them apart
    if (e instanceof CoinbaseHeightUnprovenError) throw e;
    throw new SatIdentityError('VERIFY_FAILED', (e as Error).message);
  }

  return { identity, headerTrust, bundle: built.bundle };
}
