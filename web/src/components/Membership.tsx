import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Computer, Folder, Users, User } from "lucide-react";
import { Link } from "react-router-dom";
import { ApiError, api, type Membership, type MembershipEntry } from "../api";
import { Loading } from "./Loading";

const ICONS = { user: User, group: Users, computer: Computer, ou: Folder };

/**
 * Membership, both ways round, for every kind of object.
 *
 * A group's members answer half the question. The other half — what the group
 * is itself a member of — is what decides whether a rule written against one
 * group reaches an account nobody put in it, and it was not shown anywhere: a
 * user's memberOf listed the groups they were put in and stopped there, so a
 * sudo rule two levels up was invisible from every page an operator would
 * think to look at.
 *
 * Nesting is walked one step at a time, in whichever direction the table is
 * about, so "and what is that a member of?" is a chevron rather than five
 * separate pages.
 */
export function MembershipTable({
  dn,
  direction,
  onCount,
}: {
  dn: string;
  /** "up" lists what this belongs to; "down" lists what belongs to it. */
  direction: "up" | "down";
  onCount?: (count: number) => void;
}) {
  const [state, setState] = useState<Membership | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    api.directory
      .membership(dn)
      .then((result) => {
        if (!live) return;
        setState(result);
        onCount?.(direction === "up" ? result.member_of.length : result.members.length);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
    // onCount is a render-time callback; the request depends on the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dn, direction]);

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!state) return <Loading label="Reading membership…" />;

  const rows = direction === "up" ? state.member_of : state.members;
  const inherited = direction === "up" ? rows.filter((row) => row.direct === false) : [];
  const own = direction === "up" ? rows.filter((row) => row.direct !== false) : rows;

  return (
    <>
      {direction === "up" && inherited.length > 0 && (
        <p className="stat-note">
          {own.length} direct, {inherited.length} through nesting
        </p>
      )}
      {direction === "down" && state.members_truncated && (
        <p className="stat-note">The first {rows.length}; the group has more.</p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">{direction === "up" ? "Group" : "Member"}</th>
            <th scope="col">Type</th>
            <th scope="col">Description</th>
            <th scope="col">How</th>
          </tr>
        </thead>
        <tbody>
          {own.map((entry) => (
            <Row key={entry.dn} entry={entry} direction={direction} depth={0} seen={[dn]} />
          ))}
          {inherited.map((entry) => (
            <Row key={entry.dn} entry={entry} direction={direction} depth={0} seen={[dn]} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                {direction === "up" ? "In no groups." : "No members."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

/** One row, and — for a group — the level below or above it on request. */
function Row({
  entry,
  direction,
  depth,
  seen,
}: {
  entry: MembershipEntry;
  direction: "up" | "down";
  depth: number;
  /** The chain that led here, so a group nested in itself cannot loop. */
  seen: string[];
}) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState<MembershipEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const Icon = ICONS[entry.objectType as keyof typeof ICONS] ?? Folder;
  // Only a group has anything on the other side of it.
  const expandable =
    entry.objectType === "group" && !seen.some((dn) => dn.toLowerCase() === entry.dn.toLowerCase());

  const expand = useCallback(async () => {
    setOpen((was) => !was);
    if (nested !== null) return;
    try {
      const result = await api.directory.membership(entry.dn);
      setNested(direction === "up" ? result.member_of : result.members);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setNested([]);
    }
  }, [direction, entry.dn, nested]);

  return (
    <>
      <tr>
        <td style={{ paddingLeft: depth ? 12 + depth * 18 : undefined }}>
          {expandable ? (
            <button
              type="button"
              className="icon"
              aria-label={open ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
              aria-expanded={open}
              onClick={() => void expand()}
            >
              {open ? (
                <ChevronDown size={14} aria-hidden="true" />
              ) : (
                <ChevronRight size={14} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="chevron-space" aria-hidden="true" />
          )}
          <Icon size={15} aria-hidden="true" />
          <Link to={`/directory/object?dn=${encodeURIComponent(entry.dn)}`}>{entry.name}</Link>
          <p className="mono dn">{entry.dn}</p>
        </td>
        <td>
          {entry.objectType === "group"
            ? entry.scope
              ? `Group · ${entry.scope}`
              : "Group"
            : entry.objectType === "ou"
              ? "Organizational unit"
              : entry.objectType === "computer"
                ? "Computer"
                : "User"}
        </td>
        <td>{entry.description || "—"}</td>
        <td>
          {direction === "up" && entry.direct === false ? (
            <span className="badge">nested</span>
          ) : (
            "direct"
          )}
        </td>
      </tr>

      {open && nested === null && (
        <tr>
          <td colSpan={4}>
            <Loading label={direction === "up" ? "Reading its groups…" : "Reading its members…"} />
          </td>
        </tr>
      )}
      {open &&
        (nested ?? []).map((child) => (
          <Row
            key={`${entry.dn}/${child.dn}`}
            entry={child}
            direction={direction}
            depth={depth + 1}
            seen={[...seen, entry.dn]}
          />
        ))}
      {open && nested !== null && nested.length === 0 && (
        <tr>
          <td colSpan={4} className="empty">
            {error ?? (direction === "up" ? "In no groups." : "No members.")}
          </td>
        </tr>
      )}
    </>
  );
}
