export interface SessionInfo {
  principal: string;
  display_name: string;
  distinguished_name: string;
  csrf_token: string;
  expires_at: string;
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
  logon_rights?: Record<string, unknown>[];
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
