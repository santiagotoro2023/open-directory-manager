# Domain-join client

Two front ends over one shared join library (CLAUDE.md §5.6):

- `join/` — the join sequence, implemented once.
- `cmd/odm-client-install/` — CLI modelled on `ipa-client-install`; flags for
  unattended provisioning (`--domain`, `--server`, `--otp` / `--admin-user`),
  interactive prompts otherwise.
- `cmd/odm-join-gui/` — small Fyne desktop app for joining a Debian desktop
  interactively. Uses `branding/odm-mark.svg` as its window icon and
  `branding/odm-logo-full.svg` on the welcome screen.

Both ship as `.deb` packages and are tested against the same fixtures so they
produce identical resulting configuration.

**Status:** Phase 3. This module currently contains only the package skeleton.
