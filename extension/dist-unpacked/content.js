"use strict";
(() => {
  // extension/src/content.ts
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("ord:")) return;
      event.preventDefault();
      event.stopPropagation();
      void chrome.runtime.sendMessage({ type: "open-ord-uri", uri: href });
    },
    { capture: true }
  );
})();
