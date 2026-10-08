#!/usr/bin/env bash
# Regenerates open-directory-manager.yaml from the Helm chart, so the plain
# manifest and the chart can never say different things. CI runs this and
# fails if the committed file differs.
#
#   deploy/kubernetes/generate.sh            (needs helm)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="$HERE/../helm/open-directory-manager"
OUT="$HERE/open-directory-manager.yaml"
{
cat <<'HEADER'
# Open Directory Manager on Kubernetes without Helm: one file, edit and apply.
#
#   1. Edit the values marked CHANGE below: the passwords in the two Secrets,
#      the controller's node name and address (StatefulSet ...-dc0, and the
#      hostAliases of the control plane), and the console's address.
#   2. kubectl apply -f deploy/kubernetes/open-directory-manager.yaml
#   3. kubectl -n odm logs -f statefulset/odm-dc0        the domain being provisioned
#   4. Point odm.<domain> at the Service's address; sign in as Administrator.
#
# Generated from the Helm chart (deploy/helm/open-directory-manager) by
# deploy/kubernetes/generate.sh with deploy/kubernetes/values.yaml: the chart
# is the easier way to change anything here, and adds controllers and member
# servers by listing them. docs/CONTAINERS.md explains all of it.
#
# The namespace allows privileged pods: a domain controller is a server.
apiVersion: v1
kind: Namespace
metadata:
  name: odm
  labels:
    pod-security.kubernetes.io/enforce: privileged
HEADER
helm template odm "$CHART" --namespace odm -f "$HERE/values.yaml" \
    | grep -v '^# Source: ' \
    | sed -e '/helm.sh\/chart:/d' -e 's/app.kubernetes.io\/managed-by: Helm/app.kubernetes.io\/managed-by: kubectl/' \
    | awk '/helm.sh\/hook/ {skip=1} skip && /^---/ {skip=0} !skip'
} > "$OUT"
echo "wrote $OUT"
