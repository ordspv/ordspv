import {
  calcNextBits,
  checkProofOfWork,
  concatBytes,
  displayToInternal,
  hexToBytes,
  internalToDisplay,
  parseHeader,
  sha256d,
  verifyMerkleBranch,
  workFromBits,
  MAINNET_CHAIN_PARAMS,
  type BlockHeader,
  type ChainParams,
} from '@ordspv/core';
import { MAINNET_CHECKPOINTS, HeaderTrustError, type HeaderTrustReport } from './headertrust.js';

/**
 * Header-chain sync (SPEC-VERIFICATION §4 "header sync"): a locally validated,
 * disk-persistable header chain that anchors proof bundles WITHOUT trusting any
 * server's hash-at-height answers. Validation per appended header:
 *
 *   - 80-byte parse, prev-hash linkage, embedded PoW;
 *   - difficulty retarget: at period boundaries `bits` must equal
 *     calcNextBits(...) (exact pow.cpp arithmetic); within a period it must
 *     equal the previous header's bits (mainnet has no min-difficulty rule);
 *   - median-time-past: timestamp strictly greater than the median of the
 *     previous 11 (skipped for the first 11 headers after a snapshot base,
 *     which are anchored by the base hash instead);
 *   - timestamps bounded against the local clock (+2h consensus drift);
 *   - compiled checkpoint crossings (height → hash) must match.
 *
 * Trust model note: the Electrum transport verifies server certificates by
 * default (see ElectrumTcpOptions for CA/pinning/insecure), but TLS is NOT
 * the trust anchor — every header is validated locally and reorgs are only
 * adopted on strictly greater cumulative work. TLS just denies a trivial
 * on-path attacker free tampering with an otherwise-authenticated stream.
 *
 * The chain starts from a retarget-ALIGNED trusted base (height % 2016 == 0),
 * so the first boundary after the base is fully checkable. The default base
 * covers every inscription ever (period start below inscription 0's block).
 *
 * NODE-ONLY (v1): ElectrumTcpTransport needs raw TCP/TLS sockets and
 * persistence needs a filesystem; neither exists in browsers. This module is
 * therefore a separate subpath export (`@ordspv/fetch/headersync`) kept
 * OUT of the browser bundle. Browser story: keep using checkpoint + M-of-N
 * anchoring (makeHeaderTrust), or run headerSyncTrust behind your own
 * WebSocket→Electrum bridge by implementing ElectrumTransport over it. The
 * validation core (HeaderChain) is IO-free and would run in a browser given
 * headers; only the built-in transport and file persistence are node-bound.
 */

// ---------------------------------------------------------------------------
// trusted bases
// ---------------------------------------------------------------------------

export interface HeaderChainBase {
  /** MUST be a retarget boundary (height % interval == 0) */
  height: number;
  /** 160 hex chars: the raw header at `height` */
  headerHex: string;
}

/**
 * Mainnet base: block 766080 (period start immediately below inscription 0 at
 * 767430; syncing from here covers every inscription). Hash pinned against
 * mempool.space + blockstream.info (byte-identical headers, 2026-07-11) and
 * cryptographically bound in tests: the vendored slice from this base must
 * hash-link to the in-repo-verified 767430 checkpoint.
 */
export const MAINNET_BASE_766080: HeaderChainBase = {
  height: 766080,
  headerHex:
    '0000402089138e40cd8b4832beb8013bc80b1425c8bcbe10fc280400000000000000000058a06ab0edc5653a6ab78490675a954f8d8b4d4f131728dcf965cd0022a02cdde59f8e63303808176bbe3919',
};

export interface HeaderChainOptions {
  base: HeaderChainBase;
  params?: ChainParams;
  /** enforced whenever the chain crosses one of these heights */
  checkpoints?: ReadonlyMap<number, string>;
  /** persistence file (raw concatenated 80-byte headers, base first) */
  file?: string;
  /** clock in UNIX seconds (injectable for tests); bounds header timestamps */
  now?: () => number;
}

/**
 * Consensus future-drift bound (net.h MAX_FUTURE_BLOCK_TIME): a header
 * timestamped further than this past the local clock cannot be on the
 * canonical chain and is rejected, which also blocks timestamp games that
 * try to force an artificially easy retarget.
 */
