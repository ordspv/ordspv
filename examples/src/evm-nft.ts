/**
 * The cross-chain demo: an ERC-721 token document whose `image` is an
 * `ord:` URI, resolved and L2-verified live in the browser.
 *
 * The token metadata (inlined at build time from examples/evm-nft/metadata.json,
 * the same document tokenURI() would return) is the STARTING POINT: the page
 * extracts the ord: URI from its image field, parses it, then fetches the
 * reveal tx, header, merkle proof, and commit tx from public esplora instances
 * (CORS: *). All of those are UNTRUSTED inputs; the cryptography below is what
 * makes the bytes real. The one extra check over the plain demo is the
 * cross-chain one: the fetched body must hash to the #integrity= pin embedded
 * in the token's own metadata. The only trust anchor is one compiled-in block
 * hash (the block containing inscription 0), stated explicitly on the page.
 */
import {
  bitsToTarget,
  bytesToHex,
  checkProofOfWork,
  extractTapscript,
  hexToBytes,
  inscriptionsFromTx,
  parseHeader,
  parseTx,
  sha256,
  verifyMerkleBranch,
  verifyScriptPathCommitment,
  displayToInternal,
  type Inscription,
  type ParsedTx,
} from '@ordspv/core';
import { parseOrdUri, type ParsedOrdUri } from '../../packages/fetch/src/uri';

/** trust anchor: block 767430's hash, cross-checkable against any explorer */
const CHECKPOINT_HEIGHT = 767430;
const CHECKPOINT_HASH = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';

const ESPLORAS = ['https://mempool.space/api', 'https://blockstream.info/api'];

interface TokenMetadata {
  name?: string;
  image?: string;
  [k: string]: unknown;
}

