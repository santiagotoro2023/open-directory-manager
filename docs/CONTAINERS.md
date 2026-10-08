# Open Directory Manager in containers

ODM runs from two container images, with Docker, Docker Compose, Kubernetes or
Helm. Every feature of a host install (`deploy/setup.sh`) works the same way.
Two things make that possible:

- **The control plane is a stateless service.** Any number of replicas share
  PostgreSQL and one volume, behind one address.
- **The machines of the domain stay machines.** Domain controllers and the
  servers that roles are installed on run as containers with their own
  systemd, the ODM agent, and the network and name of the host they run on.
  So everything that has always needed a real Linux server still has one:
  Samba's DNS, Kerberos and LDAP, DHCP broadcasts, SMB shares, apt-installed
  roles and the agent that installs them.

The machines being managed (desktops, laptops, servers) are not affected. They
join, run the agent and apply policy exactly as they do against a host
install.

- [What runs where](#what-runs-where)
- [The images](#the-images)
- [Docker Compose: a domain on one host](#docker-compose-a-domain-on-one-host)
- [More machines: other Docker hosts](#more-machines-other-docker-hosts)
- [Kubernetes with Helm](#kubernetes-with-helm)
- [Kubernetes without Helm](#kubernetes-without-helm)
- [Distributed: replicas, controllers, failover](#distributed-replicas-controllers-failover)
- [Networking](#networking)
- [Storage, backups and upgrades](#storage-backups-and-upgrades)
- [Settings](#settings)
- [Every feature, in containers](#every-feature-in-containers)
- [Differences from a host install](#differences-from-a-host-install)
- [Troubleshooting](#troubleshooting)

## What runs where

```
                      browsers, agents, phones
                                │ https :8443 (console)  :8444 (phone approvals)
          ┌─────────────────────┴───────────────────────┐
          │  control plane  ×N         ntfy  ×1         │  ghcr.io/<owner>/open-directory-manager
          │  (API + console)        (phone approvals)   │  unprivileged, read-only root
          └──────┬──────────────┬─────────────┬─────────┘
                 │              │             │
            PostgreSQL     shared volume      │ LDAPS, Kerberos, samba-tool,
                           /srv/odm-data      │ Kea Control Agent (TLS)
                                 │            │
          ┌──────────────────────┴────────────┴─────────┐
          │  dc1, dc2, …        srv1, srv2, …           │  ghcr.io/<owner>/open-directory-manager-node
          │  Samba AD DC        member servers:         │  systemd + agent, host network,
          │  + agent            roles installed from    │  privileged, whole disk on a volume
          │                     the console             │
          └─────────────────────────────────────────────┘
                 │  DNS :53  Kerberos :88  LDAP :389/636  SMB :445  DHCP :67 …
                         the network the domain serves
```

| Component | Image | Runs as | State |
|---|---|---|---|
| Control plane (API and console) | `open-directory-manager` | uid 10001, read-only root, no capabilities | PostgreSQL and the shared volume |
| Phone approvals (ntfy) | `open-directory-manager`, command `ntfy` | uid 10001, read-only root | its own small volume; token on the shared volume |
| PostgreSQL | `postgres:17-alpine`, or your own | | its own volume |
| Domain controller | `open-directory-manager-node`, `ODM_NODE_ROLE=domain-controller` | privileged, host network | its root filesystem on a volume |
| Member server (for roles) | `open-directory-manager-node`, `ODM_NODE_ROLE=member` | privileged, host network | its root filesystem on a volume |

### The shared volume

Every control-plane replica, the notification server and every node mount one
volume at `/srv/odm-data`:

| Path | Written by | Contents |
|---|---|---|
| `tls/` | control plane | The console's certificate and key, created self-signed on first start and replaced from the console. `phone.crt` is what phones trust |
| `secrets/odm-api.keytab`, `secrets/dc-ca.pem` | first controller | The control plane's service account keytab and the directory's LDAPS CA, from `create-api-service-account.sh` |
| `secrets/ntfy-token` | ntfy | The control plane's publishing token |
| `secrets/kea.env`, `secrets/kea-ca.pem` | the DHCP node | Where the Kea Control Agent is, its credential and its certificate |
| `ca/` | control plane | The domain certificate authority |
| `packages/` | control plane | `.deb` files uploaded for software deployment |
| `backups/` | the controller's agent | Domain backups (`samba-tool domain backup`) |
| `sysvol/` | control plane | Policy folders for the SYSVOL mirror, when it is on |

On a host install these live under `/etc/odm` and `/var/lib/odm`. The image
links those paths to the volume, so the code reads them where it always has.

### The machines

The node image is Debian 13 with systemd as init, Samba, the agent, and the
same scripts a host install uses. On first start, `odm-node-init` copies the
image's root filesystem onto the volume at `/persist`. Every start after that
boots from the copy, the way a virtual machine boots from its disk. What a role
installs with apt, what Samba keeps in `/var/lib/samba`, and the agent's own
updates all survive the container being recreated.

On first boot `odm-node-setup` does what `deploy/setup.sh` does on a server:

- **The first controller** provisions the domain (`provision-dc.sh`'s
  options). It creates the control plane's account (`create-api-service-account.sh`),
  puts the keytab on the shared volume, points `odm.<domain>` at the console,
  publishes the console certificate into SYSVOL, and installs the agent.
- **Another controller** joins as a domain controller. Samba replicates the
  directory itself; `odm-node-sync` keeps SYSVOL in step with the first
  controller.
- **A member server** joins with `odm-client-install`, using either the
  Administrator password or a join token. It is then a machine like any
  other: roles are installed on it from **Server Roles**, policy applies to
  it, and it appears under **Servers**.

## The images

| Image | Built from |
|---|---|
| `ghcr.io/santiagotoro2023/open-directory-manager` | `Dockerfile` |
| `ghcr.io/santiagotoro2023/open-directory-manager-node` | `deploy/docker/node/Dockerfile` |
| `oci://ghcr.io/santiagotoro2023/charts/open-directory-manager` | `deploy/helm/open-directory-manager` |

Every image and the chart share one version number (the one in
`api/pyproject.toml`). `.github/workflows/containers.yml` publishes them for
amd64 and arm64:

- `:<version>`, and `:latest` from `main`, on every push to `main`
- the same on every `v*` tag

Before publishing, it brings up a whole domain from the freshly built images
and tests it (`scripts/test-containers.sh`).

To build them yourself from a checkout:

```
docker build -t open-directory-manager .
docker build -f deploy/docker/node/Dockerfile -t open-directory-manager-node .
```

Behind a proxy that re-signs TLS, hand the build its CA. It is used by the
build stages only and never kept in the image:
`docker build --secret id=build_ca,src=/path/to/ca.pem …`.

The control-plane image carries the agent binary and the role installers the
console hands out. A domain therefore runs the agent version and the role
scripts of the image the console runs from, exactly as a host install hands
out what it was deployed with.

## Docker Compose: a domain on one host

`docker-compose.yml` at the root of the repository is a complete domain on one
Docker host:

| Service | Purpose | Network |
|---|---|---|
| `dc1` | The domain controller, and the machine roles can be installed on | the host's own |
| `odm` | API and console | port 8443 |
| `ntfy` | phone approvals | port 8444 |
| `db` | PostgreSQL | internal |

The host should be dedicated to this: a VM or a server whose own address
becomes the domain's DNS and KDC. The controller binds DNS, Kerberos, LDAP,
SMB and RPC on that address. Nothing else on it may already use ports 53, 88,
135, 139, 389, 445, 464, 636, 3268 or 3269.

```
cp deploy/compose/.env.example .env
$EDITOR .env                       # realm, this host's address, passwords
docker compose up -d
docker compose logs -f dc1         # the domain being provisioned: two or three minutes
```

Then open `https://odm.<domain>:8443` and sign in as `Administrator` with the
password from `.env`. Until clients use the controller for DNS, put
`odm.<domain>` in your own resolver or `hosts` file, pointing at the host's
address.

Point the network's DHCP or the clients' resolver at the host's address, and
join machines exactly as with a host install (**Wiki → Joining machines**):

```
sudo odm-client-install --domain corp.example.internal --admin-user Administrator
```

Roles install on `dc1` from **Server Roles**, as on a single-server host
install: DHCP, time, print, monitoring, and so on. To keep roles off the
controller, add member servers (next section).

### What to back up

| Volume | Holds | How |
|---|---|---|
| `odm_db` | Everything ODM keeps itself: audit log, policy objects, recycle bin, roles, delegation | `docker compose exec db pg_dump -U odm -Fc odm > odm.dump` |
| `odm_odm-data` | The shared volume (above) | `docker run --rm -v odm_odm-data:/d -v $PWD:/b debian tar czf /b/odm-data.tgz -C /d .` |
| `odm_dc1` | The controller's disk: the directory, SYSVOL, installed roles | **Operations → Backups** takes domain backups onto the shared volume, every 24 hours by default. To copy the whole disk, stop `dc1` first |

## More machines: other Docker hosts

`deploy/compose/node/` is one more machine on another Docker host: either
another domain controller or a member server. Use one per host, because the
container takes the host's address and network.

```
cd deploy/compose/node
cp .env.example .env
$EDITOR .env
docker compose up -d
```

| To add | Set |
|---|---|
| Another domain controller | `ODM_NODE_ROLE=domain-controller`, `ODM_DC_JOIN=dc1`, `ODM_ADMIN_PASSWORD`, `ODM_DNS_SERVERS=<dc1's address>` |
| A member server with the Administrator password | `ODM_NODE_ROLE=member`, `ODM_ADMIN_PASSWORD`, `ODM_DNS_SERVERS` |
| A member server with a join token | `ODM_NODE_ROLE=member`, `ODM_JOIN_TOKEN`, `ODM_CONSOLE_CA_CERT_FILE`, `ODM_DNS_SERVERS` |

A join token is redeemed with the console before the machine has an account,
so the machine checks the console against a certificate it is given. That is
the same as `--ca-cert` on any other machine. Copy it from the first host:
`docker compose cp odm:/srv/odm-data/tls/api.crt console.pem`.

**DHCP on a member server on another host.** The DHCP role configures the Kea
Control Agent on the node's address over TLS. Without the shared volume
(which a separate Docker host does not have), the installer prints the
settings for the control plane. Add them to the `odm` service's environment,
and mount the certificate it names:

```
ODM_KEA_URL=https://<node address>:8000/
ODM_KEA_USER=odm
ODM_KEA_PASSWORD=<from /etc/kea/kea-api-password on the node>
ODM_KEA_CA_CERT=/run/kea-ca.pem        # /etc/kea/odm-control.crt from the node
```

On Kubernetes, and on the controller of a Compose host, this happens by itself
through the shared volume.

## Kubernetes with Helm

```
kubectl create namespace odm
kubectl label namespace odm pod-security.kubernetes.io/enforce=privileged
helm install odm oci://ghcr.io/santiagotoro2023/charts/open-directory-manager \
  --namespace odm \
  --set domain.realm=CORP.EXAMPLE.INTERNAL --set domain.name=corp.example.internal \
  --set 'domainControllers[0].node=dc1' --set 'domainControllers[0].address=192.0.2.11'
```

Follow the provisioning with
`kubectl logs -n odm -f statefulset/odm-open-directory-manager-dc0`, and read
the Administrator password with the command `helm install` prints.
`deploy/helm/open-directory-manager/values.yaml` documents every value. The
ones that matter:

| Value | Meaning |
|---|---|
| `domain.realm`, `domain.name` | The domain. Fixed once provisioned |
| `domain.adminPassword` / `domain.existingSecret` | The Administrator password. Generated if empty, and kept across upgrades |
| `console.address` | The address the console is reached at: the Service's LoadBalancer IP. The first controller registers it in DNS as `odm.<domain>`. Set it once the address is known |
| `domainControllers` | One entry per controller: the Kubernetes `node` it runs on, and that node's `address`. The first provisions, the rest join |
| `memberServers` | Servers to install roles on, same shape |
| `controlPlane.replicaCount` | Control-plane replicas (default 3) |
| `sharedData.accessMode` | `ReadWriteMany` unless every pod runs on one node |
| `service.type` | `LoadBalancer` (default) or `NodePort` |
| `database.*` | The bundled PostgreSQL, or `database.url` / `existingSecret` for your own |
| `nodes.storage`, `nodes.storageClass` | Each machine's disk. A local volume is right |

### What the chart asks of the cluster

- **Privileged pods in the namespace.** Domain controllers and member servers
  need them: systemd as init, NT ACLs in extended attributes, and roles that
  run network services. The control plane does not, and runs with the
  `restricted` profile's settings.
- **Nodes for the machines.** Each controller and member server is pinned to
  one Kubernetes node (`kubernetes.io/hostname`). It uses that node's network
  and that node's host name, which becomes its name in the domain: at most 15
  letters, digits and hyphens. Use nodes dedicated to this, so DNS, Kerberos,
  LDAP, SMB and (for DHCP) port 67 are free on them. Taint them and add
  `nodes.tolerations` to keep other workloads off.
- **A `ReadWriteMany` storage class for the shared volume** (NFS, CephFS,
  Longhorn RWX, Azure Files, EFS, …) when the control plane and the machines
  are on more than one node. Root on the volume must be able to `chown` it
  once; with NFS `root_squash`, create the export owned by `10001:10001`.
- **A way to give the console an address outside the cluster.** A
  LoadBalancer (MetalLB, or a cloud's), or NodePort. Browsers, agents and
  phones all verify the console's own certificate, so TLS must reach the pods
  untouched. An Ingress works only in TLS passthrough
  (`ingress.enabled=true`; for ingress-nginx, `--enable-ssl-passthrough`).

### DNS inside the cluster

The control plane reaches controllers and member servers by name, because
Kerberos needs names. The chart adds every machine in `domainControllers` and
`memberServers` to the control-plane pods' `/etc/hosts`. For anything else
in the domain that the control plane has to reach by name (a password-manager
vault or a DHCP node on a machine outside the chart), forward the domain to
the controllers in CoreDNS:

```
corp.example.internal:53 {
    forward . 192.0.2.11 192.0.2.12
}
```

## Kubernetes without Helm

`deploy/kubernetes/open-directory-manager.yaml` is the chart rendered once
(`deploy/kubernetes/generate.sh`, from `deploy/kubernetes/values.yaml`), with
the namespace:

1. Edit the lines marked `CHANGE`: the two passwords, the controller's node
   and address (in its StatefulSet and in the control plane's `hostAliases`),
   and the console's address.
2. `kubectl apply -f deploy/kubernetes/open-directory-manager.yaml`
3. `kubectl -n odm logs -f statefulset/odm-dc0`

To add controllers or member servers, use the chart.

## Distributed: replicas, controllers, failover

**Control-plane replicas.** Every replica serves every request. Sessions,
sign-in lockouts and everything else the console keeps are in PostgreSQL, and
pages refresh through PostgreSQL's notifications whichever replica wrote.
Three things are arranged so that several replicas behave like one:

- *Scheduled work* (recycle-bin purge, scheduled backups, dynamic groups,
  monitoring rules, password-manager reconciliation) runs on one replica at a
  time, whichever holds a PostgreSQL advisory lock. When it stops, another
  takes over within seconds (`api/odm/leader.py`).
- *Terminals and shared screens* live in the memory of the replica that
  opened them. Their ids name that replica, and a socket that lands on another
  replica (the browser's, or the agent's) is carried across to it over TLS
  (`api/odm/replicas.py`). Each replica learns its own address from the pod's
  (`ODM_REPLICA_ADDRESS`).
- *Database migrations* run on start under a lock, so replicas starting
  together apply each migration once.

When the console certificate is replaced from **Certificates**, the replica
that handled it installs it on the shared volume. Every replica (and ntfy)
restarts on it within half a minute. The controller then publishes it into
SYSVOL for the machines that verify the console with it.

**Domain controllers.** Each controller is a full Samba AD DC: DNS for the
domain's AD-integrated zones, Kerberos and LDAP, replicated by Samba itself.
List more than one, and point clients' DNS at all of them (the DHCP role hands
them out). **Operations → Replication** shows the topology as on a host
install. SYSVOL, which Samba does not replicate, is copied from the first
controller every three minutes.

**DHCP failover.** Install the DHCP role on two machines (two controllers, or
two member servers, on different nodes or hosts), then pair them under
**DHCP**, exactly as on host installs. Leases register themselves in the
domain's DNS through `kea-dhcp-ddns`. DHCP needs to hear broadcasts, which is
why the machines use their host's network. Subnets the machines are not on
reach them through a DHCP relay (`ip helper-address`), as with any DHCP
server.

## Networking

| Port | Where | What |
|---|---|---|
| 8443/tcp | console address | Console and API, agents included |
| 8444/tcp | console address | Phone approvals (ntfy) |
| 53/udp+tcp | each controller | DNS |
| 88/udp+tcp, 464/udp+tcp | each controller | Kerberos, password changes |
| 135/tcp, 49152–65535/tcp | each controller | RPC (DNS management, replication) |
| 389/tcp, 636/tcp, 3268/tcp, 3269/tcp | each controller | LDAP, LDAPS, global catalog |
| 445/tcp | each controller, file servers | SMB: SYSVOL, shares |
| 67/udp | DHCP machines | DHCP |
| 8000/tcp | DHCP machines | Kea Control Agent, TLS, from the control plane only |
| 8080/tcp | DHCP machines | Kea failover between the pair |
| others | as a role says | print (631), VPN (WireGuard), RADIUS (1812/1813), time (123), remote desktop (3389), PXE (69, 80) |

The control plane opens connections to: PostgreSQL, ntfy, controllers (LDAPS,
Kerberos, RPC), the DHCP Control Agent, a password-manager vault, and other
replicas on 8443. Nothing connects into a member server except the protocols
of the roles it runs; machines collect their work from the control plane.

## Storage, backups and upgrades

- **PostgreSQL** holds everything ODM keeps itself. Back it up like any
  database: `pg_dump`, or your operator's backups.
- **The shared volume** holds the console certificate, the control plane's
  keytab, the certificate authority and the backups. Back it up with the
  database.
- **Each machine's volume** is that machine's disk. The directory itself is
  backed up by **Operations → Backups** (offline `samba-tool domain backup`,
  taken by the controller's own agent, written to the shared volume).
- **Upgrading the control plane** means a new image tag (`helm upgrade`,
  `docker compose pull && docker compose up -d`). Replicas roll one at a time,
  and migrations apply themselves.
- **Upgrading a machine** does not happen by replacing its image. Its disk
  was seeded once, and from then on it updates itself the way every machine in
  the domain does: packages from **Updates**, and the agent from the console
  that runs the newer image (a computer's **Update agent**, or the agent-update
  policy setting). The node image's version only matters for new machines. To
  rebuild a machine from scratch, delete its volume; a controller rejoins from
  another, and a member server rejoins and gets its roles reinstalled.

## Settings

The control plane takes every setting a host install keeps in
`/etc/odm/odm.env` (`deploy/odm.env.example`) as an environment variable. The
image works out most of them:

| Setting | Default in the image |
|---|---|
| `ODM_REALM` | required |
| `ODM_DOMAIN` | the realm in lower case |
| `ODM_DOMAIN_CONTROLLERS` | required: the controllers' names; the first is the one LDAP uses |
| `ODM_LDAP_URI` | `ldaps://<first controller>` |
| `ODM_CONSOLE_URL` | `https://odm.<domain>:8443` |
| `ODM_ALLOWED_ORIGINS` | the console's own origin |
| `ODM_DATABASE_URL` | required |
| `ODM_KEYTAB`, `ODM_LDAP_CA_CERT` | from the shared volume, put there by the first controller |
| `ODM_NTFY_URL` | set by Compose and the chart; the public address and the token follow |
| `ODM_KEA_*` | from the shared volume once the DHCP role is installed, unless set |
| `ODM_REPLICA_ADDRESS` | the pod's own address (chart); `auto` uses the container's |
| `ODM_CONTROLLER_NODE` | the first controller: the machine whose agent takes backups and publishes the console certificate |
| `ODM_DEPLOYMENT` | `container` |
| `ODM_SYSVOL_PATH` | unset (as on a host install); the chart's `domain.sysvolMirror` sets it |

Add any of the others through `controlPlane.extraEnv` (Helm) or the
`environment` of the `odm` service (Compose): session lengths, lockout
thresholds, retention, backup interval.

A node takes:

| Setting | |
|---|---|
| `ODM_NODE_ROLE` | `domain-controller` or `member` |
| `ODM_REALM`, `ODM_DOMAIN`, `ODM_NETBIOS` | the domain |
| `ODM_NODE_ADDRESS` | the address it serves on (its host's) |
| `ODM_ADMIN_PASSWORD` (or `_FILE`) | to provision, or to join |
| `ODM_DC_JOIN` | for another controller: the controller to join from |
| `ODM_DNS_SERVERS` | the controllers' addresses, for anything but the first controller |
| `ODM_JOIN_TOKEN`, `ODM_CONSOLE_CA_CERT` (or `_FILE`) | a member joining with a token |
| `ODM_CONSOLE_FQDN`, `ODM_CONSOLE_ADDRESS` | the console's name and the address the first controller registers for it |
| `ODM_DNS_FORWARDER` | upstream DNS. Default: the resolver of the host it runs on |
| `ODM_SYSVOL_MIRROR` | `yes` on the first controller to mirror policy objects into SYSVOL |

## Every feature, in containers

"Verified" means the feature ran end to end against the images (Compose, on
one Docker host) while this support was built. The automated part of that is
`scripts/test-containers.sh`, which CI runs before anything is published.
"Same path" means it runs on code and infrastructure the verified features
already exercise, unchanged from a host install. The Helm chart and the
manifest are linted and validated against the Kubernetes schema in CI. They
run the same images with the same settings that were verified under Docker.

| Area | How it works in containers | |
|---|---|---|
| Console sign-in, Domain Admins gate, lockout, sessions | API over LDAPS and Kerberos to the controller; sessions in PostgreSQL, shared by replicas | Verified |
| Directory: users, groups, computers, OUs, bulk, offboarding, dynamic groups | API over LDAP; dynamic groups on the scheduler replica | Verified (create, list, delete); rest same path |
| Recycle bin, restore keeping the SID | API; tombstone reanimation rights granted by the first controller | Verified |
| Audit, activity, delegation (RBAC) | PostgreSQL | Same path |
| Group Policy: objects, links, precedence, enforcement, blocking, filtering, targeting, history, rollback, modelling, export/import | API and PostgreSQL | Verified (create, link, apply); rest same path |
| Every policy setting on managed machines | The agent on each machine, unchanged | Same path (machines are not containers) |
| Policy settings on a node container | Applied, except those that belong to the host: firewall, sysctl, host name, boot loader and splash, graphics drivers, firmware, removable storage, device control, Wi-Fi, always-on VPN. Those are reported as skipped, with the reason | Verified |
| SYSVOL mirror for GPMC/RSAT | The control plane writes policy folders to the shared volume; the first controller copies them into SYSVOL and resets their ACLs | Verified (create and delete) |
| ADMX/ADML import | API and PostgreSQL | Same path |
| DNS: zones, records, dynamic-update status | `samba-tool dns` from the control-plane container, over Kerberos | Verified |
| DHCP: scopes, reservations, options, leases | Kea on a node; its Control Agent on the node's address over TLS; settings handed over on the shared volume | Verified (role installed from the console, scope created) |
| DHCP failover pair, DHCP→DNS updates | Kea's own HA and `kea-dhcp-ddns`, as on host installs | Same path (needs two hosts) |
| Server roles: install and remove from the console | The agent on the node runs the installer the console serves | Verified: DHCP, time, monitoring, print server |
| File shares, roaming profiles | File-server role on a member server; SMB on its host's address | Same path (one SMB server per address) |
| Printing | Print-server role | Verified (install) |
| Remote desktop: session hosts, broker, profile disks | Roles on member servers | Same path |
| VPN, RADIUS, network boot (PXE) | Roles on member servers, on their host's network | Same path |
| Time | Time role; in a container chrony serves time but never sets the clock, which is the host's | Verified |
| Monitoring and alerting | Monitoring role on a node; rules evaluated on the scheduler replica; alerts through ntfy or webhooks | Verified (install); evaluation same path |
| Phone approvals (second factor) | ntfy container with the console's own certificate; the control plane publishes over TLS checked against the console's name | Verified (publish) |
| Second factor by code, local password policy, local administrator | Agent on machines | Same path |
| Certificate authority, autoenrolment, CRL, replacing the console certificate | CA on the shared volume; a replaced console certificate is installed by the control plane and restarts every replica; the controller republishes it into SYSVOL | Verified (authority created, console certificate replaced and republished); issuing, autoenrolment and the CRL same path |
| Password manager (Vaultwarden) | Role on a member server (podman inside the node); `/vault` carried by the control plane; OpenID Connect from the control plane | Same path |
| Domain backups | Taken by the first controller's agent onto the shared volume, listed and pruned by the control plane | Verified |
| Replication topology, force replication | `samba-tool drs` from the control plane | Verified (view) |
| Health dashboard, security baseline, configuration export/import | API and PostgreSQL | Same path |
| Terminal on a machine | Held by one replica; a browser's or an agent's socket on any other is carried to it | Verified, across two replicas: opened on one, the browser and the agent on the other, both ways |
| Watching a screen (remote assist) | The same forwarding as the terminal | Forwarding verified by tests; VNC same path |
| Machine management: inventory, software, logs, updates, restart, files, disk encryption | The agent's tasks, unchanged | Same path |
| Joining machines with a credential | `odm-client-install` against the controller | Verified |
| Joining with a join token | Enrolment over LDAP from the control plane; the machine's keytab made with MIT `ktutil` from the password it was just given (a controller hands out keys only from its own database) | Verified |
| Agent updates | The control-plane image carries the agent it hands out | Same path |
| Uploaded packages | On the shared volume, served to machines by any replica | Same path |
| Client enrolment (PXE) | PXE role; `odm-client-install` is in the node image | Same path |

## Differences from a host install

- **Host-owned settings on node containers.** A controller or member server
  in a container shares its host's kernel, network namespace and name. Policy
  settings that would change those are skipped on it, with the reason (see
  the table above). The host is managed as whatever it is.
- **SSH into a node container.** Node containers do not run their own SSH
  server; the host's owns port 22. Use the console's terminal, which works on
  every machine with an agent.
- **Shutting a node down from the console restarts it.** Its container is
  stopped, and Docker or Kubernetes start it again.
- **One machine per host address.** A controller and a separate file server
  both want port 445. On one Docker host, install roles on the controller (as
  with a single-server host install), or use another host or node.
- **Token enrolment** builds the machine's keytab from its new password
  instead of exporting it from the controller's database. The result is the
  same keytab.
- **The console certificate** is installed by the control plane itself rather
  than by the controller's agent, because there is no host for the agent to
  install it on.
- **`setup.sh --uninstall`** has nothing to remove. `docker compose down -v`
  or `helm uninstall` (and deleting the kept Secrets and volumes) is the same
  thing.

## Troubleshooting

| Symptom | Look at |
|---|---|
| The console waits forever | `docker compose logs odm` / `kubectl logs`: it says what it is waiting for, usually the keytab the first controller has not published yet. Then the controller's own log |
| A controller does not come up | `docker compose logs dc1`. The node's whole journal is on the container's output. `docker compose exec dc1 journalctl -u odm-node-setup` shows the setup step by step; it retries on its own every 30 seconds |
| Ports already in use on the host | Something else on 53 (a resolver), 88 or 445. The controller binds only its address and the loopback, but those must be free |
| Agents report a certificate error after the console certificate was replaced | `docker compose exec dc1 odm-node-sync console` republishes it; agents fetch it from SYSVOL |
| DHCP says it is not configured | `secrets/kea.env` on the shared volume; the control plane restarts within half a minute of it appearing |
| `odm-client-install` with a token says the certificate is unknown | Give the node `ODM_CONSOLE_CA_CERT_FILE` (or `--ca-cert` on any machine) |
| Kubernetes: a node pod is Pending | Its `node` value must match the node's `kubernetes.io/hostname` label, and the namespace must allow privileged pods |
