import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Login } from "./Login";
import { Shell } from "./Shell";
import { Audit } from "./pages/Audit";
import { Directory } from "./pages/Directory";
import { Overview } from "./pages/Overview";
import { Policy } from "./pages/Policy";
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

  if (!session) return <Login onAuthenticated={setSession} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell session={session} onSignOut={signOut} />}>
          <Route index element={<Overview session={session} />} />
          <Route path="directory" element={<Directory />} />
          <Route path="policy" element={<Policy />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
