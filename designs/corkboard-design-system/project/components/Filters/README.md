The timeline filter form and its active-state summary. Use it above the timeline to let the reader narrow messages by type, sender speaker ID, summary text, and read state.

## Rules

- The consumer supplies the project action URL, current filter values, the page limit, the localized labels and hints, and the language hidden field.
- Render `form.filters` as an auto-fit grid: `repeat(auto-fit, minmax(11rem, 1fr))`, row gap `space-3`, column gap `space-4`, 1px `border`, `radius-md`, and `space-4` padding.
- Each `.filter-field` stacks its label and control with a `space-1` gap. Inputs keep the 0.35rem padding, `surface-raised` fill, 1px `border`, and `radius-sm`.
- Hints use `.hint` in `ink-muted` and `small`, and are linked through `aria-describedby`. The unread control is a native checkbox with a row-aligned label.
- The submit action is filled with `brand` and labelled with `brand-ink`; "Clear filters" is a normal `link`.
- `.filter-state` reports the active filters with a 4px `border` rail and readable values in `code`; it must repeat each filter as text, never colour alone. Show "No filters applied." when none are set.
- Search matches summary text only. Never expose or search message bodies from this form.

## Accessibility

Every control has a `label for`; hints are separate elements, not placeholder text. The grid stays usable at 320px because `minmax(11rem, 1fr)` collapses to one column. Focus uses the `focus` outline at 3px with a 2px offset.
