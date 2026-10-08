# Open Directory Manager: the control plane as a container image.
#
# The API, the console it serves, and everything the control plane hands to
# machines — the agent binary they update themselves from, the join client,
# the role installers. The directory itself (Samba) and the servers roles
# are installed on run from the node image, deploy/docker/node/Dockerfile.
# docs/CONTAINERS.md describes both, and how they fit together.
#
#   docker build -t open-directory-manager .
#   docker compose -f deploy/compose/docker-compose.yml up -d   a whole domain on one host
#
# Behind a proxy that re-signs TLS, hand the builder its CA (never kept in
# the image):  docker build --secret id=build_ca,src=/path/to/ca.pem .
#
# Every replica keeps its state in PostgreSQL and on one shared volume
# (/srv/odm-data: the console certificate, the certificate authority, uploaded
# packages, backups), so any number of them can run side by side.

ARG DEBIAN_RELEASE=trixie

# ------------------------------------------------------------------ console --
FROM node:22-bookworm-slim AS console
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cp /run/secrets/build_ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates >/dev/null; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY branding/ /src/branding/
RUN npm run build

# ----------------------------------------------------------- agent and join --
FROM golang:1.25-bookworm AS binaries
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cp /run/secrets/build_ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates >/dev/null; \
    fi
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
WORKDIR /src
COPY agent/ ./agent/
COPY client-join/ ./client-join/
RUN cd agent && go build -trimpath -ldflags "-s -w" -o /out/odm-agent . \
 && cd ../client-join && go build -trimpath -ldflags "-s -w" -o /out/odm-client-install ./cmd/odm-client-install

# --------------------------------------------------------------------- ntfy --
# The notification server for phone approvals, the release and checksums
# deploy/install-phone-approvals.sh pins for a host install.
FROM debian:${DEBIAN_RELEASE}-slim AS ntfy
ARG TARGETARCH
ARG NTFY_VERSION=2.28.0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cp /run/secrets/build_ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates >/dev/null; \
    fi
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) sum=48e95870ff4b1e30df8648f40e2d7f4a96956e93dc75fd07f770f726c1a4f2c5 ;; \
      arm64) sum=99b840da412bf0be75e20049b74ce488acab4ffb134fd18f02d8d0622548c9fa ;; \
      *) echo "no ntfy build for $arch" >&2; exit 1 ;; \
    esac; \
    deb="ntfy_${NTFY_VERSION}_linux_${arch}.deb"; \
    curl -fsSL --retry 3 -o "/tmp/$deb" \
      "https://github.com/binwiederhier/ntfy/releases/download/v${NTFY_VERSION}/$deb"; \
    echo "$sum  /tmp/$deb" | sha256sum -c -; \
    dpkg-deb -x "/tmp/$deb" /tmp/ntfy; \
    install -m 0755 /tmp/ntfy/usr/bin/ntfy /usr/local/bin/ntfy

# ---------------------------------------------------------------------- api --
FROM debian:${DEBIAN_RELEASE}-slim AS api
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev build-essential libkrb5-dev libsasl2-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cp /run/secrets/build_ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates >/dev/null; \
    fi
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt
COPY api/ /src/api/
RUN python3 -m venv /opt/odm/venv \
 && /opt/odm/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/odm/venv/bin/pip install --no-cache-dir /src/api

# -------------------------------------------------------------------- image --
FROM debian:${DEBIAN_RELEASE}-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="Open Directory Manager" \
      org.opencontainers.image.description="Control plane of Open Directory Manager: the API and console for an Active Directory domain run on Samba." \
      org.opencontainers.image.source="https://github.com/santiagotoro2023/open-directory-manager" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

# samba-tool (DNS, enrolment, replication), smbclient, Kerberos, OpenSSL for
# the certificate helpers, dpkg-deb for uploaded packages.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 libkrb5-3 libgssapi-krb5-2 krb5-user libsasl2-2 libsasl2-modules-gssapi-mit \
      python3-samba samba-common-bin samba-dsdb-modules smbclient ldb-tools \
      openssl ca-certificates curl tini procps \
 && rm -rf /var/lib/apt/lists/* /etc/krb5.conf

# A fixed account, so the shared volume's ownership means the same thing in
# every replica and in the controller that writes backups into it.
RUN groupadd --system --gid 10001 odm \
 && useradd --system --uid 10001 --gid odm --home-dir /var/lib/odm --shell /usr/sbin/nologin odm

COPY --from=api /opt/odm/venv /opt/odm/venv
COPY --from=console /src/web/dist /opt/odm/console
COPY --from=binaries /out/odm-agent /usr/sbin/odm-agent
COPY --from=binaries /out/odm-client-install /usr/sbin/odm-client-install
COPY --from=ntfy /usr/local/bin/ntfy /usr/bin/ntfy
# What the console serves to agents: role installers, the helpers they source,
# and the scripts the console's own operations use.
COPY deploy/install-*-role.sh deploy/odm-role-common.sh deploy/uninstall.sh \
     deploy/odm-apply-console-certificate deploy/publish-console-certificate.sh \
     /usr/lib/odm/roles/
COPY deploy/docker/control-plane/odm-control-plane /usr/sbin/odm-control-plane

# Everything that must outlive a container, and be the same in every replica,
# is on the shared volume; the paths the control plane has always used point
# into it. Kerberos and Samba configuration are written at start from the
# environment (odm-control-plane), into /run, which is per container.
RUN chmod 0755 /usr/lib/odm/roles/*.sh /usr/lib/odm/roles/odm-apply-console-certificate \
      /usr/sbin/odm-control-plane \
 && install -d -m 0750 -o odm -g odm /srv/odm-data \
 && install -d -m 0755 /etc/odm /etc/samba \
 && install -d -m 0755 -o odm -g odm /run/odm \
 && rm -rf /var/lib/odm \
 && ln -s /srv/odm-data /var/lib/odm \
 && ln -s /srv/odm-data/tls /etc/odm/tls \
 && ln -s /run/odm/krb5.conf /etc/krb5.conf \
 && ln -sf /run/odm/smb.conf /etc/samba/smb.conf

ENV ODM_DEPLOYMENT=container \
    ODM_VERSION="${VERSION}" \
    ODM_CONSOLE_DIR=/opt/odm/console \
    ODM_AGENT_BINARY=/usr/sbin/odm-agent \
    ODM_TLS_DIR=/etc/odm/tls \
    ODM_CA_DIR=/srv/odm-data/ca \
    ODM_CUSTOM_PACKAGE_DIR=/srv/odm-data/packages \
    ODM_BACKUP_DIR=/srv/odm-data/backups \
    ODM_PORT=8443 \
    HOME=/var/lib/odm \
    KRB5CCNAME=FILE:/tmp/krb5cc_odm \
    KRB5RCACHEDIR=/var/tmp \
    PATH=/opt/odm/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER odm
WORKDIR /srv/odm-data
VOLUME ["/srv/odm-data"]
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsSk "https://127.0.0.1:${ODM_PORT}/api/v1/healthz" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/sbin/odm-control-plane"]
