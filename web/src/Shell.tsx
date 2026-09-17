import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  BookOpen,
  ClipboardList,
  Globe,
  KeyRound,
  Lock,
  LayoutDashboard,
  LogOut,
  MonitorSmartphone,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  Router,
  Database,
  FolderOpen,
  Gauge,
  HardDriveDownload,
  Activity as ActivityIcon,
  ChevronDown,
  ScrollText,
  Server,
  ShieldCheck,
  ShieldHalf,
  Trash2,
  Users,
} from "lucide-react";
import { api, holds, type SessionInfo } from "./api";
import { WATCH, useLive } from "./live";
import { SecondFactorDialog } from "./components/SecondFactor";

// `permission` is what the section needs; `domainAdmin` marks a section only
// members of the domain administrators group ever see; `roles` names the server
// roles that must all be installed somewhere before the section has anything
// to show — network boot needs a boot server and a DHCP server to advertise it.
const NAV = [
  { label: "Overview", to: "/", icon: LayoutDashboard, end: true },
  { label: "Directory", group: "Domain", to: "/directory", icon: Users, permission: "directory.read" },
  { label: "Group Policy", group: "Domain", to: "/policy", icon: ClipboardList, permission: "gpo.read" },
  { label: "DNS", group: "Network", to: "/dns", icon: Globe, permission: "dns.read" },
  {
    label: "DHCP",
    group: "Network",
    to: "/dhcp",
    icon: Network,
    permission: "dhcp.read",
    roles: ["dhcp"],
  },
  {
    label: "File Shares",
    group: "Services",
    to: "/shares",
    icon: FolderOpen,
    permission: "share.read",
    roles: ["file-server"],
  },
  {
    label: "Printers",
    group: "Services",
    to: "/printers",
    icon: Printer,
    permission: "printer.read",
    roles: ["print-server"],
  },
  {
    label: "Remote Desktop",
    group: "Services",
    to: "/remote-desktop",
    icon: MonitorSmartphone,
    permission: "rd.read",
    // The broker is what people connect to; without one there is nothing to
    // configure and nothing to hand out.
    roles: ["remote-desktop-broker"],
  },
  {
    label: "Remote Access",
    group: "Network",
    to: "/vpn",
    icon: ShieldHalf,
    permission: "vpn.read",
    roles: ["vpn"],
  },
  {
    label: "Network Access",
    group: "Network",
    to: "/network-access",
    icon: Router,
    permission: "radius.read",
    roles: ["radius"],
  },
  {
    label: "Certificates",
    group: "Services",
    to: "/certificates",
    icon: KeyRound,
    permission: "ca.read",
    roles: ["certificate-authority"],
  },
  {
    label: "Passwords",
    group: "Services",
    to: "/passwords",
    icon: Lock,
    permission: "passwords.read",
    roles: ["password-manager"],
  },
  {
    label: "Client Enrolment",
    group: "Network",
    to: "/enrolment",
    icon: HardDriveDownload,
    // Network boot is advertised through DHCP: without a DHCP server there is
    // nothing to attach a deployment to.
    permission: "role.read",
    roles: ["pxe", "dhcp"],
  },
  {
    label: "Domain Controllers",
    group: "Servers",
    to: "/controllers",
    icon: Database,
    permission: "dc.read",
  },
  { label: "Server Roles", group: "Servers", to: "/roles", icon: Server, permission: "role.read" },
  { label: "Delegation", group: "Security", to: "/delegation", icon: ShieldCheck, domainAdmin: true },
  { label: "Deleted Objects", group: "Domain", to: "/recyclebin", icon: Trash2, permission: "recyclebin.read" },
  {
    label: "Monitoring",
    group: "Servers",
    to: "/monitor",
    icon: Gauge,
    permission: "monitor.read",
    roles: ["monitoring"],
  },
  { label: "Activity", group: "Security", to: "/activity", icon: ActivityIcon, permission: "audit.read" },
  { label: "Audit Log", group: "Security", to: "/audit", icon: ScrollText, permission: "audit.read" },
  { label: "Wiki", to: "/wiki", icon: BookOpen, group: "Help" },
];

