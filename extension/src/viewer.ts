/**
 * Viewer page: the actual resolver. Runs @ord-resolver/fetch (browser bundle:
 * DecompressionStream gzip/deflate; brotli bodies are served encoded) against
 * public esplora instances, verifies at the configured level, shows the
 * verification facts, and renders the content from verified bytes only.
 */
import { OrdResolver, type ResolveResult } from '@ord-resolver/fetch';
import { uriFromDnrHash, uriFromViewerHash } from './urlmap.js';

const $ = (id: string) => document.getElementById(id)!;

function fact(dt: string, dd: string, mono = false): void {
  const dl = $('facts');
  const dtEl = document.createElement('dt');
  dtEl.textContent = dt;
  const ddEl = document.createElement('dd');
  ddEl.textContent = dd;
  if (mono) ddEl.className = 'mono';
  dl.append(dtEl, ddEl);
}

function fail(message: string): void {
  $('status').className = 'status fail';
  $('status').textContent = `✗ ${message}`;
}

async function render(result: ResolveResult): Promise<void> {
  const target = $('content');
  const type = result.contentType ?? 'application/octet-stream';
  const blob = new Blob([result.body.slice()], { type });
  const url = URL.createObjectURL(blob);

  if (result.contentEncoding) {
    // still tag-9-encoded (browser build decodes gzip/deflate only, not br):
    // never render encoded bytes as their content-type
    const note = document.createElement('p');
    note.textContent = `body is ${result.contentEncoding}-encoded on-chain and this build cannot decode it — verified stored bytes offered as download:`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.uri.idString}.${result.contentEncoding}`;
    a.textContent = `${result.body.length} bytes (${type}, ${result.contentEncoding})`;
    target.append(note, a);
    return;
  }

  if (type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = result.uri.idString;
    target.appendChild(img);
  } else if (type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    target.appendChild(video);
  } else if (type.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    target.appendChild(audio);
  } else if (type.startsWith('text/html')) {
    // sandboxed, opaque-origin iframe; scripts allowed but no same-origin
    // access. NOTE: recursive /content and /r/* references inside HTML
    // inscriptions have no origin to resolve against here — standalone HTML
    // renders fine, recursive HTML needs a gateway (see README).
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = url;
    target.appendChild(frame);
  } else if (type.startsWith('text/') || type.includes('json') || type.includes('javascript')) {
    const pre = document.createElement('pre');
    pre.textContent = new TextDecoder().decode(result.body.slice(0, 512 * 1024));
    target.appendChild(pre);
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.uri.idString}`;
    a.textContent = `download ${result.body.length} bytes (${type})`;
    target.appendChild(a);
  }
}

async function main(): Promise<void> {
  const uri = uriFromDnrHash(location.hash) ?? uriFromViewerHash(location.hash);
  if (!uri) {
    fail('no ord: URI in the fragment — open via an ord: link, gateway redirect, or the "ord" omnibox keyword');
    return;
  }
  $('uri').textContent = uri;
  document.title = `ord viewer — ${uri.slice(4, 24)}…`;

  // degrade to defaults outside a real extension context (dev smoke tests)
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.sync;
  const settings = hasChrome
    ? await chrome.storage.sync.get({ level: 'L2', esploras: null })
    : { level: 'L2', esploras: null };
  const level = settings.level === 'L3' ? 'L3' : 'L2';
  $('status').textContent = `resolving & verifying at ${level}…`;

  const resolver = new OrdResolver({
    ...(Array.isArray(settings.esploras) && settings.esploras.length
      ? { esplora: settings.esploras }
      : {}),
    verification: level,
  });

  try {
    const started = performance.now();
    const result = await resolver.resolve(uri);
    const ms = Math.round(performance.now() - started);

    $('status').className = 'status pass';
    $('status').textContent = `✓ verified at ${result.verification.level} in ${ms} ms — rendered from proven bytes`;

    fact('inscription', result.uri.idString, true);
    fact('content-type', result.contentType ?? '(none)');
    fact('bytes', String(result.body.length) + (result.decoded ? ' (decoded)' : ''));
    if (result.storedContentEncoding) fact('tag-9 encoding', result.storedContentEncoding);
    if (result.viaDelegate) fact('via delegate', result.viaDelegate, true);
    fact('block', `${result.verification.height} (${result.verification.blockHash?.slice(0, 16)}…)`);
    fact('stored sha256', result.verification.bodySha256 ?? '', true);
    const l2 = result.verification.l2;
    if (l2) {
      fact(
        'assurances',
        `singleLeafTree=${l2.singleLeafTree} singleInputReveal=${l2.singleInputReveal}` +
          (result.verification.level === 'L3' ? ' (+witness commitment)' : ''),
      );
    }
    await render(result);
  } catch (e) {
    fail((e as Error).message);
  }
}

void main();
window.addEventListener('hashchange', () => location.reload());
