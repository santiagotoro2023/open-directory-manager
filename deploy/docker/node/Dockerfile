# Open Directory Manager: a domain controller or role server as a container.
#
# The control plane (the Dockerfile at the repository root) is an ordinary
# stateless service. What it manages is not: a domain controller answers DNS,
# Kerberos and LDAP on the network's own addresses; a DHCP server hears
# broadcasts; a file server keeps NT ACLs in extended attributes; every role
# is installed with apt and run by systemd, and the agent on the machine is
# what installs it. This image is that machine: Debian with systemd as its
# init, the agent, Samba, and the same scripts a host install uses. It runs
# with the host's network and enough privilege to be a server, and keeps its
# whole root filesystem on a volume, so what a role installs survives the
# container being recreated exactly as it survives a reboot.
#
#   ODM_NODE_ROLE=domain-controller   the first one provisions the domain,
#                                     the others join it as controllers
#   ODM_NODE_ROLE=member              joins as a member server: a place to
#                                     install DHCP, file shares, print, VPN,
#                                     RADIUS, network boot, remote desktop...
#
# Build from the repository root:
#   docker build -f deploy/docker/node/Dockerfile -t open-directory-manager-node .
# docs/CONTAINERS.md describes how to run it.

ARG DEBIAN_RELEASE=trixie

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

FROM debian:${DEBIAN_RELEASE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="Open Directory Manager node" \
      org.opencontainers.image.description="A domain controller or role server for Open Directory Manager: Samba, systemd and the ODM agent, run as a container." \
      org.opencontainers.image.source="https://github.com/santiagotoro2023/open-directory-manager" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

ENV container=docker \
    DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# A domain controller (provision-dc.sh's packages), a domain member (what
# odm-client-install expects), and what the agent's appliers depend on
# (install-agent.sh's). Roles add their own packages when they are installed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus libpam-systemd cron rsyslog \
 # Samba with its recommends, as provision-dc.sh installs it: a controller
 # relies on them (tdb-tools for a backup, dnspython for its DNS updates).
 && apt-get install -y \
      samba samba-ad-dc samba-ad-provision samba-common-bin python3-samba \
      samba-vfs-modules samba-dsdb-modules smbclient winbind libnss-winbind libpam-winbind \
      tdb-tools \
 && apt-get install -y --no-install-recommends \
      krb5-user krb5-config ldb-tools dnsutils acl attr \
      sssd-ad sssd-tools libnss-sss libpam-sss adcli libsasl2-modules-gssapi-mit \
      cifs-utils keyutils nftables dconf-cli sudo openssh-server \
      libpam-oath qrencode libglib2.0-dev-bin \
      ca-certificates curl openssl rsync iproute2 iputils-ping procps less util-linux \
      locales tzdata gnupg \
 && rm -rf /var/lib/apt/lists/*

# What does not belong in a container that shares its host's network and
# clock: anything that configures interfaces, resolvers or the time, consoles,
# and the hardware event daemons. Samba is started by the node's own setup,
# as a controller or not at all.
RUN for unit in systemd-networkd.service systemd-networkd.socket systemd-resolved.service \
        systemd-timesyncd.service systemd-udevd.service systemd-udevd-control.socket \
        systemd-udevd-kernel.socket getty@tty1.service console-getty.service \
        systemd-firstboot.service systemd-hwdb-update.service systemd-modules-load.service \
        sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
        systemd-remount-fs.service systemd-machine-id-commit.service; do \
      systemctl mask "$unit" >/dev/null 2>&1 || true; \
    done \
 && systemctl disable smbd.service nmbd.service winbind.service samba-ad-dc.service \
      ssh.service >/dev/null 2>&1 || true \
 && systemctl set-default multi-user.target \
 && rm -f /etc/machine-id /var/lib/dbus/machine-id && touch /etc/machine-id

# The same account number as the control plane's, so the keytab and backups
# it writes to the shared volume are readable by it there.
RUN groupadd --system --gid 10001 odm \
 && useradd --system --uid 10001 --gid odm --home-dir /nonexistent --shell /usr/sbin/nologin odm

# The node's starting copies, which install-agent.sh installs from (it will
# not install a file onto itself), and installed copies a member's join uses.
COPY --from=binaries /out/odm-agent /out/odm-client-install /usr/lib/odm/bin/
RUN install -m 0755 /usr/lib/odm/bin/odm-agent /usr/lib/odm/bin/odm-client-install /usr/sbin/
COPY deploy/ /usr/lib/odm/deploy/
# Where install-agent.sh puts them on every machine; the console serves newer
# ones, so these are only what a node starts with.
RUN install -d -m 0755 /usr/lib/odm/roles \
 && install -m 0755 /usr/lib/odm/deploy/install-*-role.sh /usr/lib/odm/deploy/uninstall.sh \
      /usr/lib/odm/deploy/odm-apply-console-certificate \
      /usr/lib/odm/deploy/publish-console-certificate.sh /usr/lib/odm/roles/ \
 && install -m 0644 /usr/lib/odm/deploy/odm-role-common.sh /usr/lib/odm/roles/ \
 && install -m 0644 /usr/lib/odm/deploy/odm-agent.service /etc/systemd/system/odm-agent.service \
 && rm -rf /usr/lib/odm/deploy/docker \
 && chmod 0755 /usr/lib/odm/deploy/*.sh

COPY deploy/docker/node/odm-node-init /usr/sbin/odm-node-init
COPY deploy/docker/node/odm-node-setup /usr/sbin/odm-node-setup
COPY deploy/docker/node/odm-node-sync /usr/sbin/odm-node-sync
COPY deploy/docker/node/systemd/ /etc/systemd/system/
RUN chmod 0755 /usr/sbin/odm-node-init /usr/sbin/odm-node-setup /usr/sbin/odm-node-sync \
 && install -d -m 0750 /etc/odm /var/lib/odm \
 && install -d -m 0750 -o odm -g odm /srv/odm-data \
 && printf '%s\n' "${VERSION}" > /etc/odm/container-node \
 && systemctl enable odm-node-setup.service odm-node-sync.timer odm-node-log.service >/dev/null

# The volume the whole root filesystem is kept on (odm-node-init), and the
# control plane's shared volume, which a domain controller writes backups and
# the control plane's keytab to.
VOLUME ["/persist"]
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/sbin/odm-node-init"]