async function esplora(path: string): Promise<Response> {
  const errors: string[] = [];
  for (const base of ESPLORAS) {
    try {
      const res = await fetch(`${base}${path}`);
      if (res.ok) return res;
      errors.push(`${base}: HTTP ${res.status}`);
    } catch (e) {
      errors.push(`${base}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all esplora sources failed for ${path}: ${errors.join('; ')}`);
}

// ---------------------------------------------------------------------------
// step runner UI
// ---------------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;

function stepElement(title: string): { pass(detail: string): void; fail(detail: string): void } {
  const li = document.createElement('li');
  li.className = 'step running';
  li.innerHTML = `<span class="mark">…</span><div><div class="title"></div><div class="detail"></div></div>`;
  (li.querySelector('.title') as HTMLElement).textContent = title;
  $('steps').appendChild(li);
  const detailElement = li.querySelector('.detail') as HTMLElement;
  const mark = li.querySelector('.mark') as HTMLElement;
  return {
    pass(detail) {
      li.className = 'step pass';
      mark.textContent = '✓';
      detailElement.textContent = detail;
    },
    fail(detail) {
      li.className = 'step fail';
      mark.textContent = '✗';
      detailElement.textContent = detail;
    },
  };
}

async function step<T>(title: string, run: () => Promise<{ value: T; detail: string }>): Promise<T> {
  const ui = stepElement(title);
  try {
    const { value, detail } = await run();
    ui.pass(detail);
    return value;
  } catch (e) {
    ui.fail((e as Error).message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// the token metadata, rendered as-is with the image field highlighted
// ---------------------------------------------------------------------------

function tokenMetadataText(): string {
  return ($('token-metadata').textContent ?? '').trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMetadata(): TokenMetadata {
  const raw = tokenMetadataText();
  const meta = JSON.parse(raw) as TokenMetadata;
  const html = raw
    .split('\n')
    .map((line) => {
      const escaped = escapeHtml(line);
      return line.includes('"image"') ? `<span class="hl">${escaped}</span>` : escaped;
    })
    .join('\n');
  $('metadata').innerHTML = html;
  return meta;
}

// ---------------------------------------------------------------------------
// the verification, step by step
// ---------------------------------------------------------------------------

async function main(meta: TokenMetadata): Promise<void> {
  $('run').setAttribute('disabled', 'true');
  $('steps').innerHTML = '';
  $('result').innerHTML = '';

  try {
    // 1. the cross-chain hop: the Bitcoin reference comes out of the token
    const parsed = await step("Parse the ord: URI from the token's image field", async () => {
      if (typeof meta.image !== 'string') throw new Error('token metadata has no image field');
      const uri: ParsedOrdUri = parseOrdUri(meta.image);
      if (!uri.integrity) throw new Error('token metadata carries no #integrity= pin');
      return {
        value: uri,
        detail:
          `inscription ${uri.idString.slice(0, 12)}…i${uri.id.index}, path /${uri.path}, ` +
          `integrity pin sha256-${uri.integrity.digestHex.slice(0, 12)}…; both the id and the ` +
          `expected content hash come from the token's metadata rather than from a server`,
      };
    });

    // 2. reveal tx: the txid is self-certifying, so recompute it from raw bytes
    const reveal = await step('Fetch reveal transaction & recompute its txid', async () => {
      const hex = (await (await esplora(`/tx/${parsed.id.txid}/hex`)).text()).trim();
      const tx = parseTx(hexToBytes(hex));
      if (tx.txid !== parsed.id.txid) {
        throw new Error(`server lied: bytes hash to ${tx.txid}`);
      }
      return {
        value: tx,
        detail: `${hex.length / 2} bytes; double-SHA256 of the stripped tx = ${tx.txid.slice(0, 16)}… ✓ matches the id inside the token's URI`,
      };
    });

    // 3. envelope
    const inscription = await step('Parse the inscription envelope from the witness', async () => {
      const inscs = inscriptionsFromTx(reveal);
      const insc = inscs.find((i) => i.index === parsed.id.index);
      if (!insc?.body) throw new Error(`no envelope at index ${parsed.id.index}`);
      if (insc.delegate) throw new Error('inscription delegates its content; this page verifies undelegated inscriptions only');
      return {
        value: insc,
        detail: `${insc.contentType}, ${insc.body.length} bytes of content in the tapscript witness; no delegate tag, so /content is this inscription's own body`,
      };
    });

    // 4. the integrity pin from the token's own metadata
    await step("Check the token's #integrity= pin over the stored bytes", async () => {
      const digest = bytesToHex(sha256(inscription.body!));
      if (digest !== parsed.integrity!.digestHex) {
        throw new Error(`stored bytes hash to ${digest.slice(0, 16)}…, not the pinned ${parsed.integrity!.digestHex.slice(0, 16)}…`);
      }
      return {
        value: undefined,
        detail:
          `sha256 of the ${inscription.body!.length} stored bytes equals the pin in the token metadata. ` +
          `This check alone (L1) needs zero Bitcoin infrastructure; the steps below anchor it to proof of work`,
      };
    });

    // 5. header: embedded PoW + the one compiled-in trust anchor
    const header = await step('Fetch block header, check proof-of-work and the pinned checkpoint', async () => {
      const headerHex = (await (await esplora(`/block/${CHECKPOINT_HASH}/header`)).text()).trim();
      const parsedHeader = parseHeader(hexToBytes(headerHex));
      if (!checkProofOfWork(parsedHeader)) throw new Error('header fails its own PoW target');
      if (parsedHeader.hash !== CHECKPOINT_HASH) {
        throw new Error(`header hashes to ${parsedHeader.hash}, not the pinned checkpoint`);
      }
      const target = bitsToTarget(parsedHeader.bits);
      const leadingZeroBits = 256 - target.toString(2).length;
      return {
        value: parsedHeader,
        detail: `block ${CHECKPOINT_HEIGHT}: hash ${parsedHeader.hash.slice(0, 20)}… meets its ~2^${256 - leadingZeroBits} target; equals the checkpoint this page pins (verify it against any explorer)`,
      };
    });

    // 6. merkle inclusion of the reveal txid in that header
    await step('Verify the txid merkle proof against the header', async () => {
      const proof = (await (await esplora(`/tx/${parsed.id.txid}/merkle-proof`)).json()) as {
        merkle: string[];
        pos: number;
      };
      const info = (await (await esplora(`/block/${CHECKPOINT_HASH}`)).json()) as { tx_count: number };
      const { root } = verifyMerkleBranch(
        reveal.txidLE,
        proof.merkle.map(displayToInternal),
        proof.pos,
        info.tx_count,
      );
      if (bytesToHex(root) !== bytesToHex(header.merkleRootLE)) {
        throw new Error('merkle branch does not fold to the header merkle root');
      }
      return {
        value: undefined,
        detail: `position ${proof.pos} of ${info.tx_count} txs; ${proof.merkle.length}-node branch folds exactly to the header's merkle root`,
      };
    });

    // 7. BIP-341: the envelope script is committed by the output the reveal spends
    const assurances = await step('Fetch commit tx and verify the BIP-341 tapscript commitment', async () => {
      const input = reveal.inputs[inscription.input];
      const commitHex = (await (await esplora(`/tx/${input.prevTxid}/hex`)).text()).trim();
      const commit = parseTx(hexToBytes(commitHex));
      if (commit.txid !== input.prevTxid) throw new Error('commit tx bytes do not hash to the spent txid');
      const spent = commit.outputs[input.vout];
      const tapscript = extractTapscript(input.witness);
      if (!tapscript) throw new Error('reveal input is not a script-path spend');
      verifyScriptPathCommitment({
        script: tapscript.script,
        controlBlock: tapscript.controlBlock,
        scriptPubKey: spent.scriptPubKey,
      });
      const depth = (tapscript.controlBlock.length - 33) / 32;
      return {
        value: { singleLeafTree: depth === 0, singleInputReveal: reveal.inputs.length === 1 },
        detail:
          `taproot output key = internal key tweaked by the envelope script's leaf hash; ` +
          `the txid-committed input binds these exact content bytes (control block depth ${depth}` +
          `${depth === 0 ? ' ⇒ single-leaf tree' : ''})`,
      };
    });

    render(meta, parsed, inscription, reveal, assurances);
  } catch {
    const note = document.createElement('p');
    note.className = 'failnote';
    note.textContent = "Verification failed. The page refuses to render the token's image unverified.";
    $('result').appendChild(note);
  } finally {
    $('run').removeAttribute('disabled');
  }
}

function render(
  meta: TokenMetadata,
  parsed: ParsedOrdUri,
  inscription: Inscription,
  reveal: ParsedTx,
  assurances: { singleLeafTree: boolean; singleInputReveal: boolean },
): void {
  const body = inscription.body!;
  const url = URL.createObjectURL(new Blob([body.slice()], { type: inscription.contentType }));
  const container = $('result');
  container.innerHTML = `
    <div class="card">
      <img alt="the token's image, verified" />
      <dl>
        <dt>token</dt><dd></dd>
        <dt>image</dt><dd class="mono">ord:${parsed.idString.slice(0, 20)}…i${parsed.id.index}/content</dd>
        <dt>content-type</dt><dd>${inscription.contentType}</dd>
        <dt>stored bytes</dt><dd>${body.length}</dd>
        <dt>sha256</dt><dd class="mono">${parsed.integrity!.digestHex.slice(0, 32)}… = the token's pin</dd>
        <dt>assurances</dt><dd>singleLeafTree=${assurances.singleLeafTree}, singleInputReveal=${assurances.singleInputReveal}</dd>
        <dt>block</dt><dd>${CHECKPOINT_HEIGHT} (${reveal.inputs.length}-input reveal)</dd>
      </dl>
    </div>
    <p class="note">A marketplace rendering this token today would dereference a hosted URL,
    typically ordinals.com, and trust whatever bytes came back. This page verified every byte
    against Bitcoin proof of work in this browser. The expected content hash lives in the
    token's own metadata, so the image does not depend on any gateway staying reachable or
    honest. This is verification level <b>L2</b> (integrity pin + tapscript commitment); L3
    additionally pins the witness through the coinbase commitment.</p>`;
  (container.querySelector('img') as HTMLImageElement).src = url;
  (container.querySelector('dd') as HTMLElement).textContent = String(meta.name ?? 'unnamed token');
}

const tokenMeta = renderMetadata();
$('run').addEventListener('click', () => void main(tokenMeta));
