import {
  ClipboardList,
  Globe,
  LayoutDashboard,
  LogOut,
  Network,
  ScrollText,
  Server,
  Users,
} from "lucide-react";
import type { SessionInfo } from "./api";

// Sections land as their phases ship (CLAUDE.md §7). Listing them keeps the
// navigation stable instead of rearranging itself under the operator.
const NAV = [
  { label: "Overview", icon: LayoutDashboard, ready: true },
  { label: "Directory", icon: Users, ready: false },
  { label: "Group Policy", icon: ClipboardList, ready: false },
  { label: "DNS", icon: Globe, ready: false },
  { label: "DHCP", icon: Network, ready: false },
  { label: "Server Roles", icon: Server, ready: false },
  { label: "Audit Log", icon: ScrollText, ready: false },
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
            {NAV.map(({ label, icon: Icon, ready }) => (
              <li key={label}>
                <a
                  href="#"
                  className={ready ? "nav-item active" : "nav-item disabled"}
                  aria-current={ready ? "page" : undefined}
                  aria-disabled={ready ? undefined : true}
                  onClick={(e) => e.preventDefault()}
                >
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="content">
          <h1>Overview</h1>
          <table className="data">
            <caption className="sr-only">Current session</caption>
            <tbody>
              <tr>
                <th scope="row">Signed in as</th>
                <td>{session.principal}</td>
              </tr>
              <tr>
                <th scope="row">Distinguished name</th>
                <td className="mono">{session.distinguished_name}</td>
              </tr>
              <tr>
                <th scope="row">Session expires</th>
                <td>{new Date(session.expires_at).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </main>
      </div>
    </div>
  );
}
