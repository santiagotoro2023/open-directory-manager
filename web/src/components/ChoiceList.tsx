import { useState } from "react";
import { Plus, X } from "lucide-react";
import { PickerDialog } from "./Picker";
import type { DirectoryObject } from "../api";

/** The Debian releases ODM supports (CLAUDE.md §2). Free text here meant a
 *  typo produced a targeting rule that silently matched nothing. */
export const SUPPORTED_RELEASES = [
  { value: "debian-13", label: "Debian 13 (trixie)" },
  { value: "debian-12", label: "Debian 12 (bookworm)" },
];

/**
 * A set of directory objects, chosen rather than typed.
 *
 * These were textareas of one distinguished name per line, which meant an
 * operator had to know that a newline was the separator, could not tell
 * whether picking a second group had added or replaced the first, and could
 * misspell a DN into a rule that silently matched nothing.
 */
export function ChoiceList({
  kind,
  values,
  onChange,
  addLabel,
  emptyLabel,
}: {
  kind: "group" | "principal" | "user" | "computer";
  values: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  emptyLabel: string;
}) {
  const [picking, setPicking] = useState(false);

  function add(object: DirectoryObject) {
    setPicking(false);
    const dn = object.distinguishedName;
    if (!values.includes(dn)) onChange([...values, dn]);
  }

  return (
    <div className="choice-list">
      {values.length === 0 ? (
        <p className="empty">{emptyLabel}</p>
      ) : (
        <ul>
          {values.map((value) => (
            <li key={value}>
              <span className="mono truncate" title={value}>
                {name(value)}
              </span>
              <span className="mono dn truncate" title={value}>
                {value}
              </span>
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${name(value)}`}
                onClick={() => onChange(values.filter((entry) => entry !== value))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ghost" onClick={() => setPicking(true)}>
        <Plus size={15} aria-hidden="true" />
        {addLabel}
      </button>
      {picking && <PickerDialog kind={kind} onClose={() => setPicking(false)} onPick={add} />}
    </div>
  );
}

/** The readable half of a distinguished name: "CN=Helpdesk,..." is Helpdesk. */
function name(dn: string): string {
  const first = dn.split(",")[0] ?? dn;
  return first.includes("=") ? first.slice(first.indexOf("=") + 1) : first;
}