export const MAX_FUTURE_DRIFT_SECONDS = 2 * 3600;

/** Thrown when a batch's FIRST header does not link to the current tip (reorg evidence). */
export class ReorgLinkError extends Error {}

/** Opaque snapshot of a chain's in-memory state (see captureState/restoreState). */
export interface HeaderChainState {
  readonly headers: readonly BlockHeader[];
  readonly work: bigint;
  readonly dirty: boolean;
}

// ---------------------------------------------------------------------------
// the validated chain
// ---------------------------------------------------------------------------

const MTP_WINDOW = 11;

type FsModule = typeof import('node:fs');

export class HeaderChain {
  readonly baseHeight: number;
  readonly params: ChainParams;
  private readonly checkpoints: ReadonlyMap<number, string>;
  private readonly file?: string;
  private readonly now: () => number;
  /** node:fs, loaded once in open() when persistence is configured */
  private fs?: FsModule;
  private headers: BlockHeader[] = [];
  private work = 0n;
  /** true when the in-memory chain has diverged from the persistence file */
  private dirty = false;

  private constructor(options: HeaderChainOptions) {
    this.params = options.params ?? MAINNET_CHAIN_PARAMS;
    this.checkpoints = options.checkpoints ?? MAINNET_CHECKPOINTS;
    this.file = options.file;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.baseHeight = options.base.height;
    if (this.baseHeight % this.params.retargetInterval !== 0) {
      throw new Error(
        `base height ${this.baseHeight} is not a retarget boundary (interval ${this.params.retargetInterval})`,
      );
    }
    const base = parseHeader(hexToBytes(options.base.headerHex));
    if (!checkProofOfWork(base)) throw new Error('base header fails its own PoW');
    this.checkCheckpoint(this.baseHeight, base.hash);
    this.headers.push(base);
    this.work = workFromBits(base.bits);
  }

  /**
   * Open a chain; when `file` exists its contents are appended through FULL
   * validation (a tampered file cannot load). The first 80 bytes must be the
   * configured base header.
   */
  static async open(options: HeaderChainOptions): Promise<HeaderChain> {
    const chain = new HeaderChain(options);
    if (options.file) {
      chain.fs = await import('node:fs');
      if (chain.fs.existsSync(options.file)) {
        const raw = new Uint8Array(chain.fs.readFileSync(options.file));
        if (raw.length % 80 !== 0) throw new Error(`${options.file}: length not a multiple of 80`);
        if (raw.length < 80) throw new Error(`${options.file}: missing base header`);
        const baseOnDisk = parseHeader(raw.slice(0, 80));
        if (baseOnDisk.hash !== chain.tipHash) {
          throw new Error(`${options.file}: base header does not match configured base`);
        }
        chain.appendBatch(raw.slice(80), { persist: false });
        chain.dirty = false; // loaded FROM disk: memory and file agree
      } else {
        chain.persistAll();
      }
    }
    return chain;
  }

  get tipHeight(): number {
    return this.baseHeight + this.headers.length - 1;
  }

  get tipHash(): string {
    return this.headers[this.headers.length - 1].hash;
  }

  /** cumulative work from base to tip (sum of per-header expected work) */
  get chainwork(): bigint {
    return this.work;
  }

  headerAt(height: number): BlockHeader | undefined {
    return this.headers[height - this.baseHeight];
  }

  hashAt(height: number): string | undefined {
    return this.headerAt(height)?.hash;
  }

  private checkCheckpoint(height: number, hash: string): void {
    const expected = this.checkpoints.get(height);
    if (expected !== undefined && expected !== hash) {
      throw new Error(`header ${hash} at height ${height} contradicts checkpoint ${expected}`);
    }
  }

  private expectedBits(height: number, prev: BlockHeader[]): number {
    const last = prev[prev.length - 1];
    if (this.params.noRetarget) return last.bits;
    if (height % this.params.retargetInterval !== 0) return last.bits;
    // boundary: closing period is [height-interval, height-1]
    const firstIndex = height - this.params.retargetInterval - this.baseHeight;
    if (firstIndex < 0) {
      throw new Error(`cannot validate retarget at ${height}: period start below base`);
    }
    return calcNextBits(last.bits, prev[firstIndex].time, last.time, this.params);
  }

