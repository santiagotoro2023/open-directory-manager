import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, type ActivityEntry, type ActivityQuery } from "../api";
import Select from "./Select";

/**
 * What people did on the machines, as one table wherever it is asked for:
 * across the whole domain (Activity), for one machine (a computer's
 * Activity tab) or for one person (a user's).
 *
 * The rows are what each machine's agent read from its own journal — a
 * sign-in, a sudo command, a switch to root, a phone approval, a password
 * change, a USB stick — plus the console's own terminal sessions. The
 * filters are the questions worth asking of them: who, where, what kind,
 * how far back, and a word that has to appear.
 */

// How each kind reads, and which ones are worth a second look.
const KINDS: Record<string, { label: string; tone?: "bad" | "good" }> = {
  "sign-in": { label: "Signed in" },
  "sign-out": { label: "Signed out" },
  "sign-in-failed": { label: "Sign-in failed", tone: "bad" },
  logon: { label: "Signed in" },
  logoff: { label: "Signed out" },
  sudo: { label: "sudo" },
  "sudo-denied": { label: "sudo refused", tone: "bad" },
  su: { label: "Became another user" },
  "su-denied": { label: "su refused", tone: "bad" },
  "console-shell": { label: "Console terminal" },
  "second-factor-approved": { label: "Phone approved", tone: "good" },
  "second-factor-denied": { label: "Phone refused", tone: "bad" },
  "second-factor-timeout": { label: "Phone did not answer", tone: "bad" },
  "second-factor-enrolled": { label: "Second factor set up" },
  "second-factor-removed": { label: "Second factor removed" },
  "password-changed": { label: "Password changed" },
  "local-user-added": { label: "Local account added" },
  "local-user-removed": { label: "Local account removed" },
  "group-changed": { label: "Group membership changed" },
  "usb-connected": { label: "USB device connected" },
  "usb-disconnected": { label: "USB device removed" },
  boot: { label: "Booted" },
  shutdown: { label: "Shut down" },
  update: { label: "Updated" },
};

const FAMILIES: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "sign-ins", label: "Sign-ins" },
  { value: "privilege", label: "sudo, su and terminals" },
  { value: "second-factor", label: "Second factor" },
  { value: "accounts", label: "Accounts and passwords" },
  { value: "devices", label: "USB devices" },
  { value: "power", label: "Boots and shutdowns" },
];

const SERVICES = ["", "login", "ssh", "sudo", "su", "remote-desktop", "console"];

const SINCE: { value: string; label: string; hours: number }[] = [
  { value: "24", label: "Last 24 hours", hours: 24 },
  { value: "168", label: "Last 7 days", hours: 168 },
  { value: "720", label: "Last 30 days", hours: 720 },
  { value: "", label: "All time", hours: 0 },
];

const PAGE = 100;

export function describeKind(kind: string): string {
  return KINDS[kind]?.label ?? kind;
}

export function kindTone(kind: string): string {
  const tone = KINDS[kind]?.tone;
  return tone === "bad" ? "badge failure" : tone === "good" ? "badge success" : "badge";
}

export function ActivityTable({
  dn,
  principal,
  compact = false,
}: {
  /** Fixed to one machine. */
  dn?: string;
  /** Fixed to one person. */
  principal?: string;
  /** Fewer controls, for a tab inside an object rather than a page. */
  compact?: boolean;
}) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filters, setFilters] = useState({
    hostname: "",
    principal: "",
    kind: "",
    service: "",
    since: compact ? "" : "168",
    q: "",
  });
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = useCallback(
    (from: number): ActivityQuery => {
      const hours = SINCE.find((option) => option.value === filters.since)?.hours ?? 0;
      return {
        dn,
        principal: principal ?? (filters.principal || undefined),
        hostname: dn ? undefined : filters.hostname || undefined,
        kind: filters.kind || undefined,
        service: filters.service || undefined,
        since: hours ? new Date(Date.now() - hours * 3_600_000).toISOString() : undefined,
        q: filters.q || undefined,
        limit: PAGE,
        offset: from,
      };
    },
    [dn, principal, filters],
  );

  const load = useCallback(
    async (from: number) => {
      setError(null);
      setLoading(true);
      try {
        const result = await api.activity.list(query(from));
        setEntries((was) => (from === 0 ? result.entries : [...was, ...result.entries]));
        setMore(result.entries.length === PAGE);
        setOffset(from + result.entries.length);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(0), 200);
    return () => clearTimeout(timer);
  }, [load]);

  const set = (key: keyof typeof filters) => (value: string) =>
    setFilters((was) => ({ ...was, [key]: value }));

  return (
    <>
      <div className="toolbar">
        {!dn && (
          <input
            aria-label="Filter by machine"
            placeholder="Machine"
            value={filters.hostname}
            onChange={(e) => set("hostname")(e.target.value)}
          />
        )}
        {!principal && (
          <input
            aria-label="Filter by person"
            placeholder="Person"
            value={filters.principal}
            onChange={(e) => set("principal")(e.target.value)}
          />
        )}
        <Select
          aria-label="Filter by kind"
          value={filters.kind}
          onChange={(e) => set("kind")(e.target.value)}
        >
          {FAMILIES.map((family) => (
            <option key={family.value} value={family.value}>
              {family.label}
            </option>
          ))}
          <optgroup label="One kind">
            {Object.entries(KINDS).map(([kind, meta]) => (
              <option key={kind} value={kind}>
                {meta.label}
              </option>
            ))}
          </optgroup>
        </Select>
        {!compact && (
          <Select
            aria-label="Filter by way in"
            value={filters.service}
            onChange={(e) => set("service")(e.target.value)}
          >
            {SERVICES.map((service) => (
              <option key={service} value={service}>
                {service === "" ? "Any way in" : service}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="How far back"
          value={filters.since}
          onChange={(e) => set("since")(e.target.value)}
        >
          {SINCE.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <input
          aria-label="Search the detail"
          className="search"
          placeholder="Command, address, device…"
          value={filters.q}
          onChange={(e) => set("q")(e.target.value)}
        />
        <span className="spacer" />
        <a className="button-link" href={api.activity.exportUrl({ ...query(0), limit: undefined, offset: undefined })} download>
          Export CSV
        </a>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data activity">
        <thead>
          <tr>
            <th scope="col">When</th>
            {!dn && <th scope="col">Machine</th>}
            <th scope="col">What</th>
            {!principal && <th scope="col">Who</th>}
            <th scope="col">Way in</th>
            <th scope="col">From</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="nowrap">{new Date(entry.occurred_at).toLocaleString()}</td>
              {!dn && (
                <td>
                  <Link to={`/directory/object?dn=${encodeURIComponent(entry.computer_dn)}&tab=activity`}>
                    {entry.hostname.split(".")[0]}
                  </Link>
                </td>
              )}
              <td>
                <span className={kindTone(entry.kind)} title={entry.kind}>
                  {describeKind(entry.kind)}
                </span>
              </td>
              {!principal && <td>{entry.principal || "—"}</td>}
              <td>{entry.service || "—"}</td>
              <td className="mono">{entry.source || "—"}</td>
              <td className="mono detail">{entry.detail}</td>
            </tr>
          ))}
          {entries.length === 0 && !loading && (
            <tr>
              <td colSpan={7} className="empty">
                Nothing recorded for this.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {more && (
        <p>
          <button type="button" className="secondary" disabled={loading} onClick={() => void load(offset)}>
            {loading ? "Loading…" : "Show more"}
          </button>
        </p>
      )}
    </>
  );
}
