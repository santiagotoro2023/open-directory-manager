import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type DashboardData, type MonitorDashboard } from "../api";
import { DashboardGrid } from "../components/monitor/Dashboard";

/**
 * A shared dashboard, full screen, with no sign-in: what a screen on a wall
 * shows. The token in the URL is the whole credential, and what it reaches
 * is the dashboard's numbers and nothing else. Refreshes itself every half
 * minute for as long as the tab is open.
 */
export function MonitorView({ token }: { token: string }) {
  const [dashboard, setDashboard] = useState<MonitorDashboard | null>(null);
  const [data, setData] = useState<DashboardData>({});
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.monitor.publicDashboard(token);
      setDashboard(result.dashboard);
      setData(result.data);
      setUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "This dashboard is not shared, or the link has been withdrawn." : String(err));
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (dashboard) document.title = `${dashboard.name} — Open Directory Manager`;
  }, [dashboard]);

  return (
    <div className="wall">
      <header className="wall-header">
        <h1>{dashboard?.name ?? "Dashboard"}</h1>
        <span className="muted">{updated ? `Updated ${updated.toLocaleTimeString()}` : ""}</span>
      </header>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {dashboard && <DashboardGrid widgets={dashboard.layout.widgets} data={data} />}
    </div>
  );
}
