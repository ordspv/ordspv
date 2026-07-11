/** Popup: global toggles, per-site enable (with optional host permission), quick-open. */
import { normalizeOrdInput, viewerUrl } from './urlmap.js';

const $ = (id: string) => document.getElementById(id)!;

async function currentOrigin(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return undefined;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

interface PopupSettings {
  interceptGateways: boolean;
  level: string;
  enabledSites: string[];
}

async function main(): Promise<void> {
  const settings = (await chrome.storage.sync.get({
    interceptGateways: true,
    level: 'L2',
    enabledSites: [] as string[],
  })) as unknown as PopupSettings;

  const intercept = $('intercept') as HTMLInputElement;
  intercept.checked = settings.interceptGateways;
  intercept.addEventListener('change', () => {
    void chrome.storage.sync.set({ interceptGateways: intercept.checked });
  });

  const level = $('level') as HTMLSelectElement;
  level.value = settings.level;
  level.addEventListener('change', () => {
    void chrome.storage.sync.set({ level: level.value === 'L3' ? 'L3' : 'L2' });
  });

  const origin = await currentOrigin();
  const siteToggle = $('site-toggle') as HTMLInputElement;
  if (!origin) {
    siteToggle.disabled = true;
    $('site').textContent = '(this page)';
  } else {
    $('site').textContent = new URL(origin).hostname;
    siteToggle.checked = settings.enabledSites.includes(origin);
    siteToggle.addEventListener('change', async () => {
      let sites = settings.enabledSites.filter((s: string) => s !== origin);
      if (siteToggle.checked) {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) {
          siteToggle.checked = false;
          return;
        }
        sites = [...sites, origin];
      }
      settings.enabledSites = sites;
      await chrome.storage.sync.set({ enabledSites: sites });
    });
  }

  const open = $('open') as HTMLInputElement;
  open.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const uri = normalizeOrdInput(open.value);
    if (uri) {
      void chrome.tabs.create({ url: viewerUrl(chrome.runtime.getURL(''), uri) });
      window.close();
    } else {
      open.setCustomValidity('not an inscription id or ord: URI');
      open.reportValidity();
    }
  });
}

void main();
