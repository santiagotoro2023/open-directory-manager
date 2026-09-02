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

export interface LoginScreenSettings {
  banner_text: string;
  background_uri: string;
  background_image?: string;
  background_image_name?: string;
  background_fit: string;
  allow_user_background: boolean;
  disable_user_list: boolean;
}

export interface SystemUpdates {
  enabled: boolean;
  security_only: boolean;
  schedule: "daily" | "weekly";
  auto_reboot: boolean;
  reboot_time: string;
  remove_unused: boolean;
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
  packages?: Record<string, unknown>[];
  trusted_certificates?: Record<string, unknown>[];
  remote_desktop_files?: Record<string, unknown>[];
  admx?: AdmxSelection[];
  browser?: { chromium?: Record<string, unknown>; firefox?: Record<string, unknown> };
  wallpaper?: {
    uri?: string;
    image?: string;
    image_name?: string;
    picture_options: string;
    for_principal?: string;
    allow_user_change?: boolean;
  };
  roaming_profile?: { path: string; kind: "directory" | "disk"; disk_gb: number };
  updates?: SystemUpdates;
  login_screen?: LoginScreenSettings;
  certificate_enrolment?: Record<string, unknown>[];
  remote_desktop_session?: {
    allow_clipboard: boolean;
    allow_printers: boolean;
    allow_drives: boolean;
    allow_audio: boolean;
    allow_microphone: boolean;
    max_colour_depth: number;
  };
  local_administrator?: {
    account: string;
    rotate_days: number;
    length: number;
    administrator: boolean;
  };
  password_self_service?: {
    enabled: boolean;
    minimum_length: number;
    require_uppercase?: boolean;
    require_lowercase?: boolean;
    require_digit?: boolean;
    require_symbol?: boolean;
  };
  local_password_policy?: {
    minimum_length: number;
    require_uppercase?: boolean;
    require_lowercase?: boolean;
    require_digit?: boolean;
    require_symbol?: boolean;
    maximum_age_days?: number;
    minimum_age_days?: number;
    warn_days?: number;
    accounts?: string[];
  };
  printers?: Record<string, unknown>[];
  always_on_vpn?: { tunnel: string; block_until_connected: boolean };
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
  /** Set when the report is one person's session rather than the machine. */
  username?: string | null;
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

export interface ManagedServer {
  name: string;
  fqdn: string;
  distinguished_name: string;
  operating_system: string;
  domain_controller: boolean;
  roles: { role: string; state: string }[];
  /** The last contact of any kind: a policy run, an inventory, or collecting
      queued work. Null only for a machine that has never run the agent. */
  last_seen: string | null;
  last_seen_how: string;
  /** The last run that applied policy. Policy already applied is not applied
      again, so this is older than last_seen on a settled machine. */
  last_policy_run: string | null;
  pending_tasks: number;
}

/** One row of a membership table: a directory object, plus how it got there. */
export interface MembershipEntry {
  dn: string;
  name: string;
  objectType: string;
  scope: string;
  description: string;
  objectSid?: string;
  groupKind?: string;
  /** Only on "member of": false for a group reached through another group. */
  direct?: boolean;
}

export interface Membership {
  dn: string;
  name: string;
  object_type: string;
  member_of: MembershipEntry[];
  members: MembershipEntry[];
  members_truncated: boolean;
}

export interface CertificateProfile {
  name: string;
  description: string;
  purposes: string[];
  validity_days: number;
  key_size: number;
  built_in: boolean;
}

export interface TrustAnchor {
  id: string;
  name: string;
  description: string;
  subject: string;
  issuer: string;
  fingerprint: string;
  not_before: string | null;
  not_after: string | null;
  is_ca: boolean;
  added_by: string | null;
  added_at: string;
}

export interface LogGroup {
  unit: string;
  count: number;
  errors: number;
  entries: { priority: number; message: string; occurred_at: string }[];
}

export interface DomainController {
  name: string;
  fqdn: string;
  distinguished_name: string;
  operating_system: string;
  read_only: boolean;
  last_seen: string | null;
  last_seen_how: string;
  last_policy_run: string | null;
}

/** How often every agent asks for policy, and how it hears about a change. */
export interface AgentSchedule {
  poll_minutes: 1 | 5 | 15 | 30;
  push_enabled: boolean;
}

export interface ControllerOverview {
  controllers: DomainController[];
  replication: {
    available?: boolean;
    detail?: string;
    healthy?: boolean;
    inbound?: {
      naming_context: string;
      partner: string;
      last_attempt: string;
      succeeded: boolean | null;
      failures: number;
      /** The controller that reported this row. */
      on?: string;
    }[];
    /** The controllers whose agents collected it. */
    servers?: string[];
    collected_at?: string | null;
    source?: string;
  };
  writable: number;
  read_only: number;
}

export interface Site {
  name: string;
  description: string;
  subnets?: { cidr: string; description: string }[];
  controllers?: { controller_dn: string; hostname: string }[];
  machines?: number;
}

export interface PasswordPolicy {
  id: string;
  name: string;
  description: string;
  precedence: number;
  complexity: boolean;
  min_length: number;
  history: number;
  min_age_days: number;
  max_age_days: number;
  lockout_threshold: number;
  lockout_minutes: number;
  group_dns: string[];
  container_dns: string[];
  applied_to: string[];
  state: string;
  last_error: string | null;
}

export interface NewPasswordPolicy {
  name: string;
  description?: string;
  precedence?: number;
  complexity?: boolean;
  min_length?: number;
  history?: number;
  min_age_days?: number;
  max_age_days?: number;
  lockout_threshold?: number;
  lockout_minutes?: number;
  group_dns?: string[];
  container_dns?: string[];
}

export interface ItemTargeting {
  os?: string[];
  hostname_pattern?: string;
  security_groups?: string[];
  ip_ranges?: string[];
}

export interface RadiusClient {
  id: string;
  node_fqdn: string;
  name: string;
  description: string;
  address: string;
  nas_identifier: string;
  has_secret: boolean;
}

export interface NewRadiusClient {
  node_fqdn: string;
  name: string;
  address: string;
  description?: string;
  nas_identifier?: string;
  secret?: string;
}

export interface RadiusPolicy {
  id: string;
  name: string;
  description: string;
  group_dn: string;
  group_name: string;
  principal_kind: "user" | "computer" | "any";
  nas_identifiers: string[];
  access: "allow" | "deny";
  vlan: number | null;
  ordering: number;
  enabled: boolean;
}

export interface NewRadiusPolicy {
  name: string;
  group_dn: string;
  group_name?: string;
  description?: string;
  principal_kind?: "user" | "computer" | "any";
  nas_identifiers?: string[];
  access?: "allow" | "deny";
  vlan?: number | null;
  ordering?: number;
  enabled?: boolean;
}

export interface Printer {
  id: string;
  node_fqdn: string;
  name: string;
  description: string;
  location: string;
  device_uri: string;
  has_ppd: boolean;
  ppd_name: string;
  duplex: boolean;
  colour: boolean;
  shared: boolean;
  state: string;
  last_error: string | null;
  uri: string;
}

export interface NewPrinter {
  node_fqdn: string;
  name: string;
  device_uri: string;
  description?: string;
  location?: string;
  ppd?: string | null;
  ppd_name?: string;
  duplex?: boolean;
  colour?: boolean;
  shared?: boolean;
}

export interface VpnTunnel {
  id: string;
  node_fqdn: string;
  name: string;
  description: string;
  endpoint: string;
  listen_port: number;
  network: string;
  routes: string[];
  dns_servers: string[];
  search_domain: string;
  public_key: string;
  state: string;
  last_error: string | null;
  peers: number;
}

export interface NewTunnel {
  node_fqdn: string;
  name: string;
  description?: string;
  endpoint: string;
  listen_port?: number;
  network: string;
  routes?: string[];
  dns_servers?: string[];
  search_domain?: string;
}

export interface VpnPeer {
  id: string;
  tunnel_id: string;
  name: string;
  principal_dn: string | null;
  address: string;
  public_key: string;
  always_on: boolean;
  enabled: boolean;
  exportable: boolean;
  created_at: string;
}

export interface ComputerFacts {
  hostname: string;
  operating_system: string;
  kernel: string;
  booted_at: string | null;
  local_users: { name: string; uid: number; shell: string; home: string; groups: string[] }[];
  sessions: { user: string; line: string; source: string; since: string }[];
  pending_updates: number;
  security_updates: number;
  updates: string[];
  updates_checked_at: string | null;
  packages: { name: string; version: string }[];
  package_count: number;
  reported_at: string;
}

export type ComputerAction =
  | "update-check"
  | "update-install"
  | "package-install"
  | "package-remove"
  | "local-user-add"
  | "local-user-remove"
  | "policy-refresh"
  | "restart"
  | "shutdown";

export interface NewLocalUser {
  name: string;
  full_name?: string;
  shell?: string;
  groups?: string[];
  password?: string;
}

export interface ComputerDetail {
  known: boolean;
  facts: ComputerFacts | null;
  events: { kind: string; principal: string; occurred_at: string; detail: string | null }[];
  tasks: {
    id: string;
    kind: string;
    state: string;
    output: string | null;
    created_at: string;
    finished_at: string | null;
  }[];
}

export type ShareAccess = "read" | "change" | "full";

export interface ShareEntry {
  principal: string;
  kind: "user" | "group";
  access: ShareAccess;
  inherit: boolean;
}

export interface RdCollection {
  id: string;
  name: string;
  description: string;
  broker_fqdn: string;
  kind: "desktop" | "remoteapp";
  app_path: string;
  app_name: string;
  profile_share: string;
  profile_gb: number;
  idle_minutes: number;
  disconnected_minutes: number;
  max_sessions_per_host: number;
  balance_method: "leastconn" | "roundrobin" | "first";
  principals: string[];
  hosts: string[];
  state: "pending" | "applying" | "active" | "failed";
  last_error: string | null;
  updated_at: string;
}

export interface RdSession {
  node_fqdn: string;
  username: string;
  display: string;
  state: string;
  reported_at: string;
}

export interface FileShare {
  id: string;
  node_fqdn: string;
  name: string;
  path: string;
  comment: string;
  owner: string;
  owner_group: string;
  entries: ShareEntry[];
  browseable: boolean;
  read_only: boolean;
  state: "pending" | "applying" | "active" | "failed";
  last_error: string | null;
  unc: string;
  updated_at: string;
}

export interface NewShare {
  node_fqdn: string;
  name: string;
  path: string;
  comment?: string;
  owner?: string;
  owner_group?: string;
  entries?: ShareEntry[];
  browseable?: boolean;
  read_only?: boolean;
}

export interface RoleArgument {
  name: string;
  label: string;
  help: string;
  kind: "text" | "choice" | "url" | "host" | "path" | "dn" | "hash" | "networks";
  choices: string[];
  placeholder: string;
  default: string;
  optional: boolean;
  configuration: boolean;
}

export interface RoleDescriptor {
  name: string;
  title: string;
  summary: string;
  core: boolean;
  arguments: RoleArgument[];
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
  /** State of the queued work, so "installing" can say whether the machine
      has actually picked it up. */
  task_state?: "pending" | "claimed" | "done" | "failed" | null;
  task_started_at?: string | null;
  /** What the installer has printed so far, while it is still running. */
  task_output?: string | null;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: {
    name: string;
    path: string;
    directory?: boolean;
    size?: number;
    modified?: string;
  }[];
  truncated: boolean;
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
    failing?: { hostname: string; setting: string; reason: string }[];
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
    throw new ApiError(response.status, describeError(body, response.statusText));
  }
  return body as T;
}