const GROUP_ORDER = ["Domain", "Network", "Services", "Servers", "Security", "Help"];

function groupRank(item: { group?: string; to: string }): number {
  // Overview stands first, outside any group.
  if (!item.group) return -1;
  return GROUP_ORDER.indexOf(item.group);
}

function recallFolded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("odm.sidebar.folded") ?? "{}");
  } catch {
    return {};
  }
}

function rememberFolded(folded: Record<string, boolean>) {
  try {
    localStorage.setItem("odm.sidebar.folded", JSON.stringify(folded));
  } catch {
    /* nothing to do */
  }
}

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
  const [readRoles, setReadRoles] = useState<() => void>(() => () => {});
  const [secondFactor, setSecondFactor] = useState(false);

  // Sections that only manage what a role provides stay out of the way until
  // the role exists. Server Roles is where they are turned on.
  const location = useLocation();
  useEffect(() => {
    if (!holds(session, "role.read")) return;
    const read = () =>
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
    void read();
    setReadRoles(() => read);
    // A slow fallback behind the live stream: a console whose stream is
    // blocked by something in the middle still catches up.
    const timer = setInterval(() => void read(), 120_000);
    return () => clearInterval(timer);
  }, [session, location.pathname]);

  // And the moment a role finishes installing, wherever it was installed
  // from, so the section it provides appears without a reload.
  useLive(WATCH.roles, () => readRoles());

  // In group order, whatever order the entries were written in, so a group's
  // heading appears once with everything in it beneath.
  const visible = NAV.filter(
    (item) =>
      (!item.domainAdmin || session.domain_admin) &&
      (!item.permission || holds(session, item.permission)) &&
      (!item.roles || item.roles.every((role) => installed.has(role))),
  ).sort((a, b) => groupRank(a) - groupRank(b));

  // Which groups are folded is furniture, not domain state: kept in the
  // browser, and a folded group still shows the page you are on.
  const [folded, setFolded] = useState<Record<string, boolean>>(recallFolded);
  function fold(group: string) {
    setFolded((was) => {
      const next = { ...was, [group]: !was[group] };
      rememberFolded(next);
      return next;
    });
  }

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
            {visible.map(({ label, to, icon: Icon, end, group }, index) => {
              const active = end ? location.pathname === to : location.pathname.startsWith(to);
              const hidden = Boolean(group && folded[group] && !collapsed && !active);
              return (
                <li key={label}>
                  {group && group !== visible[index - 1]?.group && (
                    // The sections are grouped the way an operator thinks
                    // of the domain: what is in it, the network it runs on,
                    // what it serves, the servers, and who did what. Each
                    // heading folds its group; collapsed to icons, a rule
                    // stands in for the heading.
                    <button
                      type="button"
                      className={folded[group] ? "nav-group folded" : "nav-group"}
                      onClick={() => fold(group)}
                      aria-expanded={!folded[group]}
                      tabIndex={collapsed ? -1 : 0}
                    >
                      <span>{group}</span>
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  )}
                  {!hidden && (
                    <NavLink
                      to={to}
                      end={end}
                      title={label}
                      className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{label}</span>
                    </NavLink>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <Outlet />
      </div>

      {secondFactor && <SecondFactorDialog onClose={() => setSecondFactor(false)} />}
    </div>
  );
}

/** Two letters and a menu, instead of a row of buttons across the bar.
 *
 * Signing out and enrolling a second factor are both things done to one
 * account, so they belong under that account rather than spread across the
 * width of the window competing with the product name. */
function AccountMenu({
  session,
  onSecondFactor,
  onSignOut,
}: {
  session: SessionInfo;
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
