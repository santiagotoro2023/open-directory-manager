# ODM brand assets

Generated logo assets — carry these exact files into the repo at
`branding/` (or `assets/brand/`) and use them, don't regenerate new ones
unless intentionally rebranding.

- `odm-mark.svg` — icon only. Use for: favicon, browser tab icon, native
  join application's window/taskbar icon, anywhere space is too tight for
  the wordmark.
- `odm-logo-compact.svg` — icon + "ODM" + small "OPEN DIRECTORY MANAGER"
  caption. Use for: the web UI's top nav bar, the native join app's title
  bar, anywhere horizontal space is limited but the brand name still needs
  to be legible.
- `odm-logo-full.svg` — icon + full "Open Directory Manager" wordmark. Use
  for: the web UI login screen, the join application's welcome/first
  screen, README header, about dialogs.

**Rule: the mark never appears alone on a primary surface (login screen,
nav bar, join-app header) without the brand name or "ODM" shorthand next to
it in text.** Icon-only use is reserved for favicons and OS-level app
icons where a wordmark can't render legibly.

## Palette
- Primary accent: `#4F46E5` (indigo) — mark background, primary buttons,
  active nav state, links.
- Primary text: `#111827`
- Secondary/caption text: `#6B7280`
- Borders/dividers: `#E5E7EB`
- Surface background: `#FFFFFF` / `#F8FAFC` for slightly recessed panels.

## Clear space & minimum size
- Keep clear space around the mark equal to at least a quarter of its
  height on every side.
- Don't render the mark below 20×20px; don't render the full wordmark
  lockup narrower than 180px wide — switch to the compact lockup or
  icon-only below that.

## Typography
Lockups use the system font stack (`system-ui, -apple-system, 'Segoe UI',
Roboto, sans-serif`) rather than an embedded custom font — keep the same
stack for the web UI and native app so branding and product typography
match.