interface ValidationDetail {
  loc?: (string | number)[];
  msg?: string;
}

/**
 * What went wrong, as a sentence.
 *
 * A rejected value comes back from the API as a list of objects naming the
 * field and what was wrong with it. Handing that list to a string is how a
 * dialog came to say "[object Object],[object Object]" instead of naming the
 * field it was unhappy about.
 */
function describeError(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => describeValidation(entry as ValidationDetail))
      .filter(Boolean);
    if (messages.length > 0) return messages.join(". ");
  }
  return fallback;
}

export function describeValidation(entry: ValidationDetail): string {
  const message = (entry.msg ?? "").replace(/^Value error, /, "");
  // ["body", "entries", 0, "principal"]: the field is the last name in it,
  // and the number, where there is one, says which entry.
  const names = (entry.loc ?? []).filter(
    (part) => typeof part === "string" && part !== "body" && part !== "query",
  ) as string[];
  const field = names[names.length - 1];
  const index = (entry.loc ?? []).find((part) => typeof part === "number");
  if (!field) return message;
  const where = index === undefined ? "" : ` (entry ${(index as number) + 1})`;
  return `${fieldLabel(field)}${where}: ${message || "is not valid"}`;
}

function fieldLabel(field: string): string {
  const spelled = FIELD_LABELS[field] ?? field.replace(/_/g, " ");
  return spelled.charAt(0).toUpperCase() + spelled.slice(1);
}

