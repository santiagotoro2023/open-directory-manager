import { useState } from "react";
import { ApiError, api, type NewUser, type ObjectType } from "../api";
import { Field, Modal } from "./Modal";

const GROUP_TYPES = [
  ["global-security", "Global security"],
  ["domain-local-security", "Domain local security"],
  ["universal-security", "Universal security"],
  ["global-distribution", "Global distribution"],
  ["domain-local-distribution", "Domain local distribution"],
  ["universal-distribution", "Universal distribution"],
] as const;

const TITLES: Record<ObjectType, string> = {
  user: "New user",
  group: "New group",
  computer: "New computer",
  ou: "New organizational unit",
};

export function CreateDialog({
  type,
  container,
  onClose,
  onCreated,
}: {
  type: ObjectType;
  container: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [mustChange, setMustChange] = useState(true);
  const [groupType, setGroupType] = useState<string>("global-security");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: string) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (type === "user") {
        await api.directory.createUser({
          container,
          sam_account_name: form.sam ?? "",
          name: form.name || form.sam,
          given_name: form.given,
          surname: form.surname,
          mail: form.mail,
          password: form.password || undefined,
          must_change_password: mustChange,
        });
      } else if (type === "group") {
        await api.directory.createGroup({
          container,
          name: form.name ?? "",
          group_type: groupType,
          description: form.description,
        });
      } else if (type === "computer") {
        await api.directory.createComputer({
          container,
          name: form.name ?? "",
          dns_host_name: form.dns,
        });
      } else {
        await api.directory.createOu({
          container,
          name: form.name ?? "",
          description: form.description,
        });
      }
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={TITLES[type]}
      submitLabel="Create"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="muted mono">{container}</p>

      {type === "user" && (
        <>
          <Field label="User logon name">
            <input value={form.sam ?? ""} required onChange={set("sam")} />
          </Field>
          <Field label="Full name" hint="Used as the object's common name">
            <input value={form.name ?? ""} onChange={set("name")} />
          </Field>
          <Field label="First name">
            <input value={form.given ?? ""} onChange={set("given")} />
          </Field>
          <Field label="Last name">
            <input value={form.surname ?? ""} onChange={set("surname")} />
          </Field>
          <Field label="E-mail">
            <input type="email" value={form.mail ?? ""} onChange={set("mail")} />
          </Field>
          <Field label="Password" hint="Leave empty to create the account disabled">
            <input
              type="password"
              autoComplete="new-password"
              value={form.password ?? ""}
              onChange={set("password")}
            />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={mustChange}
              onChange={(e) => setMustChange(e.target.checked)}
            />
            User must change password at next logon
          </label>
        </>
      )}

      {type === "group" && (
        <>
          <Field label="Group name">
            <input value={form.name ?? ""} required onChange={set("name")} />
          </Field>
          <Field label="Group scope and type">
            <select value={groupType} onChange={(e) => setGroupType(e.target.value)}>
              {GROUP_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <input value={form.description ?? ""} onChange={set("description")} />
          </Field>
        </>
      )}

      {type === "computer" && (
        <>
          <Field label="Computer name">
            <input value={form.name ?? ""} required onChange={set("name")} />
          </Field>
          <Field label="DNS host name">
            <input value={form.dns ?? ""} onChange={set("dns")} />
          </Field>
        </>
      )}

      {type === "ou" && (
        <>
          <Field label="Name">
            <input value={form.name ?? ""} required onChange={set("name")} />
          </Field>
          <Field label="Description">
            <input value={form.description ?? ""} onChange={set("description")} />
          </Field>
        </>
      )}
    </Modal>
  );
}

/**
 * RFC 4180-ish CSV reader: quoted fields, embedded commas, doubled quotes.
 * Enough for the exports ADUC and spreadsheets produce.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const CSV_FIELDS = new Set([
  "sam_account_name",
  "name",
  "given_name",
  "surname",
  "display_name",
  "mail",
  "description",
  "password",
]);

export function BulkImport({
  container,
  onClose,
  onImported,
}: {
  container: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [rows, setRows] = useState<NewUser[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [results, setResults] = useState<{ sam_account_name: string; created: boolean; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function read(file: File) {
    void file.text().then((text) => {
      const [header, ...body] = parseCsv(text);
      if (!header) {
        setProblems(["The file is empty."]);
        return;
      }
      const columns = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
      const unknown = columns.filter((c) => !CSV_FIELDS.has(c));
      const parsed = body.map((cells) => {
        const record: Record<string, string> = {};
        columns.forEach((column, index) => {
          if (CSV_FIELDS.has(column) && cells[index]) record[column] = cells[index].trim();
        });
        return { container, ...record } as unknown as NewUser;
      });
      setRows(parsed.filter((r) => r.sam_account_name));
      setProblems([
        ...(unknown.length ? [`Ignored columns: ${unknown.join(", ")}`] : []),
        ...(parsed.length !== parsed.filter((r) => r.sam_account_name).length
          ? ["Rows without sam_account_name were skipped."]
          : []),
      ]);
    });
  }

  async function submit() {
    if (!rows.length) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.directory.bulkUsers(rows);
      setResults(response.results);
      if (response.created > 0) onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Bulk create users from CSV"
      submitLabel={`Create ${rows.length} users`}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="muted mono">{container}</p>
      <Field
        label="CSV file"
        hint="Columns: sam_account_name, name, given_name, surname, display_name, mail, description, password"
      >
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && read(e.target.files[0])}
        />
      </Field>

      {problems.map((problem) => (
        <p key={problem} className="muted">
          {problem}
        </p>
      ))}

      {rows.length > 0 && results.length === 0 && (
        <table className="data compact">
          <thead>
            <tr>
              <th>Logon name</th>
              <th>Full name</th>
              <th>E-mail</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((row) => (
              <tr key={row.sam_account_name}>
                <td>{row.sam_account_name}</td>
                <td>{row.name ?? ""}</td>
                <td>{row.mail ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {results.length > 0 && (
        <table className="data compact">
          <thead>
            <tr>
              <th>Logon name</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.sam_account_name}>
                <td>{result.sam_account_name}</td>
                <td>{result.created ? "Created" : (result.error ?? "Failed")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
