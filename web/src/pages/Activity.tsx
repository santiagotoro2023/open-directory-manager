import { useEffect, useState } from "react";
import { api, type ActivitySummary } from "../api";
import { ActivityTable, describeKind } from "../components/ActivityTable";
import { InfoPanel } from "../components/DocsLink";

/**
 * What people did on the machines, domain-wide.
 *
 * The audit log is what was done through the console; this is what was done
 * at the machines — every sign-in and failed one, every sudo command, every
 * switch to root, every phone approval and refusal, every password change,
 * local account and USB stick, from every machine's own journal, in one
 * list. The tiles are the things worth a second look in the last day.
 */
export function Activity() {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);

  useEffect(() => {
    api.activity
      .summary(24)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  const counts = new Map((summary?.kinds ?? []).map((row) => [row.kind, row]));
  const signIns = (counts.get("sign-in")?.total ?? 0) + (counts.get("logon")?.total ?? 0);

  return (
    <div className="content">
      <h1>Activity</h1>

      <InfoPanel page="activity">
        Everything that happened at the machines, as their agents read it from their own logs:
        who signed in where, who used sudo for what, whose phone approved a sign-in, what was
        plugged in. The console's own actions are in the Audit Log.
      </InfoPanel>

      {summary && (
        <div className="stat-row">
          <div className="stat">
            <p className="stat-value">{signIns}</p>
            <p className="stat-label">Sign-ins, last 24 h</p>
            {counts.get("sign-in") && (
              <p className="stat-note">
                {counts.get("sign-in")!.people} people on {counts.get("sign-in")!.machines}{" "}
                machines
              </p>
            )}
          </div>
          {summary.watched.map((kind) => {
            const row = counts.get(kind);
            return (
              <div key={kind} className={row ? "stat attention" : "stat"}>
                <p className="stat-value">{row?.total ?? 0}</p>
                <p className="stat-label">{describeKind(kind)}, last 24 h</p>
                {row && (
                  <p className="stat-note">
                    {row.machines} {row.machines === 1 ? "machine" : "machines"}
                    {row.people > 0 && `, ${row.people} ${row.people === 1 ? "person" : "people"}`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ActivityTable />
    </div>
  );
}
