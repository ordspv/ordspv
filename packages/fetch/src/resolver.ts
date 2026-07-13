import {
  bytesToHex,
  decodeCborJson,
  hexToBytes,
  sha256,
  verifyProofBundle,
  type BlockHeader,
  type Inscription,
  type L2Assurances,
  type VerifiedInscription,
} from '@ordspv/core';
import { EsploraBackend, OrdBackend, type BackendLimits, type FetchFn } from './backends.js';
import { boundedDecompressor, defaultDecompressor, type Decompressor } from './decompress.js';
import { makeHeaderTrust, MAINNET_CHECKPOINTS, type HeaderTrustReport } from './headertrust.js';
import { buildProofBundle } from './proofbuilder.js';
import { parseOrdUri, type ParsedOrdUri } from './uri.js';

export type VerificationMode = 'none' | 'L1' | 'L2' | 'L3';

export class OrdResolveError extends Error {
  constructor(
    public readonly code:
      | 'BAD_URI'
      | 'NOT_FOUND'
      | 'NO_CONTENT'
      | 'VERIFY_FAILED'
      | 'HEADER_TRUST'
      | 'INTEGRITY'
      | 'INTEGRITY_INDETERMINATE'
      | 'BACKEND',
    message: string,
  ) {
    super(message);
    this.name = 'OrdResolveError';
  }
}

export interface ResolverOptions {
  /** esplora API base URLs (proof + chain data). Order = preference. */
  esplora?: string[];
  /** ord server base URLs (gateway-mode content). Order = preference. */
  ordGateways?: string[];
  /** default verification level for resolve() (default 'L2') */
  verification?: VerificationMode;
  /**
   * Independent sources that must support a non-checkpoint header (default 2:
   * the proof-building backend plus one other agreeing esplora). The builder
   * is excluded from the attesting vote; anchoring fails closed below this.
   */
  minHeaderAgreement?: number;
  minConfirmations?: number;
  checkpoints?: ReadonlyMap<number, string>;
  /**
   * Compact-bits proof-of-work floor for accepted headers. Defaults to the
   * mainnet powLimit (0x1d00ffff); pass the network's own limit (or null to
   * disable) when resolving against non-mainnet chains.
   */
  powLimitBits?: number | null;
  /**
   * Replace checkpoint/M-of-N anchoring entirely with a custom header anchor
   * (e.g. headerSyncTrust over a locally synced chain; see
   * `@ordspv/fetch/headersync`). Throw to reject the header.
   */
  trustHeader?: (header: BlockHeader, height: number) => Promise<HeaderTrustReport>;
  fetchFn?: FetchFn;
  decompressor?: Decompressor;
  /** cap on decoded (decompressed) body size when auto-decoding tag-9 encodings */
  maxDecompressedBytes?: number;
  /** per-request deadline and per-endpoint response-size caps for all backends */
  limits?: Partial<BackendLimits>;
}

export interface Verification {
  level: VerificationMode;
  blockHash?: string;
  height?: number;
  l2?: L2Assurances;
  headerTrust?: HeaderTrustReport;
  /** sha256 (hex) of the stored body bytes actually served */
  bodySha256?: string;
  integrityChecked: boolean;
}

export interface ResolveResult {
  uri: ParsedOrdUri;
  /** body bytes after content-encoding handling (see `decoded`) */
  body: Uint8Array;
  contentType?: string;
  /** on-chain content-encoding, if the body is still encoded */
  contentEncoding?: string;
  /**
   * tag-9 content-encoding declared by the SERVED source's envelope, from the
   * envelope parse (attestation-grade; transport headers are ambiguous through
   * CDNs). Unlike `contentEncoding` it survives decoding; only set on verified
   * paths, where the envelope was actually parsed.
   */
  storedContentEncoding?: string;
  /** true when the resolver decoded the on-chain content-encoding */
  decoded: boolean;
  verification: Verification;
  /** envelope-level data of the ADDRESSED inscription (not the delegate) */
  inscription?: Inscription;
  /** set when content was served from a delegate */
  viaDelegate?: string;
  /** decoded CBOR metadata (metadata path only) */
  metadataJson?: unknown;
}

export const DEFAULT_ESPLORA = ['https://mempool.space/api', 'https://blockstream.info/api'];
export const DEFAULT_ORD_GATEWAYS = ['https://ordinals.com'];

export class OrdResolver {
  private esploras: EsploraBackend[];
  private ordServers: OrdBackend[];
  private options: ResolverOptions;
  private decompressor: Decompressor;

  constructor(options: ResolverOptions = {}) {
    this.options = options;
    const fetchFn = options.fetchFn;
    const limits = options.limits ?? {};
    this.esploras = (options.esplora ?? DEFAULT_ESPLORA).map(
      (u) => new EsploraBackend(u, fetchFn, limits),
    );
    this.ordServers = (options.ordGateways ?? DEFAULT_ORD_GATEWAYS).map(
      (u) => new OrdBackend(u, fetchFn, limits),
    );
    this.decompressor =
      options.decompressor ??
      (options.maxDecompressedBytes !== undefined
        ? boundedDecompressor(options.maxDecompressedBytes)
        : defaultDecompressor);
  }

