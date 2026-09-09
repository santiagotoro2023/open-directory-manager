/**
 * What changed, as it changes.
 *
 * One EventSource for the whole console. The stream carries the name of a
 * table that changed and nothing else; a page subscribes to the tables it is
 * showing and re-reads with its own request when one of them fires. So a role
 * finishing, a share appearing, a machine reporting or a task ending shows up
 * where somebody is already looking, without a reload.
 */
import { useEffect, useRef } from "react";

type Listener = (table: string) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retry = 0;
let reconnect: number | undefined;

function open() {
  if (source || listeners.size === 0) return;
  source = new EventSource("/api/v1/events", { withCredentials: true });
  source.onmessage = (event) => {
    retry = 0;
    try {
      const { table } = JSON.parse(event.data) as { table?: string };
      if (table) for (const listener of [...listeners]) listener(table);
    } catch {
      // A frame we cannot read is not worth tearing the stream down for.
    }
  };
  source.onerror = () => {
    source?.close();
    source = null;
    if (listeners.size === 0) return;
    // Backing off to half a minute: a console left open against a control
    // plane that is down should not be the reason it stays down.
    retry = Math.min(retry + 1, 6);
    window.clearTimeout(reconnect);
    reconnect = window.setTimeout(open, Math.min(1000 * 2 ** retry, 30_000));
  };
}

function close() {
  if (listeners.size > 0) return;
  window.clearTimeout(reconnect);
  source?.close();
  source = null;
}

/**
 * Re-run `reload` whenever one of `tables` changes.
 *
 * Coalesced: a bulk change is one reload, not one per row, and a page that is
 * already loading is not asked to load again on top of itself.
 */
export function useLive(tables: readonly string[], reload: () => void | Promise<unknown>) {
  const latest = useRef(reload);
  latest.current = reload;
  const wanted = tables.join(",");

  useEffect(() => {
    const names = new Set(wanted.split(",").filter(Boolean));
    let pending: number | undefined;
    const listener: Listener = (table) => {
      if (!names.has(table)) return;
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void latest.current(), 400);
    };
    listeners.add(listener);
    open();
    return () => {
      window.clearTimeout(pending);
      listeners.delete(listener);
      close();
    };
  }, [wanted]);
}

/** The tables each part of the console is looking at. */
export const WATCH = {
  directory: ["audit_log", "computer_fact", "rbac_assignment"],
  policy: ["gpo", "gpo_link", "audit_log"],
  roles: ["server_role", "node_task"],
  servers: ["computer_fact", "agent_report", "node_task", "server_role"],
  shares: ["share", "node_task"],
  printers: ["printer", "node_task"],
  remoteDesktop: ["rd_collection", "rd_host", "node_task", "computer_fact"],
  vpn: ["vpn_peer", "node_task"],
  certificates: ["certificate", "audit_log"],
  audit: ["audit_log"],
  recycleBin: ["deleted_object"],
  dhcp: ["dhcp_scope", "node_task", "audit_log"],
  dns: ["audit_log"],
  overview: ["computer_fact", "server_role", "audit_log", "agent_report"],
  delegation: ["rbac_assignment", "audit_log"],
} as const;
