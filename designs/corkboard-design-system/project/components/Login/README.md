Sign-in form for the read-only web dashboard: one page title, labelled email and password fields, and a single primary action. Use it only at `/login`; it is the sole write action on the web surface and keeps its CSRF hidden field, `return_to`, and same-origin submission.

## Rules

- The page supplies one `h1` in the `h1` style, the localized labels, the `return_to` value, the CSRF token, and the error copy.
- Put inputs on `surface-raised` with a 1px `border` and `radius-sm`, set in `body`. Keep the native `type`, `autocomplete`, and `required` attributes.
- The submit action is a `brand` fill with a `brand-ink` label. Never set the label in `brand` on a surface.
- Render a failed sign-in with `role="alert"` and the `.error` rail in `danger`. Do not reveal whether the email exists.
- Do not add "remember me", social sign-in, or a password-visibility toggle. Do not put credentials in the URL, a query string, or a log.

## Accessibility

`label for` matches each input `id`; the error is announced through `role="alert"`; the focus outline is `focus` at 3px with a 2px offset. The form stays single-column at 320px with a `space-4` gutter.
