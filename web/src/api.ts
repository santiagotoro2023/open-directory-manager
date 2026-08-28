export interface SessionInfo {
  principal: string;
  display_name: string;
  distinguished_name: string;
  csrf_token: string;
  expires_at: string;
  domain_admin: boolean;
  /** Permissions this operator holds; ["*"] for a domain administrator. */
  permissions: string[];
  scopes: { role: string; scope_dn: string }[];
}

/** True when the signed-in operator holds a permission anywhere. */
export function holds(session: SessionInfo, permission: string): boolean {
  return session.domain_admin || session.permissions.includes(permission);
}

export interface RbacRole {
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
}

export interface RbacAssignment {
  id: string;
  role_name: string;
  principal_sid: string;
  principal_name: string;
  scope_dn: string;
  description: string;
  granted_by: string;
  granted_at: string;
}

export type ObjectType = "user" | "group" | "computer" | "ou";

export interface DirectoryObject {
  distinguishedName: string;
  objectType: ObjectType | "container" | "domain";
  [attribute: string]: unknown;
}

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor: string;
  source_ip: string | null;
  action: string;
  object_type: string | null;
  object_dn: string | null;
  outcome: "success" | "failure" | "denied";
  detail: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface PolicySettings {
  files?: Record<string, unknown>[];
  scripts?: Record<string, unknown>[];
  systemd_units?: Record<string, unknown>[];
  cron?: Record<string, unknown>[];
  firewall?: Record<string, unknown>[];
  drive_maps?: Record<string, unknown>[];
  sudo_rules?: Record<string, unknown>[];
  hbac_rules?: Record<string, unknown>[];
  admx?: AdmxSelection[];
  browser?: { chromium?: Record<string, unknown>; firefox?: Record<string, unknown> };
  wallpaper?: { uri: string; picture_options: string; for_principal?: string };
  agent?: { refresh_minutes: number };
}

export interface Targeting {
  os?: string[];
  hostname_pattern?: string;
  security_groups?: string[];
  ip_ranges?: string[];
}

export interface Gpo {
  guid: string;
  display_name: string;
  description: string;
  enabled: boolean;
  version: number;
  settings: PolicySettings;
  security_filter: string[];
  targeting: Targeting;
  updated_at: string;
  link_count?: number;
  links?: GpoLink[];
}

export interface GpoLink {
  id: string;
  gpo_guid: string;
  target_dn: string;
  link_order: number;
  enforced: boolean;
  enabled: boolean;
  display_name?: string;
  gpo_enabled?: boolean;
}

export interface EffectivePolicy {
  target: { dn: string; hostname: string; os: string };
  applied_gpos: { guid: string; name: string }[];
  skipped_gpos: { guid: string; name: string; reason: string }[];
  settings: PolicySettings;
  serial: string;
}

export interface AgentReport {
  id: string;
  computer_dn: string;
  hostname: string;
  reported_at: string;
  agent_version: string | null;
  policy_serial: string | null;
  applied_gpos: { guid: string; name: string }[];
  results: { setting: string; status: string; reason?: string }[];
  failures: number;
}

export interface AdmxElement {
  id: string;
  type: "boolean" | "decimal" | "text" | "multiText" | "enum" | "list";
  value_name: string;
  label: string;
  required: boolean;
  minimum: number | null;
  maximum: number | null;
  max_length: number | null;
  items: { label: string; value: string | number }[];
}

export interface AdmxPolicy {
  id: string;
  display_name: string;
  explain_text: string;
  policy_class: string;
  category: string;
  registry_key: string;
  value_name: string;
  supported_on: string;
  elements: AdmxElement[];
  applicable: boolean;
}

export interface AdmxTemplate {
  id: string;
  namespace: string;
  display_name: string;
  file_name: string;
  revision: string;
  policy_count: number;
  applicable_count: number;
  has_adml: boolean;
  uploaded_by: string;
  uploaded_at: string;
}

export interface AdmxSelection {
  policy_id: string;
  state: "enabled" | "disabled";
  values: Record<string, unknown>;
}

