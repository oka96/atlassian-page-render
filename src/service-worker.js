importScripts("plantuml-codec.js");

const PLANTUML_SERVER = "https://www.plantuml.com/plantuml";
const RENDER_FORMAT = "svg";
const REQUEST_TIMEOUT_MS = 15000;

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId)
  };
}

async function fetchPlantUmlSvg(source) {
  const encoded = await globalThis.PlantUmlCodec.encode(source);
  const url = `${PLANTUML_SERVER}/${RENDER_FORMAT}/${encoded}`;
  const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: timeout.signal
    });

    const svg = await response.text();
    const contentType = response.headers.get("content-type") || "";

    if (!response.ok && !contentType.includes("image/svg+xml")) {
      throw new Error(`PlantUML server returned HTTP ${response.status}.`);
    }

    return {
      svg,
      url
    };
  } finally {
    timeout.cancel();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "confluence-puml-render") {
    return false;
  }

  if (typeof message.source !== "string" || message.source.trim() === "") {
    sendResponse({
      ok: false,
      error: "PlantUML source is empty."
    });
    return false;
  }

  fetchPlantUmlSvg(message.source)
    .then(({ svg, url }) => {
      sendResponse({
        ok: true,
        svg,
        url
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "PlantUML rendering failed."
      });
    });

  return true;
});
