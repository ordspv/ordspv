"use strict";
(() => {
  // extension/src/urlmap.ts
  var ID_RE = /^[0-9a-f]{64}i\d+$/i;
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

  // extension/src/popup.ts
  var $ = (id) => document.getElementById(id);
  async function currentOrigin() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return void 0;
    try {
      const url = new URL(tab.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return void 0;
      return url.origin;
    } catch {
      return void 0;
    }
  }
  async function main() {
    const settings = await chrome.storage.sync.get({
      interceptGateways: true,
      level: "L2",
      enabledSites: []
    });
    const intercept = $("intercept");
    intercept.checked = settings.interceptGateways;
    intercept.addEventListener("change", () => {
      void chrome.storage.sync.set({ interceptGateways: intercept.checked });
    });
    const level = $("level");
    level.value = settings.level;
    level.addEventListener("change", () => {
      void chrome.storage.sync.set({ level: level.value === "L3" ? "L3" : "L2" });
    });
    const origin = await currentOrigin();
    const siteToggle = $("site-toggle");
    if (!origin) {
      siteToggle.disabled = true;
      $("site").textContent = "(this page)";
    } else {
      $("site").textContent = new URL(origin).hostname;
      siteToggle.checked = settings.enabledSites.includes(origin);
      siteToggle.addEventListener("change", async () => {
        let sites = settings.enabledSites.filter((s) => s !== origin);
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
    const open = $("open");
    open.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const uri = normalizeOrdInput(open.value);
      if (uri) {
        void chrome.tabs.create({ url: viewerUrl(chrome.runtime.getURL(""), uri) });
        window.close();
      } else {
        open.setCustomValidity("not an inscription id or ord: URI");
        open.reportValidity();
      }
    });
  }
  void main();
})();
