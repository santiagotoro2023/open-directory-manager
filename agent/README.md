# odm-agent

Single static Go binary that runs on every domain-joined Debian machine.

It authenticates to the ODM API with GSSAPI using the machine's existing
domain-join keytab, polls for its effective policy (default every 15 minutes,
configurable by policy), applies it, and reports per-setting Resultant Set of
Policy status back. `odm-agent apply --force` is the `gpupdate /force`
equivalent.

Precedence — OU inheritance, block inheritance, enforced links, multiple
linked GPOs, security-group filtering, item-level targeting — is resolved by
the API, never here (CLAUDE.md §5.2).

**Status:** Phase 3. This module currently contains only the command skeleton.
