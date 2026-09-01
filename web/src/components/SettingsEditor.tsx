import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, type AdmxSelection, type ItemTargeting, type PolicySettings } from "../api";
import { AdmxEditor } from "./AdmxEditor";
import { ChoiceList, SUPPORTED_RELEASES } from "./ChoiceList";
import { FileInput } from "./FileInput";
import { Field, Modal } from "./Modal";
import { PickerField, type PickerKind, type PickerValue } from "./Picker";
import { Split } from "./Split";
import Select from "./Select"

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
  // Ready-made values offered beside the field. The field stays typeable:
  // these are the ones asked for most often, not the only ones allowed.
  suggestions?: { value: string; label: string }[];
}

// What a helpdesk or a developer is usually given, so the common rule is a
// choice rather than a path somebody has to look up. ALL is deliberately here
// too: it is what "full sudo" means, and hiding it does not stop anyone.
const COMMON_SUDO_COMMANDS = [
  { value: "ALL", label: "Everything (full sudo)" },
  { value: "/usr/bin/systemctl", label: "Manage services — systemctl" },
  { value: "/usr/bin/journalctl", label: "Read logs — journalctl" },
  { value: "/usr/bin/apt, /usr/bin/apt-get", label: "Install packages — apt" },
  { value: "/usr/bin/dpkg", label: "Install packages — dpkg" },
  { value: "/usr/sbin/reboot, /usr/sbin/shutdown", label: "Restart and shut down" },
  { value: "/usr/bin/mount, /usr/bin/umount", label: "Mount and unmount" },
  { value: "/usr/sbin/odm-agent", label: "Re-apply policy — odm-agent" },
  { value: "/usr/bin/passwd", label: "Change local passwords — passwd" },
  { value: "/usr/sbin/ufw, /usr/sbin/nft", label: "Firewall — ufw, nft" },
];

type Half = "Computer" | "User";

// A picture travels in the policy document itself, so the machines it is for
// receive it rather than being pointed at a path nobody put it at.
async function readBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(-128);
  return cleaned || "background";
}

// Where one entry can carry targeting of its own. A drive map for laptops and
// another for desks is one policy object in Active Directory, not two.
const TARGETABLE = new Set([
  "files",
  "scripts",
  "systemd_units",
  "cron",
  "drive_maps",
  "printers",
  "packages",
]);

/** Which halves of Group Policy this object actually configures.
 *
 * Which half a setting is in decides where the object has to be linked: a
 * user setting linked at an OU full of computers reaches nobody, and reads as
 * the setting not working rather than the link being in the wrong place. */
export function halvesConfigured(settings: PolicySettings): Half[] {
  const halves = new Set<Half>();
  for (const entry of [...CATEGORIES, ...SPECIAL]) {
    if (countOf(settings, "id" in entry && entry.id ? entry.id : String(entry.key)) > 0) {
      halves.add(entry.half);
    }
  }
  return (["Computer", "User"] as Half[]).filter((half) => halves.has(half));
}

function categoryId(category: CategorySpec): string {
  return category.id ?? String(category.key);
}

