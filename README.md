# Confluence PlantUML Renderer

Chrome extension that turns PlantUML code snippets on Atlassian Confluence pages into rendered SVG diagrams.

## What It Does

- Scans Confluence code blocks on `https://*.atlassian.net/wiki/*`.
- Also runs on the local extension fixture at `http://127.0.0.1:4173/examples/confluence-extension-fixture.html` for real Chrome verification.
- Detects PlantUML snippets with `@start...` and `@end...` markers.
- Replaces each detected snippet with a rendered diagram.
- Keeps the original source behind a `Code` toggle.
- In Confluence edit mode, expands the snippet row across the page, keeps the PlantUML source visible on the left, and gives the live rendered preview the larger right pane.
- Watches page mutations so diagrams render when Confluence loads content dynamically.
- Fetches SVG through the extension service worker using declared PlantUML host permissions, then injects sanitized inline SVG into the page.

## Load The Extension

1. Open Chrome Extensions at `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked`.
4. Select this repository folder.
5. Open or reload a Confluence page containing PlantUML code blocks.

## Local Verification

Run:

```sh
npm run verify
```

For a manual fixture, open:

```text
examples/confluence-fixture.html
```

To verify the unpacked Chrome extension itself, run a local server from this repository and open:

```text
http://127.0.0.1:4173/examples/confluence-extension-fixture.html
```

The extension uses the public PlantUML SVG endpoint at `https://www.plantuml.com/plantuml/svg/...`.
When loaded as a Chrome extension, the background service worker fetches SVG and the content script injects sanitized inline SVG. The fixture page falls back to direct image URLs because it is not running inside Chrome extension APIs.
