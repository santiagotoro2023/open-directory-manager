import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type {
  DashboardData,
  DashboardWidget,
  MonitorAlert,
  MonitorHost,
  MonitorSeries,
} from "../../api";

/**
 * A dashboard as it is looked at: a grid of widgets, each drawn from the data
 * the control plane rendered for it in one answer. The same component draws
 * the console's page, the designer's preview and the public full-screen
 * view, so what somebody designs is exactly what the wall shows.
 */

// One colour per series, in an order that stays legible at a distance.
const PALETTE = ["#4f46e5", "#0891b2", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0d9488", "#be185d"];

export const METRIC_LABELS: Record<string, { label: string; unit: string }> = {
  cpu_percent: { label: "Processor busy", unit: "%" },
  load1: { label: "Load average", unit: "" },
  mem_percent: { label: "Memory used", unit: "%" },
  swap_percent: { label: "Swap used", unit: "%" },
  "disk_percent:": { label: "Filesystem used", unit: "%" },
  "disk_free_bytes:": { label: "Filesystem free", unit: "bytes" },
  net_rx_bytes_per_s: { label: "Network received", unit: "bytes/s" },
  net_tx_bytes_per_s: { label: "Network sent", unit: "bytes/s" },
  temp_c: { label: "Temperature", unit: "°C" },
  uptime_seconds: { label: "Uptime", unit: "s" },
  processes: { label: "Processes", unit: "" },
  agent_up: { label: "Reporting", unit: "" },
  probe_up: { label: "Probe answered", unit: "" },
  probe_latency_ms: { label: "Probe latency", unit: "ms" },
};

export function metricMeta(metric: string): { label: string; unit: string } {
  const base = metric.includes(":") ? metric.split(":")[0] + ":" : metric;
  const suffix = metric.includes(":") ? metric.split(":").slice(1).join(":") : "";
  const meta = METRIC_LABELS[base] ?? { label: metric, unit: "" };
  return { label: suffix ? `${meta.label} ${suffix}` : meta.label, unit: meta.unit };
}

export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (unit === "bytes" || unit === "bytes/s") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = value;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}${unit === "bytes/s" ? "/s" : ""}`;
  }
  if (unit === "s") {
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((value % 3600) / 60)}m`;
  }
  if (unit === "%") return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
  if (unit === "°C") return `${value.toFixed(0)} °C`;
  if (unit === "ms") return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function shortHost(host: string): string {
  return host.split(".")[0];
}

/** One time-series chart of every series the widget's scope covers. */
export function Chart({ series, unit, height }: { series: MonitorSeries[]; unit: string; height: number }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // Align every series onto one x axis: the union of all timestamps.
    const stamps = Array.from(
      new Set(series.flatMap((entry) => entry.points.map((point) => point[0]))),
    ).sort((a, b) => a - b);
    const index = new Map(stamps.map((stamp, i) => [stamp, i]));
    const columns: (number | null)[][] = series.map((entry) => {
      const column: (number | null)[] = new Array(stamps.length).fill(null);
      for (const [stamp, value] of entry.points) column[index.get(stamp)!] = value;
      return column;
    });
    const percent = unit === "%";
    const plot = new uPlot(
      {
        width: element.clientWidth || 400,
        height,
        cursor: { drag: { x: false, y: false } },
        legend: { show: series.length <= 8 },
        scales: { y: percent ? { range: [0, 100] } : {} },
        axes: [
          { stroke: "#6b7280", grid: { stroke: "#e5e7eb" }, ticks: { stroke: "#e5e7eb" } },
          {
            stroke: "#6b7280",
            grid: { stroke: "#e5e7eb" },
            ticks: { stroke: "#e5e7eb" },
            size: 56,
            values: (_u, ticks) => ticks.map((tick) => formatValue(tick, unit)),
          },
        ],
        series: [
          {},
          ...series.map((entry, i) => ({
            label: series.every((s) => s.host === entry.host)
              ? entry.metric.includes(":")
                ? entry.metric.split(":").slice(1).join(":")
                : shortHost(entry.host)
              : entry.metric.includes(":")
                ? `${shortHost(entry.host)} ${entry.metric.split(":").slice(1).join(":")}`
                : shortHost(entry.host),
            stroke: PALETTE[i % PALETTE.length],
            width: 1.5,
            spanGaps: false,
            value: (_u: uPlot, value: number | null) => formatValue(value, unit),
          })),
        ],
      },
      [stamps, ...columns] as uPlot.AlignedData,
      element,
    );
    const observer = new ResizeObserver(() => {
      plot.setSize({ width: element.clientWidth || 400, height });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      plot.destroy();
    };
  }, [series, unit, height]);

  if (series.length === 0) {
    return <p className="muted widget-empty">No data yet.</p>;
  }
  return <div className="chart" ref={host} />;
}

