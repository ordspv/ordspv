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
  hexToBytes,
  inscriptionsFromTx,
  parseInscriptionId,
  genesisSatpoint,
  transferSatpoint,
  provenInputValues,
  formatSatpoint,
  verifyCustodyBundle,
  CustodyUnsupportedError,
  type CustodyBundleJson,
  type CustodyHopJson,
  type Satpoint,
  type VerifiedCustody,
  type ParsedTx,
} from '@ordspv/core';
import { EsploraBackend, type EsploraOutspend, type FetchFn, type BackendLimits } from './backends.js';
import {
  makeHeaderTrust,
  MAINNET_CHECKPOINTS,
  type HeaderTrustReport,
} from './headertrust.js';
import { DEFAULT_ESPLORA } from './resolver.js';

export interface CustodyBackend {
  readonly baseUrl: string;
  getTxHex(txid: string): Promise<string>;
  getTxStatus(txid: string): Promise<{ confirmed: boolean; block_height?: number; block_hash?: string }>;
  getMerkleProof(txid: string): Promise<{ block_height: number; merkle: string[]; pos: number }>;
  getHeaderHex(blockHash: string): Promise<string>;
  getBlockInfo(blockHash: string): Promise<{ tx_count: number }>;
  getOutspend(txid: string, vout: number): Promise<EsploraOutspend>;
}

export interface BuildCustodyResult {
  bundle: CustodyBundleJson;
  /** set when the walk stopped at an unconfirmed spend of the final satpoint */
  pendingSpendTxid?: string;
}

export class CustodyBuildError extends Error {}

async function assembleHop(
  backend: CustodyBackend,
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
 * Build a custody bundle for an inscription by walking confirmed outspends
 * from its reveal. The result is UNVERIFIED; callers must run
 * `verifyCustodyBundle` (fetchCustody does both).
 */
export async function buildCustodyBundle(
  inscriptionId: string,
  backend: CustodyBackend,
  options: { maxHops?: number } = {},
): Promise<BuildCustodyResult> {
  const maxHops = options.maxHops ?? 64;
  const id = parseInscriptionId(inscriptionId);

  const revealHex = await backend.getTxHex(id.txid);
  const reveal = parseTx(hexToBytes(revealHex.trim()));
  const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
  if (!inscription) {
    throw new CustodyBuildError(`reveal ${id.txid} has no envelope with index ${id.index}`);
  }

  const revealHop = await assembleHop(backend, reveal, revealHex, inscription.input);
  const hops: CustodyHopJson[] = [revealHop];

  // working (unverified) satpoint to know which outpoint to walk next
  let current: Satpoint = genesisSatpoint(
    reveal,
    inscription,
    provenInputValues(reveal, revealHop.prevTxs, inscription.input),
    revealHop.block.height,
  );
  let pendingSpendTxid: string | undefined;

  for (let h = 1; h <= maxHops; h++) {
    const outspend = await backend.getOutspend(current.txid, current.vout);
    if (!outspend.spent) break;
    if (!outspend.txid) throw new CustodyBuildError('outspend reports spent without a txid');
    if (!outspend.status?.confirmed) {
      pendingSpendTxid = outspend.txid;
      break;
    }
    const hex = await backend.getTxHex(outspend.txid);
    const tx = parseTx(hexToBytes(hex.trim()));
    const j = tx.inputs.findIndex((inp) => inp.prevTxid === current.txid && inp.vout === current.vout);
    if (j === -1) {
      throw new CustodyBuildError(
        `${outspend.txid} claimed to spend ${formatSatpoint(current)} but does not`,
      );
    }
    const hop = await assembleHop(backend, tx, hex, j);
    hops.push(hop);
    current = transferSatpoint(
      tx,
      provenInputValues(tx, hop.prevTxs, j),
      current,
      hop.block.height,
    );
    if (h === maxHops) throw new CustodyBuildError(`custody path exceeds ${maxHops} hops`);
  }

  return {
    bundle: {
      version: 1,
      inscriptionId: inscriptionId.toLowerCase(),
      hops,
      finalSatpoint: formatSatpoint(current),
    },
    pendingSpendTxid,
  };
}

// ---------------------------------------------------------------------------
// High-level: build, verify, anchor, and tip-check with failover
// ---------------------------------------------------------------------------

export interface FetchCustodyOptions {
  esplora?: string[];
  fetchFn?: FetchFn;
  limits?: Partial<BackendLimits>;
  maxHops?: number;
  /** see HeaderTrustOptions; defaults mirror the resolver */
  minHeaderAgreement?: number;
  minConfirmations?: number;
  checkpoints?: Map<number, string>;
  powLimitBits?: number | null;
  trustHeader?: (header: import('@ordspv/core').BlockHeader, height: number) => Promise<HeaderTrustReport>;
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

  // build with failover
  let built: BuildCustodyResult | undefined;
  let source: EsploraBackend | undefined;
  const buildErrors: string[] = [];
  for (const backend of backends) {
    try {
      built = await buildCustodyBundle(inscriptionId, backend, { maxHops: options.maxHops });
      source = backend;
      break;
    } catch (e) {
      // a v1-domain refusal is a property of the path, not of the backend:
      // every backend would report the same, so surface it as-is
      if (e instanceof CustodyUnsupportedError) throw e;
      buildErrors.push(`${backend.baseUrl}: ${(e as Error).message}`);
    }
  }
  if (!built || !source) {
    throw new CustodyError('BUILD_FAILED', `all backends failed:\n${buildErrors.join('\n')}`);
  }

  // structural verification (sync, trustless)
  let custody: VerifiedCustody;
  try {
    custody = verifyCustodyBundle(built.bundle);
  } catch (e) {
    throw new CustodyError('VERIFY_FAILED', (e as Error).message);
  }

  // anchor every hop header; the builder cannot attest to its own headers
  const trust =
    options.trustHeader ??
    makeHeaderTrust({
      esploras: backends,
      minAgreement: options.minHeaderAgreement,
      minConfirmations: options.minConfirmations,
      checkpoints: options.checkpoints ?? MAINNET_CHECKPOINTS,
      proofSource: source.baseUrl,
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
