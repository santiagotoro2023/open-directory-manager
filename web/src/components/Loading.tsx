/**
 * That the console is fetching, rather than that there is nothing.
 *
 * An empty table drawn while the first request is still out says "no shares"
 * to somebody who has shares, and says it for exactly as long as the request
 * takes. Every list shows this until it knows.
 */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

/** The same, as a row, for a table that has not loaded yet. */
export function LoadingRow({ colSpan, label }: { colSpan: number; label?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="empty">
        <Loading label={label} />
      </td>
    </tr>
  );
}
