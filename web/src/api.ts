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