  /** Resolve an ord URI to verified bytes. */
  async resolve(uri: string, overrides: { verification?: VerificationMode } = {}): Promise<ResolveResult> {
    let parsed: ParsedOrdUri;
    try {
      parsed = parseOrdUri(uri);
    } catch (e) {
      throw new OrdResolveError('BAD_URI', (e as Error).message);
    }
    const mode = overrides.verification ?? this.options.verification ?? 'L2';

    if (mode === 'L2' || mode === 'L3') return this.resolveVerified(parsed, mode);
    return this.resolveViaGateway(parsed, mode);
  }

  /** fetch()-shaped convenience. */
  async fetch(uri: string, overrides: { verification?: VerificationMode } = {}): Promise<Response> {
    const result = await this.resolve(uri, overrides);
    return toResponse(result);
  }

  // ---------- verified path (chain data, untrusted servers) ----------

  private async withEsplora<T>(
    fn: (e: EsploraBackend) => Promise<T>,
  ): Promise<{ value: T; source: EsploraBackend }> {
    const errors: string[] = [];
    for (const e of this.esploras) {
      try {
        return { value: await fn(e), source: e };
      } catch (err) {
        errors.push(`${e.baseUrl}: ${(err as Error).message}`);
      }
    }
    throw new OrdResolveError('BACKEND', `all esplora backends failed:\n${errors.join('\n')}`);
  }

  private async verifyInscription(
    idString: string,
    level: 'L2' | 'L3',
  ): Promise<{ verified: VerifiedInscription; headerTrust: HeaderTrustReport }> {
    const parsed = parseOrdUri(idString);
    const { value: bundle, source } = await this.withEsplora((e) =>
      buildProofBundle(e, parsed.id, level),
    );
    let verified: VerifiedInscription;
    try {
      verified = verifyProofBundle(bundle);
    } catch (e) {
      throw new OrdResolveError('VERIFY_FAILED', (e as Error).message);
    }
    const trust =
      this.options.trustHeader ??
      makeHeaderTrust({
        esploras: this.esploras,
        minAgreement: this.options.minHeaderAgreement,
        minConfirmations: this.options.minConfirmations,
        checkpoints: this.options.checkpoints ?? MAINNET_CHECKPOINTS,
        // the backend that built the proof cannot also attest to its header
        proofSource: source.baseUrl,
        powLimitBits: this.options.powLimitBits,
      });
    let headerTrust: HeaderTrustReport;
    try {
      headerTrust = await trust(verified.header, verified.height);
    } catch (e) {
      throw new OrdResolveError('HEADER_TRUST', (e as Error).message);
    }
    return { verified, headerTrust };
  }

  private async resolveVerified(parsed: ParsedOrdUri, level: 'L2' | 'L3'): Promise<ResolveResult> {
    // headerTrust is reassigned when a delegate serves the content: the report
    // must describe the block of the bytes actually served
    let { verified, headerTrust } = await this.verifyInscription(parsed.idString, level);
    const inscription = verified.inscription;

    if (parsed.path === 'metadata') {
      if (!inscription.metadata) throw new OrdResolveError('NO_CONTENT', 'inscription has no metadata');
      const body = inscription.metadata;
      this.checkIntegrity(parsed, body);
      return {
        uri: parsed,
        body,
        contentType: 'application/cbor',
        decoded: false,
        metadataJson: safeDecodeCbor(body),
        inscription,
        verification: this.verification(level, verified, headerTrust, body, parsed),
      };
    }

    // content source: the inscription itself, or its delegate (one hop, ord parity)
    let source = inscription;
    let viaDelegate: string | undefined;
    let sourceVerified = verified;
    if (parsed.path === 'content' && inscription.delegate) {
      const delegate = await this.verifyInscription(inscription.delegate, level);
      source = delegate.verified.inscription;
      sourceVerified = delegate.verified;
      headerTrust = delegate.headerTrust;
      viaDelegate = inscription.delegate;
    }
    if (!source.body) {
      throw new OrdResolveError(
        'NO_CONTENT',
        viaDelegate ? `delegate ${viaDelegate} has no body` : 'inscription has no body',
      );
    }

    const stored = source.body;
    this.checkIntegrity(parsed, stored);

    const storedContentEncoding = source.contentEncoding;
    let body = stored;
    let decoded = false;
    let contentEncoding = storedContentEncoding;
    if (contentEncoding) {
      const attempt = await this.decompressor(contentEncoding, stored);
      if (attempt) {
        body = attempt;
        decoded = true;
        contentEncoding = undefined;
      }
    }

    return {
      uri: parsed,
      body,
      contentType: source.contentType,
      contentEncoding,
      storedContentEncoding,
      decoded,
      inscription,
      viaDelegate,
      verification: this.verification(level, sourceVerified, headerTrust, stored, parsed),
    };
  }

