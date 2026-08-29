import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AdmxSelection, PolicySettings } from "../api";
import { AdmxEditor } from "./AdmxEditor";
import { PickerField, type PickerKind, type PickerValue } from "./Picker";
import { Split } from "./Split";

type FieldKind = "text" | "number" | "textarea" | "select" | "checkbox";

interface FieldSpec {
  key: string;
  label: string;
  kind?: FieldKind;
  options?: string[];
  placeholder?: string;
  width?: string;
  // A value the directory already knows is chosen, not typed.
  picker?: PickerKind;
  pickerValue?: PickerValue;
  pickerMultiple?: boolean;
}

type Half = "Computer" | "User";

interface CategorySpec {
  key: keyof PolicySettings;
  title: string;
  // Which half of the policy the setting is enforced in, as the Group Policy
  // Management Editor splits them.
  half: Half;
  note?: string;
  fields: FieldSpec[];
  blank: Record<string, unknown>;
}

// One declarative spec per policy category; the editor below renders all of
// them the same way. Field names match the API's typed schema exactly, so a
// rejected value comes back with a message pointing at the right field.
export const CATEGORIES: CategorySpec[] = [
  {
    key: "files",
    title: "File deployment",
    half: "Computer",
    fields: [
      { key: "path", label: "Path", placeholder: "/etc/motd" },
      { key: "content", label: "Content", kind: "textarea" },
      { key: "mode", label: "Mode", width: "90px" },
      { key: "owner", label: "Owner", width: "150px", picker: "user" },
      { key: "group", label: "Group", width: "150px", picker: "group" },
    ],
    blank: { path: "", content: "", mode: "0644", owner: "root", group: "root" },
  },
  {
    key: "scripts",
    title: "Scripts",
    half: "Computer",
    fields: [
      {
        key: "trigger",
        label: "Trigger",
        kind: "select",
        options: ["startup", "shutdown", "logon", "logoff"],
        width: "130px",
      },
      { key: "name", label: "Name", width: "160px" },
      { key: "interpreter", label: "Interpreter", width: "140px" },
      { key: "content", label: "Script", kind: "textarea" },
    ],
    blank: { trigger: "startup", name: "", interpreter: "/bin/sh", content: "" },
  },
  {
    key: "systemd_units",
    title: "systemd units",
    half: "Computer",
    fields: [
      { key: "unit", label: "Unit", placeholder: "telnet.socket" },
      {
        key: "state",
        label: "State",
        kind: "select",
        options: ["enabled", "disabled", "masked", "started", "stopped"],
        width: "140px",
      },
    ],
    blank: { unit: "", state: "enabled" },
  },
  {
    key: "cron",
    title: "Scheduled tasks",
    half: "Computer",
    fields: [
      { key: "name", label: "Name", width: "160px" },
      { key: "schedule", label: "Schedule", placeholder: "0 3 * * 0", width: "150px" },
      { key: "command", label: "Command" },
      { key: "user", label: "Run as", width: "150px", picker: "user" },
    ],
    blank: { name: "", schedule: "0 3 * * 0", command: "", user: "root" },
  },
  {
    key: "drive_maps",
    title: "Drive maps",
    half: "User",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      { key: "unc", label: "Share", placeholder: "//fs01/shared" },
      { key: "mount_point", label: "Mount point", placeholder: "/mnt/shared" },
      {
        key: "for_principal",
        label: "For user or group",
        placeholder: "%Engineers",
        picker: "principal",
        pickerValue: "principal",
      },
      { key: "options", label: "Options" },
    ],
    blank: { name: "", unc: "", mount_point: "", for_principal: "", options: "" },
  },
  {
    key: "sudo_rules",
    title: "Sudo rules",
    note: "Users and commands are comma separated.",
    half: "Computer",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      {
        key: "users",
        label: "Users and groups",
        placeholder: "%Helpdesk",
        picker: "principal",
        pickerValue: "principal",
        pickerMultiple: true,
      },
      { key: "commands", label: "Commands", placeholder: "/usr/bin/systemctl" },
      { key: "run_as", label: "Run as", width: "140px", picker: "user" },
      { key: "nopasswd", label: "NOPASSWD", kind: "checkbox", width: "110px" },
    ],
    blank: { name: "", users: [], commands: [], run_as: "ALL", nopasswd: false },
  },
  {
    key: "hbac_rules",
    title: "HBAC rules",
    note: "Who may open a session on a machine, and how.",
    half: "Computer",
    fields: [
      {
        key: "principal",
        label: "User or group",
        placeholder: "%Engineers",
        picker: "principal",
        pickerValue: "principal",
      },
      {
        key: "service",
        label: "Service",
        kind: "select",
        options: ["all", "local", "ssh", "rdp"],
        width: "120px",
      },
      {
        key: "access",
        label: "Access",
        kind: "select",
        options: ["allow", "deny"],
        width: "110px",
      },
    ],
    blank: { principal: "", service: "all", access: "allow" },
  },
  {
    key: "packages",
    title: "Software deployment",
    half: "Computer",
    note: "Packages the machine should have, keep current, or not have.",
    fields: [
      { key: "name", label: "Package", placeholder: "cifs-utils" },
      {
        key: "state",
        label: "State",
        kind: "select",
        options: ["present", "latest", "absent"],
        width: "130px",
      },
    ],
    blank: { name: "", state: "present" },
  },
  {
    key: "certificate_enrolment",
    title: "Certificates",
    half: "Computer",
    note: "Certificates the machine gets by itself, and renews before they expire.",
    fields: [
      {
        key: "profile",
        label: "Kind",
        kind: "select",
        options: ["server", "client"],
        width: "130px",
      },
      { key: "path", label: "Written to", placeholder: "/etc/ssl/odm" },
      { key: "validity_days", label: "Valid for (days)", kind: "number", width: "150px" },
      { key: "renew_before_days", label: "Renew with (days) left", kind: "number", width: "180px" },
    ],
    blank: { profile: "server", path: "/etc/ssl/odm", validity_days: 365, renew_before_days: 30 },
  },
  {
    key: "printers",
    title: "Printers",
    half: "User",
    note: "Printers the person signing in should have. They come from a print server.",
    fields: [
      { key: "name", label: "Printer", width: "180px" },
      { key: "server", label: "Print server", picker: "computer", pickerValue: "host" },
      {
        key: "for_principal",
        label: "For user or group",
        placeholder: "%Finance",
        picker: "principal",
        pickerValue: "principal",
      },
      { key: "default", label: "Default", kind: "checkbox", width: "90px" },
    ],
    blank: { name: "", server: "", for_principal: "", default: false },
  },
  {
    key: "firewall",
    title: "Firewall rules",
    half: "Computer",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      { key: "action", label: "Action", kind: "select", options: ["allow", "deny"], width: "110px" },
      { key: "direction", label: "Direction", kind: "select", options: ["in", "out"], width: "110px" },
      {
        key: "protocol",
        label: "Protocol",
        kind: "select",
        options: ["tcp", "udp", "icmp", "any"],
        width: "110px",
      },
      { key: "port", label: "Port", kind: "number", width: "100px" },
      { key: "source", label: "Source", placeholder: "10.0.0.0/8" },
    ],
    blank: { name: "", action: "allow", direction: "in", protocol: "tcp", port: null, source: "any" },
  },
];

