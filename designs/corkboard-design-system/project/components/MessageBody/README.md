The read-only message body page: a back link, one page title, and the plain-text body in a focusable preformatted block. Use it after a timeline card's "Reveal body" link; the body is untrusted text and never HTML.

## Rules

- The consumer supplies the body text, the project back URL, and the localized title and back-link copy.
- Render one `h1` in the `h1` style, a back link in `link`, and `pre.body-text` with `tabindex="0"`, 1px `border`, `radius-md`, `space-4` padding, and `code` type on `surface-raised`.
- Preserve `white-space: pre-wrap` and `overflow-wrap: anywhere`. Escape every character; never interpolate HTML, markup, or a link from the body.
- The focusable `pre` must show the `focus` outline at 3px with a 2px offset so keyboard readers can scroll a long body.
- When the body has expired, show the localized expired title and the sentence "This message body is no longer available." Do not render a partial or cached body, and do not offer a retry that could imply the content still exists.
- Keep the body's `code` style at 15/22/400; do not switch a message body to a proportional face.

## Accessibility

The back link is the first control in the document. The `pre` is reachable by keyboard and keeps visible focus. Long unbroken lines wrap instead of forcing horizontal scroll at 320px.
