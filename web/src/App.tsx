import { useCallback, useEffect, useState } from "react";
import { Login } from "./Login";
import { Shell } from "./Shell";
import { api, type SessionInfo } from "./api";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api
      .session()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setSession(null);
  }, []);

  if (checking) {
    return (
      <div className="centered" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  return session ? (
    <Shell session={session} onSignOut={signOut} />
  ) : (
    <Login onAuthenticated={setSession} />
  );
}
