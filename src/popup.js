(function popup() {
  "use strict";

  const RENDER_ENABLED_STORAGE_KEY = "renderEnabled";
  const toggle = document.getElementById("render-toggle");

  chrome.storage.sync.get({ [RENDER_ENABLED_STORAGE_KEY]: true }, (items) => {
    if (!chrome.runtime.lastError) {
      toggle.checked = Boolean(items[RENDER_ENABLED_STORAGE_KEY]);
    }
  });

  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ [RENDER_ENABLED_STORAGE_KEY]: toggle.checked });
  });
})();
