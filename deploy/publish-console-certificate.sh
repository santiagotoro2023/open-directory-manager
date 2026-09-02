#!/usr/bin/env bash
# Publish the console's certificate where every domain machine can fetch it.
#
# A machine has to verify the console before it can talk to it, and until the
# domain has a certificate authority of its own the console's certificate is
# self-signed — so there is nothing in a machine's system trust store that
# vouches for it. Handing operators a --ca-cert flag made a joined machine that
# reported nothing the normal outcome of a normal join.
#
# SYSVOL is where Active Directory has always distributed exactly this sort of
# thing. It is readable by any authenticated domain member, the transfer is
# Kerberos-authenticated with mandatory signing, and the domain controller's
# identity is proven by the KDC rather than by the certificate being fetched —
# which is what makes fetching it safe. A join, and afterwards the agent,
# reads it from there and needs nothing typed.
#
# Idempotent, and safe to run whenever the certificate changes: the rotation
# script calls it, so an agent re-fetching after a new certificate is issued
# gets the new one.

set -euo pipefail

CERT="${1:-/etc/odm/tls/api.crt}"
SYSVOL="${ODM_SYSVOL_ROOT:-/var/lib/samba/sysvol}"
CA_CERT="${ODM_CA_DIR:-/var/lib/odm/ca}/ca-cert.pem"

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ -f "$CERT" ]] || { echo "no certificate at $CERT" >&2; exit 1; }

# It has to be a certificate, and only a certificate: this file is what every
# machine in the domain will trust.
openssl x509 -noout -in "$CERT" >/dev/null 2>&1 || {
    echo "$CERT is not a PEM certificate" >&2
    exit 1
}
grep -q "PRIVATE KEY" "$CERT" && {
    echo "$CERT contains a private key; refusing to publish it" >&2
    exit 1
}

# The authority that signed it, where there is one, rather than the console's
# own certificate: a certificate gets replaced — renewed, reissued, moved to a
# real name — and an anchor that is the certificate itself stops matching the
# moment it does, which takes every agent in the domain with it. The authority
# outlives all of that. Published only when it really signed what the console
# is presenting, so a domain whose console is still self-signed keeps working.
if [[ -f "$CA_CERT" ]] && openssl verify -CAfile "$CA_CERT" "$CERT" >/dev/null 2>&1; then
    echo "the console's certificate is issued by this domain's authority"
    CERT="$CA_CERT"
fi

# The domain's own directory under SYSVOL, whatever the realm is called. One
# match is the answer; none means this machine is not a controller.
DOMAIN_DIR=""
for CANDIDATE in "$SYSVOL"/*/; do
    [[ -d "$CANDIDATE" ]] || continue
    [[ "$(basename "$CANDIDATE")" == "sysvol" ]] && continue
    DOMAIN_DIR="${CANDIDATE%/}"
    break
done
[[ -n "$DOMAIN_DIR" ]] || {
    echo "no SYSVOL domain directory under $SYSVOL; is this a domain controller?" >&2
    exit 1
}

install -d -m 0755 "$DOMAIN_DIR/odm"
install -m 0644 "$CERT" "$DOMAIN_DIR/odm/api-ca.pem"
echo "published $DOMAIN_DIR/odm/api-ca.pem"