interface CategorySpec {
  key: keyof PolicySettings;
  // Set when two entries edit the same category, so each is its own item in
  // the list. Defaults to the key.
  id?: string;
  // Restricts an entry to part of its category. Logon scripts are a user
  // setting and startup scripts are a machine one; in the directory they are
  // one list with a trigger, and showing them as one item put half of them
  // under the wrong heading.
  only?: { field: string; values: string[] };
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
    id: "scripts-computer",
    only: { field: "trigger", values: ["startup", "shutdown"] },
    title: "Startup and shutdown scripts",
    half: "Computer",
    fields: [
      {
        key: "trigger",
        label: "Trigger",
        kind: "select",
        options: ["startup", "shutdown"],
        width: "130px",
      },
      { key: "name", label: "Name", width: "160px" },
      { key: "interpreter", label: "Interpreter", width: "140px" },
      { key: "content", label: "Script", kind: "textarea" },
    ],
    blank: { trigger: "startup", name: "", interpreter: "/bin/sh", content: "" },
  },
  {
    key: "scripts",
    id: "scripts-user",
    only: { field: "trigger", values: ["logon", "logoff"] },
    title: "Logon and logoff scripts",
    half: "User",
    fields: [
      {
        key: "trigger",
        label: "Trigger",
        kind: "select",
        options: ["logon", "logoff"],
        width: "130px",
      },
      { key: "name", label: "Name", width: "160px" },
      { key: "interpreter", label: "Interpreter", width: "140px" },
      { key: "content", label: "Script", kind: "textarea" },
    ],
    blank: { trigger: "logon", name: "", interpreter: "/bin/sh", content: "" },
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
      {
        key: "commands",
        label: "Commands",
        placeholder: "/usr/bin/systemctl",
        suggestions: COMMON_SUDO_COMMANDS,
      },
      { key: "run_as", label: "Run as", width: "140px", picker: "user" },
      { key: "nopasswd", label: "NOPASSWD", kind: "checkbox", width: "110px" },
    ],
    blank: { name: "", users: [], commands: [], run_as: "ALL", nopasswd: false },
  },
  {
    key: "hbac_rules",
    title: "HBAC rules",
    note:
      "Who may open a session on a machine, and how. A group is written with a leading % — " +
      "Select… does that for you. Deny beats allow, and root is never locked out.",
    half: "Computer",
    fields: [
      {
        key: "principal",
        label: "User, or %group",
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
    key: "trusted_certificates",
    title: "Trusted certificates",
    half: "Computer",
    note:
      "Authorities every machine trusts. Certificates → Publish to domain writes this one; " +
      "editing it here is unusual.",
    fields: [
      { key: "name", label: "Name", placeholder: "internal-root-ca" },
      { key: "certificate_pem", label: "PEM", kind: "textarea" },
    ],
    blank: { name: "", certificate_pem: "" },
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
      {
        key: "action",
        label: "Action",
        kind: "select",
        options: ["allow", "deny"],
        width: "110px",
      },
      {
        key: "direction",
        label: "Direction",
        kind: "select",
        options: ["in", "out"],
        width: "110px",
      },
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
    blank: {
      name: "",
      action: "allow",
      direction: "in",
      protocol: "tcp",
      port: null,
      source: "any",
    },
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
  { key: "local_administrator", title: "Local administrator", half: "Computer" as Half },
  {
    key: "remote_desktop_session",
    title: "Remote desktop session",
    half: "Computer" as Half,
  },
  { key: "password_self_service", title: "Self-service password", half: "User" as Half },
  { key: "roaming_profile", title: "Roaming profile", half: "User" as Half },
  { key: "wallpaper", title: "Desktop background", half: "User" as Half },
  { key: "browser", title: "Browser policy", half: "Computer" as Half },
  { key: "admx", title: "Administrative templates", half: "Computer" as Half },
] as const;

type Selected = string;

function countOf(settings: PolicySettings, key: string): number {
  if (key === "updates") return settings.updates ? 1 : 0;
  if (key === "login_screen") return settings.login_screen ? 1 : 0;
  if (key === "always_on_vpn") return settings.always_on_vpn ? 1 : 0;
  if (key === "local_administrator") return settings.local_administrator ? 1 : 0;
  if (key === "remote_desktop_session") return settings.remote_desktop_session ? 1 : 0;
  if (key === "password_self_service") return settings.password_self_service ? 1 : 0;
  if (key === "roaming_profile") return settings.roaming_profile ? 1 : 0;
  if (key === "wallpaper") return settings.wallpaper?.uri || settings.wallpaper?.image ? 1 : 0;
  if (key === "browser") {
    const browser = settings.browser;
    if (!browser) return 0;
    return Object.keys(browser.chromium ?? {}).length + Object.keys(browser.firefox ?? {}).length;
  }
  // A category split across the two halves counts only its own half.
  const split = CATEGORIES.find((entry) => entry.id === key);
  if (split) return rowsOf(settings, split).mine.length;
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
  const [selected, setSelected] = useState<Selected>(categoryId(CATEGORIES[0]));

  const entries = [
    ...CATEGORIES.map((category) => ({
      key: categoryId(category),
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
          <p className="category-group">
            {half} Configuration
            <span>
              {half === "Computer"
                ? "Applies to computers in the linked OU"
                : "Applies to users in the linked OU"}
            </span>
          </p>
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

  const category = CATEGORIES.find((entry) => categoryId(entry) === selected);

  return (
    <div className="settings-editor">
      <Split id="policy-categories" label="Resize the category list" initial={230} side={tree}>
        <div className="category-editor">
          {category && <RowsEditor category={category} settings={settings} onChange={onChange} />}
          {selected === "updates" && <UpdatesEditor settings={settings} onChange={onChange} />}
          {selected === "login_screen" && (
            <LoginScreenEditor settings={settings} onChange={onChange} />
          )}
          {selected === "always_on_vpn" && (
            <AlwaysOnVpnEditor settings={settings} onChange={onChange} />
          )}
          {selected === "local_administrator" && (
            <LocalAdministratorEditor settings={settings} onChange={onChange} />
          )}
          {selected === "remote_desktop_session" && (
            <RemoteDesktopSessionEditor settings={settings} onChange={onChange} />
          )}
          {selected === "password_self_service" && (
            <SelfServiceEditor settings={settings} onChange={onChange} />
          )}
          {selected === "roaming_profile" && (
            <RoamingProfileEditor settings={settings} onChange={onChange} />
          )}
          {selected === "wallpaper" && <WallpaperEditor settings={settings} onChange={onChange} />}
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

/** What a setting looks like before it has a value.
 *
 * A bordered placeholder rather than a sentence in the middle of an empty
 * panel: the shape shows something belongs here, and the button that creates
 * it is inside the shape rather than floating below it. */
function EmptySetting({ onAdd, message }: { onAdd: () => void; message?: string }) {
  return (
    <div className="empty-setting">
      <p>{message ?? "Nothing configured. This policy leaves the setting alone."}</p>
      <button type="button" className="primary" onClick={onAdd}>
        <Plus size={15} aria-hidden="true" />
        Add
      </button>
    </div>
  );
}

// The rows this entry shows, and the ones it must leave alone: two entries
// over one category each edit their own half of it.
function rowsOf(
  settings: PolicySettings,
  category: CategorySpec,
): { mine: Record<string, unknown>[]; others: Record<string, unknown>[] } {
  const all = (settings[category.key] as Record<string, unknown>[] | undefined) ?? [];
  if (!category.only) return { mine: all, others: [] };
  const { field, values } = category.only;
  return {
    mine: all.filter((row) => values.includes(String(row[field]))),
    others: all.filter((row) => !values.includes(String(row[field]))),
  };
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
  const { mine: current, others } = rowsOf(settings, category);
  const [targeting, setTargeting] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  // Four or more fields in a row squeezes every one of them to nothing. Those
  // categories show what an entry is and open the rest in a dialog, which is
  // also where a long value has room to be read.
  const cramped = category.fields.length > 3;
  const summary = cramped ? category.fields.slice(0, 2) : category.fields;

  function update(next: Record<string, unknown>[]) {
    onChange({ ...settings, [category.key]: [...others, ...next] });
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

      {/* The table is drawn whether or not it has rows. A bare "Not
          configured" in the middle of an empty panel shows nothing about what
          would go there; the column headings do. */}
      <table className="data compact">
        <thead>
          <tr>
            {summary.map((field) => (
              <th key={field.key} style={field.width ? { width: field.width } : undefined}>
                {field.label}
              </th>
            ))}
            {cramped && <th>Settings</th>}
            {TARGETABLE.has(String(category.key)) && <th style={{ width: "120px" }}>Applies to</th>}
            {cramped && (
              <th style={{ width: "84px" }}>
                <span className="sr-only">Edit</span>
              </th>
            )}
            <th style={{ width: "44px" }}>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {current.map((row, index) => (
            <tr key={index}>
              {summary.map((field) => (
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
              {cramped && (
                <td className="muted truncate">
                  {category.fields
                    .slice(2)
                    .map((field) => `${field.label}: ${describe(row[field.key])}`)
                    .join(" · ")}
                </td>
              )}
              {cramped && (
                <td>
                  <button type="button" className="ghost" onClick={() => setEditing(index)}>
                    <Pencil size={14} aria-hidden="true" />
                    Edit
                  </button>
                </td>
              )}
              {TARGETABLE.has(String(category.key)) && (
                <td>
                  <button type="button" className="ghost" onClick={() => setTargeting(index)}>
                    {row.targeting ? "Some" : "Everyone"}
                  </button>
                </td>
              )}
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
          {current.length === 0 && (
            <tr>
              <td
                className="empty"
                colSpan={
                  summary.length +
                  (cramped ? 2 : 0) +
                  (TARGETABLE.has(String(category.key)) ? 2 : 1)
                }
              >
                Nothing configured. Add creates the first entry.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing !== null && current[editing] && (
        <EntryDialog
          category={category}
          row={current[editing]}
          index={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            const rows = [...current];
            rows[editing] = next;
            update(rows);
            setEditing(null);
          }}
        />
      )}

      {targeting !== null && current[targeting] && (
        <ItemTargetingDialog
          value={(current[targeting].targeting as ItemTargeting | undefined) ?? null}
          onClose={() => setTargeting(null)}
          onSave={(next) => {
            const rows = [...current];
            rows[targeting] = { ...rows[targeting], targeting: next ?? undefined };
            update(rows);
            setTargeting(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Targeting on one entry rather than the whole policy object.
 *
 * The fields are the object's own, so what "matches" means does not depend on
 * where it is written. Empty everywhere means the entry applies to whoever the
 * policy object reaches.
 */
function ItemTargetingDialog({
  value,
  onClose,
  onSave,
}: {
  value: ItemTargeting | null;
  onClose: () => void;
  onSave: (value: ItemTargeting | null) => void;
}) {
  const [os, setOs] = useState<string[]>(value?.os ?? []);
  const [hostname, setHostname] = useState(value?.hostname_pattern ?? "");
  const [groups, setGroups] = useState<string[]>(value?.security_groups ?? []);
  const [ranges, setRanges] = useState((value?.ip_ranges ?? []).join(", "));

  const lines = (text: string) =>
    text
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);

  return (
    <Modal
      title="This entry applies to"
      submitLabel="Save"
      wide
      onClose={onClose}
      onSubmit={() => {
        const next: ItemTargeting = {
          os,
          hostname_pattern: hostname || undefined,
          security_groups: groups,
          ip_ranges: lines(ranges),
        };
        const empty =
          !next.os?.length &&
          !next.hostname_pattern &&
          !next.security_groups?.length &&
          !next.ip_ranges?.length;
        onSave(empty ? null : next);
      }}
    >
      <p className="muted">
        Leave everything empty and the entry applies wherever the policy object does. Anything set
        here narrows it further — it can never widen it.
      </p>

      {/* The releases ODM supports, rather than a free-text field where a
          typo produces a rule that quietly matches nothing. */}
      <div className="field">
        <span>Operating systems</span>
        <div className="option-row">
          {SUPPORTED_RELEASES.map((release) => (
            <label key={release.value} className="checkbox">
              <input
                type="checkbox"
                checked={os.includes(release.value)}
                onChange={(e) =>
                  setOs(
                    e.target.checked
                      ? [...os, release.value]
                      : os.filter((entry) => entry !== release.value),
                  )
                }
              />
              {release.label}
            </label>
          ))}
        </div>
        <small>None ticked means every operating system.</small>
      </div>
      <label className="field">
        <span>Host name pattern</span>
        <input value={hostname} placeholder="ws-*" onChange={(e) => setHostname(e.target.value)} />
      </label>
      <div className="field">
        <span>Groups</span>
        <ChoiceList
          kind="group"
          values={groups}
          onChange={setGroups}
          addLabel="Add a group…"
          emptyLabel="Any group. Add one to narrow this entry to its members."
        />
      </div>
      <label className="field">
        <span>Address ranges</span>
        <input
          value={ranges}
          placeholder="10.20.0.0/24"
          onChange={(e) => setRanges(e.target.value)}
        />
      </label>
    </Modal>
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
        <EmptySetting onAdd={() => set({})} />
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
              <Select
                value={current.security_only ? "security" : "all"}
                onChange={(e) => set({ security_only: e.target.value === "security" })}
              >
                <option value="security">Security updates only</option>
                <option value="all">Every available update</option>
              </Select>
            </label>
            <label className="field">
              <span>How often</span>
              <Select
                value={current.schedule}
                onChange={(e) => set({ schedule: e.target.value as "daily" | "weekly" })}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
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
        <EmptySetting onAdd={() => set({})} />
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

          <label className="field">
            <span>Background picture</span>
            <FileInput
              accept="image/*"
              placeholder={current.background_image_name || "No picture chosen"}
              onChoose={async (file) =>
                set({
                  background_image: await readBase64(file),
                  background_image_name: safeFileName(file.name),
                  background_uri: "",
                })
              }
            />
          </label>
          <div className="inline-fields">
            <label className="field">
              <span>Or a location the picture is already at</span>
              <input
                value={current.background_uri}
                placeholder="file:///usr/share/backgrounds/login.png"
                onChange={(e) => set({ background_uri: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Fit</span>
              <Select
                value={current.background_fit}
                onChange={(e) => set({ background_fit: e.target.value })}
              >
                {["zoom", "scaled", "stretched", "centered", "none"].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
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
  const [tunnels, setTunnels] = useState<string[]>([]);

  // A tunnel that does not exist is a machine that never comes up, and the
  // name is not something to remember correctly.
  useEffect(() => {
    api.vpn
      .list()
      .then((result) => setTunnels(result.tunnels.map((tunnel) => tunnel.name)))
      .catch(() => setTunnels([]));
  }, []);

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
        The machine holds this tunnel up from boot, before anyone signs in, and the person using it
        cannot turn it off. Each machine needs a peer on the tunnel under Remote Access; the key is
        delivered to that machine alone.
      </p>

      {!current ? (
        <EmptySetting
          onAdd={() =>
            onChange({
              ...settings,
              always_on_vpn: { tunnel: "", block_until_connected: false },
            })
          }
        />
      ) : (
        <>
          <label className="field">
            <span>Tunnel</span>
            <Select
              value={current.tunnel}
              onChange={(e) =>
                onChange({
                  ...settings,
                  always_on_vpn: { ...current, tunnel: e.target.value },
                })
              }
            >
              <option value="">Not set</option>
              {tunnels.map((tunnel) => (
                <option key={tunnel} value={tunnel}>
                  {tunnel}
                </option>
              ))}
              {current.tunnel && !tunnels.includes(current.tunnel) && (
                <option value={current.tunnel}>{current.tunnel} &mdash; no longer exists</option>
              )}
            </Select>
            <small>
              {tunnels.length === 0
                ? "No tunnels yet. Create one under Remote Access."
                : "Each machine also needs a peer on this tunnel under Remote Access."}
            </small>
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

/** Kept beside the rules the API enforces in routes_password.COMPLEXITY. */
const COMPLEXITY_RULES = [
  { key: "require_uppercase", label: "An upper-case letter" },
  { key: "require_lowercase", label: "A lower-case letter" },
  { key: "require_digit", label: "A digit" },
  { key: "require_symbol", label: "A symbol" },
] as const;

/**
 * A local administrator the machine manages for itself — LAPS.
 *
 * The password is not here and cannot be: the machine generates it, so it
 * differs on every machine and one recovered from a stolen laptop opens
 * nothing else. It is read off the computer object, and every read is audited.
 */
function LocalAdministratorEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.local_administrator;

  function set(changes: Partial<NonNullable<PolicySettings["local_administrator"]>>) {
    onChange({
      ...settings,
      local_administrator: {
        account: "odmadmin",
        rotate_days: 30,
        length: 20,
        administrator: true,
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <header>
        <h3>Local administrator</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, local_administrator: undefined })}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove
          </button>
        )}
      </header>
      <p className="muted">
        A local account on every machine this reaches, with a password the machine chooses and
        rotates itself. It is the way in when the domain is unreachable, and because every machine
        picks its own, one recovered from a stolen laptop opens nothing else. Read it under a
        computer &rarr; Machine; every read is audited.
      </p>

      {!current ? (
        <EmptySetting onAdd={() => set({})} />
      ) : (
        <>
          <div className="field-grid">
            <label className="field">
              <span>Account name</span>
              <input
                value={current.account}
                placeholder="odmadmin"
                onChange={(e) => set({ account: e.target.value })}
              />
              <small>Created if it does not exist. Lower case, no spaces.</small>
            </label>
            <label className="field">
              <span>Rotate every (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={current.rotate_days}
                onChange={(e) => set({ rotate_days: Number(e.target.value) })}
              />
              <small>
                A password is also rotated the first time this policy reaches a machine.
              </small>
            </label>
            <label className="field">
              <span>Password length</span>
              <input
                type="number"
                min={12}
                max={128}
                value={current.length}
                onChange={(e) => set({ length: Number(e.target.value) })}
              />
              <small>Generated on the machine, from characters that cannot be misread.</small>
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={current.administrator}
              onChange={(e) => set({ administrator: e.target.checked })}
            />
            May use sudo
          </label>
          <p className="muted">
            Without it the account is a way in but not a way up, which is enough to reach a machine
            and read its logs.
          </p>
        </>
      )}
    </>
  );
}

/** What a remote desktop session may carry between client and host. */
const REDIRECTION = [
  { key: "allow_clipboard", label: "Clipboard" },
  { key: "allow_printers", label: "The client's printers" },
  { key: "allow_drives", label: "The client's drives" },
  { key: "allow_audio", label: "Sound to the client" },
  { key: "allow_microphone", label: "The client's microphone" },
] as const;

function RemoteDesktopSessionEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.remote_desktop_session;

  function set(changes: Partial<NonNullable<PolicySettings["remote_desktop_session"]>>) {
    onChange({
      ...settings,
      remote_desktop_session: {
        allow_clipboard: true,
        allow_printers: true,
        allow_drives: false,
        allow_audio: true,
        allow_microphone: false,
        max_colour_depth: 32,
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <header>
        <h3>Remote desktop session</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, remote_desktop_session: undefined })}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove
          </button>
        )}
      </header>
      <p className="muted">
        What a session may carry between the client and the host it runs on. This is a rule about
        machines rather than about a collection, so it is set here and linked where it should apply.
        Machines that are not session hosts skip it.
      </p>

      {!current ? (
        <EmptySetting onAdd={() => set({})} />
      ) : (
        <>
          <div className="field">
            <span>Allowed in a session</span>
            <div className="option-row">
              {REDIRECTION.map((entry) => (
                <label key={entry.key} className="checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(current[entry.key])}
                    onChange={(e) => set({ [entry.key]: e.target.checked })}
                  />
                  {entry.label}
                </label>
              ))}
            </div>
            <small>
              A redirected drive is the client&rsquo;s own filesystem inside the session, which is
              the usual way data leaves a managed desktop. It is off unless turned on.
            </small>
          </div>

          <label className="field">
            <span>Most colour depth</span>
            <Select
              value={String(current.max_colour_depth)}
              onChange={(e) => set({ max_colour_depth: Number(e.target.value) })}
            >
              <option value="32">32-bit</option>
              <option value="24">24-bit</option>
              <option value="16">16-bit</option>
              <option value="8">8-bit</option>
            </Select>
            <small>Lower is less to send, which shows on a slow or distant link.</small>
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
        Whether these people may change their own password from the console. Not configured anywhere
        means yes — changing your own password is ordinary, and a policy object is how it is taken
        away. The current password is always required, whatever this says.
      </p>

      {!current ? (
        <EmptySetting
          message="Not configured here, so people may change their own password."
          onAdd={() =>
            onChange({
              ...settings,
              password_self_service: { enabled: true, minimum_length: 12 },
            })
          }
        />
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
              Checked before the change is attempted. The domain&rsquo;s own policy is enforced by
              the directory on top of this.
            </small>
          </label>

          <div className="field">
            <span>Must contain</span>
            <div className="option-row">
              {COMPLEXITY_RULES.map((rule) => (
                <label key={rule.key} className="checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(current[rule.key])}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        password_self_service: { ...current, [rule.key]: e.target.checked },
                      })
                    }
                  />
                  {rule.label}
                </label>
              ))}
            </div>
            <small>
              Whoever is changing their password is told which of these they missed, rather than
              getting one flat refusal from the directory.
            </small>
          </div>
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
      <label className="field">
        <span>Picture</span>
        <FileInput
          accept="image/*"
          placeholder={settings.wallpaper?.image_name ?? "No picture chosen"}
          onChoose={async (file) =>
            onChange({
              ...settings,
              wallpaper: {
                ...settings.wallpaper,
                image: await readBase64(file),
                image_name: safeFileName(file.name),
                uri: "",
                picture_options: settings.wallpaper?.picture_options ?? "zoom",
              },
            })
          }
        />
      </label>
      <div className="inline-fields">
        <label className="field">
          <span>Or a location the picture is already at</span>
          <input
            value={settings.wallpaper?.uri ?? ""}
            placeholder="file:///usr/share/backgrounds/corp.png"
            onChange={(e) =>
              onChange({
                ...settings,
                wallpaper:
                  e.target.value || settings.wallpaper?.image
                    ? {
                        ...settings.wallpaper,
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
          <Select
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
          </Select>
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
      <Select
        aria-label={field.label}
        value={toInput(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
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
  if (field.suggestions) {
    return (
      <div className="with-suggestions">
        <input
          aria-label={field.label}
          placeholder={field.placeholder}
          value={toInput(value)}
          onChange={(e) => onChange(fromInput(field, e.target.value))}
        />
        {/* Appends rather than replaces: a rule is usually a handful of
            commands, and nobody should have to remember the path to visudo. */}
        <Select
          aria-label={`Common ${field.label.toLowerCase()}`}
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            const current = toInput(value)
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean);
            if (!current.includes(e.target.value)) current.push(e.target.value);
            onChange(fromInput(field, current.join(", ")));
          }}
        >
          <option value="">Common…</option>
          {field.suggestions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
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

/** What a field holds, short enough for a summary column. */
function describe(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

/** One entry of a category with too many fields to sit in a table row. */
function EntryDialog({
  category,
  row,
  index,
  onClose,
  onSave,
}: {
  category: CategorySpec;
  row: Record<string, unknown>;
  index: number;
  onClose: () => void;
  onSave: (next: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...row });
  return (
    <Modal
      title={`${category.title} — entry ${index + 1}`}
      submitLabel="Done"
      wide
      onClose={onClose}
      onSubmit={() => onSave(draft)}
    >
      {category.note && <p className="muted">{category.note}</p>}
      {category.fields.map((field) => (
        <Field key={field.key} label={field.label}>
          <Cell
            field={field}
            value={draft[field.key]}
            onChange={(value) => setDraft((was) => ({ ...was, [field.key]: value }))}
          />
        </Field>
      ))}
    </Modal>
  );
}

/** A home directory that follows the person rather than staying on the desk.
 *
 * The same mechanism a remote desktop collection uses for its user profile
 * disks: point both at the same share and somebody has one profile across
 * every desktop and every session host. */
function RoamingProfileEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.roaming_profile;

  function set(changes: Partial<NonNullable<PolicySettings["roaming_profile"]>>) {
    onChange({
      ...settings,
      roaming_profile: {
        path: "",
        kind: "directory",
        disk_gb: 10,
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <header>
        <h3>Roaming profile</h3>
        <span className="spacer" />
        {current && (
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ ...settings, roaming_profile: undefined })}
          >
            <Trash2 size={14} aria-hidden="true" />
            Not configured
          </button>
        )}
      </header>
      {!current ? (
        <EmptySetting
          message="People keep a local home directory on whichever machine they sign in to."
          onAdd={() => set({})}
        />
      ) : (
        <>
          <Field
            label="Profile path"
            hint="%username% becomes the person's own name, so one policy serves everybody"
          >
            <input
              value={current.path}
              placeholder="//fs01/profiles/%username%"
              onChange={(e) => set({ path: e.target.value })}
            />
          </Field>
          <div className="inline-fields">
            <Field label="Stored as">
              <Select
                value={current.kind}
                onChange={(e) => set({ kind: e.target.value as "directory" | "disk" })}
              >
                <option value="directory">A directory on the share</option>
                <option value="disk">A disk image per person</option>
              </Select>
            </Field>
            {current.kind === "disk" && (
              <Field label="Each disk may grow to (GB)">
                <input
                  type="number"
                  min={1}
                  max={2048}
                  value={current.disk_gb}
                  onChange={(e) => set({ disk_gb: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>
          <p className="muted">
            The share needs to let these people write, and the machines they sign in to read it:
            the machine mounts the profile with its own credentials before the session starts. A
            share that cannot be reached leaves that session with a local home rather than
            refusing the sign-in.
          </p>
        </>
      )}
    </>
  );
}
