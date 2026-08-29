import { useState, type FormEvent } from "react";
import { AlertCircle } from "lucide-react";
import { ApiError, api, type SessionInfo } from "./api";

export function Login({ onAuthenticated }: { onAuthenticated: (s: SessionInfo) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await api.login(username, password, code || undefined));
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Cannot reach the Open Directory Manager API.";
      setError(message);
      // The password was right; this account has a second factor. Keep it, ask
      // for the code, and do not make them type the password again.
      if (message.toLowerCase().includes("authenticator") || message.includes("code")) {
        setNeedsCode(true);
        setCode("");
      } else {
        setPassword("");
        setNeedsCode(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/odm-logo-full.svg" alt="Open Directory Manager" className="login-logo" />

        <label htmlFor="username">User name</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {needsCode && (
          <>
            <label htmlFor="code">Authenticator code</label>
            <input
              id="code"
              name="one-time-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <small className="muted">
              From your authenticator, or one of your recovery codes.
            </small>
          </>
        )}

        {error && (
          <p className="alert" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            {error}
          </p>
        )}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in…" : needsCode ? "Verify" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