  private medianTimePast(prev: BlockHeader[]): number | undefined {
    if (prev.length < MTP_WINDOW) return undefined; // pre-base context unavailable
    const times = prev.slice(-MTP_WINDOW).map((h) => h.time);
    times.sort((a, b) => a - b);
    return times[Math.floor(MTP_WINDOW / 2)];
  }

  /**
   * Validate and append `count = raw.length/80` headers extending the tip.
   * All headers validate before anything is committed or persisted.
   *
   * A prev-hash mismatch on the FIRST header (i.e. at tipHeight+1) throws the
   * typed ReorgLinkError: it is the only failure that is evidence of a chain
   * reorganization rather than a bad batch. Every other failure (PoW, bits,
   * median-time-past, checkpoint, deep linkage break) is a plain Error and
   * must never trigger a rewind.
   */
  appendBatch(raw: Uint8Array, opts: { persist?: boolean } = {}): number {
    if (raw.length % 80 !== 0) throw new Error(`batch length ${raw.length} not a multiple of 80`);
    const staged: BlockHeader[] = [];
    let stagedWork = 0n;
    const view = (i: number) => raw.slice(i * 80, (i + 1) * 80);
    const context = () => [...this.headers, ...staged];
    const maxTime = this.now() + MAX_FUTURE_DRIFT_SECONDS;

    for (let i = 0; i < raw.length / 80; i++) {
      const header = parseHeader(view(i));
      const prev = context();
      const height = this.baseHeight + prev.length;
      const last = prev[prev.length - 1];

      if (header.prevBlock !== last.hash) {
        const message = `header at height ${height} does not link: prev ${header.prevBlock} != ${last.hash}`;
        throw i === 0 ? new ReorgLinkError(message) : new Error(message);
      }
      const expectedBits = this.expectedBits(height, prev);
      if (header.bits !== expectedBits) {
        throw new Error(
          `header at height ${height} has bits 0x${header.bits.toString(16)}, consensus requires 0x${expectedBits.toString(16)}` +
            (height % this.params.retargetInterval === 0 ? ' (retarget boundary)' : ''),
        );
      }
      if (!checkProofOfWork(header)) {
        throw new Error(`header at height ${height} fails its own PoW target`);
      }
      const mtp = this.medianTimePast(prev);
      if (mtp !== undefined && header.time <= mtp) {
        throw new Error(`header at height ${height} time ${header.time} <= median-time-past ${mtp}`);
      }
      if (header.time > maxTime) {
        throw new Error(
          `header at height ${height} time ${header.time} is more than ${MAX_FUTURE_DRIFT_SECONDS}s in the future`,
        );
      }
      this.checkCheckpoint(height, header.hash);
      staged.push(header);
      stagedWork += workFromBits(header.bits);
    }

    this.headers.push(...staged);
    this.work += stagedWork;
    if (opts.persist === false) {
      if (this.file && staged.length > 0) this.dirty = true;
    } else if (this.file && staged.length > 0) {
      if (this.dirty) {
        this.persistAll();
        this.dirty = false;
      } else {
        this.appendToFile(staged);
      }
    }
    return this.tipHeight;
  }

  /**
   * Drop headers above `height` (reorg handling). With `persist: false` the
   * rewind stays in memory (the file is rewritten once by the next persisting
   * append or an explicit flush()).
   */
  truncateTo(height: number, opts: { persist?: boolean } = {}): void {
    if (height < this.baseHeight) throw new Error('cannot truncate below base');
    const keep = height - this.baseHeight + 1;
    if (keep >= this.headers.length) return;
    for (const dropped of this.headers.slice(keep)) this.work -= workFromBits(dropped.bits);
    this.headers.length = keep;
    if (opts.persist === false) {
      if (this.file) this.dirty = true;
    } else {
      this.persistAll();
      this.dirty = false;
    }
  }

