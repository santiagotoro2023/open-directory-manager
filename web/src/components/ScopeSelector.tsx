import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type DhcpScope } from "../api";

/**
 * Which DHCP scopes a deployment is offered in.
 *
 * Network boot is advertised over DHCP, so the scopes are the networks. Naming
 * them is what keeps a provisioning network separate from a client network: a
 * boot server that answers everything on its interface will offer to reinstall
 * a workstation that PXE-booted by accident.
 */
export function ScopeSelector({
  value,
  onChange,
}: {
  /** Comma-separated network addresses, as the role's argument carries them. */
  value: string;
  onChange: (value: string) => void;
}) {
  const [scopes, setScopes] = useState<DhcpScope[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setScopes((await api.dhcp.scopes()).scopes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chosen = new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

  function toggle(network: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(network);
    else next.delete(network);
    onChange([...next].join(","));
  }

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col" style={{ width: "60px" }}>
              Boot
            </th>
            <th scope="col">Network</th>
            <th scope="col">Pools</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {scopes.map((scope) => {
            // The role stores the network address; the scope carries the CIDR.
            const network = scope.subnet.split("/")[0];
            return (
              <tr key={scope.id ?? scope.subnet}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Offer network boot on ${scope.subnet}`}
                    checked={chosen.has(network)}
                    onChange={(e) => toggle(network, e.target.checked)}
                  />
                </td>
                <td className="mono">{scope.subnet}</td>
                <td className="mono">
                  {(scope.pools ?? []).map((pool) => pool.pool).join(", ") || "—"}
                </td>
                <td>{scope["user-context"]?.comment ?? ""}</td>
              </tr>
            );
          })}
          {scopes.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No DHCP scopes yet. Add one under DHCP first.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {chosen.size === 0 && scopes.length > 0 && (
        <p className="alert" role="alert">
          No network chosen, so boot is offered to everything on the server&rsquo;s interface —
          including any workstation that happens to PXE-boot.
        </p>
      )}
    </>
  );
}