// Where the API's field name is not what the console calls the field.
const FIELD_LABELS: Record<string, string> = {
  node_fqdn: "server",
  owner_group: "owning group",
  unc: "share",
  sam_account_name: "logon name",
  hw_address: "hardware address",
  ip_address: "IP address",
  subnet_id: "scope",
  for_principal: "for user or group",
  mount_point: "mount point",
};

function remember(session: SessionInfo): SessionInfo {
  csrfToken = session.csrf_token;
  return session;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // false is a value, not an absence: a flag has to be sendable as off.
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
  login: (username: string, password: string, code?: string) =>
    request<SessionInfo>("/auth/login", json({ username, password, code })).then(remember),

  session: () => request<SessionInfo>("/auth/session").then(remember),

  logout: async () => {
    await request<void>("/auth/logout", { method: "POST" });
    csrfToken = "";
  },

  directory: {
    tree: () =>
      request<{
        base_dn: string;
        domain: string;
        netbios_name: string;
        nodes: DirectoryObject[];
      }>("/directory/tree"),

    list: (params: {
      container?: string;
      object_type?: ObjectType;
      query?: string;
      scope?: "level" | "subtree";
      limit?: number;
    }) =>
      request<{ objects: DirectoryObject[]; truncated: boolean }>(
        `/directory/objects${qs(params)}`,
      ),

    get: (dn: string) => request<DirectoryObject>(`/directory/object${qs({ dn })}`),

    /** Both directions: what this object belongs to, and what belongs to it. */
    membership: (dn: string) => request<Membership>(`/directory/membership${qs({ dn })}`),

    createUser: (body: NewUser) => request<DirectoryObject>("/directory/users", json(body)),

    bulkUsers: (users: NewUser[]) =>
      request<{
        created: number;
        results: { sam_account_name: string; created: boolean; error?: string }[];
      }>("/directory/users/bulk", json({ users })),

    createGroup: (body: {
      container: string;
      name: string;
      kind: "user" | "computer";
      scope: string;
      description?: string;
    }) => request<DirectoryObject>("/directory/groups", json(body)),

    setGroupKind: (dn: string, kind: "user" | "computer") =>
      request<DirectoryObject>("/directory/group/kind", json({ dn, kind })),

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

    setPhoto: (dn: string, photo: string) =>
      request<void>("/directory/user/photo", json({ dn, photo })),

    editMembers: (dn: string, add: string[], remove: string[]) =>
      request<DirectoryObject>("/directory/group/members", json({ dn, add, remove })),

    remove: (dn: string) => request<void>(`/directory/object${qs({ dn })}`, { method: "DELETE" }),
  },

  policy: {
    list: () => request<{ gpos: Gpo[] }>("/policy/gpos"),

    get: (guid: string) => request<Gpo>(`/policy/gpo${qs({ guid })}`),

    // Portable JSON: reviewable, diffable in a repository, and movable
    // between a lab domain and a real one.
    export: (guid?: string) =>
      request<{ format: number; exported_at: string; objects: unknown[] }>(
        `/policy/gpo/export${guid ? qs({ guid }) : ""}`,
      ),

    import: (body: {
      format: number;
      objects: unknown[];
      on_conflict: "skip" | "replace" | "rename";
      restore_links: boolean;
    }) =>
      request<{
        created: string[];
        replaced: string[];
        skipped: { name: string; reason: string }[];
        links_restored: number;
        links_skipped: string[];
      }>("/policy/gpos/import", json(body)),

    create: (display_name: string, description: string) =>
      request<Gpo>("/policy/gpos", json({ display_name, description })),

    update: (body: Partial<Gpo> & { guid: string }) =>
      request<Gpo>("/policy/gpo", { method: "PATCH", body: JSON.stringify(body) }),

    remove: (guid: string) => request<void>(`/policy/gpo${qs({ guid })}`, { method: "DELETE" }),

    links: (target_dn?: string) =>
      request<{ links: GpoLink[] }>(`/policy/links${qs({ target_dn })}`),

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

    /** What one person's sessions reported, one per machine they signed in to.
        Their drive maps and connection files are applied at sign-in, so this
        is where a drive that did not mount says why. */
    sessionReports: (username: string) =>
      request<{ reports: AgentReport[] }>(`/policy/reports${qs({ username })}`),
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
      request<{
        categories: {
          name: string;
          display_name: string;
          parent: string | null;
          policy_count: number;
        }[];
      }>("/admx/categories"),

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

    createReverseZone: (network: string) =>
      request<{ zone: string; network: string }>("/dns/zones/reverse", json({ network })),

    createZone: (zone: string) => request<{ zone: string }>("/dns/zones", json({ zone })),

    deleteZone: (zone: string) => request<void>(`/dns/zone${qs({ zone })}`, { method: "DELETE" }),

    addRecord: (body: {
      zone: string;
      name: string;
      type: string;
      data: string;
      create_pointer?: boolean;
    }) => request<DnsRecord & { pointer: string | null }>("/dns/records", json(body)),

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

    /** What a new scope should hand out: the domain, and the DCs serving it. */
    defaults: () =>
      request<{ domain_name: string; dns_servers: string[] }>("/dhcp/defaults"),

    createScope: (body: Record<string, unknown>) => request<DhcpScope>("/dhcp/scopes", json(body)),

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

    restore: (id: string, container?: string) =>
      request<Record<string, unknown>>("/recyclebin/restore", json({ id, container })),

    purge: (id: string) => request<void>(`/recyclebin/item${qs({ id })}`, { method: "DELETE" }),
  },

  roles: {
    list: () =>
      request<{ available: RoleDescriptor[]; installed: RoleInstance[]; nodes: string[] }>(
        "/roles",
      ),

    instance: (id: string) => request<RoleInstance>(`/roles/instance${qs({ id })}`),

    install: (role: string, node_fqdn: string, config: Record<string, string>) =>
      request<RoleInstance>("/roles/install", json({ role, node_fqdn, config })),

    remove: (id: string) => request<void>(`/roles/instance${qs({ id })}`, { method: "DELETE" }),
  },

  controllers: {
    list: () => request<ControllerOverview>("/controllers"),

    joinCommand: (hostname: string, read_only: boolean, site: string) =>
      request<{ role: string; steps: string[]; notes: string[] }>(
        `/controllers/join-command${qs({ hostname, read_only, site })}`,
      ),

    replication: (server?: string) =>
      request<{ server: string; inbound: unknown[]; healthy: boolean }>(
        `/controllers/replication${qs({ server })}`,
      ),

    agents: () => request<AgentSchedule>("/controllers/agents"),

    setAgents: (body: AgentSchedule) =>
      request<AgentSchedule>("/controllers/agents", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
  },

  radius: {
    overview: () => request<{ clients: RadiusClient[]; policies: RadiusPolicy[] }>("/radius"),

    preview: () => request<{ policies: string }>("/radius/preview"),

    addClient: (body: NewRadiusClient) =>
      request<RadiusClient & { secret: string }>("/radius/clients", json(body)),

    removeClient: (id: string) =>
      request<void>(`/radius/clients${qs({ id })}`, { method: "DELETE" }),

    addPolicy: (body: NewRadiusPolicy) => request<RadiusPolicy>("/radius/policies", json(body)),

    removePolicy: (id: string) =>
      request<void>(`/radius/policies${qs({ id })}`, { method: "DELETE" }),
  },

  auth2fa: {
    state: () =>
      request<{ enrolled: boolean; pending: boolean; recovery_codes_left: number }>(
        "/auth/second-factor",
      ),

    begin: () =>
      request<{ secret: string; uri: string; digits: number; period: number }>(
        "/auth/second-factor",
        json({}),
      ),

    confirm: (code: string) =>
      request<{ recovery_codes: string[] }>("/auth/second-factor/confirm", json({ code })),

    remove: (code: string) =>
      request<void>("/auth/second-factor", { method: "DELETE", body: JSON.stringify({ code }) }),
  },

  sites: {
    list: () => request<{ sites: Site[]; unplaced: number }>("/controllers/sites"),

    create: (name: string, description: string) =>
      request<Site>("/controllers/sites", json({ name, description })),

    remove: (name: string) =>
      request<void>(`/controllers/sites${qs({ name })}`, { method: "DELETE" }),

    addSubnet: (cidr: string, site_name: string, description: string) =>
      request<{ cidr: string; site: string; overlaps: string[] }>(
        "/controllers/sites/subnets",
        json({ cidr, site_name, description }),
      ),

    removeSubnet: (cidr: string) =>
      request<void>(`/controllers/sites/subnets${qs({ cidr })}`, { method: "DELETE" }),

    assign: (controller_dn: string, site_name: string, hostname: string) =>
      request<{ controller_dn: string; site: string }>(
        "/controllers/sites/controllers",
        json({ controller_dn, site_name, hostname }),
      ),
  },

  password: {
    policy: () => request<{ policy: Record<string, string> }>("/password/policy"),

    updatePolicy: (body: Record<string, string | number>) =>
      request<{ policy: Record<string, string> }>("/password/policy", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),

    selfService: () =>
      request<{ enabled: boolean; minimum_length?: number; detail?: string }>(
        "/password/self-service",
      ),

    change: (current_password: string, new_password: string) =>
      request<void>("/password/change", json({ current_password, new_password })),

    policies: () => request<{ policies: PasswordPolicy[] }>("/password/policies"),

    createPolicy: (body: NewPasswordPolicy) =>
      request<PasswordPolicy>("/password/policies", json(body)),

    syncPolicies: () => request<{ synced: unknown[] }>("/password/policies/sync", json({})),

    removePolicy: (id: string) =>
      request<void>(`/password/policies${qs({ id })}`, { method: "DELETE" }),
  },

  rd: {
    list: () => request<{ collections: RdCollection[]; unassigned_hosts: string[] }>("/rd"),

    sessions: () => request<{ sessions: RdSession[] }>("/rd/sessions"),

    create: (body: Partial<RdCollection>) => request<RdCollection>("/rd", json(body)),

    update: (body: { id: string } & Partial<RdCollection>) =>
      request<RdCollection>("/rd", { method: "PATCH", body: JSON.stringify(body) }),

    remove: (id: string) => request<void>(`/rd${qs({ id })}`, { method: "DELETE" }),

    addHost: (collection_id: string, node_fqdn: string) =>
      request<RdCollection>("/rd/hosts", json({ collection_id, node_fqdn })),

    removeHost: (collection_id: string, node_fqdn: string) =>
      request<void>(`/rd/hosts${qs({ collection_id, node_fqdn })}`, { method: "DELETE" }),

    // A file the browser downloads rather than JSON the console renders.
    connectionUrl: (id: string, username: string) => `/api/v1/rd/rdp${qs({ id, username })}`,
  },

  printers: {
    /** Ask the server to sweep the network now, rather than using what it
        last reported at check-in. */
    discover: (node: string) =>
      request<{ devices: { uri: string; description: string }[] }>(
        `/printers/discover${qs({ node })}`,
      ),

    devices: (node_fqdn: string) =>
      request<{ devices: { uri: string; description: string }[] }>(
        `/printers/devices${qs({ node_fqdn })}`,
      ),

    list: () => request<{ printers: Printer[] }>("/printers"),

    create: (body: NewPrinter) => request<Printer>("/printers", json(body)),

    update: (body: { id: string } & Partial<NewPrinter>) =>
      request<Printer>("/printers", { method: "PATCH", body: JSON.stringify(body) }),

    remove: (id: string) => request<void>(`/printers${qs({ id })}`, { method: "DELETE" }),

    /** Put CUPS's own test page on the queue, from the print server. */
    test: (id: string) =>
      request<{ task_id: string; node_fqdn: string; name: string }>(
        `/printers/test${qs({ id })}`,
        { method: "POST" },
      ),

    testResult: (task_id: string) =>
      request<{ state: string; output: string; created_at: string; finished_at: string | null }>(
        `/printers/test${qs({ task_id })}`,
      ),
  },

  vpn: {
    list: () => request<{ tunnels: VpnTunnel[] }>("/vpn"),

    create: (body: NewTunnel) => request<VpnTunnel>("/vpn", json(body)),

    update: (body: { id: string } & Partial<NewTunnel>) =>
      request<VpnTunnel>("/vpn", { method: "PATCH", body: JSON.stringify(body) }),

    remove: (id: string) => request<void>(`/vpn${qs({ id })}`, { method: "DELETE" }),

    peers: (tunnel_id: string) => request<{ peers: VpnPeer[] }>(`/vpn/peers${qs({ tunnel_id })}`),

    addPeer: (body: {
      tunnel_id: string;
      name: string;
      principal_dn?: string;
      always_on?: boolean;
    }) => request<VpnPeer>("/vpn/peers", json(body)),

    removePeer: (id: string) => request<void>(`/vpn/peers${qs({ id })}`, { method: "DELETE" }),

    // A download rather than a fetch: the file is what a client is handed.
    configurationUrl: (id: string) => `/api/v1/vpn/peers/configuration${qs({ id })}`,
  },

  servers: {
    list: () => request<{ servers: ManagedServer[] }>("/servers"),

    computer: (dn: string) => request<ComputerDetail>(`/servers/computer${qs({ dn })}`),

    // Read on demand rather than with the rest of the machine: every read is
    // audited, so fetching it to render a page nobody asked it of would fill
    // the log with reads that never happened.
    localAdministrator: (dn: string) =>
      request<{
        configured: boolean;
        account?: string;
        password?: string;
        rotated_at?: string;
        expires_at?: string;
      }>(`/servers/computer/localadmin${qs({ dn })}`),

    logs: (dn: string, hours: number) =>
      request<{ hours: number; total: number; groups: LogGroup[] }>(
        `/servers/computer/logs${qs({ dn, hours })}`,
      ),

    bulkAction: (dns: string[], action: ComputerAction, pkg?: string) =>
      request<{
        queued: { dn: string; node: string; task: string }[];
        skipped: { dn: string; reason: string }[];
      }>("/servers/computers/action", json({ dns, action, package: pkg })),

    /** List the folders under a path on one machine. The agent answers in
        about a second, so this is a dialog rather than a queued job. */
    browse: (node: string, path: string, make = false, files = false) =>
      request<DirectoryListing>(
        `/servers/computer/browse${qs({
          node,
          path,
          make: make ? "true" : undefined,
          files: files ? "true" : undefined,
        })}`,
      ),

    action: (dn: string, action: ComputerAction, pkg?: string, localUser?: NewLocalUser) =>
      request<{ task: string; node: string }>(
        "/servers/computer/action",
        json({ dn, action, package: pkg, local_user: localUser }),
      ),
  },

  shares: {
    list: () => request<{ shares: FileShare[]; access_levels: Record<string, string> }>("/shares"),

    create: (body: NewShare) => request<FileShare>("/shares", json(body)),

    update: (body: { id: string } & Partial<NewShare>) =>
      request<FileShare>("/shares", { method: "PATCH", body: JSON.stringify(body) }),

    /** Stop sharing. contents deletes the directory on the server as well. */
    remove: (id: string, contents = false) =>
      request<void>(`/shares${qs({ id, contents: contents ? "true" : undefined })}`, {
        method: "DELETE",
      }),
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

    unassign: (id: string) => request<void>(`/rbac/assignment${qs({ id })}`, { method: "DELETE" }),
  },

  ca: {
    status: () => request<CaStatus>("/ca/status"),

    initialise: (common_name?: string, publish_root = true) =>
      request<CaStatus>("/ca/initialise", json({ common_name, publish_root })),

    profiles: () =>
      request<{ purposes: string[]; profiles: CertificateProfile[] }>("/ca/profiles"),

    saveProfile: (body: Omit<CertificateProfile, "built_in">) =>
      request<CertificateProfile>("/ca/profiles", json(body)),

    deleteProfile: (name: string) =>
      request<void>(`/ca/profiles${qs({ name })}`, { method: "DELETE" }),

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

    publish: () =>
      request<{ gpo_guid: string; display_name: string; published: string[] }>(
        "/ca/publish",
        json({}),
      ),

    trusted: () => request<{ trusted: TrustAnchor[] }>("/ca/trusted"),

    trust: (body: { name: string; description: string; certificate_pem: string }) =>
      request<TrustAnchor>("/ca/trusted", json(body)),

    untrust: (id: string) => request<void>(`/ca/trusted${qs({ id })}`, { method: "DELETE" }),

    consoleCertificate: (body: { common_name: string; sans: string[]; validity_days: number }) =>
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
