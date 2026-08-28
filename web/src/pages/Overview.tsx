import type { SessionInfo } from "../api";

export function Overview({ session }: { session: SessionInfo }) {
  return (
    <main className="content">
      <h1>Overview</h1>
      <table className="data">
        <caption className="sr-only">Current session</caption>
        <tbody>
          <tr>
            <th scope="row">Signed in as</th>
            <td>{session.principal}</td>
          </tr>
          <tr>
            <th scope="row">Distinguished name</th>
            <td className="mono">{session.distinguished_name}</td>
          </tr>
          <tr>
            <th scope="row">Session expires</th>
            <td>{new Date(session.expires_at).toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}