export interface DnsZone {
  name: string;
  type?: string;
  flags?: string;
  dynamic_update?: boolean;
}

export interface DnsRecord {
  name: string;
  type: string;
  data: string;
  ttl: number;
  serial: number;
  flags: string;
}

export interface DhcpScope {
  id: number;
  subnet: string;
  pools: { pool: string }[];
  "option-data"?: { name: string; data: string }[];
  reservations?: { "hw-address": string; "ip-address": string; hostname?: string }[];
  "valid-lifetime"?: number;
  "user-context"?: { comment?: string };
}

export interface DhcpLease {
  "ip-address": string;
  "hw-address": string;
  hostname?: string;
  "subnet-id": number;
  "valid-lft": number;
  cltt: number;
  state: number;
}

export interface DeletedObject {
  id: string;
  object_dn: string;
  object_type: string;
  display_name: string | null;
  parent_dn: string;
  deleted_by: string;
  deleted_at: string;
  purge_after: string;
  restored_at: string | null;
  memberships: string[];
  members: string[];
}

export interface RoleDescriptor {
  name: string;
  title: string;
  summary: string;
  core: boolean;
  arguments: string[];
  optional_arguments: string[];
  packages: string[];
  produces_settings: string[];
  notes: string;
}

export interface RoleInstance {
  id: string;
  role_name: string;
  node_fqdn: string;
  state: "pending" | "installing" | "active" | "failed" | "removed";
  config: Record<string, string>;
  last_error: string | null;
  installed_by: string | null;
  installed_at: string | null;
  updated_at: string;
}

export interface CaStatus {
  initialised: boolean;
  subject?: string;
  not_before?: string;
  not_after?: string;
  fingerprint?: string;
  serial?: string;
  issued?: number;
  expiring_soon?: number;
}

export interface IssuedCertificate {
  serial: string;
  subject: string;
  sans: string[];
  profile: "server" | "client" | "console";
  fingerprint: string;
  not_before: string;
  not_after: string;
  issued_by: string;
  issued_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  certificate_pem?: string;
  private_key_pem?: string;
}

export interface HealthReport {
  domain: string;
  directory: { available?: boolean; controllers?: number; names?: string[]; detail?: string };
  replication: {
    available?: boolean;
    healthy?: boolean;
    server?: string;
    inbound?: {
      naming_context: string;
      partner: string;
      last_attempt: string;
      succeeded: boolean | null;
      failures: number;
    }[];
    detail?: string;
  };
  dhcp: { configured?: boolean; statistics?: Record<string, number>; detail?: string };
  certificates: { initialised?: boolean; not_after?: string; expiring_soon?: number };
  agents: {
    checked_in: number;
    fresh: number;
    stale: number;
    failing_settings: number;
    stale_after_minutes: number;
  };
  backups: {
    configured: boolean;
    interval_hours?: number;
    last?: { started_at: string; size_bytes: number } | null;
  };
}

export interface BackupRecord {
  id: string;
  path: string;
  state: string;
  size_bytes: number;
  started_at: string;
  finished_at: string | null;
  taken_by: string;
  detail: string | null;
}

export interface JoinToken {
  id: string;
  label: string;
  container_dn: string;
  hostname: string | null;
  uses_allowed: number;
  uses_spent: number;
  expires_at: string;
  created_by: string;
  last_used_at: string | null;
  last_used_by: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (method !== "GET" && csrfToken) headers.set("X-ODM-CSRF", csrfToken);

  const response = await fetch(`/api/v1${path}`, {
    ...init,
    method,
    headers,
    credentials: "same-origin",
  });

  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, (body as { detail?: string }).detail ?? response.statusText);
  }
  return body as T;
}

