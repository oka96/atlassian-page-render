(function confluencePlantUmlRenderer() {
  "use strict";

  const EXTENSION_ROOT_CLASS = "confluence-puml-renderer";
  const HIDDEN_SOURCE_CLASS = "confluence-puml-source-hidden";
  const VISIBLE_SOURCE_CLASS = "confluence-puml-source-visible";
  const DEFAULT_PLANTUML_SERVER = "https://www.plantuml.com/plantuml";
  const RENDER_FORMAT = "svg";
  const SCAN_DEBOUNCE_MS = 150;
  const RESCAN_INTERVAL_MS = 2000;
  const EDIT_SOURCE_WIDTH = "42%";
  const EDIT_PREVIEW_GAP = 16;
  const EDIT_PREVIEW_MIN_WIDTH = 280;
  const EDIT_PREVIEW_MIN_HEIGHT = 120;
  const EDIT_PREVIEW_MARGIN = 8;
  const EDIT_PREVIEW_Z_INDEX = "200";
  const GENERATED_IMAGE_HIDDEN_CLASS = "confluence-puml-generated-hidden";
  const GENERATED_IMAGE_PREFIX = "plantuml-";
  const GENERATED_IMAGE_PATTERN = /plantuml-[0-9a-f]{8}\.png/i;
  const INSERT_BUTTON_LABEL = "Insert image";
  const INSERT_BUTTON_TITLE =
    "Render the diagram to PNG and insert it into the page so viewers without the extension can see it.";
  const INSERT_STATUS_RESET_MS = 3000;
  const INSERT_COPIED_RESET_MS = 6000;
  const PASTE_SELECTION_SETTLE_MS = 120;
  const MEDIA_PROBE_SELECTOR =
    "img, [data-testid*='media'], [data-node-type*='media']";
  const MEDIA_PROBE_TIMEOUT_MS = 2500;
  const MEDIA_PROBE_INTERVAL_MS = 150;
  // 2x the PlantUML default of 96. Higher would risk the public server's
  // 4096px output limit, which crops large diagrams instead of shrinking them.
  const INSERT_IMAGE_DPI = 192;
  // Only these diagram types safely accept an injected skinparam line. Types
  // like ditaa/dot/latex embed foreign syntax where an extra line would
  // corrupt the diagram.
  const DPI_INJECTABLE_START = /@start(?:uml|mindmap|wbs|gantt)\b/i;
  const EXPLICIT_SIZE_DIRECTIVE = /^\s*(?:scale\s|skinparam\s+dpi\b)/im;
  const CODE_BLOCK_SELECTOR = [
    "pre",
    "code",
    "textarea",
    "[data-testid='code-block']",
    "[data-testid*='code-block']",
    "[data-testid*='codeBlock']",
    "[data-node-type='codeBlock']",
    "[data-node-type='code-block']",
    ".ak-renderer-code-block",
    ".ak-editor-code-block",
    "[class*='code-block']",
    "[class*='codeBlock']"
  ].join(",");
  const EDIT_MODE_SELECTOR = [
    "[contenteditable='true']",
    ".ProseMirror",
    "[class*='ProseMirror']",
    "[data-testid='ak-editor-content-area']",
    "[data-testid*='editor']",
    "[data-testid*='Editor']"
  ].join(",");

  const START_PATTERN =
    /@start(?:uml|mindmap|wbs|gantt|json|yaml|salt|ditaa|dot|chen|creole|ebnf|regex|chronology|wire|nwdiag|packetdiag|rackdiag|git|jcckit|latex)\b/i;
  const END_PATTERN =
    /@end(?:uml|mindmap|wbs|gantt|json|yaml|salt|ditaa|dot|chen|creole|ebnf|regex|chronology|wire|nwdiag|packetdiag|rackdiag|git|jcckit|latex)\b/i;
  const LINE_NUMBER_SELECTOR = [
    "[data-testid*='line-number']",
    "[data-testid*='lineNumber']",
    "[class*='line-number']",
    "[class*='lineNumber']",
    "[aria-hidden='true']"
  ].join(",");
  const CODE_LINE_SELECTOR = [
    ".code-line",
    "[class*='code-line']",
    "[class*='codeLine']",
    "[data-testid*='code-block--line']:not([data-testid*='line-number'])"
  ].join(",");

  const RENDER_ENABLED_STORAGE_KEY = "renderEnabled";

  const stateBySource = new WeakMap();
  const activeStates = new Set();
  let renderingEnabled = true;
  const confluenceCodeBlockSourceByLocalId = new Map();
  let scanTimer = 0;
  let contentObserver = null;
  let contentObserverRoot = null;
  let documentElementObserver = null;
  let rescanInterval = 0;
  let embeddedAdfScanned = false;
  let editRepositionScheduled = false;
  let editRepositionListenersAttached = false;

  function normalizeText(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function stripLineNumberRows(text) {
    const lines = text.split("\n");
    const numericRows = lines.filter((line) => /^\s*\d+\s*$/.test(line));

    if (numericRows.length < 2) {
      return text;
    }

    const withoutNumericRows = lines
      .filter((line) => !/^\s*\d+\s*$/.test(line))
      .join("\n")
      .trim();

    return START_PATTERN.test(withoutNumericRows) ? withoutNumericRows : text;
  }

  function stripInlineLineNumbers(text) {
    const lines = text.split("\n");
    const numberedLines = lines.filter((line) => /^\s*\d+\s+\S/.test(line));

    if (numberedLines.length < 2) {
      return text;
    }

    const withoutNumbers = lines
      .map((line) => line.replace(/^\s*\d+\s+/, ""))
      .join("\n")
      .trim();

    return START_PATTERN.test(withoutNumbers) ? withoutNumbers : text;
  }

  function stripMarkdownFence(text) {
    const trimmed = text.trim();

    if (!trimmed.startsWith("```")) {
      return text;
    }

    return trimmed
      .replace(/^```[ \t]*(?:plantuml|puml)?[ \t]*(?:\n)?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
  }

  function isLikelyLineNumberElement(node) {
    if (!(node instanceof Element) || !node.matches(LINE_NUMBER_SELECTOR)) {
      return false;
    }

    const text = normalizeText(node.textContent || "");
    return text === "" || /^\d+$/.test(text);
  }

  function removeLikelyLineNumbers(root) {
    root.querySelectorAll(LINE_NUMBER_SELECTOR).forEach((node) => {
      if (isLikelyLineNumberElement(node)) {
        node.remove();
      }
    });
  }

  function textWithoutLineNumbers(element) {
    if (isLikelyLineNumberElement(element)) {
      return "";
    }

    if (
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLInputElement
    ) {
      return element.value || "";
    }

    const clone = element.cloneNode(true);
    clone
      .querySelectorAll(`.${EXTENSION_ROOT_CLASS}, script, style`)
      .forEach((node) => node.remove());
    removeLikelyLineNumbers(clone);

    return clone.textContent || "";
  }

  function extractTextFromLineNodes(sourceElement) {
    const lineTexts = Array.from(sourceElement.querySelectorAll(CODE_LINE_SELECTOR))
      .map((line) => normalizeText(textWithoutLineNumbers(line)))
      .filter(Boolean);

    if (lineTexts.length < 2) {
      return "";
    }

    const text = lineTexts.join("\n");
    return START_PATTERN.test(text) ? text : "";
  }

  function extractTextFromCodeMirror(sourceElement) {
    return extractVisibleTextFromCodeMirror(sourceElement);
  }

  function extractVisibleTextFromCodeMirror(sourceElement) {
    const content = sourceElement.matches(".cm-content")
      ? sourceElement
      : sourceElement.querySelector(".cm-content");

    if (!content) {
      return "";
    }

    const lineTexts = Array.from(content.querySelectorAll(".cm-line")).map(
      (line) => textWithoutLineNumbers(line).replace(/\u00a0/g, " ")
    );

    if (lineTexts.length < 2) {
      return "";
    }

    const text = lineTexts.join("\n");
    return START_PATTERN.test(text) ? text : "";
  }

  function localIdForCodeBlock(sourceElement) {
    return (
      sourceElement.getAttribute("data-local-id") ||
      sourceElement.closest("[data-local-id]")?.getAttribute("data-local-id") ||
      ""
    );
  }

  function collectCodeBlockText(node) {
    if (!Array.isArray(node?.content)) {
      return "";
    }

    return node.content
      .map((child) => child.text || collectCodeBlockText(child))
      .join("");
  }

  function walkAdfForCodeBlocks(node) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (node.type === "codeBlock") {
      const localId = node.attrs?.localId;
      const text = collectCodeBlockText(node);

      if (localId && text && !confluenceCodeBlockSourceByLocalId.has(localId)) {
        confluenceCodeBlockSourceByLocalId.set(localId, text);
      }
    }

    if (Array.isArray(node.content)) {
      node.content.forEach(walkAdfForCodeBlocks);
    }
  }

  function scanEmbeddedConfluenceAdf() {
    if (embeddedAdfScanned) {
      return;
    }

    const initialCacheSize = confluenceCodeBlockSourceByLocalId.size;

    Array.from(document.scripts).forEach((script) => {
      const scriptText = script.textContent || "";

      if (!scriptText.includes("codeBlock") || !scriptText.includes('"document"')) {
        return;
      }

      const documentMatches = scriptText.matchAll(/"document":"((?:\\.|[^"\\])*)"/g);

      for (const match of documentMatches) {
        try {
          const adfText = JSON.parse(`"${match[1]}"`);
          walkAdfForCodeBlocks(JSON.parse(adfText));
        } catch {
          // Ignore unrelated script payloads; Confluence embeds several JSON fragments.
        }
      }
    });

    embeddedAdfScanned =
      confluenceCodeBlockSourceByLocalId.size > initialCacheSize;
  }

  function visibleCodeMirrorPatch(sourceElement) {
    const content = sourceElement.matches(".cm-content")
      ? sourceElement
      : sourceElement.querySelector(".cm-content");

    if (!content) {
      return null;
    }

    const lineTexts = Array.from(content.querySelectorAll(".cm-line")).map(
      (line) => textWithoutLineNumbers(line).replace(/\u00a0/g, " ")
    );

    if (!lineTexts.length) {
      return null;
    }

    const lineNumberElements = Array.from(
      sourceElement.querySelectorAll(".cm-gutter.cm-lineNumbers .cm-gutterElement")
    ).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        /^\d+$/.test(normalizeText(element.textContent || ""))
      );
    });
    const firstLineNumber = Number.parseInt(
      normalizeText(lineNumberElements[0]?.textContent || ""),
      10
    );

    return {
      firstLineNumber: Number.isFinite(firstLineNumber) ? firstLineNumber : 1,
      lineTexts
    };
  }

  function extractTextFromConfluenceEmbeddedAdf(sourceElement) {
    const localId = localIdForCodeBlock(sourceElement);

    if (!localId) {
      return "";
    }

    scanEmbeddedConfluenceAdf();

    const cachedText = confluenceCodeBlockSourceByLocalId.get(localId);

    if (!cachedText) {
      return "";
    }

    const patch = visibleCodeMirrorPatch(sourceElement);

    if (!patch) {
      return cachedText;
    }

    const lines = cachedText.split("\n");
    const startIndex = Math.max(0, patch.firstLineNumber - 1);

    patch.lineTexts.forEach((lineText, index) => {
      lines[startIndex + index] = lineText;
    });

    const patchedText = lines.join("\n");
    confluenceCodeBlockSourceByLocalId.set(localId, patchedText);
    return patchedText;
  }

  function extractCodeText(sourceElement) {
    let text =
      extractTextFromConfluenceEmbeddedAdf(sourceElement) ||
      extractTextFromCodeMirror(sourceElement) ||
      extractTextFromLineNodes(sourceElement) ||
      textWithoutLineNumbers(sourceElement);

    text = normalizeText(text);
    text = stripLineNumberRows(text);
    text = stripInlineLineNumbers(text);
    text = stripMarkdownFence(text);

    return normalizeText(text);
  }

  function languageHint(sourceElement) {
    const attributes = [
      sourceElement.getAttribute("data-language"),
      sourceElement.getAttribute("data-syntax"),
      sourceElement.getAttribute("data-code-lang"),
      sourceElement.getAttribute("class"),
      sourceElement.querySelector("code")?.getAttribute("class")
    ];

    return attributes.filter(Boolean).join(" ").toLowerCase();
  }

  function isPlantUmlSource(text, sourceElement) {
    if (!text) {
      return false;
    }

    return START_PATTERN.test(text) && END_PATTERN.test(text);
  }

  function isEditModeSource(sourceElement) {
    return Boolean(sourceElement.closest(EDIT_MODE_SELECTOR));
  }

  function normalizeCandidate(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    if (element.closest(`.${EXTENSION_ROOT_CLASS}`)) {
      return null;
    }

    let candidate = element.matches(CODE_BLOCK_SELECTOR) ? element : null;
    let parent = element.parentElement;

    while (parent) {
      if (parent.matches(CODE_BLOCK_SELECTOR)) {
        candidate = parent;
      }

      parent = parent.parentElement;
    }

    return candidate || element;
  }

  function findCandidateBlocks(root) {
    const candidates = new Set();
    const searchRoot = root instanceof Element || root instanceof Document ? root : document;

    if (searchRoot instanceof Element) {
      const normalized = normalizeCandidate(searchRoot);
      if (normalized && normalized.matches(CODE_BLOCK_SELECTOR)) {
        candidates.add(normalized);
      }
    }

    searchRoot.querySelectorAll(CODE_BLOCK_SELECTOR).forEach((element) => {
      const normalized = normalizeCandidate(element);
      if (normalized) {
        candidates.add(normalized);
      }
    });

    return new Set(
      Array.from(candidates).filter((candidate) => {
        let parent = candidate.parentElement;

        while (parent) {
          if (candidates.has(parent)) {
            return false;
          }

          parent = parent.parentElement;
        }

        return true;
      })
    );
  }

  function findAncestorState(sourceElement) {
    for (const state of activeStates) {
      if (
        state.sourceElement !== sourceElement &&
        state.sourceElement.contains(sourceElement)
      ) {
        return state;
      }
    }

    return null;
  }

  function findDescendantStates(sourceElement) {
    return Array.from(activeStates).filter(
      (state) =>
        state.sourceElement !== sourceElement &&
        sourceElement.contains(state.sourceElement)
    );
  }

  function editOverlayRoot() {
    return document.body || document.documentElement;
  }

  function narrowEditSource(sourceElement) {
    // Inline styles survive ProseMirror/CodeMirror DOM rewrites (a class does
    // not — CodeMirror rewrites the editor's className on focus/typing), so the
    // code block stays narrowed without the editor undoing it.
    sourceElement.style.setProperty("box-sizing", "border-box", "important");
    sourceElement.style.setProperty("width", EDIT_SOURCE_WIDTH, "important");
    sourceElement.style.setProperty("max-width", EDIT_SOURCE_WIDTH, "important");
  }

  function resetEditSource(sourceElement) {
    sourceElement.style.removeProperty("box-sizing");
    sourceElement.style.removeProperty("width");
    sourceElement.style.removeProperty("max-width");
  }

  function editContentTop(sourceElement) {
    // The top of the scrollable editor content, i.e. just below Confluence's
    // sticky toolbars. The preview is clamped to this so it never rises into
    // (and covers) the toolbar as the code block scrolls up.
    let el = sourceElement.parentElement;

    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);

      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 4
      ) {
        return el.getBoundingClientRect().top;
      }

      el = el.parentElement;
    }

    return 0;
  }

  function positionEditPreview(state) {
    const sourceElement = state.sourceElement;
    const wrapper = state.wrapper;

    if (!sourceElement.isConnected) {
      return false;
    }

    const sourceRect = sourceElement.getBoundingClientRect();
    const containerRect = (
      sourceElement.parentElement || sourceElement
    ).getBoundingClientRect();
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;

    const contentTop = Math.max(
      EDIT_PREVIEW_MARGIN,
      editContentTop(sourceElement)
    );

    const sourceHidden =
      (sourceRect.width === 0 && sourceRect.height === 0) ||
      sourceRect.bottom <= contentTop ||
      sourceRect.top >= viewportHeight;

    if (sourceHidden) {
      wrapper.style.visibility = "hidden";
      return true;
    }

    const left = Math.round(sourceRect.right + EDIT_PREVIEW_GAP);
    const rightBound = Math.min(
      containerRect.right,
      viewportWidth - EDIT_PREVIEW_MARGIN
    );
    const width = Math.max(EDIT_PREVIEW_MIN_WIDTH, Math.round(rightBound - left));

    // The preview shares the code block's top edge and height and scrolls away
    // with it (the title is not pinned). The portion that would rise over
    // Confluence's sticky toolbar is clipped rather than drawn, so the preview
    // appears to slide under the toolbar instead of covering it.
    const top = Math.round(sourceRect.top);
    const height = Math.max(
      EDIT_PREVIEW_MIN_HEIGHT,
      Math.round(sourceRect.height)
    );
    const clipTop = Math.max(0, Math.round(contentTop - sourceRect.top));

    wrapper.style.visibility = "";
    wrapper.style.position = "fixed";
    wrapper.style.top = `${top}px`;
    wrapper.style.left = `${left}px`;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.clipPath =
      clipTop > 0 ? `inset(${clipTop}px 0px 0px 0px round 0px 0px 6px 6px)` : "none";
    wrapper.style.zIndex = EDIT_PREVIEW_Z_INDEX;

    return true;
  }

  function repositionEditPreviews() {
    editRepositionScheduled = false;

    for (const state of activeStates) {
      if (state.mode === "edit") {
        positionEditPreview(state);
      }
    }
  }

  function scheduleEditReposition() {
    if (editRepositionScheduled) {
      return;
    }

    editRepositionScheduled = true;
    window.requestAnimationFrame(repositionEditPreviews);
  }

  function ensureEditRepositionListeners() {
    if (editRepositionListenersAttached) {
      return;
    }

    editRepositionListenersAttached = true;
    window.addEventListener("scroll", scheduleEditReposition, {
      capture: true,
      passive: true
    });
    window.addEventListener("resize", scheduleEditReposition, { passive: true });
  }

  function attachEditPreview(state) {
    // Render the preview outside the editor's contenteditable. ProseMirror
    // reconciles its own DOM and ejects any wrapper injected around a code
    // block, which made the preview blank out and snap back on every
    // scroll/hover/focus. A floating panel anchored to the (narrowed) code
    // block sidesteps that fight entirely.
    narrowEditSource(state.sourceElement);
    editOverlayRoot().append(state.wrapper);

    if (!state.sourceResizeObserver && typeof ResizeObserver === "function") {
      state.sourceResizeObserver = new ResizeObserver(scheduleEditReposition);
      state.sourceResizeObserver.observe(state.sourceElement);
    }

    ensureEditRepositionListeners();
    positionEditPreview(state);
  }

  function detachEditPreview(state) {
    if (state.sourceResizeObserver) {
      state.sourceResizeObserver.disconnect();
      state.sourceResizeObserver = null;
    }

    resetEditSource(state.sourceElement);
    state.wrapper.remove();
  }

  function isRendererAttached(state) {
    if (state.mode === "edit") {
      if (!state.sourceElement.isConnected) {
        return false;
      }

      if (!state.wrapper.isConnected) {
        editOverlayRoot().append(state.wrapper);
      }

      positionEditPreview(state);
      return true;
    }

    return state.sourceElement.isConnected && state.wrapper.isConnected;
  }

  function shouldKeepInvalidEditRenderer(state) {
    return (
      state.mode === "edit" &&
      (state.lastSource ||
        state.renderId > 0 ||
        state.diagram.childElementCount > 0)
    );
  }

  function hashSource(text) {
    let hash = 0x811c9dc5;

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function base64ToBytes(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  // The inserted PNG is displayed at page width by Confluence, so render it at
  // double resolution to keep small text and edge details legible in the
  // click-to-zoom preview. Applied only to the copy sent for PNG generation;
  // the code block and live preview keep the original source. An explicit
  // scale/dpi already in the diagram wins.
  function highResolutionSource(source) {
    if (
      !DPI_INJECTABLE_START.test(source) ||
      EXPLICIT_SIZE_DIRECTIVE.test(source)
    ) {
      return source;
    }

    const lines = source.split("\n");
    const startIndex = lines.findIndex((line) => START_PATTERN.test(line));

    if (startIndex === -1) {
      return source;
    }

    lines.splice(startIndex + 1, 0, `skinparam dpi ${INSERT_IMAGE_DPI}`);
    return lines.join("\n");
  }

  function requestExtensionPng(source) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "confluence-puml-render-png",
          source
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }

          resolve(response || null);
        }
      );
    });
  }

  function editorRootFor(sourceElement) {
    return (
      sourceElement.closest(".ProseMirror") ||
      sourceElement.closest("[contenteditable='true']")
    );
  }

  function pointBelowCodeBlock(sourceElement) {
    const rect = sourceElement.getBoundingClientRect();

    return {
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(
        Math.min(rect.bottom + 8, (window.innerHeight || rect.bottom) - 8)
      )
    };
  }

  // Move the editor caret below the code block through ProseMirror's own
  // mouse handling (posAtCoords), so a paste lands next to this specific
  // block rather than at whatever the editor's previous cursor position was —
  // a page can hold several PlantUML snippets.
  function placeCaretBelowCodeBlock(editorRoot, sourceElement) {
    const { clientX, clientY } = pointBelowCodeBlock(sourceElement);
    const pointTarget = document.elementFromPoint(clientX, clientY);
    const target =
      pointTarget && editorRoot.contains(pointTarget) ? pointTarget : editorRoot;

    ["mousedown", "mouseup", "click"].forEach((type) => {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          clientX,
          clientY
        })
      );
    });
  }

  async function dispatchImagePaste(editorRoot, sourceElement, file) {
    if (typeof editorRoot.focus === "function") {
      editorRoot.focus({ preventScroll: true });
    }

    placeCaretBelowCodeBlock(editorRoot, sourceElement);

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStartAfter(sourceElement);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Keep the editor's current selection; ProseMirror still finds a valid
      // position for a pasted image.
    }

    // ProseMirror syncs the DOM selection into its own state asynchronously,
    // so give it a beat before pasting at that position.
    await new Promise((resolve) =>
      setTimeout(resolve, PASTE_SELECTION_SETTLE_MS)
    );

    const clipboardData = new DataTransfer();
    clipboardData.items.add(file);

    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData
    });

    editorRoot.dispatchEvent(pasteEvent);

    // ProseMirror calls preventDefault() when its paste handler consumes the
    // event, so this reports whether the editor accepted the image.
    return pasteEvent.defaultPrevented;
  }

  function dispatchImageDrop(editorRoot, sourceElement, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const { clientX, clientY } = pointBelowCodeBlock(sourceElement);

    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer
    });

    const pointTarget = document.elementFromPoint(clientX, clientY);
    const target =
      pointTarget && editorRoot.contains(pointTarget) ? pointTarget : editorRoot;
    target.dispatchEvent(dropEvent);

    return dropEvent.defaultPrevented;
  }

  function editorMediaSet(editorRoot) {
    return new Set(editorRoot.querySelectorAll(MEDIA_PROBE_SELECTOR));
  }

  function findAddedMedia(editorRoot, previousMedia) {
    for (const element of editorRoot.querySelectorAll(MEDIA_PROBE_SELECTOR)) {
      if (!previousMedia.has(element)) {
        return element;
      }
    }

    return null;
  }

  // preventDefault() on the synthetic paste/drop only proves an editor handler
  // ran, not that an image landed in the document. Watch for a new media/img
  // node (Confluence shows an upload placeholder immediately) before reporting
  // success.
  async function waitForNewEditorMedia(editorRoot, previousMedia) {
    const deadline = Date.now() + MEDIA_PROBE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const added = findAddedMedia(editorRoot, previousMedia);

      if (added) {
        return added;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, MEDIA_PROBE_INTERVAL_MS)
      );
    }

    return findAddedMedia(editorRoot, previousMedia);
  }

  function topLevelBlockIn(editorRoot, element) {
    let node = element;

    while (node && node.parentElement && node.parentElement !== editorRoot) {
      node = node.parentElement;
    }

    return node && node.parentElement === editorRoot ? node : null;
  }

  // A page can hold several PlantUML snippets, so an inserted image only
  // counts as correctly placed when it sits in (or within a few blocks after)
  // the code block it was generated from.
  function isMediaNearCodeBlock(editorRoot, mediaElement, sourceElement) {
    const codeBlock = topLevelBlockIn(editorRoot, sourceElement);
    const mediaBlock = topLevelBlockIn(editorRoot, mediaElement);

    if (!codeBlock || !mediaBlock) {
      return true;
    }

    if (codeBlock === mediaBlock || codeBlock.contains(mediaBlock)) {
      return true;
    }

    let sibling = codeBlock.nextElementSibling;

    for (let steps = 0; sibling && steps < 3; steps += 1) {
      if (sibling === mediaBlock) {
        return true;
      }

      sibling = sibling.nextElementSibling;
    }

    return false;
  }

  function logInsertDiagnostic(message) {
    console.info(`[confluence-puml] ${message}`);
  }

  async function copyImageToClipboard(file) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      return false;
    }

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([file], { type: "image/png" })
        })
      ]);
      return true;
    } catch {
      return false;
    }
  }

  function flashInsertStatus(state, label, title, resetMs) {
    const button = state.insertButton;

    if (!button) {
      return;
    }

    window.clearTimeout(state.insertStatusTimer);
    button.textContent = label;
    button.title = title || "";

    state.insertStatusTimer = window.setTimeout(() => {
      button.textContent = INSERT_BUTTON_LABEL;
      button.title = INSERT_BUTTON_TITLE;
    }, resetMs || INSERT_STATUS_RESET_MS);
  }

  function showInsertHint(state, text) {
    if (!state.insertHint) {
      return;
    }

    window.clearTimeout(state.insertHintTimer);
    state.insertHint.textContent = text;
    state.insertHint.hidden = false;

    state.insertHintTimer = window.setTimeout(() => {
      state.insertHint.hidden = true;
    }, 15000);
  }

  function hideInsertHint(state) {
    if (!state.insertHint) {
      return;
    }

    window.clearTimeout(state.insertHintTimer);
    state.insertHint.hidden = true;
  }

  async function insertRenderedImage(state) {
    if (state.inserting) {
      return;
    }

    const source = extractCodeText(state.sourceElement);

    if (!isPlantUmlSource(source, state.sourceElement)) {
      flashInsertStatus(
        state,
        "No diagram",
        "The code block does not contain a complete PlantUML diagram."
      );
      return;
    }

    state.inserting = true;
    state.insertButton.disabled = true;
    state.insertButton.textContent = "Generating...";
    hideInsertHint(state);

    try {
      const response = await requestExtensionPng(highResolutionSource(source));

      if (!response?.ok || typeof response.pngBase64 !== "string") {
        throw new Error(response?.error || "PlantUML PNG rendering failed.");
      }

      const file = new File(
        [base64ToBytes(response.pngBase64)],
        `${GENERATED_IMAGE_PREFIX}${hashSource(source)}.png`,
        { type: "image/png" }
      );

      state.insertButton.textContent = "Inserting...";
      const editorRoot = editorRootFor(state.sourceElement);

      if (editorRoot) {
        const mediaBefore = editorMediaSet(editorRoot);
        const pasteAccepted = await dispatchImagePaste(
          editorRoot,
          state.sourceElement,
          file
        );
        logInsertDiagnostic(
          `synthetic paste ${pasteAccepted ? "accepted" : "ignored"} by editor`
        );

        let insertedMedia = pasteAccepted
          ? await waitForNewEditorMedia(editorRoot, mediaBefore)
          : null;

        if (insertedMedia) {
          logInsertDiagnostic("media node appeared after paste");
        } else {
          const dropAccepted = dispatchImageDrop(
            editorRoot,
            state.sourceElement,
            file
          );
          logInsertDiagnostic(
            `synthetic drop ${dropAccepted ? "accepted" : "ignored"} by editor`
          );

          insertedMedia = dropAccepted
            ? await waitForNewEditorMedia(editorRoot, mediaBefore)
            : null;

          if (insertedMedia) {
            logInsertDiagnostic("media node appeared after drop");
          }
        }

        if (insertedMedia) {
          flashInsertStatus(
            state,
            "Inserted",
            "Delete any older generated image, then publish the page."
          );

          if (
            !isMediaNearCodeBlock(editorRoot, insertedMedia, state.sourceElement)
          ) {
            logInsertDiagnostic(
              "inserted media is not adjacent to its code block"
            );
            showInsertHint(
              state,
              "The image was inserted at the editor's cursor position - drag it to sit directly below this code block."
            );
          }

          return;
        }
      } else {
        logInsertDiagnostic("no editor root found for the code block");
      }

      if (await copyImageToClipboard(file)) {
        const pasteKey = /mac/i.test(navigator.platform) ? "Cmd+V" : "Ctrl+V";
        logInsertDiagnostic("fell back to clipboard copy");
        flashInsertStatus(
          state,
          `Copied - press ${pasteKey}`,
          "Click in the page below the code block and paste the image.",
          INSERT_COPIED_RESET_MS
        );
        showInsertHint(
          state,
          `The editor did not accept automatic insertion. The PNG is on your clipboard - click in the page below the code block and press ${pasteKey} to paste it.`
        );
        return;
      }

      throw new Error("Could not insert or copy the rendered image.");
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "Image insertion failed.";
      logInsertDiagnostic(`insert failed: ${description}`);
      flashInsertStatus(state, "Failed", description);
      showInsertHint(state, `Image insertion failed: ${description}`);
    } finally {
      state.inserting = false;
      state.insertButton.disabled = false;
    }
  }

  function generatedImageElement(container) {
    const images = container.matches("img")
      ? [container]
      : Array.from(container.querySelectorAll("img"));

    return (
      images.find((image) =>
        GENERATED_IMAGE_PATTERN.test(
          `${image.getAttribute("alt") || ""} ${image.getAttribute("src") || ""}`
        )
      ) || null
    );
  }

  function findGeneratedImageContainer(sourceElement) {
    let anchor = sourceElement;

    for (let depth = 0; anchor && depth < 5; depth += 1) {
      let sibling = anchor.nextElementSibling;

      // Skip the extension's own renderer wrapper, inserted right after the
      // code block in view mode.
      while (sibling && sibling.classList.contains(EXTENSION_ROOT_CLASS)) {
        sibling = sibling.nextElementSibling;
      }

      if (sibling) {
        const image = generatedImageElement(sibling);

        if (image) {
          const media = image.closest(
            "[data-node-type='mediaSingle'], [data-testid*='media-single'], [data-testid*='mediaSingle'], figure"
          );
          return media && sibling.contains(media) ? media : image;
        }
      }

      anchor = anchor.parentElement;
    }

    return null;
  }

  // In view mode the extension renders the diagram live, so a static image
  // generated by the "Insert image" edit-mode button would show the diagram
  // twice. Hide the static copy for extension users; everyone else still sees
  // it.
  function hideAdjacentGeneratedImage(state) {
    if (state.mode === "edit" || state.hiddenGeneratedImage?.isConnected) {
      return;
    }

    state.hiddenGeneratedImage = null;
    const container = findGeneratedImageContainer(state.sourceElement);

    if (container) {
      container.classList.add(GENERATED_IMAGE_HIDDEN_CLASS);
      state.hiddenGeneratedImage = container;
    }
  }

  function createRenderer(sourceElement, mode) {
    const wrapper = document.createElement("section");
    wrapper.className =
      mode === "edit"
        ? `${EXTENSION_ROOT_CLASS} confluence-puml-edit-preview`
        : EXTENSION_ROOT_CLASS;
    wrapper.setAttribute("data-confluence-puml-renderer", "true");

    const toolbar = document.createElement("div");
    toolbar.className = "confluence-puml-toolbar";

    const title = document.createElement("span");
    title.className = "confluence-puml-title";
    title.textContent = mode === "edit" ? "PlantUML preview" : "PlantUML";

    const spacer = document.createElement("span");
    spacer.className = "confluence-puml-spacer";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "confluence-puml-button";
    toggleButton.textContent = "Code";
    toggleButton.setAttribute("aria-pressed", "false");

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "confluence-puml-button";
    refreshButton.textContent = "Refresh";

    const insertButton = document.createElement("button");
    insertButton.type = "button";
    insertButton.className = "confluence-puml-button";
    insertButton.textContent = INSERT_BUTTON_LABEL;
    insertButton.title = INSERT_BUTTON_TITLE;

    const openLink = document.createElement("a");
    openLink.className = "confluence-puml-link";
    openLink.textContent = "Open SVG";
    openLink.target = "_blank";
    openLink.rel = "noreferrer noopener";

    toolbar.append(title, spacer);

    if (mode === "edit") {
      toolbar.append(insertButton);
    } else {
      toolbar.append(toggleButton);
    }

    toolbar.append(refreshButton, openLink);

    const insertHint = document.createElement("div");
    insertHint.className = "confluence-puml-insert-hint";
    insertHint.hidden = true;

    const output = document.createElement("div");
    output.className = "confluence-puml-output";

    const message = document.createElement("div");
    message.className = "confluence-puml-message";
    message.textContent = "Rendering PlantUML...";

    const diagram = document.createElement("div");
    diagram.className = "confluence-puml-diagram";
    diagram.setAttribute("role", "img");
    diagram.setAttribute("aria-label", "Rendered PlantUML diagram");
    diagram.hidden = true;

    output.append(message, diagram);
    wrapper.append(toolbar, insertHint, output);

    if (mode !== "edit") {
      sourceElement.after(wrapper);
      sourceElement.classList.add(HIDDEN_SOURCE_CLASS);
    }

    const state = {
      mode,
      sourceElement,
      wrapper,
      diagram,
      message,
      openLink,
      toggleButton,
      insertButton,
      insertHint,
      insertStatusTimer: 0,
      insertHintTimer: 0,
      inserting: false,
      hiddenGeneratedImage: null,
      sourceResizeObserver: null,
      lastSource: "",
      renderId: 0
    };

    if (mode === "edit") {
      insertButton.addEventListener("click", () => {
        insertRenderedImage(state);
      });
    }

    if (mode !== "edit") {
      toggleButton.addEventListener("click", () => {
        const isVisible = sourceElement.classList.toggle(VISIBLE_SOURCE_CLASS);
        sourceElement.classList.toggle(HIDDEN_SOURCE_CLASS, !isVisible);
        toggleButton.setAttribute("aria-pressed", String(isVisible));
      });
    }

    refreshButton.addEventListener("click", () => {
      state.lastSource = "";
      renderState(state);
    });

    stateBySource.set(sourceElement, state);
    activeStates.add(state);

    if (mode === "edit") {
      attachEditPreview(state);
    }

    return state;
  }

  function removeRenderer(state) {
    state.renderId += 1;
    window.clearTimeout(state.insertStatusTimer);
    window.clearTimeout(state.insertHintTimer);

    if (state.hiddenGeneratedImage) {
      state.hiddenGeneratedImage.classList.remove(GENERATED_IMAGE_HIDDEN_CLASS);
      state.hiddenGeneratedImage = null;
    }

    if (state.mode === "edit") {
      detachEditPreview(state);
    } else {
      state.sourceElement.classList.remove(
        HIDDEN_SOURCE_CLASS,
        VISIBLE_SOURCE_CLASS
      );
      state.wrapper.remove();
    }

    activeStates.delete(state);
    stateBySource.delete(state.sourceElement);
  }

  function setLoading(state) {
    const shouldPreserveEditPreview =
      state.mode === "edit" && state.diagram.childElementCount > 0;

    state.wrapper.classList.remove("confluence-puml-has-error");
    state.message.textContent = "Rendering PlantUML...";

    if (shouldPreserveEditPreview) {
      state.message.hidden = true;
      state.diagram.hidden = false;
      return;
    }

    state.message.hidden = false;
    state.diagram.hidden = true;
    state.diagram.replaceChildren();
  }

  function setRenderError(state, message) {
    state.wrapper.classList.add("confluence-puml-has-error");
    state.diagram.hidden = true;
    state.diagram.replaceChildren();
    state.message.hidden = false;
    state.message.textContent = message;
  }

  function sanitizeSvg(svgText) {
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = parsed.documentElement;

    if (!svg || svg.nodeName.toLowerCase() !== "svg") {
      throw new Error("PlantUML server did not return SVG.");
    }

    svg
      .querySelectorAll("script, foreignObject, iframe, object, embed")
      .forEach((node) => node.remove());

    svg.querySelectorAll("*").forEach((node) => {
      Array.from(node.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        const isHref = name === "href" || name === "xlink:href";
        const isSafeHref =
          value === "" ||
          value.startsWith("#") ||
          value.startsWith("http://") ||
          value.startsWith("https://") ||
          value.startsWith("mailto:");

        if (name.startsWith("on") || (isHref && !isSafeHref)) {
          node.removeAttribute(attribute.name);
        }
      });
    });

    stripInlineSvgSize(svg);

    return document.importNode(svg, true);
  }

  // PlantUML bakes a fixed pixel size into the SVG's inline style
  // (e.g. style="width:592px;height:325px"). An inline style overrides the
  // stylesheet, so the diagram renders at its raw size instead of obeying the
  // width:100% rule used by the edit-mode preview. As the diagram is edited,
  // each re-render returns a different intrinsic size and the flex preview pane
  // jumps around. Strip width/height from the inline style so the responsive
  // CSS can size the diagram; the width/height attributes are kept so view mode
  // still uses the diagram's natural size.
  function stripInlineSvgSize(svg) {
    const inlineStyle = svg.getAttribute("style");

    if (!inlineStyle) {
      return;
    }

    const withoutSize = inlineStyle
      .replace(/(?:^|;)\s*(?:width|height)\s*:[^;]*/gi, "")
      .replace(/^\s*;+/, "")
      .trim();

    if (withoutSize) {
      svg.setAttribute("style", withoutSize);
    } else {
      svg.removeAttribute("style");
    }
  }

  function showSvg(state, svgText) {
    const svg = sanitizeSvg(svgText);
    state.diagram.replaceChildren(svg);
    state.wrapper.classList.remove("confluence-puml-has-error");
    state.message.hidden = true;
    state.diagram.hidden = false;
  }

  function showImageFallback(state, imageUrl, renderId) {
    const image = document.createElement("img");
    image.className = "confluence-puml-image";
    image.alt = "Rendered PlantUML diagram";
    image.loading = "lazy";
    image.onload = () => {
      if (renderId === state.renderId) {
        state.wrapper.classList.remove("confluence-puml-has-error");
        state.message.hidden = true;
        state.diagram.hidden = false;
      }
    };
    image.onerror = () => {
      if (renderId === state.renderId) {
        setRenderError(state, "PlantUML server could not render this diagram.");
      }
    };
    image.src = imageUrl;
    state.diagram.replaceChildren(image);
  }

  function requestExtensionRender(source) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "confluence-puml-render",
          source
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }

          resolve(response || null);
        }
      );
    });
  }

  async function renderState(state) {
    const source = extractCodeText(state.sourceElement);

    if (!isPlantUmlSource(source, state.sourceElement)) {
      if (shouldKeepInvalidEditRenderer(state)) {
        return;
      }

      removeRenderer(state);
      return;
    }

    hideAdjacentGeneratedImage(state);

    if (source === state.lastSource && state.diagram.childElementCount > 0) {
      return;
    }

    state.lastSource = source;
    state.renderId += 1;
    const renderId = state.renderId;
    setLoading(state);

    try {
      if (!window.PlantUmlCodec?.encode) {
        throw new Error("PlantUML encoder is unavailable.");
      }

      const extensionResponse = await requestExtensionRender(source);

      if (extensionResponse?.ok && typeof extensionResponse.svg === "string") {
        if (renderId !== state.renderId) {
          return;
        }

        state.openLink.href = extensionResponse.url || "";
        showSvg(state, extensionResponse.svg);
        return;
      }

      if (extensionResponse && extensionResponse.ok === false) {
        throw new Error(
          extensionResponse.error || "PlantUML rendering failed."
        );
      }

      const encoded = await window.PlantUmlCodec.encode(source);
      const imageUrl = `${DEFAULT_PLANTUML_SERVER}/${RENDER_FORMAT}/${encoded}`;

      if (renderId !== state.renderId) {
        return;
      }

      state.openLink.href = imageUrl;
      showImageFallback(state, imageUrl, renderId);
    } catch (error) {
      if (renderId === state.renderId) {
        setRenderError(
          state,
          error instanceof Error ? error.message : "PlantUML rendering failed."
        );
      }
    }
  }

  function scan(root) {
    if (!renderingEnabled) {
      return;
    }

    for (const state of Array.from(activeStates)) {
      if (!isRendererAttached(state)) {
        removeRenderer(state);
      }
    }

    findCandidateBlocks(root).forEach((sourceElement) => {
      let existingState = stateBySource.get(sourceElement);
      const mode = isEditModeSource(sourceElement) ? "edit" : "view";

      if (existingState && existingState.mode !== mode) {
        removeRenderer(existingState);
        existingState = null;
      }

      if (!existingState && findAncestorState(sourceElement)) {
        return;
      }

      const source = extractCodeText(sourceElement);

      if (!isPlantUmlSource(source, sourceElement)) {
        if (existingState) {
          if (shouldKeepInvalidEditRenderer(existingState)) {
            return;
          }

          removeRenderer(existingState);
        }
        return;
      }

      if (!existingState) {
        findDescendantStates(sourceElement).forEach(removeRenderer);
      }

      const state = existingState || createRenderer(sourceElement, mode);
      renderState(state);
    });
  }

  function scheduleScan(root) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => scan(root || document), SCAN_DEBOUNCE_MS);
  }

  function shouldScanMutations(mutations) {
    return mutations.some((mutation) => {
      const target = mutation.target;
      return !(target instanceof Element && target.closest(`.${EXTENSION_ROOT_CLASS}`));
    });
  }

  function observeContentRoot() {
    const root = document.body || document.documentElement;

    if (!root || root === contentObserverRoot) {
      return;
    }

    if (contentObserver) {
      contentObserver.disconnect();
    }

    contentObserverRoot = root;
    contentObserver = new MutationObserver((mutations) => {
      if (shouldScanMutations(mutations)) {
        scheduleScan(document);
      }
    });

    contentObserver.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-code-lang", "data-language", "data-syntax", "data-testid"],
      childList: true,
      characterData: true,
      subtree: true
    });

    scheduleScan(document);
  }

  function start() {
    scan(document);
    observeContentRoot();

    if (!documentElementObserver && document.documentElement) {
      documentElementObserver = new MutationObserver(() => {
        observeContentRoot();
        scheduleScan(document);
      });

      documentElementObserver.observe(document.documentElement, {
        childList: true
      });
    }

    if (!rescanInterval) {
      rescanInterval = window.setInterval(() => {
        observeContentRoot();
        scheduleScan(document);
      }, RESCAN_INTERVAL_MS);
    }
  }

  function removeAllRenderers() {
    for (const state of Array.from(activeStates)) {
      removeRenderer(state);
    }
  }

  // start() is idempotent (observers and the rescan interval are created
  // once), so re-enabling after a disable simply resumes scanning.
  function applyRenderingEnabled(enabled) {
    renderingEnabled = enabled;

    if (enabled) {
      start();
    } else {
      window.clearTimeout(scanTimer);
      removeAllRenderers();
    }
  }

  function initialize() {
    const storage = globalThis.chrome?.storage?.sync;

    if (!storage) {
      start();
      return;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes[RENDER_ENABLED_STORAGE_KEY]) {
        applyRenderingEnabled(
          Boolean(changes[RENDER_ENABLED_STORAGE_KEY].newValue)
        );
      }
    });

    // Hold the first scan until the stored setting arrives, so pages never
    // flash a rendered diagram for users who switched rendering off.
    storage.get({ [RENDER_ENABLED_STORAGE_KEY]: true }, (items) => {
      const enabled = chrome.runtime.lastError
        ? true
        : Boolean(items[RENDER_ENABLED_STORAGE_KEY]);
      applyRenderingEnabled(enabled);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
