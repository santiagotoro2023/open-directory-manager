// Package join is the single implementation of the domain-join sequence:
// discover the domain through DNS SRV records, authenticate a join
// credential or OTP, write krb5.conf and sssd.conf, join the Samba AD DC,
// register the computer object, install the machine keytab, and install and
// enable odm-agent as a systemd service.
//
// Both front ends — the odm-client-install CLI and the Fyne GUI — call this
// package and must produce identical configuration; the join logic is never
// written twice (CLAUDE.md §5.6).
//
// Phase 3.
package join