  /** write the in-memory chain to the persistence file if it has diverged */
  flush(): void {
    if (!this.dirty) return;
    this.persistAll();
    this.dirty = false;
  }

  /** snapshot the in-memory state (headers, work, file-divergence flag) */
  captureState(): HeaderChainState {
    return { headers: this.headers.slice(), work: this.work, dirty: this.dirty };
  }

  /** restore a snapshot taken by captureState (memory only; file untouched) */
  restoreState(state: HeaderChainState): void {
    this.headers = state.headers.slice();
    this.work = state.work;
    this.dirty = state.dirty;
  }

  private appendToFile(staged: BlockHeader[]): void {
    if (!this.file || !this.fs) return;
    const bytes = new Uint8Array(staged.length * 80);
    staged.forEach((h, i) => bytes.set(h.raw, i * 80));
    this.fs.appendFileSync(this.file, bytes);
  }

  private persistAll(): void {
    if (!this.file || !this.fs) return;
    const bytes = new Uint8Array(this.headers.length * 80);
    this.headers.forEach((h, i) => bytes.set(h.raw, i * 80));
    this.fs.writeFileSync(this.file, bytes);
  }
}

// ---------------------------------------------------------------------------
// Electrum transport + sync loop
// ---------------------------------------------------------------------------

export interface ElectrumTransport {
  request(method: string, params: unknown[]): Promise<unknown>;
  close?(): void;
}

export interface ElectrumTcpOptions {
  host: string;
  /** default 50002 (TLS); 50001 with tls:false */
  port?: number;
  tls?: boolean;
  timeoutMs?: number;
  /**
   * Accept ANY certificate (self-signed servers) — explicit opt-in only.
   * TLS here is transport hygiene, not the trust anchor (headers are
   * validated by PoW/checkpoints either way), but verified TLS still stops
   * trivial on-path tampering and downgrade games. Prefer `ca` or
   * `pinnedCertSha256` over this.
   */
  insecure?: boolean;
  /** additional trusted CA certificate(s), PEM (e.g. a self-hosted server's own CA) */
  ca?: string | string[];
  /**
   * Pin the server certificate by SHA-256 fingerprint (hex, colons optional,
   * as printed by `openssl x509 -fingerprint -sha256`). Replaces CA
   * validation: the connection is accepted iff the presented certificate
   * matches, which also supports self-signed deployments without `insecure`.
   */
  pinnedCertSha256?: string;
  /** cap on a single buffered protocol line (default 4 MiB) */
  maxBufferBytes?: number;
}

const DEFAULT_ELECTRUM_BUFFER_BYTES = 4 * 1024 * 1024;

function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase();
}

/**
 * Minimal newline-delimited JSON-RPC over TCP/TLS (node-only). Server
 * certificates are verified by default; see ElectrumTcpOptions for CA
 * bundles, fingerprint pinning, and the explicit `insecure` opt-out.
 */
export class ElectrumTcpTransport implements ElectrumTransport {
  private socket?: { write(d: string): void; end(): void; destroy(): void };
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private connecting?: Promise<void>;

  constructor(private readonly options: ElectrumTcpOptions) {}

