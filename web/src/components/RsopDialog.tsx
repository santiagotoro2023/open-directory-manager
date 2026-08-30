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
  onClose,
  inline,
}: {
  dn: string;
  isComputer: boolean;
  onClose: () => void;
  /** Render as a section of a page rather than as a dialog over one. */
  inline?: boolean;
}) {
  const [policy, setPolicy] = useState<EffectivePolicy | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
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
  }, [dn, isComputer]);

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