function StatWidget({ values, unit }: { values: { host: string; metric: string; value: number }[]; unit: string }) {
  if (values.length === 0) return <p className="muted widget-empty">No data yet.</p>;
  return (
    <div className="stat-grid">
      {values.map((entry) => (
        <div key={entry.host + entry.metric} className="stat-cell">
          <span className="stat-cell-value">{formatValue(entry.value, unit)}</span>
          <span className="stat-cell-label">
            {shortHost(entry.host)}
            {entry.metric.includes(":") && ` ${entry.metric.split(":").slice(1).join(":")}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HostsWidget({ hosts }: { hosts: MonitorHost[] }) {
  if (hosts.length === 0) return <p className="muted widget-empty">No machine has reported yet.</p>;
  return (
    <table className="data compact">
      <thead>
        <tr>
          <th scope="col">Machine</th>
          <th scope="col">CPU</th>
          <th scope="col">Memory</th>
          <th scope="col">Disk /</th>
          <th scope="col">Temp</th>
          <th scope="col">Seen</th>
        </tr>
      </thead>
      <tbody>
        {hosts.map((host) => (
          <tr key={host.host} className={host.up ? "" : "row-down"}>
            <td>
              <span className={`dot ${host.up ? "up" : "down"}`} aria-hidden="true" />
              {shortHost(host.host)}
            </td>
            <td>{formatValue(host.metrics.cpu_percent, "%")}</td>
            <td>{formatValue(host.metrics.mem_percent, "%")}</td>
            <td>{formatValue(host.disks["/"], "%")}</td>
            <td>{formatValue(host.metrics.temp_c, "°C")}</td>
            <td className="muted">{host.up ? "now" : `${Math.round(host.age_seconds / 60)} min ago`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AlertsWidget({ alerts }: { alerts: MonitorAlert[] }) {
  if (alerts.length === 0) return <p className="muted widget-empty">Nothing is firing.</p>;
  return (
    <ul className="alert-list">
      {alerts.map((alert) => (
        <li key={alert.id} className={`alert-row ${alert.severity}`}>
          <span className={`badge ${alert.severity === "critical" ? "failure" : "warning"}`}>
            {alert.severity}
          </span>
          <span className="alert-text">
            <strong>{alert.rule_name}</strong> — {alert.message}
            {alert.suppressed && <span className="muted"> (maintenance)</span>}
          </span>
          <span className="muted nowrap">{new Date(alert.started_at).toLocaleTimeString()}</span>
        </li>
      ))}
    </ul>
  );
}

export function Widget({ widget, data }: { widget: DashboardWidget; data: unknown }) {
  const meta = widget.metric ? metricMeta(widget.metric) : { label: "", unit: "" };
  const height = widget.h === 1 ? 120 : widget.h === 2 ? 220 : 340;
  switch (widget.type) {
    case "chart":
      return <Chart series={(data as MonitorSeries[]) ?? []} unit={meta.unit} height={height} />;
    case "stat":
      return <StatWidget values={(data as { host: string; metric: string; value: number }[]) ?? []} unit={meta.unit} />;
    case "hosts":
      return <HostsWidget hosts={(data as MonitorHost[]) ?? []} />;
    case "alerts":
      return <AlertsWidget alerts={(data as MonitorAlert[]) ?? []} />;
    case "text":
      return <p className="widget-text">{widget.text}</p>;
    default:
      return null;
  }
}

export function DashboardGrid({
  widgets,
  data,
  tools,
}: {
  widgets: DashboardWidget[];
  data: DashboardData;
  /** Per-widget controls, drawn in the title bar when designing. */
  tools?: (widget: DashboardWidget, index: number) => React.ReactNode;
}) {
  return (
    <div className="dashboard-grid">
      {widgets.map((widget, index) => (
        <section
          key={widget.id}
          className={`widget h${widget.h}`}
          style={{ gridColumn: `span ${widget.w}` }}
        >
          <header className="widget-title">
            <span>
              {widget.title || (widget.metric ? metricMeta(widget.metric).label : widget.type)}
            </span>
            {tools && <span className="widget-tools">{tools(widget, index)}</span>}
          </header>
          <div className="widget-body">
            <Widget widget={widget} data={data[widget.id]} />
          </div>
        </section>
      ))}
      {widgets.length === 0 && <p className="muted">This dashboard has no widgets yet.</p>}
    </div>
  );
}