  private async connect(): Promise<void> {
    if (this.socket) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const useTls = this.options.tls ?? true;
        const port = this.options.port ?? (useTls ? 50002 : 50001);
        const pinned = this.options.pinnedCertSha256
          ? normalizeFingerprint(this.options.pinnedCertSha256)
          : undefined;
        const socket = useTls
          ? (await import('node:tls')).connect({
              host: this.options.host,
              port,
              // pinning replaces chain validation; otherwise verify unless
              // the caller explicitly opted out
              rejectUnauthorized: !(this.options.insecure || pinned),
              ca: this.options.ca,
            })
          : (await import('node:net')).connect({ host: this.options.host, port });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk, socket));
        socket.on('error', (e: Error) => this.failAll(e));
        socket.on('close', () => {
          this.failAll(new Error('electrum socket closed'));
          if (this.socket === socket) this.socket = undefined;
          this.connecting = undefined;
        });
        await new Promise<void>((resolve, reject) => {
          socket.once(useTls ? 'secureConnect' : 'connect', () => {
            if (pinned) {
              const cert = (
                socket as unknown as { getPeerCertificate(): { fingerprint256?: string } }
              ).getPeerCertificate();
              const actual = cert?.fingerprint256 ? normalizeFingerprint(cert.fingerprint256) : '';
              if (actual !== pinned) {
                socket.destroy();
                reject(
                  new Error(
                    `electrum server certificate fingerprint ${actual || '(none)'} does not match pinned ${pinned}`,
                  ),
                );
                return;
              }
            }
            resolve();
          });
          socket.once('error', reject);
        });
        this.socket = socket;
      })();
      this.connecting.catch(() => {
        this.connecting = undefined; // allow reconnect attempts after failure
      });
    }
    await this.connecting;
  }

  private onData(chunk: string, socket: { destroy(): void }): void {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue; // subscription notification, ignored here
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`electrum: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else waiter.resolve(msg.result);
    }
    // a server must never need this much room for one line; kill it before
    // an unterminated stream grows the buffer without bound
    const maxBuffer = this.options.maxBufferBytes ?? DEFAULT_ELECTRUM_BUFFER_BYTES;
    if (this.buffer.length > maxBuffer) {
      this.buffer = '';
      this.failAll(new Error(`electrum receive buffer exceeded ${maxBuffer} bytes without a line terminator`));
      socket.destroy();
    }
  }

  private failAll(e: Error): void {
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    await this.connect();
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`electrum request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
  }
}

export interface SyncOptions {
  /** headers per request (Electrum servers commonly cap at 2016) */
  batchSize?: number;
  /** how deep a tip reorg we tolerate by truncating and re-requesting */
  maxReorgDepth?: number;
  /**
   * optional Electrum cp_height anchoring: when set, every batch (whose end is
   * ≤ checkpoint.height) is requested with cp_height and the returned branch
   * must fold the batch's last header hash to `root` (bitcoin-style merkle
   * over block hashes 0..height, hex, display order). Roots are derivable
   * from any fully synced chain via blockHashMerkleRoot().
   */
  checkpoint?: { height: number; root: string };
}

export interface SyncResult {
  tipHeight: number;
  added: number;
}

/**
 * Sync `chain` to the server's tip, validating every header locally.
 *
 * Reorg discipline: only a ReorgLinkError (the batch's first header failing
 * to link at tipHeight+1) triggers a one-step rewind; consensus failures
 * (PoW, bits, MTP, checkpoints) abort the sync unchanged. Rewinds and the
 * competing branch are staged IN MEMORY and adopted only if the resulting
 * chain carries strictly more cumulative work than the pre-rewind chain
 * (most-work rule, not tallest); otherwise the original state is restored
 * and the sync fails. The persistence file is rewritten once, on adoption.
 */
export async function syncHeaders(
  chain: HeaderChain,
  transport: ElectrumTransport,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const batchSize = options.batchSize ?? 2016;
  const maxReorg = options.maxReorgDepth ?? 100;
  await transport.request('server.version', ['ordspv headersync', '1.4']);
  const sub = (await transport.request('blockchain.headers.subscribe', [])) as { height: number };
  const serverTip = sub.height;

  let added = 0;
  let rewinds = 0;
  let preFork: HeaderChainState | undefined;
  try {
    while (chain.tipHeight < serverTip) {
      const start = chain.tipHeight + 1;
      const count = Math.min(batchSize, serverTip - chain.tipHeight);
      const params: unknown[] = [start, count];
      const useCp = options.checkpoint !== undefined && start + count - 1 <= options.checkpoint.height;
      if (useCp) params.push(options.checkpoint!.height);
      const res = (await transport.request('blockchain.block.headers', params)) as {
        hex: string;
        count: number;
        root?: string;
        branch?: string[];
      };
      // bound and cross-check the response before decoding: the hex must be
      // exactly the claimed header count, and never more than requested
      if (
        typeof res.hex !== 'string' ||
        typeof res.count !== 'number' ||
        !Number.isInteger(res.count) ||
        res.count <= 0 ||
        res.count > count ||
        res.hex.length !== res.count * 160
      ) {
        throw new Error(
          `electrum header batch malformed: count=${res.count}, hex length ${res.hex?.length ?? 0} (requested ${count})`,
        );
      }
      const raw = hexToBytes(res.hex);
      try {
        chain.appendBatch(raw, preFork ? { persist: false } : {});
      } catch (e) {
        // ONLY linkage failure at our tip is reorg evidence; rewind one step
        // in memory and re-request. Anything else aborts the sync.
        if (!(e instanceof ReorgLinkError) || rewinds >= maxReorg) throw e;
        rewinds++;
        preFork ??= chain.captureState();
        chain.truncateTo(Math.max(chain.baseHeight, chain.tipHeight - 1), { persist: false });
        continue;
      }
      if (useCp) {
        verifyCpBranch(chain, res, options.checkpoint!);
      }
      added += raw.length / 80;
    }
  } catch (e) {
    if (preFork) chain.restoreState(preFork);
    throw e;
  }
  if (preFork) {
    if (chain.chainwork > preFork.work) {
      chain.flush(); // adopt: single rewrite of the persistence file
    } else {
      const forkWork = chain.chainwork;
      chain.restoreState(preFork);
      throw new Error(
        `reorg rejected: competing branch chainwork ${forkWork} does not exceed current ${preFork.work} (most-work rule)`,
      );
    }
  }
  return { tipHeight: chain.tipHeight, added };
}

