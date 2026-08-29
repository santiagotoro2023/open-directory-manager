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
  FolderOpen,
  HardDriveDownload,
  ScrollText,
  Server,
  ServerCog,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { api, holds, type SessionInfo } from "./api";

// `permission` is what the section needs; `domainAdmin` marks a section only
// members of the domain administrators group ever see; `role` marks a section
// that manages something a server role provides, and so has nothing to show
// until that role is installed somewhere.
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
    role: "dhcp",
  },
  {
    label: "File Shares",
    to: "/shares",
    icon: FolderOpen,
    permission: "share.read",
    role: "file-server",
  },
  {
    label: "Certificates",
    to: "/certificates",
    icon: KeyRound,
    permission: "ca.read",
    role: "certificate-authority",
  },
  {
    label: "Client Enrolment",
    to: "/enrolment",
    icon: HardDriveDownload,
    permission: "role.read",
    role: "pxe",
  },
  { label: "Servers", to: "/servers", icon: ServerCog, permission: "server.read" },
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
                (!item.role || installed.has(item.role)),
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
    </div>
  );
}