// Fields the API models as a list but an operator types as a line.
const LIST_FIELDS = new Set(["users", "commands"]);

function toInput(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function fromInput(field: FieldSpec, raw: string): unknown {
  if (LIST_FIELDS.has(field.key)) {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (field.kind === "number") return raw === "" ? null : Number(raw);
  return raw;
}

// Categories with no repeating rows; each renders its own editor.
const SPECIAL = [
  { key: "updates", title: "System updates", half: "Computer" as Half },
  { key: "login_screen", title: "Login screen", half: "Computer" as Half },
  { key: "always_on_vpn", title: "Always-on VPN", half: "Computer" as Half },
  { key: "password_self_service", title: "Self-service password", half: "User" as Half },
  { key: "wallpaper", title: "Desktop background", half: "User" as Half },
  { key: "browser", title: "Browser policy", half: "Computer" as Half },
  { key: "admx", title: "Administrative templates", half: "Computer" as Half },
] as const;

type Selected = string;

function countOf(settings: PolicySettings, key: string): number {
  if (key === "updates") return settings.updates ? 1 : 0;
  if (key === "login_screen") return settings.login_screen ? 1 : 0;
  if (key === "always_on_vpn") return settings.always_on_vpn ? 1 : 0;
  if (key === "password_self_service") return settings.password_self_service ? 1 : 0;
  if (key === "wallpaper") return settings.wallpaper?.uri ? 1 : 0;
  if (key === "browser") {
    const browser = settings.browser;
    if (!browser) return 0;
    return (
      Object.keys(browser.chromium ?? {}).length + Object.keys(browser.firefox ?? {}).length
    );
  }
  const value = settings[key as keyof PolicySettings];
  return Array.isArray(value) ? value.length : 0;
}

export function SettingsEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const [selected, setSelected] = useState<Selected>(String(CATEGORIES[0].key));

  const entries = [
    ...CATEGORIES.map((category) => ({
      key: String(category.key),
      title: category.title,
      half: category.half,
    })),
    ...SPECIAL.map((special) => ({
      key: special.key,
      title: special.title,
      half: special.half,
    })),
  ];

  const tree = (
    <ul className="category-list">
      {(["Computer", "User"] as Half[]).map((half) => (
        <li key={half}>
          <p className="category-group">{half}</p>
          <ul>
            {entries
              .filter((entry) => entry.half === half)
              .map((entry) => {
                const count = countOf(settings, entry.key);
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className={selected === entry.key ? "active" : ""}
                      aria-current={selected === entry.key ? "true" : undefined}
                      onClick={() => setSelected(entry.key)}
                    >
                      <span className="truncate">{entry.title}</span>
                      {count > 0 && (
                        <span className="count" aria-label={`${count} configured`}>
                          {count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
          </ul>
        </li>
      ))}
    </ul>
  );

  const category = CATEGORIES.find((entry) => String(entry.key) === selected);

  return (
    <div className="settings-editor">
      <Split id="policy-categories" label="Resize the category list" initial={230} side={tree}>
        <div className="category-editor">
          {category && (
            <RowsEditor category={category} settings={settings} onChange={onChange} />
          )}
          {selected === "updates" && <UpdatesEditor settings={settings} onChange={onChange} />}
          {selected === "login_screen" && (
            <LoginScreenEditor settings={settings} onChange={onChange} />
          )}
          {selected === "always_on_vpn" && (
            <AlwaysOnVpnEditor settings={settings} onChange={onChange} />
          )}
          {selected === "password_self_service" && (
            <SelfServiceEditor settings={settings} onChange={onChange} />
          )}
          {selected === "wallpaper" && (
            <WallpaperEditor settings={settings} onChange={onChange} />
          )}
          {selected === "browser" && <BrowserEditor settings={settings} onChange={onChange} />}
          {selected === "admx" && (
            <>
              <header>
                <h3>Administrative templates</h3>
              </header>
              <AdmxEditor
                selections={settings.admx ?? []}
                onChange={(admx: AdmxSelection[]) => onChange({ ...settings, admx })}
              />
            </>
          )}
        </div>
      </Split>
    </div>
  );
}

function RowsEditor({
  category,
  settings,
  onChange,
}: {
  category: CategorySpec;
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = (settings[category.key] as Record<string, unknown>[] | undefined) ?? [];

  function update(next: Record<string, unknown>[]) {
    onChange({ ...settings, [category.key]: next });
  }

  return (
    <>
      <header>
        <h3>{category.title}</h3>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          onClick={() => update([...current, { ...category.blank }])}
        >
          <Plus size={15} aria-hidden="true" />
          Add
        </button>
      </header>
      {category.note && <p className="muted">{category.note}</p>}

      {current.length === 0 ? (
        <p className="empty">Not configured.</p>
      ) : (
        <table className="data compact">
          <thead>
            <tr>
              {category.fields.map((field) => (
                <th key={field.key} style={field.width ? { width: field.width } : undefined}>
                  {field.label}
                </th>
              ))}
              <th style={{ width: "44px" }}>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {current.map((row, index) => (
              <tr key={index}>
                {category.fields.map((field) => (
                  <td key={field.key}>
                    <Cell
                      field={field}
                      value={row[field.key]}
                      onChange={(value) => {
                        const next = [...current];
                        next[index] = { ...row, [field.key]: value };
                        update(next);
                      }}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Remove ${category.title} entry ${index + 1}`}
                    onClick={() => update(current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function UpdatesEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.updates;

  function set(changes: Partial<NonNullable<PolicySettings["updates"]>>) {
    onChange({
      ...settings,
      updates: {
        enabled: true,
        security_only: true,
        schedule: "daily",
        auto_reboot: false,
        reboot_time: "03:00",
        remove_unused: true,
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <header>
        <h3>System updates</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, updates: undefined })}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove
          </button>
        )}
      </header>

      {!current ? (
        <>
          <p className="empty">Not configured.</p>
          <div className="actions-row">
            <button type="button" className="primary" onClick={() => set({})}>
              <Plus size={15} aria-hidden="true" />
              Add
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Install updates without being asked
          </label>

          <div className="inline-fields">
            <label className="field">
              <span>What to install</span>
              <select
                value={current.security_only ? "security" : "all"}
                onChange={(e) => set({ security_only: e.target.value === "security" })}
              >
                <option value="security">Security updates only</option>
                <option value="all">Every available update</option>
              </select>
            </label>
            <label className="field">
              <span>How often</span>
              <select
                value={current.schedule}
                onChange={(e) => set({ schedule: e.target.value as "daily" | "weekly" })}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.remove_unused}
              onChange={(e) => set({ remove_unused: e.target.checked })}
            />
            Remove packages nothing needs any more
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.auto_reboot}
              onChange={(e) => set({ auto_reboot: e.target.checked })}
            />
            Restart the machine when an update needs it
          </label>
          {current.auto_reboot && (
            <label className="field">
              <span>Restart at</span>
              <input
                type="time"
                value={current.reboot_time}
                onChange={(e) => set({ reboot_time: e.target.value })}
              />
            </label>
          )}
        </>
      )}
    </>
  );
}

function LoginScreenEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.login_screen;

  function set(changes: Partial<NonNullable<PolicySettings["login_screen"]>>) {
    onChange({
      ...settings,
      login_screen: {
        banner_text: "",
        background_uri: "",
        background_fit: "zoom",
        allow_user_background: true,
        disable_user_list: false,
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <header>
        <h3>Login screen</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, login_screen: undefined })}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove
          </button>
        )}
      </header>
      <p className="muted">
        What a machine shows before anyone signs in. Separate from the desktop background, which
        belongs to whoever is signed in.
      </p>

      {!current ? (
        <>
          <p className="empty">Not configured.</p>
          <div className="actions-row">
            <button type="button" className="primary" onClick={() => set({})}>
              <Plus size={15} aria-hidden="true" />
              Add
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span>Message</span>
            <input
              value={current.banner_text}
              placeholder="Welcome to Example Corp"
              onChange={(e) => set({ banner_text: e.target.value })}
            />
            <small>Shown above the sign-in box. Empty means no message.</small>
          </label>

          <div className="inline-fields">
            <label className="field">
              <span>Background image</span>
              <input
                value={current.background_uri}
                placeholder="file:///usr/share/backgrounds/login.png"
                onChange={(e) => set({ background_uri: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Fit</span>
              <select
                value={current.background_fit}
                onChange={(e) => set({ background_fit: e.target.value })}
              >
                {["zoom", "scaled", "stretched", "centered", "none"].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.allow_user_background}
              onChange={(e) => set({ allow_user_background: e.target.checked })}
            />
            Let people change their own desktop background
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.disable_user_list}
              onChange={(e) => set({ disable_user_list: e.target.checked })}
            />
            Hide the list of accounts; make people type their name
          </label>
        </>
      )}
    </>
  );
}

function AlwaysOnVpnEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.always_on_vpn;

  return (
    <>
      <header>
        <h3>Always-on VPN</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, always_on_vpn: undefined })}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove
          </button>
        )}
      </header>
      <p className="muted">
        The machine holds this tunnel up from boot, before anyone signs in, and the person using
        it cannot turn it off. Each machine needs a peer on the tunnel under Remote Access; the
        key is delivered to that machine alone.
      </p>

      {!current ? (
        <>
          <p className="empty">Not configured.</p>
          <div className="actions-row">
            <button
              type="button"
              className="primary"
              onClick={() =>
                onChange({
                  ...settings,
                  always_on_vpn: { tunnel: "", block_until_connected: false },
                })
              }
            >
              <Plus size={15} aria-hidden="true" />
              Add
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span>Tunnel</span>
            <input
              value={current.tunnel}
              placeholder="homeoffice"
              onChange={(e) =>
                onChange({
                  ...settings,
                  always_on_vpn: { ...current, tunnel: e.target.value },
                })
              }
            />
            <small>The tunnel's name, as it appears under Remote Access.</small>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.block_until_connected}
              onChange={(e) =>
                onChange({
                  ...settings,
                  always_on_vpn: { ...current, block_until_connected: e.target.checked },
                })
              }
            />
            Refuse to reach those networks until the tunnel is up
          </label>
        </>
      )}
    </>
  );
}

function SelfServiceEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.password_self_service;

  return (
    <>
      <header>
        <h3>Self-service password</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, password_self_service: undefined })}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove
          </button>
        )}
      </header>
      <p className="muted">
        Whether these people may change their own password from the console. Not configured
        anywhere means yes — changing your own password is ordinary, and a policy object is how
        it is taken away. The current password is always required, whatever this says.
      </p>

      {!current ? (
        <>
          <p className="empty">Not configured. People may change their own password.</p>
          <div className="actions-row">
            <button
              type="button"
              className="primary"
              onClick={() =>
                onChange({
                  ...settings,
                  password_self_service: { enabled: true, minimum_length: 12 },
                })
              }
            >
              <Plus size={15} aria-hidden="true" />
              Add
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.enabled}
              onChange={(e) =>
                onChange({
                  ...settings,
                  password_self_service: { ...current, enabled: e.target.checked },
                })
              }
            />
            Let people change their own password
          </label>
          <label className="field">
            <span>Minimum length</span>
            <input
              type="number"
              value={current.minimum_length}
              onChange={(e) =>
                onChange({
                  ...settings,
                  password_self_service: {
                    ...current,
                    minimum_length: Number(e.target.value),
                  },
                })
              }
            />
            <small>
              Checked before the change is attempted. The domain&rsquo;s own policy is enforced
              by the directory on top of this.
            </small>
          </label>
        </>
      )}
    </>
  );
}

function WallpaperEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  return (
    <>
      <header>
        <h3>Desktop background</h3>
      </header>
      <div className="inline-fields">
        <label className="field">
          <span>Image location</span>
          <input
            value={settings.wallpaper?.uri ?? ""}
            placeholder="file:///usr/share/backgrounds/corp.png"
            onChange={(e) =>
              onChange({
                ...settings,
                wallpaper: e.target.value
                  ? {
                      uri: e.target.value,
                      picture_options: settings.wallpaper?.picture_options ?? "zoom",
                    }
                  : undefined,
              })
            }
          />
        </label>
        <label className="field">
          <span>Fit</span>
          <select
            value={settings.wallpaper?.picture_options ?? "zoom"}
            onChange={(e) =>
              onChange({
                ...settings,
                wallpaper: settings.wallpaper
                  ? { ...settings.wallpaper, picture_options: e.target.value }
                  : undefined,
              })
            }
          >
            {["zoom", "scaled", "stretched", "centered", "wallpaper", "spanned", "none"].map(
              (option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.wallpaper?.allow_user_change ?? false}
          disabled={!settings.wallpaper}
          onChange={(e) =>
            settings.wallpaper &&
            onChange({
              ...settings,
              wallpaper: { ...settings.wallpaper, allow_user_change: e.target.checked },
            })
          }
        />
        Let people change it afterwards
      </label>
    </>
  );
}

function BrowserEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  return (
    <>
      <header>
        <h3>Browser policy</h3>
      </header>
      <p className="muted">
        Managed-policy documents, written to each browser&rsquo;s own policy directory.
      </p>
      <JsonField
        label="Chromium"
        value={settings.browser?.chromium}
        onChange={(value) =>
          onChange({
            ...settings,
            browser: { chromium: value, firefox: settings.browser?.firefox ?? {} },
          })
        }
      />
      <JsonField
        label="Firefox"
        value={settings.browser?.firefox}
        onChange={(value) =>
          onChange({
            ...settings,
            browser: { chromium: settings.browser?.chromium ?? {}, firefox: value },
          })
        }
      />
    </>
  );
}

function Cell({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={field.label}
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.kind === "select") {
    return (
      <select
        aria-label={field.label}
        value={toInput(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "textarea") {
    return (
      <textarea
        aria-label={field.label}
        rows={3}
        value={toInput(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.picker) {
    return (
      <PickerField
        kind={field.picker}
        as={field.pickerValue}
        ariaLabel={field.label}
        placeholder={field.placeholder}
        multiple={field.pickerMultiple}
        value={toInput(value)}
        onChange={(next) => onChange(fromInput(field, next))}
      />
    );
  }
  return (
    <input
      aria-label={field.label}
      type={field.kind === "number" ? "number" : "text"}
      placeholder={field.placeholder}
      value={toInput(value)}
      onChange={(e) => onChange(fromInput(field, e.target.value))}
    />
  );
}

function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown>) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={5}
        className="mono"
        defaultValue={JSON.stringify(value ?? {}, null, 2)}
        onBlur={(e) => {
          try {
            onChange(JSON.parse(e.target.value || "{}"));
          } catch {
            /* invalid JSON is left for the operator to fix; nothing is sent */
          }
        }}
      />
    </label>
  );
}
