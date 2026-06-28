(function confluencePlantUmlRenderer() {
  "use strict";

  const EXTENSION_ROOT_CLASS = "confluence-puml-renderer";
  const HIDDEN_SOURCE_CLASS = "confluence-puml-source-hidden";
  const VISIBLE_SOURCE_CLASS = "confluence-puml-source-visible";
  const EDIT_SOURCE_CLASS = "confluence-puml-edit-source";
  const EDIT_ROW_CLASS = "confluence-puml-edit-row";
  const EDIT_LAYOUT_CLASS = "confluence-puml-edit-layout";
  const DEFAULT_PLANTUML_SERVER = "https://www.plantuml.com/plantuml";
  const RENDER_FORMAT = "svg";
  const SCAN_DEBOUNCE_MS = 150;
  const RESCAN_INTERVAL_MS = 2000;
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

  const stateBySource = new WeakMap();
  const activeStates = new Set();
  const confluenceCodeBlockSourceByLocalId = new Map();
  let scanTimer = 0;
  let contentObserver = null;
  let contentObserverRoot = null;
  let documentElementObserver = null;
  let rescanInterval = 0;
  let embeddedAdfScanned = false;

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

  function createEditLayoutElement(sourceElement, wrapper) {
    const layoutElement = document.createElement("div");
    layoutElement.className = `${EDIT_LAYOUT_CLASS} ${EDIT_ROW_CLASS}`;
    layoutElement.setAttribute("data-confluence-puml-edit-layout", "true");
    sourceElement.before(layoutElement);
    layoutElement.append(sourceElement, wrapper);
    return layoutElement;
  }

  function unwrapEditLayout(state) {
    const layoutElement = state.editLayoutElement;

    if (!layoutElement) {
      return;
    }

    if (layoutElement.isConnected && state.sourceElement.isConnected) {
      layoutElement.before(state.sourceElement);
    }

    layoutElement.remove();
  }

  function repairEditLayout(state) {
    if (!state.sourceElement.isConnected) {
      return false;
    }

    let layoutElement = state.editLayoutElement;
    const layoutHasSource =
      layoutElement?.isConnected && layoutElement.contains(state.sourceElement);

    if (!layoutHasSource) {
      const staleLayoutElement = layoutElement;
      layoutElement = createEditLayoutElement(state.sourceElement, state.wrapper);
      state.editLayoutElement = layoutElement;

      if (staleLayoutElement?.isConnected) {
        staleLayoutElement.remove();
      }
    }

    if (
      state.wrapper.parentElement !== layoutElement ||
      state.sourceElement.nextElementSibling !== state.wrapper
    ) {
      state.sourceElement.after(state.wrapper);
    }

    return state.wrapper.isConnected && layoutElement.contains(state.wrapper);
  }

  function isRendererAttached(state) {
    if (state.mode === "edit") {
      return repairEditLayout(state);
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

    const openLink = document.createElement("a");
    openLink.className = "confluence-puml-link";
    openLink.textContent = "Open SVG";
    openLink.target = "_blank";
    openLink.rel = "noreferrer noopener";

    toolbar.append(title, spacer);

    if (mode !== "edit") {
      toolbar.append(toggleButton);
    }

    toolbar.append(refreshButton, openLink);

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
    wrapper.append(toolbar, output);

    const editLayoutElement =
      mode === "edit" ? createEditLayoutElement(sourceElement, wrapper) : null;

    if (mode !== "edit") {
      sourceElement.after(wrapper);
    }

    if (mode === "edit") {
      sourceElement.classList.add(EDIT_SOURCE_CLASS);
      sourceElement.style.setProperty("display", "inline-flex", "important");
    } else {
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
      editLayoutElement,
      lastSource: "",
      renderId: 0
    };

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
    return state;
  }

  function removeRenderer(state) {
    state.renderId += 1;
    state.sourceElement.classList.remove(
      HIDDEN_SOURCE_CLASS,
      VISIBLE_SOURCE_CLASS,
      EDIT_SOURCE_CLASS
    );

    if (state.mode === "edit") {
      state.sourceElement.style.removeProperty("display");
      unwrapEditLayout(state);
    } else {
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

    return document.importNode(svg, true);
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
