import { useEffect, useState } from "react";
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

export function Shell({
  session,
  onSignOut,
}: {
  session: SessionInfo;
  onSignOut: () => void;
}) {
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
              .filter((instance) => instance.state !== "removed")
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
        <img src="/odm-logo-compact.svg" alt="Open Directory Manager" className="topbar-logo" />
        <div className="topbar-right">
          <span className="principal" title={session.distinguished_name}>
            {session.display_name}
            {!session.domain_admin && <span className="badge">delegated</span>}
          </span>
          <button type="button" className="ghost" onClick={() => setSecondFactor(true)}>
            <ShieldCheck size={16} aria-hidden="true" />
            Second factor
          </button>
          {selfService && (
            <button type="button" className="ghost" onClick={() => setChanging(true)}>
              <KeyRound size={16} aria-hidden="true" />
              Change password
            </button>
          )}
          <button type="button" className="ghost" onClick={onSignOut}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
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
          Changed. Anywhere you are signed in with the old password — a workstation, a mail
          client — will ask for the new one.
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