function verifyCpBranch(
  chain: HeaderChain,
  res: { root?: string; branch?: string[] },
  checkpoint: { height: number; root: string },
): void {
  if (!res.root || !res.branch) throw new Error('electrum response missing cp_height root/branch');
  if (res.root.toLowerCase() !== checkpoint.root.toLowerCase()) {
    throw new Error(`electrum cp root ${res.root} != pinned ${checkpoint.root}`);
  }
  const tip = chain.headerAt(chain.tipHeight)!;
  const { root } = verifyMerkleBranch(
    tip.hashLE,
    res.branch.map(displayToInternal),
    chain.tipHeight,
    checkpoint.height + 1,
  );
  if (internalToDisplay(root) !== checkpoint.root.toLowerCase()) {
    throw new Error('electrum cp branch does not fold to the pinned root');
  }
}

/**
 * Merkle root over block hashes 0..tip (Electrum cp_height convention,
 * bitcoin-style pairing with odd-node self-duplication). Run once over a
 * fully synced chain to derive roots you then pin via SyncOptions.checkpoint.
 */
export function blockHashMerkleRoot(hashesLE: Uint8Array[]): Uint8Array {
  if (hashesLE.length === 0) throw new Error('no hashes');
  let level: Uint8Array[] = hashesLE.map((h) => h.slice());
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256d(concatBytes(a, b)));
    }
    level = next;
  }
  return level[0];
}

// ---------------------------------------------------------------------------
// trustHeader adapter
// ---------------------------------------------------------------------------

/**
 * Drop-in anchor for verifyProofBundle / OrdResolver (`trustHeader` option):
 * a bundle header is accepted iff it IS the synced chain's header at that
 * height (with optional confirmation depth).
 */
export function headerSyncTrust(
  chain: HeaderChain,
  options: { minConfirmations?: number } = {},
): (header: BlockHeader, height: number) => Promise<HeaderTrustReport> {
  return async (header, height) => {
    const known = chain.hashAt(height);
    if (known === undefined) {
      throw new HeaderTrustError(
        `height ${height} outside synced chain [${chain.baseHeight}, ${chain.tipHeight}]`,
      );
    }
    if (known !== header.hash) {
      throw new HeaderTrustError(`header ${header.hash} at height ${height} contradicts synced chain ${known}`);
    }
    const confirmations = chain.tipHeight - height + 1;
    if (options.minConfirmations && confirmations < options.minConfirmations) {
      throw new HeaderTrustError(`only ${confirmations} confirmations, need ${options.minConfirmations}`);
    }
    return {
      checkpointHit: false,
      sourcesQueried: 1,
      sourcesAgreed: 1,
      independentSources: 1,
      anchored: true,
      tipHeight: chain.tipHeight,
      anchoredBySync: true,
    };
  };
}
