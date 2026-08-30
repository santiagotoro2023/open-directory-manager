import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  BookOpen,
  ClipboardList,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  Router,
  Database,
  FolderOpen,
  HardDriveDownload,
  ScrollText,
  Server,
  ServerCog,
  ShieldCheck,
  ShieldHalf,
  Trash2,
  Users,
} from "lucide-react";
import { ApiError, api, holds, type SessionInfo } from "./api";
import { Field, Modal } from "./components/Modal";
import { SecondFactorDialog } from "./components/SecondFactor";

// `permission` is what the section needs; `domainAdmin` marks a section only
// members of the domain administrators group ever see; `roles` names the server
// roles that must all be installed somewhere before the section has anything
// to show — network boot needs a boot server and a DHCP server to advertise it.
const NAV = [
  { label: "Overview", to: "/", icon: LayoutDashboard, end: true },
  { label: "Directory", to: "/directory", icon: Users, permission: "directory.read" },
  { label: "Group Policy", to: "/policy", icon: ClipboardList, permission: "gpo.read" },
  { label: "DNS", to: "/dns", icon: Globe, permission: "dns.read" },
  {
    label: "DHCP",
    to: "/dhcp",
    icon: Network,
    permission: "dhcp.read",
    roles: ["dhcp"],
  },
  {
    label: "File Shares",
    to: "/shares",
    icon: FolderOpen,
    permission: "share.read",
    roles: ["file-server"],
  },
  {
    label: "Printers",
    to: "/printers",
    icon: Printer,
    permission: "printer.read",
    roles: ["print-server"],
  },
  {
    label: "Remote Access",
    to: "/vpn",
    icon: ShieldHalf,
    permission: "vpn.read",
    roles: ["vpn"],
  },
  {
    label: "Network Access",
    to: "/network-access",
    icon: Router,
    permission: "radius.read",
    roles: ["radius"],
  },
  {
    label: "Certificates",
    to: "/certificates",
    icon: KeyRound,
    permission: "ca.read",
    roles: ["certificate-authority"],
  },
  {
    label: "Client Enrolment",
    to: "/enrolment",
    icon: HardDriveDownload,
    // Network boot is advertised through DHCP: without a DHCP server there is
    // nothing to attach a deployment to.
    permission: "role.read",
    roles: ["pxe", "dhcp"],
  },
  { label: "Servers", to: "/servers", icon: ServerCog, permission: "server.read" },
  {
    label: "Domain Controllers",
    to: "/controllers",
    icon: Database,
    permission: "dc.read",
  },
  { label: "Server Roles", to: "/roles", icon: Server, permission: "role.read" },
  { label: "Delegation", to: "/delegation", icon: ShieldCheck, domainAdmin: true },
  { label: "Deleted Objects", to: "/recyclebin", icon: Trash2, permission: "recyclebin.read" },
  { label: "Audit Log", to: "/audit", icon: ScrollText, permission: "audit.read" },
  { label: "Wiki", to: "/wiki", icon: BookOpen },
];

function remember(collapsed: boolean) {
  try {
    localStorage.setItem("odm.sidebar", collapsed ? "collapsed" : "open");
  } catch {
    /* nothing to do: the sidebar simply opens again next time */
  }
}

function recall(): boolean {
  try {
    return localStorage.getItem("odm.sidebar") === "collapsed";
  } catch {
    return false;
  }
}

