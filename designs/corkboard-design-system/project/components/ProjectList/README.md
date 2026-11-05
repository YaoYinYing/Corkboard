Project cards for the dashboard: a heading and a short description over a small metadata list. Use it as the dashboard's only list, with one card per project the account may read.

## Rules

- The consumer supplies the ordered project records: title, optional summary, member display name, and the project URL.
- Render `ul.project-list` with one `article` per project, a `space-4` grid gap, a 1px `border`, `radius-md`, and `space-4` padding. Do not add a shadow.
- Title the card with an `h2` link in `link`. Use the `summaryFallback` copy ("No description.") when the summary is empty; never invent one.
- Metadata is a `dl` with `label` terms and `ink` values. Render status as `success` plus the word "Active", never as colour alone.
- Use the `.empty` paragraph in `ink-muted` on `surface-muted` when there are no projects.
- Do not expose a project the account cannot read; absent and forbidden projects use the same not-found page.

## Accessibility

Each `article` is named by its `h2` through `aria-labelledby`; titles and summaries wrap with `overflow-wrap: anywhere`. The list keeps a `space-4` gap and collapses to one column at 320px without horizontal scroll.
