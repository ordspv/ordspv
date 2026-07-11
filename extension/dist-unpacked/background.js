"use strict";
(() => {
  // extension/src/urlmap.ts
  var ID_RE = /^[0-9a-f]{64}i\d+$/i;
  var DEFAULT_GATEWAY_HOSTS = ["ordinals.com"];
  function normalizeOrdInput(input) {
    let s = input.trim();
    if (s.startsWith("ord://")) s = `ord:${s.slice("ord://".length)}`;
    if (!s.startsWith("ord:")) {
      if (ID_RE.test(s)) return `ord:${s.toLowerCase()}`;
      return void 0;
    }
    const rest = s.slice(4);
    const idPart = rest.split(/[/#?]/, 1)[0];
    if (!ID_RE.test(idPart)) return void 0;
    return `ord:${rest}`;
  }
  function viewerUrl(extensionBaseUrl, uri) {
    return `${extensionBaseUrl}viewer.html#${uri}`;
  }
  function dnrRuleForHost(host, ruleId, extensionBaseUrl) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      id: ruleId,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          // \1 = path kind, \2 = inscription id; the viewer re-normalizes
          regexSubstitution: `${extensionBaseUrl}viewer.html#gw:\\1:\\2`
        }
      },
      condition: {
        regexFilter: `^https?://${escaped}/(content|preview|r/undelegated-content)/([0-9a-fA-F]{64}i[0-9]+)$`,
        resourceTypes: ["main_frame"]
      }
    };
  }

  // extension/src/background.ts
  var DEFAULTS = {
    interceptGateways: true,
    gatewayHosts: DEFAULT_GATEWAY_HOSTS.slice(),
    enabledSites: [],
    level: "L2"
  };
  async function getSettings() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return stored;
  }
  async function syncRules() {
    const settings = await getSettings();
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    const base = chrome.runtime.getURL("");
    const addRules = settings.interceptGateways ? settings.gatewayHosts.map((host, i) => dnrRuleForHost(host, i + 1, base)) : [];
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
  chrome.runtime.onInstalled.addListener(() => void syncRules());
  chrome.runtime.onStartup.addListener(() => void syncRules());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.interceptGateways || changes.gatewayHosts)) void syncRules();
    if (area === "sync" && changes.enabledSites) void syncContentScripts();
  });
  async function syncContentScripts() {
    const settings = await getSettings();
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ["ord-links"] });
    if (registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: ["ord-links"] });
    }
    if (settings.enabledSites.length === 0) return;
    await chrome.scripting.registerContentScripts([
      {
        id: "ord-links",
        js: ["content.js"],
        matches: settings.enabledSites.map((origin) => `${origin}/*`),
        runAt: "document_idle"
      }
    ]);
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "open-ord-uri" && message.uri) {
      const uri = normalizeOrdInput(message.uri);
      if (uri) void chrome.tabs.create({ url: viewerUrl(chrome.runtime.getURL(""), uri) });
      sendResponse({ ok: Boolean(uri) });
    }
    return false;
  });
  chrome.omnibox.onInputEntered.addListener((text) => {
    const uri = normalizeOrdInput(text);
    if (uri) void chrome.tabs.create({ url: viewerUrl(chrome.runtime.getURL(""), uri) });
  });
  chrome.omnibox.setDefaultSuggestion({
    description: "Resolve and verify an inscription: paste an id or ord: URI"
  });
})();
