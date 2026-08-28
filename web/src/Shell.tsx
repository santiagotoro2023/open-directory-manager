import { NavLink, Outlet } from "react-router-dom";
import {
  ClipboardList,
  Globe,
  LayoutDashboard,
  LogOut,
  Network,
  ScrollText,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import type { SessionInfo } from "./api";

// Sections land as their phases ship (CLAUDE.md §7). Listing them keeps the
// navigation stable instead of rearranging itself under the operator.
const NAV = [
  { label: "Overview", to: "/", icon: LayoutDashboard, ready: true, end: true },
  { label: "Directory", to: "/directory", icon: Users, ready: true },
  { label: "Group Policy", to: "/policy", icon: ClipboardList, ready: true },
  { label: "DNS", to: "/dns", icon: Globe, ready: true },
  { label: "DHCP", to: "/dhcp", icon: Network, ready: true },
  { label: "Server Roles", to: "/roles", icon: Server, ready: true },
  { label: "Deleted Objects", to: "/recyclebin", icon: Trash2, ready: true },
  { label: "Audit Log", to: "/audit", icon: ScrollText, ready: true },
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
            {NAV.map(({ label, to, icon: Icon, ready, end }) => (
              <li key={label}>
                {ready ? (
                  <NavLink
                    to={to}
                    end={end}
                    className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {label}
                  </NavLink>
                ) : (
                  <span className="nav-item disabled" aria-disabled="true">
                    <Icon size={16} aria-hidden="true" />
                    {label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <Outlet />
      </div>
    </div>
  );
}
