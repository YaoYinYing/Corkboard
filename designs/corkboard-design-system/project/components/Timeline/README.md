Message metadata in a sequence list: one card per message, with sender, committed time, reply target, and read receipts. Use it for a project timeline; message bodies are not part of this card.

## Rules

- The consumer supplies the ordered message records: sequence number, summary, sender, committed timestamp, reply target, receipt holders, body state, and the body URL.
- Render `ol.timeline` with `article.message` cards, a `space-4` gap, a 1px `border`, `radius-md`, and `space-4` padding.
- The `.seq` marker is `ink-muted`, `small`, and `font-variant-numeric: tabular-nums`. The summary is `h3`; metadata is a `dl` with `label` terms and `ink` values.
- "Reveal body" is a `link`. For an expired body, replace the link with `.state.expired`: a 4px `border` rail and the sentence "This message body has expired. Its metadata is retained." Never render a disabled link or a partial body.
- Format the committed value from the server instant in the page locale and keep the `UTC` label. Do not localize or guess the time.
- Pagination lives in `nav.pager` with `rel="prev"` and `rel="next"`; only show a cursor link the result actually supports.

## Accessibility

Name each `article` by its `h3` through `aria-labelledby`. The metadata `dl` expands to four columns at 48rem and collapses to one below 40rem; long sender names and IDs wrap with `overflow-wrap: anywhere`. The expired state is carried by both the rail and the sentence.
