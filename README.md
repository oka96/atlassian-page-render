# Confluence PlantUML Renderer

Chrome extension that turns PlantUML code snippets on Atlassian Confluence pages into rendered SVG diagrams.

## What It Does

- Scans Confluence code blocks on `https://*.atlassian.net/wiki/*`.
- Also runs on the local extension fixture at `http://127.0.0.1:4173/examples/confluence-extension-fixture.html` for real Chrome verification.
- Detects PlantUML snippets with `@start...` and `@end...` markers.
- Replaces each detected snippet with a rendered diagram.
- Keeps the original source behind a `Code` toggle.
- In Confluence edit mode, expands the snippet row across the page, keeps the PlantUML source visible on the left, and gives the live rendered preview the larger right pane.
- In edit mode, an `Insert image` button renders the diagram to PNG and inserts it into the page as a normal attached image, so viewers without the extension still see the diagram. The PNG is generated at double resolution (`skinparam dpi 192`, injected only for diagram types that safely accept it and skipped when the source sets its own `scale`/`dpi`) so details stay legible in Confluence's click-to-zoom preview. If direct insertion is not accepted by the editor, the PNG is copied to the clipboard and the button prompts you to paste it. Inserted images are named `plantuml-<hash>.png`; in view mode the extension hides them next to a live-rendered code block so extension users do not see the diagram twice.
- Watches page mutations so diagrams render when Confluence loads content dynamically.
- The toolbar popup has a switch to turn rendering off; pages then show the original code blocks and any inserted images - exactly what viewers without the extension see. The setting syncs across devices and applies to open tabs immediately.
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
