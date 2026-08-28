import { NavLink, Outlet } from "react-router-dom";
import {
  ClipboardList,
  Globe,
  LayoutDashboard,
  LogOut,
  Network,
  Activity,
  KeyRound,
  ScrollText,
  Server,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { holds, type SessionInfo } from "./api";

// `permission` is what the section needs; `domainAdmin` marks a section only
// members of the domain administrators group ever see.
const NAV = [
  { label: "Overview", to: "/", icon: LayoutDashboard, end: true },
  { label: "Directory", to: "/directory", icon: Users, permission: "directory.read" },
  { label: "Group Policy", to: "/policy", icon: ClipboardList, permission: "gpo.read" },
  { label: "DNS", to: "/dns", icon: Globe, permission: "dns.read" },
  { label: "DHCP", to: "/dhcp", icon: Network, permission: "dhcp.read" },
  { label: "Certificates", to: "/certificates", icon: KeyRound, permission: "ca.read" },
  { label: "Server Roles", to: "/roles", icon: Server, permission: "role.read" },
  { label: "Delegation", to: "/delegation", icon: ShieldCheck, domainAdmin: true },
  { label: "Operations", to: "/operations", icon: Activity, permission: "health.read" },
  { label: "Deleted Objects", to: "/recyclebin", icon: Trash2, permission: "recyclebin.read" },
  { label: "Audit Log", to: "/audit", icon: ScrollText, permission: "audit.read" },
];

export function Shell({
  session,
  onSignOut,
}: {
  session: SessionInfo;
  onSignOut: () => void;
}) {
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
        <nav className="sidebar" aria-label="Sections">
          <ul>
            {NAV.filter(
              (item) =>
                (!item.domainAdmin || session.domain_admin) &&
                (!item.permission || holds(session, item.permission)),
            ).map(({ label, to, icon: Icon, end }) => (
              <li key={label}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                >
                  <Icon size={16} aria-hidden="true" />
                  {label}
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