  private verification(
    level: 'L2' | 'L3',
    verified: VerifiedInscription,
    headerTrust: HeaderTrustReport,
    stored: Uint8Array,
    parsed: ParsedOrdUri,
  ): Verification {
    return {
      level,
      blockHash: verified.header.hash,
      height: verified.height,
      l2: verified.l2,
      headerTrust,
      bodySha256: bytesToHex(sha256(stored)),
      integrityChecked: parsed.integrity !== undefined,
    };
  }

  private checkIntegrity(parsed: ParsedOrdUri, stored: Uint8Array): void {
    if (!parsed.integrity) return;
    const actual = bytesToHex(sha256(stored));
    if (actual !== parsed.integrity.digestHex) {
      throw new OrdResolveError(
        'INTEGRITY',
        `integrity mismatch: body sha256 ${actual}, URI pins ${parsed.integrity.digestHex}`,
      );
    }
  }

  // ---------- gateway path (trusted ord servers, optional L1 pin) ----------

  private async resolveViaGateway(parsed: ParsedOrdUri, mode: 'none' | 'L1'): Promise<ResolveResult> {
    if (mode === 'L1' && !parsed.integrity) {
      throw new OrdResolveError(
        'INTEGRITY',
        'L1 verification requires an #integrity fragment in the URI',
      );
    }
    const errors: string[] = [];
    for (const ord of this.ordServers) {
      try {
        if (parsed.path === 'metadata') {
          const hex = await ord.metadataHex(parsed.idString);
          const body = hexToBytes(hex);
          this.checkIntegrity(parsed, body);
          return {
            uri: parsed,
            body,
            contentType: 'application/cbor',
            decoded: false,
            metadataJson: safeDecodeCbor(body),
            verification: {
              level: mode,
              bodySha256: bytesToHex(sha256(body)),
              integrityChecked: parsed.integrity !== undefined,
            },
          };
        }
        const res =
          parsed.path === 'content'
            ? await ord.content(parsed.idString)
            : await ord.undelegatedContent(parsed.idString);
        const body = new Uint8Array(await res.arrayBuffer());
        const contentEncoding = res.headers.get('content-encoding') ?? undefined;
        if (parsed.integrity) {
          const actual = bytesToHex(sha256(body));
          if (actual !== parsed.integrity.digestHex) {
            // fetch() may have transparently decoded the transport encoding,
            // in which case the stored-bytes pin cannot be evaluated here.
            throw new OrdResolveError(
              contentEncoding ? 'INTEGRITY_INDETERMINATE' : 'INTEGRITY',
              contentEncoding
                ? `body was transport-decoded (${contentEncoding}); use L2/L3 to check an integrity pin on encoded inscriptions`
                : `integrity mismatch: body sha256 ${actual}, URI pins ${parsed.integrity.digestHex}`,
            );
          }
        }
        return {
          uri: parsed,
          body,
          contentType: res.headers.get('content-type') ?? undefined,
          contentEncoding,
          decoded: false,
          verification: {
            level: mode,
            bodySha256: bytesToHex(sha256(body)),
            integrityChecked: parsed.integrity !== undefined,
          },
        };
      } catch (e) {
        if (e instanceof OrdResolveError && e.code !== 'BACKEND') throw e;
        errors.push(`${ord.baseUrl}: ${(e as Error).message}`);
      }
    }
    throw new OrdResolveError('BACKEND', `all ord gateways failed:\n${errors.join('\n')}`);
  }
}

function safeDecodeCbor(bytes: Uint8Array): unknown {
  try {
    return decodeCborJson(bytes);
  } catch {
    return undefined;
  }
}

/** Materialize a ResolveResult as a standard Response. */
export function toResponse(result: ResolveResult): Response {
  const headers = new Headers();
  headers.set('content-type', result.contentType ?? 'application/octet-stream');
  if (result.contentEncoding) headers.set('content-encoding', result.contentEncoding);
  // attestation: the envelope's tag-9 encoding, NEVER copied from transport
  // headers (SPEC-GATEWAY §5; Content-Encoding is ambiguous through CDNs)
  if (result.storedContentEncoding) {
    headers.set('x-ord-content-encoding', result.storedContentEncoding);
  }
  headers.set('x-ord-verification', result.verification.level);
  if (result.verification.blockHash) headers.set('x-ord-block', result.verification.blockHash);
  if (result.verification.height !== undefined) {
    headers.set('x-ord-height', String(result.verification.height));
  }
  if (result.verification.bodySha256) headers.set('x-ord-body-sha256', result.verification.bodySha256);
  if (result.viaDelegate) headers.set('x-ord-delegate', result.viaDelegate);
  headers.set('cache-control', 'public, max-age=1209600, immutable');
  return new Response(result.body.slice(), { status: 200, headers });
}

/** One-shot convenience mirroring @helia/verified-fetch ergonomics. */
export async function ordFetch(
  uri: string,
  options: ResolverOptions & { verification?: VerificationMode } = {},
): Promise<Response> {
  const resolver = new OrdResolver(options);
  return resolver.fetch(uri, { verification: options.verification });
}