function remember(session: SessionInfo): SessionInfo {
  csrfToken = session.csrf_token;
  return session;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export interface NewUser {
  container: string;
  sam_account_name: string;
  name?: string;
  given_name?: string;
  surname?: string;
  display_name?: string;
  mail?: string;
  description?: string;
  password?: string;
  must_change_password?: boolean;
  enabled?: boolean;
}

export const api = {
  login: (username: string, password: string) =>
    request<SessionInfo>("/auth/login", json({ username, password })).then(remember),

  session: () => request<SessionInfo>("/auth/session").then(remember),

  logout: async () => {
    await request<void>("/auth/logout", { method: "POST" });
    csrfToken = "";
  },

  directory: {
    tree: () => request<{ base_dn: string; nodes: DirectoryObject[] }>("/directory/tree"),

    list: (params: {
      container?: string;
      object_type?: ObjectType;
      query?: string;
      scope?: "level" | "subtree";
    }) =>
      request<{ objects: DirectoryObject[]; truncated: boolean }>(
        `/directory/objects${qs(params)}`,
      ),

    get: (dn: string) => request<DirectoryObject>(`/directory/object${qs({ dn })}`),

    createUser: (body: NewUser) => request<DirectoryObject>("/directory/users", json(body)),

    bulkUsers: (users: NewUser[]) =>
      request<{ created: number; results: { sam_account_name: string; created: boolean; error?: string }[] }>(
        "/directory/users/bulk",
        json({ users }),
      ),

    createGroup: (body: { container: string; name: string; group_type: string; description?: string }) =>
      request<DirectoryObject>("/directory/groups", json(body)),

    createComputer: (body: { container: string; name: string; dns_host_name?: string }) =>
      request<DirectoryObject>("/directory/computers", json(body)),

    createOu: (body: { container: string; name: string; description?: string }) =>
      request<DirectoryObject>("/directory/ous", json(body)),

    update: (dn: string, changes: Record<string, string | null>) =>
      request<DirectoryObject>("/directory/object", {
        method: "PATCH",
        body: JSON.stringify({ dn, changes }),
      }),

    move: (dn: string, target_container: string, new_name?: string) =>
      request<DirectoryObject>("/directory/object/move", json({ dn, target_container, new_name })),

    setEnabled: (dn: string, enabled: boolean) =>
      request<DirectoryObject>("/directory/object/enabled", json({ dn, enabled })),

    setPassword: (dn: string, password: string, must_change: boolean) =>
      request<void>("/directory/user/password", json({ dn, password, must_change })),

    editMembers: (dn: string, add: string[], remove: string[]) =>
      request<DirectoryObject>("/directory/group/members", json({ dn, add, remove })),

    remove: (dn: string) =>
      request<void>(`/directory/object${qs({ dn })}`, { method: "DELETE" }),
  },

  policy: {
    list: () => request<{ gpos: Gpo[] }>("/policy/gpos"),

    get: (guid: string) => request<Gpo>(`/policy/gpo${qs({ guid })}`),

    create: (display_name: string, description: string) =>
      request<Gpo>("/policy/gpos", json({ display_name, description })),

    update: (body: Partial<Gpo> & { guid: string }) =>
      request<Gpo>("/policy/gpo", { method: "PATCH", body: JSON.stringify(body) }),

    remove: (guid: string) =>
      request<void>(`/policy/gpo${qs({ guid })}`, { method: "DELETE" }),

    links: (target_dn?: string) => request<{ links: GpoLink[] }>(`/policy/links${qs({ target_dn })}`),

    link: (gpo_guid: string, target_dn: string) =>
      request<{ id: string; link_order: number }>("/policy/links", json({ gpo_guid, target_dn })),

    updateLink: (body: {
      id: string;
      link_order?: number;
      enforced?: boolean;
      enabled?: boolean;
    }) => request<GpoLink>("/policy/link", { method: "PATCH", body: JSON.stringify(body) }),

    unlink: (id: string) => request<void>(`/policy/link${qs({ id })}`, { method: "DELETE" }),

    setInheritance: (ou_dn: string, block_inheritance: boolean) =>
      request<{ block_inheritance: boolean }>(
        "/policy/inheritance",
        json({ ou_dn, block_inheritance }),
      ),

    effective: (dn: string) => request<EffectivePolicy>(`/policy/effective${qs({ dn })}`),

    reports: (computer_dn?: string) =>
      request<{ reports: AgentReport[] }>(`/policy/reports${qs({ computer_dn })}`),
  },

  admx: {
    templates: () => request<{ templates: AdmxTemplate[] }>("/admx/templates"),

    upload: (file_name: string, admxB64: string, admlB64?: string) =>
      request<{ namespace: string; policy_count: number; applicable_count: number }>(
        "/admx/templates",
        json({ file_name, admx: admxB64, adml: admlB64 }),
      ),

    removeTemplate: (id: string) =>
      request<void>(`/admx/template${qs({ id })}`, { method: "DELETE" }),

    categories: () =>
      request<{ categories: { name: string; display_name: string; parent: string | null; policy_count: number }[] }>(
        "/admx/categories",
      ),

    policies: (params: { query?: string; category?: string; applicable_only?: boolean }) =>
      request<{ policies: AdmxPolicy[] }>(
        `/admx/policies${qs({
          query: params.query,
          category: params.category,
          applicable_only: params.applicable_only === false ? "false" : undefined,
        })}`,
      ),
  },

  dns: {
    status: () => request<{ available: boolean; server: string }>("/dns/status"),

    zones: () => request<{ zones: DnsZone[] }>("/dns/zones"),

    zone: (zone: string) =>
      request<{ zone: Record<string, string>; records: DnsRecord[] }>(`/dns/zone${qs({ zone })}`),

    createZone: (zone: string) => request<{ zone: string }>("/dns/zones", json({ zone })),

    deleteZone: (zone: string) => request<void>(`/dns/zone${qs({ zone })}`, { method: "DELETE" }),

    addRecord: (body: { zone: string; name: string; type: string; data: string }) =>
      request<DnsRecord>("/dns/records", json(body)),

    updateRecord: (body: {
      zone: string;
      name: string;
      type: string;
      old_data: string;
      new_data: string;
    }) => request<DnsRecord>("/dns/record", { method: "PATCH", body: JSON.stringify(body) }),

    deleteRecord: (zone: string, name: string, type: string, data: string) =>
      request<void>(`/dns/record${qs({ zone, name, type, data })}`, { method: "DELETE" }),
  },

  dhcp: {
    status: () =>
      request<{
        configured: boolean;
        high_availability?: unknown;
        statistics?: Record<string, number>;
      }>("/dhcp/status"),

    scopes: () => request<{ scopes: DhcpScope[] }>("/dhcp/scopes"),

    createScope: (body: Record<string, unknown>) =>
      request<DhcpScope>("/dhcp/scopes", json(body)),

    updateScope: (body: Record<string, unknown>) =>
      request<DhcpScope>("/dhcp/scope", { method: "PATCH", body: JSON.stringify(body) }),

    deleteScope: (id: number) => request<void>(`/dhcp/scope${qs({ id })}`, { method: "DELETE" }),

    addReservation: (body: {
      subnet_id: number;
      hw_address: string;
      ip_address: string;
      hostname?: string;
    }) => request<unknown>("/dhcp/reservations", json(body)),

    deleteReservation: (subnet_id: number, hw_address: string) =>
      request<void>(`/dhcp/reservation${qs({ subnet_id, hw_address })}`, { method: "DELETE" }),

    leases: () => request<{ leases: DhcpLease[] }>("/dhcp/leases"),
  },

  recyclebin: {
    list: (params: { query?: string; object_type?: string; include_restored?: boolean }) =>
      request<{ items: DeletedObject[]; retention_days: number }>(
        `/recyclebin${qs({
          query: params.query,
          object_type: params.object_type,
          include_restored: params.include_restored ? "true" : undefined,
        })}`,
      ),

    item: (id: string) =>
      request<DeletedObject & { attributes: Record<string, unknown> }>(
        `/recyclebin/item${qs({ id })}`,
      ),

    restore: (id: string) => request<Record<string, unknown>>("/recyclebin/restore", json({ id })),

    purge: (id: string) => request<void>(`/recyclebin/item${qs({ id })}`, { method: "DELETE" }),
  },

  roles: {
    list: () =>
      request<{ available: RoleDescriptor[]; installed: RoleInstance[] }>("/roles"),

    instance: (id: string) => request<RoleInstance>(`/roles/instance${qs({ id })}`),

    install: (role: string, node_fqdn: string, config: Record<string, string>) =>
      request<RoleInstance>("/roles/install", json({ role, node_fqdn, config })),

    remove: (id: string) => request<void>(`/roles/instance${qs({ id })}`, { method: "DELETE" }),
  },

  rbac: {
    permissions: () => request<{ permissions: string[]; wildcard: string }>("/rbac/permissions"),

    roles: () => request<{ roles: RbacRole[] }>("/rbac/roles"),

    saveRole: (name: string, description: string, permissions: string[]) =>
      request<RbacRole>("/rbac/roles", json({ name, description, permissions })),

    deleteRole: (name: string) => request<void>(`/rbac/role${qs({ name })}`, { method: "DELETE" }),

    assignments: () => request<{ assignments: RbacAssignment[] }>("/rbac/assignments"),

    assign: (body: {
      role_name: string;
      principal_dn: string;
      scope_dn: string;
      description?: string;
    }) => request<{ id: string }>("/rbac/assignments", json(body)),

    unassign: (id: string) =>
      request<void>(`/rbac/assignment${qs({ id })}`, { method: "DELETE" }),
  },

  ca: {
    status: () => request<CaStatus>("/ca/status"),

    initialise: (common_name?: string) =>
      request<CaStatus>("/ca/initialise", json({ common_name })),

    certificates: (include_revoked = false) =>
      request<{ certificates: IssuedCertificate[] }>(
        `/ca/certificates${qs({ include_revoked: include_revoked ? "true" : undefined })}`,
      ),

    issue: (body: {
      common_name: string;
      sans: string[];
      profile: string;
      validity_days: number;
    }) => request<IssuedCertificate>("/ca/issue", json(body)),

    revoke: (serial: string, reason: string) =>
      request<void>("/ca/revoke", json({ serial, reason })),

    publish: () => request<{ gpo_guid: string; display_name: string }>("/ca/publish", json({})),

    consoleCertificate: (body: {
      common_name: string;
      sans: string[];
      validity_days: number;
    }) =>
      request<{ serial: string; fingerprint: string; applied: boolean; note: string }>(
        "/ca/console-certificate",
        json(body),
      ),

    rootUrl: "/api/v1/ca/root",
  },

  operations: {
    health: () => request<HealthReport>("/health"),

    replication: () =>
      request<{
        controllers: { name: string; dns_host_name: string; operating_system: string }[];
        server: string;
        healthy: boolean;
        inbound: {
          naming_context: string;
          partner: string;
          last_attempt: string;
          succeeded: boolean | null;
          failures: number;
        }[];
      }>("/replication"),

    replicate: (destination: string, source: string, naming_context: string) =>
      request<{ output: string }>(
        "/replication/replicate",
        json({ destination, source, naming_context }),
      ),

    backups: () =>
      request<{
        configured: boolean;
        directory: string | null;
        interval_hours: number;
        keep: number;
        history: BackupRecord[];
        archives: { path: string; size_bytes: number }[];
      }>("/backups"),

    takeBackup: () => request<{ id: string; state: string }>("/backups", json({})),
  },

  join: {
    tokens: () => request<{ tokens: JoinToken[] }>("/join/tokens"),

    createToken: (body: {
      label: string;
      container_dn: string;
      hostname?: string;
      uses_allowed: number;
      ttl_minutes: number;
    }) =>
      request<{ id: string; token: string; expires_at: string; command: string }>(
        "/join/tokens",
        json(body),
      ),

    revokeToken: (id: string) => request<void>(`/join/token${qs({ id })}`, { method: "DELETE" }),
  },

  audit: {
    list: (params: {
      actor?: string;
      action?: string;
      object_dn?: string;
      outcome?: string;
      limit?: number;
      offset?: number;
    }) => request<{ entries: AuditEntry[] }>(`/audit${qs(params)}`),

    actions: () => request<string[]>("/audit/actions"),
  },
};
