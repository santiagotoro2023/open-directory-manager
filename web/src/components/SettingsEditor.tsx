import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, type AdmxSelection, type ItemTargeting, type PolicySettings } from "../api";
import { AdmxEditor } from "./AdmxEditor";
import { ChoiceList, SUPPORTED_RELEASES } from "./ChoiceList";
import { CollectionPicker, PrinterPicker, SharePicker } from "./ResourcePicker";
import { InfoPanel } from "./DocsLink";
import { LocalAccountList } from "./LocalAccountPicker";
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
  /** What the field wants, where the label alone reads two ways. Shown in the
      entry dialog only: a table column has no room for it. */
  hint?: string;
  width?: string;
  /** Browse for something that is not a directory object. Picking one can
      fill in more than its own field — a printer names the server it is on,
      a share names what to call the drive and where to mount it. */
  pick?: "printer" | "share" | "collection";
  // A value the directory already knows is chosen, not typed.
  picker?: PickerKind;
  pickerValue?: PickerValue;
  pickerMultiple?: boolean;
  /** Offer an account on a machine as well as one in the directory. */
  pickerLocal?: boolean;
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
    const id = "id" in entry && typeof entry.id === "string" ? entry.id : String(entry.key);
    if (countOf(settings, id) > 0) {
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
  // What the entry is called in its row. Defaults to the first field, which
  // is the identity for every category where the first field is not it.
  identity?: string;
  // One sentence on what the category does, shown above the list beside the
  // link to the section of the wiki covering it.
  help: string;
  // The section of the policy-settings page this links to. Section headings
  // carry an anchor made from their title.
  doc: string;
  /** The wiki page the link lands on. Defaults to the policy-settings page. */
  docPage?: string;
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
    identity: "path",
    help:
      "A file written to every machine the policy reaches, with the owner and mode " +
      "it should have.",
    doc: "file-deployment",
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
    identity: "name",
    help:
      "A script the machine runs as root when it starts or as it shuts down.",
    doc: "scripts",
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
    identity: "name",
    help:
      "A script that runs as the person signing in or out, in their own session.",
    doc: "scripts",
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
    identity: "unit",
    help:
      "The state a service, socket or timer is held in: enabled, disabled, masked, " +
      "started or stopped.",
    doc: "systemd-units",
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
    identity: "name",
    help:
      "A command run on a schedule, written into the machine's cron. Five cron " +
      "fields, or an @keyword such as @daily.",
    doc: "scheduled-tasks",
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
    identity: "name",
    help:
      "A share mounted for the person signing in, with their own Kerberos ticket.",
    doc: "drive-maps",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      {
        key: "unc",
        label: "Share",
        placeholder: "//fs01/shared",
        hint: "The share as the file server publishes it",
        pick: "share",
      },
      { key: "mount_point", label: "Mount point", placeholder: "/mnt/shared" },
      {
        key: "display_name",
        label: "Shown as",
        placeholder: "The name above",
        width: "160px",
      },
      {
        key: "for_principal",
        label: "For user or group",
        placeholder: "%Engineers",
        picker: "principal",
        pickerValue: "principal",
      },
      { key: "options", label: "Options" },
    ],
    blank: { name: "", unc: "", mount_point: "", display_name: "", for_principal: "", options: "" },
  },
  {
    key: "sudo_rules",
    title: "Sudo rules",
    note: "Users and commands are comma separated.",
    half: "Computer",
    identity: "name",
    help:
      "Who may run which commands as another user on the machines this policy " +
      "reaches. Written to the directory as a sudoRole.",
    doc: "sudo-rules",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      {
        key: "users",
        label: "Users and groups",
        placeholder: "%Helpdesk",
        picker: "principal",
        pickerValue: "principal",
        pickerMultiple: true,
        pickerLocal: true,
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
    identity: "principal",
    help:
      "Who may open a session, and how: locally, over SSH, or over remote desktop. " +
      "Deny beats allow.",
    doc: "hbac-rules",
    note: "A group is written with a leading % — Select… does that for you.",
    half: "Computer",
    fields: [
      {
        key: "principal",
        label: "User, or %group",
        placeholder: "%Engineers",
        picker: "principal",
        pickerValue: "principal",
        pickerLocal: true,
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
    identity: "name",
    help:
      "Packages the machine should have, keep current, or not have, installed with " +
      "apt from its own sources.",
    doc: "software-deployment",
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
    identity: "name",
    help:
      "Authorities every machine trusts, installed into the system trust store.",
    doc: "trusted-certificates",
    note: "Certificates → Publish to domain writes this one; editing it here is unusual.",
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
    identity: "profile",
    help:
      "Certificates the machine requests for itself and renews before they expire.",
    doc: "certificate-enrolment",
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
    key: "remote_desktop_files",
    title: "Remote desktop files",
    half: "User",
    identity: "name",
    help:
      "A connection file on the desktop of everybody in a group, for one " +
      "remote desktop collection. It goes when the membership or the link does.",
    doc: "remote-desktop-files",
    docPage: "remote-desktop",
    fields: [
      {
        key: "name",
        label: "Name",
        width: "180px",
        placeholder: "Terminal Server",
        hint: "What the icon is called on the desktop",
        pick: "collection",
      },
      {
        key: "address",
        label: "Broker",
        placeholder: "rd.corp.example.internal",
        hint: "Filled in by choosing a collection above",
      },
      {
        key: "application",
        label: "Published application",
        placeholder: "Empty for a whole desktop",
      },
      {
        key: "for_principal",
        label: "For user or group",
        placeholder: "%Finance",
        picker: "principal",
        pickerValue: "principal",
      },
      { key: "full_screen", label: "Full screen", kind: "checkbox", width: "110px" },
    ],
    blank: {
      name: "",
      address: "",
      collection: "",
      application: "",
      for_principal: "",
      full_screen: true,
    },
  },
  {
    key: "printers",
    title: "Printers",
    half: "User",
    identity: "name",
    help:
      "Printers the person signing in should have, from a machine carrying the " +
      "print-server role.",
    doc: "printers",
    fields: [
      {
        key: "name",
        label: "Printer",
        width: "180px",
        placeholder: "odm-prt-01",
        // The queue, not the device: the agent points CUPS at
        // ipp://<server>/printers/<queue> and the server holds the driver.
        // "Printer" reads just as easily as the printer's own address, so the
        // field says which it wants and offers the ones that exist.
        hint: "The queue on the print server, as listed under Printers — not the device address",
        pick: "printer",
      },
      {
        key: "server",
        label: "Print server",
        picker: "computer",
        pickerValue: "host",
        hint: "Filled in by choosing a printer above",
      },
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
    identity: "name",
    help:
      "Rules applied to the machine's firewall. Anything not named here is left as " +
      "it is.",
    doc: "firewall-rules",
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

/** A setting configured once rather than as a list of entries.
 *
 * These carry the same heading, the same explanation and the same link to
 * their documentation as the list categories; only the body below differs,
 * because there is one of them rather than many. */
interface SpecialSpec {
  key: string;
  title: string;
  half: Half;
  help: string;
  doc: string;
  /** The wiki page the link lands on. Defaults to the policy-settings page. */
  docPage?: string;
}

const SPECIAL: SpecialSpec[] = [
  {
    key: "updates",
    title: "System updates",
    half: "Computer",
    help:
      "Which updates the machine installs unattended, on what schedule, and whether " +
      "it may restart to finish them.",
    doc: "system-updates",
  },
  {
    key: "login_screen",
    title: "Login screen",
    half: "Computer",
    help:
      "The greeter, before anybody has signed in: its message, its background, and " +
      "whether it lists accounts. Separate from the desktop background, which belongs " +
      "to whoever is signed in.",
    doc: "login-screen-and-desktop-background",
  },
  {
    key: "always_on_vpn",
    title: "Always-on VPN",
    half: "Computer",
    help:
      "Holds a WireGuard tunnel up on the machine, optionally refusing to route the " +
      "networks it carries until it is up.",
    doc: "always-on-vpn",
  },
  {
    key: "local_administrator",
    title: "Local administrator",
    half: "Computer",
    help:
      "A local account with a password the machine generates, rotates on a schedule " +
      "and reports back. Different on every machine.",
    doc: "local-administrator",
  },
  {
    key: "remote_desktop_session",
    title: "Remote desktop session",
    half: "Computer",
    help:
      "What a remote desktop session carries between client and host: clipboard, " +
      "printers, drives, audio, microphone. Set here and linked where it applies, " +
      "rather than on a collection.",
    doc: "remote-desktop-session",
  },
  {
    key: "local_password_policy",
    title: "Local password policy",
    half: "Computer",
    help:
      "What a password on the machine itself has to be, and how long it lasts. " +
      "Accounts in the domain keep the domain's own rules.",
    doc: "local-password-policy",
  },
  {
    key: "password_self_service",
    title: "Self-service password",
    half: "User",
    help:
      "Whether people may change their own password from the sign-in page, and the " +
      "rules a new one has to meet.",
    doc: "self-service-password",
  },
  {
    key: "roaming_profile",
    title: "Roaming profile",
    half: "User",
    help:
      "Where a person's home directory lives, so it follows them from machine to " +
      "machine.",
    doc: "roaming-profile",
  },
  {
    key: "wallpaper",
    title: "Desktop background",
    half: "User",
    help: "The picture behind the desktop, and whether the person signing in may change it.",
    doc: "desktop-background",
  },
  {
    key: "admx",
    title: "Administrative templates",
    half: "Computer",
    help:
      "Settings from imported ADMX templates. Import a template under Group Policy, " +
      "then configure its policies here.",
    doc: "quickstart",
    docPage: "administrative-templates",
  },
];

function specialFor(key: string): SpecialSpec {
  const found = SPECIAL.find((entry) => entry.key === key);
  if (!found) throw new Error(`no such setting ${key}`);
  return found;
}

type Selected = string;

function countOf(settings: PolicySettings, key: string): number {
  if (key === "updates") return settings.updates ? 1 : 0;
  if (key === "login_screen") return settings.login_screen ? 1 : 0;
  if (key === "always_on_vpn") return settings.always_on_vpn ? 1 : 0;
  if (key === "local_administrator") return settings.local_administrator ? 1 : 0;
  if (key === "remote_desktop_session") return settings.remote_desktop_session ? 1 : 0;
  if (key === "password_self_service") return settings.password_self_service ? 1 : 0;
  if (key === "local_password_policy") return settings.local_password_policy ? 1 : 0;
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

  // Browser policy is no longer offered: an imported ADMX template configures
  // Chrome and Firefox, and two ways to set the same thing is one too many.
  // A policy that already carries one keeps it, and can be read and cleared
  // here, so nothing set before this change becomes invisible.
  const legacyBrowser = countOf(settings, "browser") > 0;

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
    ...(legacyBrowser
      ? [{ key: "browser", title: "Browser policy", half: "Computer" as Half }]
      : []),
  ];

  const tree = (
    <ul className="category-list">
      {(["Computer", "User"] as Half[]).map((half) => (
        <li key={half}>
          <p className="category-group">
            {half} Configuration
            <span>
              {half === "Computer" ? "Computers in the linked OU" : "Users in the linked OU"}
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
          {selected === "local_password_policy" && (
            <LocalPasswordEditor settings={settings} onChange={onChange} />
          )}
          {selected === "roaming_profile" && (
            <RoamingProfileEditor settings={settings} onChange={onChange} />
          )}
          {selected === "wallpaper" && <WallpaperEditor settings={settings} onChange={onChange} />}
          {selected === "browser" && <BrowserEditor settings={settings} onChange={onChange} />}
          {selected === "admx" && (
            <>
              <SettingHeading meta={specialFor("admx")} />
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

/** The heading every setting shares: what it is called, what it does, where
 * the rest of it is written down, and whatever the setting itself offers on
 * the right — Add, or Remove once it is configured. */
function SettingHeading({
  meta,
  actions,
}: {
  meta: { title: string; help: string; doc: string; docPage?: string };
  actions?: ReactNode;
}) {
  return (
    <>
      <header>
        <h3>{meta.title}</h3>
        <span className="spacer" />
        {actions}
      </header>
      <InfoPanel page={meta.docPage ?? "policy-settings"} anchor={meta.doc}>
        {meta.help}
      </InfoPanel>
    </>
  );
}

/** Remove, for a setting that is configured once rather than as a list.
 *
 * Removing it is not the same as turning it off: the policy stops carrying
 * the setting at all, and whatever a policy below it says then applies. */
function RemoveSetting({ onRemove }: { onRemove: () => void }) {
  return (
    <button type="button" className="ghost" onClick={onRemove}>
      <Trash2 size={15} aria-hidden="true" />
      Remove
    </button>
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
  // The index being edited, or "new" while an entry that does not exist yet is
  // being filled in. Nothing is added to the policy until it is saved, so a
  // cancelled Add leaves no half-written row behind.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const targetable = TARGETABLE.has(String(category.key));

  function update(next: Record<string, unknown>[]) {
    onChange({ ...settings, [category.key]: [...others, ...next] });
  }

  return (
    <>
      <SettingHeading
        meta={category}
        actions={
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            <Plus size={15} aria-hidden="true" />
            Add
          </button>
        }
      />

      {/* One row per entry, and one way to change it. Half the fields inline
          and the rest behind an Edit button meant the same entry was edited in
          two places, with the row's own columns deciding which half you got. */}
      <table className="data compact">
        <thead>
          <tr>
            <th scope="col">{identityLabel(category)}</th>
            <th scope="col">Settings</th>
            {targetable && <th scope="col" style={{ width: "150px" }}>Applies to</th>}
            <th style={{ width: "90px" }}>
              <span className="sr-only">Edit</span>
            </th>
            <th style={{ width: "44px" }}>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {current.map((row, index) => (
            <tr key={index} onDoubleClick={() => setEditing(index)}>
              <td className="entry-name">{identityOf(category, row)}</td>
              <td className="muted truncate">{summarise(category, row)}</td>
              {targetable && (
                <td className="muted">{row.targeting ? "Some machines" : "Everyone"}</td>
              )}
              <td>
                <button type="button" className="ghost" onClick={() => setEditing(index)}>
                  <Pencil size={14} aria-hidden="true" />
                  Edit
                </button>
              </td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${identityOf(category, row)}`}
                  onClick={() => update(current.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {current.length === 0 && (
            <tr>
              <td className="empty" colSpan={targetable ? 5 : 4}>
                Nothing configured. Add creates the first entry.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing !== null && (
        <EntryDialog
          category={category}
          row={editing === "new" ? { ...category.blank } : current[editing]}
          adding={editing === "new"}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            if (editing === "new") {
              update([...current, next]);
            } else {
              const rows = [...current];
              rows[editing] = next;
              update(rows);
            }
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** The field that names an entry, and what its column is called. */
function identityField(category: CategorySpec): FieldSpec {
  const named = category.fields.find((field) => field.key === category.identity);
  return named ?? category.fields[0];
}

function identityLabel(category: CategorySpec): string {
  return identityField(category).label;
}

function identityOf(category: CategorySpec, row: Record<string, unknown>): string {
  const value = describe(row[identityField(category).key], 60);
  return value === "—" ? "Unnamed" : value;
}

/** Everything about the entry except its name, as one line. */
function summarise(category: CategorySpec, row: Record<string, unknown>): string {
  const identity = identityField(category).key;
  return (
    category.fields
      .filter((field) => field.key !== identity)
      .map((field) => `${field.label}: ${describe(row[field.key])}`)
      .join(" · ") || "—"
  );
}

/**
 * Targeting on one entry rather than the whole policy object.
 *
 * The fields are the object's own, so what "matches" means does not depend on
 * where it is written. Empty everywhere means the entry applies to whoever the
 * policy object reaches. Shown inside the entry's own dialog: who an entry is
 * for is part of the entry.
 */
function ItemTargetingFields({
  value,
  onChange,
}: {
  value: ItemTargeting | null;
  onChange: (value: ItemTargeting | null) => void;
}) {
  const os = value?.os ?? [];
  const groups = value?.security_groups ?? [];

  function set(changes: Partial<ItemTargeting>) {
    const next: ItemTargeting = { ...(value ?? {}), ...changes };
    const empty =
      !next.os?.length &&
      !next.hostname_pattern &&
      !next.security_groups?.length &&
      !next.ip_ranges?.length;
    onChange(empty ? null : next);
  }

  const lines = (text: string) =>
    text
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);

  return (
    <>
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
                  set({
                    os: e.target.checked
                      ? [...os, release.value]
                      : os.filter((entry) => entry !== release.value),
                  })
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
        <input
          value={value?.hostname_pattern ?? ""}
          placeholder="ws-*"
          onChange={(e) => set({ hostname_pattern: e.target.value || undefined })}
        />
      </label>
      <div className="field">
        <span>Groups</span>
        <ChoiceList
          kind="group"
          values={groups}
          onChange={(next) => set({ security_groups: next })}
          addLabel="Add a group…"
          emptyLabel="Any group. Add one to narrow this entry to its members."
        />
      </div>
      <label className="field">
        <span>Address ranges</span>
        <input
          value={(value?.ip_ranges ?? []).join(", ")}
          placeholder="10.20.0.0/24"
          onChange={(e) => set({ ip_ranges: lines(e.target.value) })}
        />
      </label>
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
      <SettingHeading
        meta={specialFor("updates")}
        actions={
          current && <RemoveSetting onRemove={() => onChange({ ...settings, updates: undefined })} />
        }
      />

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
      <SettingHeading
        meta={specialFor("login_screen")}
        actions={
          current && <RemoveSetting onRemove={() => onChange({ ...settings, login_screen: undefined })} />
        }
      />
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
            <small>
              GNOME&rsquo;s greeter takes its background from its compiled shell theme and
              ignores this; the banner and the user list below do apply there.
            </small>
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
      <SettingHeading
        meta={specialFor("always_on_vpn")}
        actions={
          current && <RemoveSetting onRemove={() => onChange({ ...settings, always_on_vpn: undefined })} />
        }
      />
      <p className="muted">
        Each machine needs a peer on the tunnel under Remote Access; the key goes to that machine
        alone.
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
      <SettingHeading
        meta={specialFor("local_administrator")}
        actions={
          current && <RemoveSetting onRemove={() => onChange({ ...settings, local_administrator: undefined })} />
        }
      />
      <p className="muted">
        Read the current password under a computer &rarr; Machine. Every read is audited.
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
      <SettingHeading
        meta={specialFor("remote_desktop_session")}
        actions={
          current && <RemoveSetting onRemove={() => onChange({ ...settings, remote_desktop_session: undefined })} />
        }
      />
      <p className="muted">Machines that are not session hosts skip it.</p>

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

function LocalPasswordEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = settings.local_password_policy;

  function set(changes: Partial<NonNullable<PolicySettings["local_password_policy"]>>) {
    onChange({
      ...settings,
      local_password_policy: {
        minimum_length: 12,
        require_uppercase: false,
        require_lowercase: false,
        require_digit: false,
        require_symbol: false,
        maximum_age_days: 0,
        minimum_age_days: 0,
        warn_days: 7,
        accounts: [],
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <SettingHeading
        meta={specialFor("local_password_policy")}
        actions={
          current && (
            <RemoveSetting
              onRemove={() => onChange({ ...settings, local_password_policy: undefined })}
            />
          )
        }
      />
      <p className="muted">
        Applies to accounts that live on the machine — a local administrator, an engineer&rsquo;s
        own account on a server. Domain accounts are governed by the domain&rsquo;s password policy
        under Delegation.
      </p>

      {!current ? (
        <EmptySetting
          message="Not configured, so each machine keeps its own rules."
          onAdd={() => set({})}
        />
      ) : (
        <>
          <div className="field-grid">
            <Field label="Minimum length">
              <input
                type="number"
                min={6}
                max={128}
                value={current.minimum_length}
                onChange={(e) => set({ minimum_length: Number(e.target.value) })}
              />
            </Field>
            <Field label="Expires after (days)" hint="0 leaves the machine's own value alone">
              <input
                type="number"
                min={0}
                value={current.maximum_age_days}
                onChange={(e) => set({ maximum_age_days: Number(e.target.value) })}
              />
            </Field>
            <Field label="Cannot be changed again for (days)" hint="0 for no wait">
              <input
                type="number"
                min={0}
                value={current.minimum_age_days}
                onChange={(e) => set({ minimum_age_days: Number(e.target.value) })}
              />
            </Field>
            <Field label="Warn before it expires (days)">
              <input
                type="number"
                min={0}
                value={current.warn_days}
                onChange={(e) => set({ warn_days: Number(e.target.value) })}
              />
            </Field>
          </div>

          <h3 className="section-title">A new password must contain</h3>
          <div className="option-row">
            {(
              [
                ["require_uppercase", "An upper-case letter"],
                ["require_lowercase", "A lower-case letter"],
                ["require_digit", "A digit"],
                ["require_symbol", "A symbol"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(current[key])}
                  onChange={(e) => set({ [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>

          <h3 className="section-title">Accounts the expiry applies to</h3>
          <LocalAccountList
            values={current.accounts ?? []}
            onChange={(accounts) => set({ accounts })}
            addLabel="Add an account…"
            emptyLabel="Every account on the machine somebody can sign in to."
          />
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
      <SettingHeading
        meta={specialFor("password_self_service")}
        actions={
          current && <RemoveSetting onRemove={() => onChange({ ...settings, password_self_service: undefined })} />
        }
      />
      <p className="muted">
        Checked before the directory is asked, in addition to the domain&rsquo;s own password
        policy under Delegation &rarr; Password policy. Changing a password always needs the
        current one.
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
      <SettingHeading
        meta={specialFor("wallpaper")}
        actions={
          settings.wallpaper && (
            <RemoveSetting onRemove={() => onChange({ ...settings, wallpaper: undefined })} />
          )
        }
      />
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

/** A browser policy set before administrative templates replaced it.
 *
 * Not offered for new policy objects: Chrome and Firefox both ship ADMX
 * templates, and importing one gives every setting a name, a type and a
 * description instead of a JSON document that has to be right first time.
 * What a policy already carries is still applied, and is shown here so it can
 * be read and cleared rather than quietly living on.
 */
function BrowserEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  return (
    <>
      <SettingHeading
        meta={{
          title: "Browser policy",
          help:
            "A managed-policy document set on this object. Chrome and Firefox both ship " +
            "ADMX templates; import one under Group Policy to configure them there.",
          doc: "quickstart",
          docPage: "administrative-templates",
        }}
        actions={<RemoveSetting onRemove={() => onChange({ ...settings, browser: undefined })} />}
      />
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
  entry,
  onChange,
  onPatch,
}: {
  field: FieldSpec;
  value: unknown;
  /** The whole entry being edited, for a pick that fills in more than one
      field of it. Absent in a table row, where an entry is edited in the
      dialog rather than in place. */
  entry?: Record<string, unknown>;
  onChange: (value: unknown) => void;
  onPatch?: (patch: Record<string, unknown>) => void;
}) {
  if (field.pick && onPatch) {
    return (
      <BrowseField
        field={field}
        value={toInput(value)}
        entry={entry ?? {}}
        onChange={(next) => onChange(next)}
        onPatch={onPatch}
      />
    );
  }
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
        local={field.pickerLocal}
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

/** A resource a server publishes, chosen rather than remembered.
 *
 * Typeable as well: a share on a machine the console does not manage, or a
 * queue on a server that has not reported yet, is still a valid entry. */
function BrowseField({
  field,
  value,
  entry,
  onChange,
  onPatch,
}: {
  field: FieldSpec;
  value: string;
  entry: Record<string, unknown>;
  onChange: (value: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="picker-field">
      <input
        aria-label={field.label}
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="ghost" onClick={() => setPicking(true)}>
        Select…
      </button>
      {picking && field.pick === "printer" && (
        <PrinterPicker
          onClose={() => setPicking(false)}
          onPick={(printer) => {
            setPicking(false);
            // The server as well: a queue only means anything on the machine
            // that holds it, and typing the pair by hand is how they end up
            // disagreeing.
            onPatch({ [field.key]: printer.name, server: printer.server });
          }}
        />
      )}
      {picking && field.pick === "collection" && (
        <CollectionPicker
          onClose={() => setPicking(false)}
          onPick={(collection) => {
            setPicking(false);
            // The broker and whether it publishes an application come from
            // the collection; the name is what the icon says, which starts as
            // the collection's own name and can be anything.
            onPatch({
              [field.key]: entry.name ? String(entry.name) : collection.name,
              collection: collection.name,
              address: collection.address,
              application: collection.application,
            });
          }}
        />
      )}
      {picking && field.pick === "share" && (
        <SharePicker
          onClose={() => setPicking(false)}
          onPick={(share) => {
            setPicking(false);
            // The name and the mount point follow from the share, but only
            // where they are still empty: an entry being corrected must not
            // lose the name somebody chose for it.
            onPatch({
              [field.key]: share.unc,
              ...(entry.name ? {} : { name: share.name }),
              ...(entry.mount_point ? {} : { mount_point: `/mnt/${share.name}` }),
            });
          }}
        />
      )}
    </div>
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
function describe(value: unknown, limit = 40): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

/** One entry of a category, all of it, in one place.
 *
 * Every field the entry has, and — where the category supports it — who the
 * entry applies to, which is part of the entry rather than a second dialog
 * behind a second button in the row. */
function EntryDialog({
  category,
  row,
  adding,
  onClose,
  onSave,
}: {
  category: CategorySpec;
  row: Record<string, unknown>;
  adding: boolean;
  onClose: () => void;
  onSave: (next: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...row });
  const targetable = TARGETABLE.has(String(category.key));
  const targeting = (draft.targeting as ItemTargeting | undefined) ?? null;

  return (
    <Modal
      title={adding ? `New ${category.title.toLowerCase()} entry` : identityOf(category, draft)}
      submitLabel={adding ? "Add" : "Save"}
      wide
      onClose={onClose}
      onSubmit={() => onSave(draft)}
    >
      {category.note && <p className="muted">{category.note}</p>}
      {category.fields.map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          <Cell
            field={field}
            value={draft[field.key]}
            entry={draft}
            onChange={(value) => setDraft((was) => ({ ...was, [field.key]: value }))}
            onPatch={(patch) => setDraft((was) => ({ ...was, ...patch }))}
          />
        </Field>
      ))}

      {targetable && (
        <>
          <h3 className="section-title">Applies to</h3>
          <p className="muted">
            Leave this empty and the entry applies wherever the policy object does. Anything set
            here narrows that further — it can never widen it.
          </p>
          <ItemTargetingFields
            value={targeting}
            onChange={(next) => setDraft((was) => ({ ...was, targeting: next ?? undefined }))}
          />
        </>
      )}
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
        kind: "disk",
        disk_gb: 10,
        ...current,
        ...changes,
      },
    });
  }

  return (
    <>
      <SettingHeading
        meta={specialFor("roaming_profile")}
        actions={
          current && (
            <RemoveSetting onRemove={() => onChange({ ...settings, roaming_profile: undefined })} />
          )
        }
      />
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
                <option value="disk">A disk image per person</option>
                <option value="directory">A directory on the share</option>
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
            A disk image is the default for the same reason Windows uses one: a desktop expects a
            real filesystem under its home, and one mounted straight over SMB cannot rename
            dconf&rsquo;s database into place &mdash; which stalls every application that saves a
            setting, the file manager included.
          </p>
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
