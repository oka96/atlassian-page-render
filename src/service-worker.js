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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

async function fetchPlantUmlPng(source) {
  const encoded = await globalThis.PlantUmlCodec.encode(source);
  const url = `${PLANTUML_SERVER}/png/${encoded}`;
  const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: timeout.signal
    });

    // The PlantUML server answers diagram syntax errors with a non-2xx status
    // (still an image). Treat those as failures so a broken "error image" is
    // never inserted into the page.
    if (!response.ok) {
      throw new Error(`PlantUML server returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("image/png")) {
      throw new Error("PlantUML server did not return a PNG image.");
    }

    return {
      pngBase64: arrayBufferToBase64(await response.arrayBuffer()),
      url
    };
  } finally {
    timeout.cancel();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type !== "confluence-puml-render" &&
    message?.type !== "confluence-puml-render-png"
  ) {
    return false;
  }

  if (typeof message.source !== "string" || message.source.trim() === "") {
    sendResponse({
      ok: false,
      error: "PlantUML source is empty."
    });
    return false;
  }

  const request =
    message.type === "confluence-puml-render-png"
      ? fetchPlantUmlPng(message.source)
      : fetchPlantUmlSvg(message.source);

  request
    .then((result) => {
      sendResponse({
        ok: true,
        ...result
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
