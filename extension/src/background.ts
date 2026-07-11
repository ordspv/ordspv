/**
 * Service worker: owns the declarativeNetRequest rules (gateway → viewer
 * redirects), the omnibox keyword, and per-site content-script registration.
 * Deliberately dependency-free; all resolution/verification happens in the
 * viewer page.
 */
import { DEFAULT_GATEWAY_HOSTS, dnrRuleForHost, normalizeOrdInput, viewerUrl } from './urlmap.js';

interface Settings {
  interceptGateways: boolean;
  gatewayHosts: string[];
  /** origins where the ord:-link content script is registered */
  enabledSites: string[];
  level: 'L2' | 'L3';
}

const DEFAULTS: Settings = {
  interceptGateways: true,
  gatewayHosts: DEFAULT_GATEWAY_HOSTS.slice(),
  enabledSites: [],
  level: 'L2',
};

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULTS as unknown as Record<string, unknown>);
  return stored as unknown as Settings;
}

// ---------------------------------------------------------------------------
// gateway interception (dNR dynamic rules)
// ---------------------------------------------------------------------------

async function syncRules(): Promise<void> {
  const settings = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const base = chrome.runtime.getURL('');
  const addRules = settings.interceptGateways
    ? settings.gatewayHosts.map((host, i) => dnrRuleForHost(host, i + 1, base))
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

chrome.runtime.onInstalled.addListener(() => void syncRules());
chrome.runtime.onStartup.addListener(() => void syncRules());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.interceptGateways || changes.gatewayHosts)) void syncRules();
  if (area === 'sync' && changes.enabledSites) void syncContentScripts();
});

// ---------------------------------------------------------------------------
// per-site ord:-link handling (content script registered only where enabled)
// ---------------------------------------------------------------------------

async function syncContentScripts(): Promise<void> {
  const settings = await getSettings();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ['ord-links'] });
  if (registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: ['ord-links'] });
  }
  if (settings.enabledSites.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: 'ord-links',
      js: ['content.js'],
      matches: settings.enabledSites.map((origin) => `${origin}/*`),
      runAt: 'document_idle',
    },
  ]);
}

// content script asks us to open the viewer (it cannot navigate to ord: itself)
chrome.runtime.onMessage.addListener((message: { type?: string; uri?: string }, _sender, sendResponse) => {
  if (message.type === 'open-ord-uri' && message.uri) {
    const uri = normalizeOrdInput(message.uri);
    if (uri) void chrome.tabs.create({ url: viewerUrl(chrome.runtime.getURL(''), uri) });
    sendResponse({ ok: Boolean(uri) });
  }
  return false;
});

// ---------------------------------------------------------------------------
// omnibox: "ord <id-or-uri>"
// ---------------------------------------------------------------------------

chrome.omnibox.onInputEntered.addListener((text) => {
  const uri = normalizeOrdInput(text);
  if (uri) void chrome.tabs.create({ url: viewerUrl(chrome.runtime.getURL(''), uri) });
});

chrome.omnibox.setDefaultSuggestion({
  description: 'Resolve and verify an inscription: paste an id or ord: URI',
});
