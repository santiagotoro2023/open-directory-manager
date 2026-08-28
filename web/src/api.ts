export interface SessionInfo {
  principal: string;
  display_name: string;
  distinguished_name: string;
  csrf_token: string;
  expires_at: string;
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

export const api = {
  login: (username: string, password: string) =>
    request<SessionInfo>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }).then(remember),

  session: () => request<SessionInfo>("/auth/session").then(remember),

  logout: async () => {
    await request<void>("/auth/logout", { method: "POST" });
    csrfToken = "";
  },
};