export function Shell({ session, onSignOut }: { session: SessionInfo; onSignOut: () => void }) {
  const [collapsed, setCollapsed] = useState(recall);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [selfService, setSelfService] = useState(false);
  const [changing, setChanging] = useState(false);
  const [secondFactor, setSecondFactor] = useState(false);

  // Changing your own password is offered only where policy allows it.
  useEffect(() => {
    api.password
      .selfService()
      .then((state) => setSelfService(state.enabled))
      .catch(() => setSelfService(false));
  }, []);

  // Sections that only manage what a role provides stay out of the way until
  // the role exists. Server Roles is where they are turned on.
  useEffect(() => {
    if (!holds(session, "role.read")) return;
    api.roles
      .list()
      .then((result) =>
        setInstalled(
          new Set(
            result.installed
              // Only a role that actually came up. A failed install left its
              // section in the sidebar, so the console offered to manage
              // printers on a machine where CUPS had never installed.
              .filter((instance) => instance.state === "active")
              .map((instance) => instance.role_name),
          ),
        ),
      )
      .catch(() => setInstalled(new Set()));
  }, [session]);

  function toggle() {
    setCollapsed((current) => {
      remember(!current);
      return !current;
    });
  }

  return (
    <div className="shell">
      <header className="topbar">
        <img src="/odm-logo-full.svg" alt="Open Directory Manager" className="topbar-logo" />
        <AccountMenu
          session={session}
          selfService={selfService}
          onChangePassword={() => setChanging(true)}
          onSecondFactor={() => setSecondFactor(true)}
          onSignOut={onSignOut}
        />
      </header>

      <div className="body">
        <nav className={collapsed ? "sidebar collapsed" : "sidebar"} aria-label="Sections">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand the navigation" : "Collapse the navigation"}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} aria-hidden="true" />
            )}
          </button>
          <ul>
            {NAV.filter(
              (item) =>
                (!item.domainAdmin || session.domain_admin) &&
                (!item.permission || holds(session, item.permission)) &&
                (!item.roles || item.roles.every((role) => installed.has(role))),
            ).map(({ label, to, icon: Icon, end }) => (
              <li key={label}>
                <NavLink
                  to={to}
                  end={end}
                  title={label}
                  className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <Outlet />
      </div>

      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
      {secondFactor && <SecondFactorDialog onClose={() => setSecondFactor(false)} />}
    </div>
  );
}

/** Two letters and a menu, instead of a row of buttons across the bar.
 *
 * Signing out, changing a password and enrolling a second factor are all
 * things done to one account, so they belong under that account rather than
 * spread across the width of the window competing with the product name. */
function AccountMenu({
  session,
  selfService,
  onChangePassword,
  onSecondFactor,
  onSignOut,
}: {
  session: SessionInfo;
  selfService: boolean;
  onChangePassword: () => void;
  onSecondFactor: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  // Anywhere else, and away: a menu that stays open behind what you clicked
  // next is a menu in the way.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="account" ref={holder}>
      <button
        type="button"
        className="avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${session.display_name}`}
        onClick={() => setOpen((current) => !current)}
      >
        {initials(session.display_name)}
      </button>

      {open && (
        <div className="account-menu" role="menu">
          <div className="account-who">
            <strong>{session.display_name}</strong>
            <span className="mono" title={session.distinguished_name}>
              {session.distinguished_name}
            </span>
            {!session.domain_admin && <span className="badge">delegated</span>}
          </div>
          {selfService && (
            <button type="button" role="menuitem" onClick={() => choose(onChangePassword)}>
              <KeyRound size={15} aria-hidden="true" />
              Change password
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => choose(onSecondFactor)}>
            <ShieldCheck size={15} aria-hidden="true" />
            Second factor
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onSignOut)}>
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** First letters of the first two words: "Ada Lovelace" is AL, and an account
 *  with one name is its first letter rather than a blank circle. */
function initials(name: string): string {
  const parts = (name || "?")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.slice(0, 2).map((part) => part[0]);
  return letters.join("").toUpperCase();
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <Modal
      title="Change your password"
      submitLabel={done ? "Close" : "Change it"}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        if (done) {
          onClose();
          return;
        }
        if (next !== again) {
          setError("the two new passwords do not match");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await api.password.change(current, next);
          setDone(true);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {done ? (
        <p>
          Changed. Anywhere you are signed in with the old password — a workstation, a mail client —
          will ask for the new one.
        </p>
      ) : (
        <>
          <Field
            label="Current password"
            hint="Asked for every time: a session is not proof you are still at the keyboard"
          >
            <input
              type="password"
              value={current}
              required
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <input
              type="password"
              value={next}
              required
              autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="New password again">
            <input
              type="password"
              value={again}
              required
              autoComplete="new-password"
              onChange={(e) => setAgain(e.target.value)}
            />
          </Field>
          <p className="muted">
            It has to satisfy the domain&rsquo;s password policy, which the directory enforces.
          </p>
        </>
      )}
    </Modal>
  );
}
