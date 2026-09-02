import { useEffect, useState } from "react";
import { ApiError, api, type AgentReport, type EffectivePolicy } from "../api";
import { Modal } from "./Modal";

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
                        <td className="mono">{result.setting}</td>
                        <td>
                          <span
                            className={`badge ${
                              result.status === "failed" ? "failure" : "success"
                            }`}
                          >
                            {result.status}
                          </span>
                        </td>
                        <td className="muted">{result.reason ?? ""}</td>
                      </tr>
                    ))}
                    {session.results.length === 0 && (
                      <tr>
                        <td colSpan={3} className="muted">
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
