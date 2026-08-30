import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { ApiError, api, type AdmxElement, type AdmxPolicy, type AdmxSelection } from "../api";
import { Field, Modal } from "./Modal";

/**
 * Administrative templates (CLAUDE.md §3.6): the controls below are rendered
 * from the vendor's own ADMX schema, not hand-written per setting.
 */
export function AdmxEditor({
  selections,
  onChange,
}: {
  selections: AdmxSelection[];
  onChange: (next: AdmxSelection[]) => void;
}) {
  const [known, setKnown] = useState<Record<string, AdmxPolicy>>({});
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Definitions for whatever is already configured, so the rows can render
  // their real labels and controls rather than raw identifiers.
  useEffect(() => {
    if (selections.length === 0) return;
    api.admx
      .policies({ applicable_only: false })
      .then((result) =>
        setKnown(Object.fromEntries(result.policies.map((policy) => [policy.id, policy]))),
      )
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [selections.length]);

  function update(index: number, next: AdmxSelection) {
    onChange(selections.map((selection, i) => (i === index ? next : selection)));
  }

  return (
    <section>
      <header>
        <h3>Administrative templates</h3>
        <button type="button" className="ghost" onClick={() => setPicking(true)}>
          <Plus size={14} aria-hidden="true" />
          Add setting
        </button>
      </header>
      <p className="muted">
        Imported ADMX definitions. Settings with no Debian equivalent can still be configured, and
        are reported as unsupported in Resultant Set of Policy.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {selections.length === 0 && <p className="muted">Nothing configured from a template.</p>}

      {selections.map((selection, index) => {
        const policy = known[selection.policy_id];
        return (
          <div className="admx-row" key={`${selection.policy_id}-${index}`}>
            <div className="admx-head">
              <div>
                <strong>{policy?.display_name ?? selection.policy_id}</strong>
                <p className="mono muted">{selection.policy_id}</p>
              </div>
              <select
                aria-label={`State of ${policy?.display_name ?? selection.policy_id}`}
                value={selection.state}
                onChange={(e) =>
                  update(index, { ...selection, state: e.target.value as "enabled" | "disabled" })
                }
              >
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${policy?.display_name ?? selection.policy_id}`}
                onClick={() => onChange(selections.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>

            {policy?.explain_text && <p className="muted">{policy.explain_text}</p>}

            {selection.state === "enabled" &&
              (policy?.elements ?? []).map((element) => (
                <ElementControl
                  key={element.id}
                  element={element}
                  value={selection.values?.[element.id]}
                  onChange={(value) =>
                    update(index, {
                      ...selection,
                      values: { ...(selection.values ?? {}), [element.id]: value },
                    })
                  }
                />
              ))}
          </div>
        );
      })}

      {picking && (
        <PolicyPicker
          chosen={new Set(selections.map((s) => s.policy_id))}
          onClose={() => setPicking(false)}
          onPick={(policy) => {
            setKnown({ ...known, [policy.id]: policy });
            onChange([...selections, { policy_id: policy.id, state: "enabled", values: {} }]);
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}

function ElementControl({
  element,
  value,
  onChange,
}: {
  element: AdmxElement;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = element.label || element.id;

  if (element.type === "boolean") {
    return (
      <label className="checkbox">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (element.type === "enum") {
    return (
      <Field label={label}>
        <select
          value={String(value ?? "")}
          onChange={(e) => {
            const item = element.items.find((option) => String(option.value) === e.target.value);
            onChange(item ? item.value : e.target.value);
          }}
        >
          <option value="">Not set</option>
          {element.items.map((item) => (
            <option key={String(item.value)} value={String(item.value)}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (element.type === "list") {
    const lines = Array.isArray(value) ? (value as unknown[]).join("\n") : String(value ?? "");
    return (
      <Field label={label} hint="One entry per line">
        <textarea
          rows={4}
          className="mono"
          value={lines}
          onChange={(e) =>
            onChange(
              e.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
    );
  }

  if (element.type === "multiText") {
    return (
      <Field label={label}>
        <textarea rows={3} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }

  if (element.type === "decimal") {
    return (
      <Field
        label={label}
        hint={
          element.minimum !== null || element.maximum !== null
            ? `Between ${element.minimum ?? 0} and ${element.maximum ?? "∞"}`
            : undefined
        }
      >
        <input
          type="number"
          min={element.minimum ?? undefined}
          max={element.maximum ?? undefined}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      </Field>
    );
  }

  return (
    <Field label={label}>
      <input
        maxLength={element.max_length ?? undefined}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function PolicyPicker({
  chosen,
  onClose,
  onPick,
}: {
  chosen: Set<string>;
  onClose: () => void;
  onPick: (policy: AdmxPolicy) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<{ name: string; display_name: string }[]>([]);
  const [policies, setPolicies] = useState<AdmxPolicy[]>([]);
  const [applicableOnly, setApplicableOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.admx
      .categories()
      .then((result) => setCategories(result.categories))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.admx
        .policies({ query, category: category || undefined, applicable_only: applicableOnly })
        .then((result) => setPolicies(result.policies))
        .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, category, applicableOnly]);

  const grouped = useMemo(() => {
    const labels = new Map(categories.map((c) => [c.name, c.display_name]));
    return policies.map((policy) => ({
      policy,
      categoryLabel: labels.get(policy.category) ?? policy.category,
    }));
  }, [policies, categories]);

  return (
    <Modal
      title="Add a setting from an administrative template"
      submitLabel="Done"
      error={error}
      onClose={onClose}
      onSubmit={onClose}
    >
      <div className="toolbar">
        <div className="search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search template settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((item) => (
            <option key={item.name} value={item.name}>
              {item.display_name}
            </option>
          ))}
        </select>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={applicableOnly}
          onChange={(e) => setApplicableOnly(e.target.checked)}
        />
        Only settings ODM can apply on Debian
      </label>

      {policies.length === 0 && (
        <p className="muted">
          No matching settings. Import a vendor ADMX and ADML pair under Administrative Templates
          first.
        </p>
      )}

      <table className="data compact">
        <tbody>
          {grouped.map(({ policy, categoryLabel }) => (
            <tr key={policy.id}>
              <td>
                <strong>{policy.display_name}</strong>
                <p className="muted">{categoryLabel}</p>
              </td>
              <td>{policy.applicable ? "" : <span className="badge">Windows only</span>}</td>
              <td style={{ width: "90px" }}>
                <button
                  type="button"
                  className="ghost"
                  disabled={chosen.has(policy.id)}
                  onClick={() => onPick(policy)}
                >
                  {chosen.has(policy.id) ? "Added" : "Add"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
