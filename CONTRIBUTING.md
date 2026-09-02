# Contributing to Open Directory Manager

## Before you write code

Read [CLAUDE.md](CLAUDE.md) in full. It is the authoritative specification —
architecture decisions in §2 are locked, the v1 feature list in §3 is
non-negotiable, and §6 (security) applies to every change, not just the ones
where it is convenient.

## Ground rules

- **No personal or company identifiers anywhere** — code, comments, commit
  messages, config examples, tests, docs. Use `example.org` /
  `corp.example.internal`, org `Example Corp`, maintainer
  `Open Directory Manager Contributors <hello@example.org>`.
- **No secrets in git.** Keytabs, DB credentials and Kea API credentials
  come from a mode-`0600` secrets file or a secrets manager.
- **No custom crypto, no custom Kerberos/LDAP implementation.** Use Samba,
  MIT Kerberos and the system libraries.
- **Pinned dependencies.** Exact versions in `pyproject.toml` and
  `package.json`; CI runs dependency scanning.
- **Audit every write.** Any API call that changes state records actor,
  timestamp and a before/after diff.
- **A new role installer ships with its uninstall.** Every
  `deploy/install-<role>-role.sh` needs a matching `teardown_<role>` function
  in `deploy/uninstall.sh`, added in the same commit — see the header comment
  there. `deploy/uninstall.sh` warns at runtime about any role installer that
  has no matching teardown, but that warning should never fire on `main`.

## Layout

| Path | Stack | Lint | Test |
|---|---|---|---|
| `api/` | Python 3.11+, FastAPI | `ruff check` | `pytest` |
| `agent/` | Go | `go vet ./...` | `go test ./...` |
| `client-join/` | Go | `go vet ./...` | `go test ./...` |
| `web/` | React + TypeScript | `tsc --noEmit` | `npm run build` |

CI (`.github/workflows/ci.yml`) runs all of the above plus `pip-audit`,
`npm audit` and `govulncheck` on every push and pull request.

## Development environment

`api/` needs `libkrb5-dev`, `libsasl2-dev` and a PostgreSQL instance;
`web/` needs Node 22+. A Samba AD DC to develop against is provisioned with
`deploy/provision-dc.sh` — run it in a throwaway VM, never on a workstation.

## Commits and pull requests

- Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`).
- One logical change per pull request; describe the security impact if the
  change touches authentication, authorization, or the directory.
- Keep the phase ordering in CLAUDE.md §7 — do not open a pull request for a
  later phase while an earlier one is incomplete.

## License

Contributions are made under AGPL-3.0-or-later.

## Documentation

Every user-visible change — a feature, a server role, a policy category, an
endpoint, a configuration option — ships with its wiki page in the same
commit. The wiki lives in `web/src/wiki/` and is the source of truth for
operators.

House style, applied to every page:

- Open with a **Quickstart**: a short run-down and concrete examples, enough
  to act on immediately.
- Follow with **Details** covering everything there is to know about that
  component.
- Professional documentation tone. Describe what the system does and how to
  work with it. Do not justify architectural decisions or compare them with
  alternatives; the wiki documents the state of the system.
- Use the components in `web/src/wiki/components.tsx` rather than raw markup,
  so pages stay consistent as the wiki grows.

Adding a page:

1. Create `web/src/wiki/pages/<id>.tsx` exporting `meta` and `Content`.
2. Add it to `MODULES` in `web/src/wiki/index.ts`.

The sidebar, search and routing are driven from that registry; nothing else
needs to change. A new section is created by naming it in `meta.section` and
adding it to `SECTION_ORDER`.

Terminology follows the console:

- Computer objects are **Computers**; the object type on the wire is
  `computer`.
- A group is a **User group** or a **Computer group**, with a **scope**
  (global, domain local, universal). The words "security group" and
  "distribution group" are not used.
- Logon rights are **HBAC rules**.

Active Directory terms are kept where they are the clearest: Organizational
Unit, Group Policy Object, Distinguished Name, Sudo Rule, security
filtering, enforced link, block inheritance.
