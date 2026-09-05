import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type AgentReport, type EffectivePolicy, type Gpo } from "../api";
import { Field, Modal } from "./Modal";
import Select from "./Select";

/**
 * Resultant Set of Policy: what the API resolves for this object, and what
 * the machine last reported after actually applying it. The two are separate
 * on purpose — "should apply" and "did apply" are different questions.
 */
export function RsopDialog({
  dn,
  isComputer,
  account,
  onClose,
  inline,
}: {
  dn: string;
  isComputer: boolean;
  /** For a user: their account name, so their sessions can be asked about. */
  account?: string;
  onClose: () => void;
  /** Render as a section of a page rather than as a dialog over one. */
  inline?: boolean;
}) {
  const [policy, setPolicy] = useState<EffectivePolicy | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [sessions, setSessions] = useState<AgentReport[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.policy
      .effective(dn)
      .then(setPolicy)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    if (isComputer) {
      api.policy
        .reports(dn)
        .then((result) => setReport(result.reports[0] ?? null))
        .catch(() => setReport(null));
    }
    // A person's policy is applied in their session, on whichever machine
    // they signed in to. Resolving what should apply answered half the
    // question and the other half was in a journal on that machine.
    if (!isComputer && account) {
      api.policy
        .sessionReports(account)
        .then((result) => setSessions(result.reports))
        .catch(() => setSessions([]));
    }
  }, [dn, isComputer, account]);

  const body = (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <h3>Applied, lowest precedence first</h3>
      <ol className="rsop-list">
        {policy?.applied_gpos.map((gpo) => (
          <li key={gpo.guid}>{gpo.name}</li>
        ))}
        {policy?.applied_gpos.length === 0 && <li className="muted">Nothing applies.</li>}
      </ol>

      {policy && policy.skipped_gpos.length > 0 && (
        <>
          <h3>Not applied</h3>
          <table className="data compact">
            <tbody>
              {policy.skipped_gpos.map((gpo, index) => (
                <tr key={`${gpo.guid}-${index}`}>
                  <td>{gpo.name}</td>
                  <td className="muted">{gpo.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Effective settings</h3>
      <pre>{JSON.stringify(policy?.settings ?? {}, null, 2)}</pre>

      <ModelChange dn={dn} />

      {!isComputer && account && (
        <>
          <h3>Last applied in a session</h3>
          {sessions.length === 0 ? (
            <p className="muted">
              Nothing yet. Drive maps, connection files and the background are applied when this
              person signs in, and the machine reports what happened then.
            </p>
          ) : (
            sessions.map((session) => (
              <div key={session.id}>
                <p className="muted">
                  {session.hostname} · {new Date(session.reported_at).toLocaleString()} ·{" "}
                  {session.failures} failed
                </p>
                <table className="data compact">
                  <tbody>
                    {session.results.map((result, index) => (
                      <tr key={`${result.setting}-${index}`}>
                        <td>
                          <span className="mono">{result.setting}</span>
                          <span
                            className={`badge ${
                              result.status === "failed" ? "failure" : "success"
                            }`}
                          >
                            {result.status}
                          </span>
                          {/* Under the name rather than beside it: the reason
                              a mount failed is a sentence, and in a column it
                              was off the edge of the table. */}
                          {result.reason && <p className="stat-note">{result.reason}</p>}
                        </td>
                      </tr>
                    ))}
                    {session.results.length === 0 && (
                      <tr>
                        <td className="muted">
                          This person&rsquo;s policy carries nothing a session applies.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </>
      )}

      {isComputer && (
        <>
          <h3>Last agent report</h3>
          {report ? (
            <>
              <p className="muted">
                {new Date(report.reported_at).toLocaleString()} · agent{" "}
                {report.agent_version || "unknown"} ·{" "}
                {report.policy_serial === policy?.serial ? "current" : "out of date"} ·{" "}
                {report.failures} failed
              </p>
              <table className="data compact">
                <tbody>
                  {report.results.map((result, index) => (
                    <tr key={`${result.setting}-${index}`}>
                      <td className="mono">{result.setting}</td>
                      <td>
                        <span
                          className={`badge ${result.status === "failed" ? "failure" : "success"}`}
                        >
                          {result.status}
                        </span>
                      </td>
                      <td className="muted">{result.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted">This machine has not checked in yet.</p>
          )}
        </>
      )}
    </>
  );

  if (inline) return body;
  return (
    <Modal
      title="Resultant Set of Policy"
      submitLabel="Close"
      error={error}
      onClose={onClose}
      onSubmit={onClose}
    >
      {body}
    </Modal>
  );
}


/**
 * What this object would get if a policy object were linked somewhere.
 *
 * Both answers come out of the resolver the agent's own answer does, with the
 * proposed link added to the second one — so what this says is what the
 * machine will do, rather than a second implementation that can drift away
 * from it.
 */
function ModelChange({ dn }: { dn: string }) {
  const [open, setOpen] = useState(false);
  const [gpos, setGpos] = useState<Gpo[]>([]);
  const [guid, setGuid] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.policy.model>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || gpos.length > 0) return;
    api.policy
      .list()
      .then((answer) => setGpos(answer.gpos))
      .catch(() => setGpos([]));
  }, [open, gpos.length]);

  // The containers this object sits under. A link anywhere else could not
  // reach it, so offering them would only invite a preview that says nothing
  // changed for a reason nobody could see.
  const chain = useMemo(() => {
    const parts = dn.split(",");
    const found: string[] = [];
    for (let index = 1; index < parts.length; index += 1) {
      found.push(parts.slice(index).join(","));
    }
    return found;
  }, [dn]);

  if (!open) {
    return (
      <div className="actions-row">
        <button type="button" className="ghost" onClick={() => setOpen(true)}>
          Model a change…
        </button>
      </div>
    );
  }

  return (
    <>
      <h3>What would change</h3>
      <p className="muted">
        Pick a policy object and where it would be linked. Nothing is changed &mdash; this only
        resolves the answer twice.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="field-grid">
        <Field label="If this were linked">
          <Select value={guid} onChange={(event) => setGuid(event.target.value)}>
            <option value="">Choose a policy object</option>
            {gpos.map((gpo) => (
              <option key={gpo.guid} value={gpo.guid}>
                {gpo.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Choose a container</option>
            {chain.map((container) => (
              <option key={container} value={container}>
                {container}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="actions-row">
        <button
          type="button"
          className="primary"
          disabled={!guid || !target || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(
                await api.policy.model({
                  dn,
                  add: [{ gpo_guid: guid, target_dn: target }],
                }),
              );
            } catch (err) {
              setError(err instanceof ApiError ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Resolving…" : "Show me"}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {result && (
        <>
          {result.changes.length === 0 ? (
            <p className="muted">
              Nothing would change. The object is already applied here, filtered out, or sets
              nothing this object does not already get.
            </p>
          ) : (
            <table className="data compact">
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th scope="col" style={{ width: "120px" }}>
                    Change
                  </th>
                  <th scope="col" style={{ width: "160px" }}>
                    Entries
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.changes.map((change) => (
                  <tr key={change.category}>
                    <td className="mono">{change.category}</td>
                    <td>
                      <span
                        className={`badge ${change.state === "removed" ? "failure" : "success"}`}
                      >
                        {change.state}
                      </span>
                    </td>
                    <td className="mono">
                      {change.before_count} &rarr; {change.after_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>It would then receive</h3>
          <pre>{JSON.stringify(result.proposed.settings ?? {}, null, 2)}</pre>
        </>
      )}
    </>
  );
}
