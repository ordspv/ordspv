/**
 * Content script (registered ONLY on per-site-enabled origins): makes
 * ord:/ord:// links clickable by routing them to the extension viewer.
 * Browsers won't navigate unknown schemes, and MV3 extensions cannot register
 * protocol handlers for them. This is the IPFS Companion workaround.
 */
document.addEventListener(
  'click',
  (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith('ord:')) return;
    event.preventDefault();
    event.stopPropagation();
    void chrome.runtime.sendMessage({ type: 'open-ord-uri', uri: href });
  },
  { capture: true },
);
