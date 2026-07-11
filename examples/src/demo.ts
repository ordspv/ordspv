/**
 * Live in-browser L2 verification of inscription 0 — the demo behind
 * "click and watch your browser verify Bitcoin".
 *
 * Everything happens client-side with plain fetch() against public esplora
 * instances (CORS: *): the reveal tx, merkle proof, header, and commit tx are
 * all UNTRUSTED inputs; the cryptography below is what makes the bytes real.
 * The only trust anchor is one compiled-in block hash (the block containing
 * inscription 0), stated explicitly on the page.
 */
import {
  bitsToTarget,
  bytesToHex,
  checkProofOfWork,
  extractTapscript,
  hexToBytes,
  inscriptionsFromTx,
  leBytesToBigInt,
  parseHeader,
  parseTx,
  sha256,
  verifyMerkleBranch,
  verifyScriptPathCommitment,
  displayToInternal,
  type Inscription,
  type ParsedTx,
} from '@ord-resolver/core';

const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
const REVEAL_TXID = INSC0.slice(0, 64);
/** trust anchor: block 767430's hash, cross-checkable against any explorer */
const CHECKPOINT_HEIGHT = 767430;
const CHECKPOINT_HASH = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';

const ESPLORAS = ['https://mempool.space/api', 'https://blockstream.info/api'];

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
  throw new Error(`all esplora sources failed for ${path} — ${errors.join('; ')}`);
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
// the verification, step by step
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  $('run').setAttribute('disabled', 'true');
  $('steps').innerHTML = '';
  $('result').innerHTML = '';

  try {
    // 1. reveal tx: the txid is self-certifying — recompute it from raw bytes
    const reveal = await step('Fetch reveal transaction & recompute its txid', async () => {
      const hex = (await (await esplora(`/tx/${REVEAL_TXID}/hex`)).text()).trim();
      const tx = parseTx(hexToBytes(hex));
      if (tx.txid !== REVEAL_TXID) {
        throw new Error(`server lied: bytes hash to ${tx.txid}`);
      }
      return {
        value: tx,
        detail: `${hex.length / 2} bytes; double-SHA256 of the stripped tx = ${tx.txid.slice(0, 16)}… ✓ matches the inscription id`,
      };
    });

    // 2. envelope
    const inscription = await step('Parse the inscription envelope from the witness', async () => {
      const inscs = inscriptionsFromTx(reveal);
      const insc = inscs.find((i) => i.index === 0);
      if (!insc?.body) throw new Error('no envelope at index 0');
      return {
        value: insc,
        detail: `${insc.contentType}, ${insc.body.length} bytes of content in the tapscript witness`,
      };
    });

    // 3. header: embedded PoW + the one compiled-in trust anchor
    const header = await step('Fetch block header — check proof-of-work & the pinned checkpoint', async () => {
      const headerHex = (await (await esplora(`/block/${CHECKPOINT_HASH}/header`)).text()).trim();
      const parsed = parseHeader(hexToBytes(headerHex));
      if (!checkProofOfWork(parsed)) throw new Error('header fails its own PoW target');
      if (parsed.hash !== CHECKPOINT_HASH) {
        throw new Error(`header hashes to ${parsed.hash}, not the pinned checkpoint`);
      }
      const work = leBytesToBigInt(parsed.hashLE);
      const target = bitsToTarget(parsed.bits);
      const leadingZeroBits = 256 - target.toString(2).length;
      void work;
      return {
        value: parsed,
        detail: `block ${CHECKPOINT_HEIGHT}: hash ${parsed.hash.slice(0, 20)}… meets its ~2^${256 - leadingZeroBits} target; equals the checkpoint this page pins (verify it against any explorer)`,
      };
    });

    // 4. merkle inclusion of the reveal txid in that header
    await step('Verify the txid merkle proof against the header', async () => {
      const proof = (await (await esplora(`/tx/${REVEAL_TXID}/merkle-proof`)).json()) as {
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

    // 5. BIP-341: the envelope script is committed by the output the reveal spends
    const assurances = await step('Fetch commit tx — verify the BIP-341 tapscript commitment', async () => {
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
          `taproot output key = internal key tweaked by the envelope script's leaf hash — ` +
          `the txid-committed input binds these exact content bytes (control block depth ${depth}` +
          `${depth === 0 ? ' ⇒ single-leaf tree' : ''})`,
      };
    });

    render(inscription, reveal, assurances);
  } catch {
    const note = document.createElement('p');
    note.className = 'failnote';
    note.textContent = 'Verification failed — the page refuses to render unverified bytes.';
    $('result').appendChild(note);
  } finally {
    $('run').removeAttribute('disabled');
  }
}

function render(
  inscription: Inscription,
  reveal: ParsedTx,
  assurances: { singleLeafTree: boolean; singleInputReveal: boolean },
): void {
  const body = inscription.body!;
  const digest = bytesToHex(sha256(body));
  const url = URL.createObjectURL(new Blob([body.slice()], { type: inscription.contentType }));
  const container = $('result');
  container.innerHTML = `
    <div class="card">
      <img alt="inscription 0" />
      <dl>
        <dt>inscription</dt><dd class="mono">${INSC0.slice(0, 24)}…i0</dd>
        <dt>content-type</dt><dd>${inscription.contentType}</dd>
        <dt>stored bytes</dt><dd>${body.length}</dd>
        <dt>sha256</dt><dd class="mono">${digest.slice(0, 32)}…</dd>
        <dt>assurances</dt><dd>singleLeafTree=${assurances.singleLeafTree}, singleInputReveal=${assurances.singleInputReveal}</dd>
        <dt>block</dt><dd>${CHECKPOINT_HEIGHT} (${reveal.inputs.length}-input reveal)</dd>
      </dl>
    </div>
    <p class="note">Every byte above was verified against Bitcoin proof-of-work in this browser —
    the servers involved could not have forged it. This is verification level <b>L2</b>
    (tapscript commitment); L3 additionally pins the witness through the coinbase
    commitment. Copy-pasteable pin for embedding:
    <span class="mono">ord:${INSC0}#integrity=sha256-${digest}</span></p>`;
  (container.querySelector('img') as HTMLImageElement).src = url;
}

$('run').addEventListener('click', () => void main());
