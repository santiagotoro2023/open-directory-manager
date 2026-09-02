import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { ApiError, api, type ComputerDetail } from "../api";
import { Loading } from "./Loading";
import { Field, Modal } from "./Modal";
import { PickerField } from "./Picker";

/**
 * Accounts that exist on one machine rather than in the directory.
 *
 * The directory pickers search the domain, and a local account is not in it:
 * it is on a machine, reported by that machine's agent. So the machine is
 * chosen first and its accounts are listed — which is also the only way to
 * know the name is one that exists.
 */
export function LocalAccountList({
  values,
  onChange,
  addLabel,
  emptyLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  emptyLabel: string;
}) {
  const [picking, setPicking] = useState(false);

  return (
    <div className="choice-list">
      {values.length === 0 ? (
        <p className="empty">{emptyLabel}</p>
      ) : (
        <ul>
          {values.map((value) => (
            <li key={value}>
              <span className="mono truncate">{value}</span>
              <span className="mono dn truncate">on the machines this policy reaches</span>
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${value}`}
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
      {picking && (
        <LocalAccountDialog
          onClose={() => setPicking(false)}
          onPick={(account) => {
            setPicking(false);
            if (!values.includes(account)) onChange([...values, account]);
          }}
        />
      )}
    </div>
  );
}

export function LocalAccountDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (account: string) => void;
}) {
  const [machine, setMachine] = useState("");
  const [detail, setDetail] = useState<ComputerDetail | null>(null);
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!machine) {
      setDetail(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    api.servers
      .computer(machine)
      .then((result) => current && setDetail(result))
      .catch((err) => current && setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [machine]);

  return (
    <Modal
      title="Local account"
      submitLabel="Use this name"
      error={error}
      onClose={onClose}
      onSubmit={() => typed.trim() && onPick(typed.trim())}
    >
      <Field
        label="Machine"
        hint="Whose accounts to list. The name chosen applies wherever this policy reaches."
      >
        <PickerField
          kind="computer"
          as="dn"
          ariaLabel="Machine"
          value={machine}
          placeholder="CN=WS-01,OU=Workstations,…"
          onChange={setMachine}
        />
      </Field>

      {loading && <Loading label="Reading its accounts…" />}

      {detail && (
        <ul className="picker">
          {(detail.facts?.local_users ?? []).map((user) => (
            <li key={user.name}>
              <button type="button" onClick={() => onPick(user.name)}>
                {user.name}
                <span className="secondary">
                  uid {user.uid} · {user.shell}
                </span>
              </button>
            </li>
          ))}
          {(detail.facts?.local_users ?? []).length === 0 && (
            <li className="empty">No local accounts outside the system range.</li>
          )}
        </ul>
      )}

      <Field label="Or type the account name" hint="For a machine that has not reported yet">
        <input value={typed} onChange={(event) => setTyped(event.target.value)} />
      </Field>
    </Modal>
  );
}
