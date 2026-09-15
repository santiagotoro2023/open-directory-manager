import { useState, type ReactNode } from "react";

/**
 * A section that is folded away until somebody wants it.
 *
 * For the parts of a form most people never touch — item-level targeting is
 * the case in point: it sits on every policy object and on every entry, and
 * a full set of empty filter fields in plain view reads as something that
 * has to be filled in. Folded, with one line saying what it currently does,
 * it is there for the people who want it and out of the way for everyone
 * else. Opens itself when something is set, so a filter that is narrowing
 * a policy is never hidden from the person looking at that policy.
 */
export function Collapsible({
  title,
  summary,
  open: openWhenSet,
  children,
}: {
  title: string;
  /** One line describing the current state, shown beside the title while folded. */
  summary: string;
  /** Whether something is set inside: open on first render when true. */
  open?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(openWhenSet));
  return (
    <details
      className="collapsible"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="collapsible-title">{title}</span>
        {!open && <span className="collapsible-summary muted">{summary}</span>}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
