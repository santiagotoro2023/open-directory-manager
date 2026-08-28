import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ApiError, api, type JoinToken } from "../api";
import { Field, Modal } from "./Modal";

/**
 * Enrolment tokens let a machine join without a domain administrator
 * credential ever being typed on it.
 */
export function EnrolmentTokens({
  container,
  onClose,
}: {
  container: string;
  onClose: () => void;
}) {
  const [tokens, setTokens] = useState<JoinToken[]>([]);
  const [label, setLabel] = useState("");
  const [uses, setUses] = useState(1);
  const [ttl, setTtl] = useState(1440);
  const [issued, setIssued] = useState<{ token: string; command: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens((await api.join.tokens()).tokens);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal
      title="Enrolment tokens"
      submitLabel="Create token"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await api.join.createToken({
            label,
            container_dn: container,
            uses_allowed: uses,
            ttl_minutes: ttl,
          });
          setIssued({ token: result.token, command: result.command });
          setLabel("");
          await load();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">
        Computer accounts are created in <span className="mono">{container}</span>.
      </p>

      <Field label="Label" hint="Shown in the token list">
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Uses" hint="How many machines may enrol with it">
        <input
          type="number"
          min={1}
          max={1000}
          value={uses}
          onChange={(e) => setUses(Number(e.target.value))}
        />
      </Field>
      <Field label="Valid for (minutes)">
        <input
          type="number"
          min={5}
          max={43200}
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
        />
      </Field>

      {issued && (
        <>
          <p className="muted">Copy this now. The token is not shown again.</p>
          <Field label="Run on the client">
            <textarea readOnly rows={3} className="mono" value={issued.command} />
          </Field>
        </>
      )}

      <h3>Active tokens</h3>
      <table className="data compact">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Container</th>
            <th scope="col">Uses</th>
            <th scope="col">Expires</th>
            <th scope="col">
              <span className="sr-only">Revoke</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.id}>
              <td>{token.label || "—"}</td>
              <td className="mono">{token.container_dn}</td>
              <td>
                {token.uses_spent} / {token.uses_allowed}
              </td>
              <td>{new Date(token.expires_at).toLocaleString()}</td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Revoke token ${token.label || token.id}`}
                  onClick={async () => {
                    await api.join.revokeToken(token.id).catch(() => undefined);
                    await load();
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {tokens.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No active tokens.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
