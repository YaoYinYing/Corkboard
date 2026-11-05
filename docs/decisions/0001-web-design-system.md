# 0001 — Web design system

- Status: Accepted
- Date: 2026-11-05
- Base: `55bd96e28f013dc79f934eae760eb7ff5415b167`
- Design source tree: `7870c94`, imported patch-identically into this checkpoint
  (original commit `496dc5b3d4342c3cdcf1f86d5f14025ce12135a8`)

## Context

The shipped web surface is server-rendered HTML with one fixed stylesheet in
`src/app/web.ts`. It has no brand palette: color comes from CSS system colors
(`Canvas`, `CanvasText`, `LinkText`, `GrayText`, `Highlight`, `Mark`). The
campaign needs concrete light and dark values before the stylesheet can be
replaced, and a contract that later agents can consume without guessing.

## Decision

The `claude-design-system` format (the baoyu claude-* suite) is authoritative
for the web UI. The system lives at `designs/corkboard-design-system/`:
`project/tokens.json` is the token contract, `project/README.md` is the usage
guide, and `project/components/*/preview.html` are static previews of the
shipped structures.

Every token maps one-to-one to a CSS custom property `--<name>` when the
application phase compiles the system (`--surface`, `--ink`, `--brand`,
`--space-4`, `--radius-md`, `--shadow-card`, `--font-sans`, `--font-mono`).
Type styles compile to classes (`.body`, `.small`, `.label`, `.h1`, `.h2`,
`.h3`, `.code`). The first theme is light; `[data-theme="dark"]` overrides it.

The shipped stylesheet is not changed in this phase. `src/app/web.ts` continues
to serve system colors until the application phase consumes these tokens.

## Alternatives considered

- Keep CSS system colors only: no testable contrast contract, no brand
  identity, and the dark theme is whatever the browser chooses.
- Ad hoc custom properties inside `WEB_CSS`: fast, but no usage notes,
  component rules, or reviewable light/dark pairs.
- A utility-CSS framework or component library: adds a build dependency and
  markup churn the server-rendered, script-free surface does not need.
- A DTCG/W3C token file: valid, but the design-system reader expects the
  list-shaped `tokens.json`; a map would have to be converted anyway.

## Consequences

- The application phase must consume the tokens, not restate the values. It
  must also provide the theme hand-off (system preference or explicit
  `data-theme`), the 3px `focus` outline with 2px offset, and the 60rem
  measure.
- Design data is a contract and documentation, never authority. It does not
  change authorization, validation, logging, or any runtime behavior.
- The deployed CSP is fixed: `src/app/html.ts` serves
  `default-src 'none'; style-src 'self'`. Tokens must therefore compile into
  one same-origin stylesheet, never an inline `<style>` block or a `style=`
  attribute. Fonts stay on the system stacks (`system-ui` and
  `ui-monospace`), so no font request is possible. Theming uses
  `prefers-color-scheme` and/or a server-rendered `data-theme`; there is no
  script, inline event handler, or external URL. This matches
  `docs/web-ui.md`.
- Previews are static, use system fonts only, load no external URLs, and run
  no scripts. They show the **intended token contract** and the shipped DOM
  structures, not the current shipped rendering: `src/app/web.ts` still serves
  system colors, and the ProjectList status colour in the preview is
  aspirational. They are not a second implementation.
- A token or component change is a change to `tokens.json` and the matching
  README/preview, followed by `artifact.mjs check`; the generated
  `tokens.css` and `manifest.json` are not committed by hand.
- Contrast is part of the contract: body text is at least 4.5:1 and borders,
  focus rings, and meaningful marks at least 3:1 in both themes. State is
  never signalled by color alone.
