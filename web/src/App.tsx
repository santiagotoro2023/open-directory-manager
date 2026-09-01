import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Login } from "./Login";
import { Shell } from "./Shell";
import { Audit } from "./pages/Audit";
import { Certificates } from "./pages/Certificates";
import { Controllers } from "./pages/Controllers";
import { Delegation } from "./pages/Delegation";
import { Dhcp } from "./pages/Dhcp";
import { Directory } from "./pages/Directory";
import { Dns } from "./pages/Dns";
import { Enrolment } from "./pages/Enrolment";
import { ObjectDetail } from "./pages/ObjectDetail";
import { Overview } from "./pages/Overview";
import { NetworkAccess } from "./pages/NetworkAccess";
import { Printers } from "./pages/Printers";
import { Policy } from "./pages/Policy";
import { RecycleBin } from "./pages/RecycleBin";
import { Roles } from "./pages/Roles";
import { Shares } from "./pages/Shares";
import { RemoteDesktop } from "./pages/RemoteDesktop";
import { Vpn } from "./pages/Vpn";
import { Wiki } from "./wiki/Wiki";
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
          <Route path="directory/object" element={<ObjectDetail />} />
          <Route path="policy" element={<Policy />} />
          <Route path="dns" element={<Dns />} />
          <Route path="dhcp" element={<Dhcp />} />
          <Route path="roles" element={<Roles />} />
          <Route path="shares" element={<Shares />} />
          <Route path="enrolment" element={<Enrolment />} />
          <Route path="printers" element={<Printers />} />
          <Route path="remote-desktop" element={<RemoteDesktop />} />
          <Route path="vpn" element={<Vpn />} />
          <Route path="network-access" element={<NetworkAccess />} />
          <Route path="controllers" element={<Controllers />} />
          <Route path="delegation" element={<Delegation />} />
          <Route path="certificates" element={<Certificates />} />
          <Route path="operations" element={<Navigate to="/" replace />} />
          <Route path="recyclebin" element={<RecycleBin />} />
          <Route path="wiki/*" element={<Wiki />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
