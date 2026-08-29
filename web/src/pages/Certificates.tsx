import { useCallback, useEffect, useState } from "react";
import { Download, Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  ApiError,
  api,
  type CaStatus,
  type IssuedCertificate,
  type TrustAnchor,
} from "../api";
import { Field, Modal } from "../components/Modal";

export function Certificates() {
  const [status, setStatus] = useState<CaStatus | null>(null);
  const [certificates, setCertificates] = useState<IssuedCertificate[]>([]);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [tab, setTab] = useState<"issued" | "trusted">("issued");
  const [dialog, setDialog] = useState<"issue" | "console" | null>(null);
  const [issued, setIssued] = useState<IssuedCertificate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const current = await api.ca.status();
      setStatus(current);
      if (current.initialised) {
        setCertificates((await api.ca.certificates(includeRevoked)).certificates);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [includeRevoked]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, message?: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      if (message) setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (status && !status.initialised) {
    return (
      <main className="content">
        <h1>Certificates</h1>
        <p className="muted">
          No certificate authority exists yet. Creating one lets ODM issue server and client
          certificates, publish its root to every domain member, and re-issue the certificate this
          console is served with.
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary"
          onClick={() => void run(() => api.ca.initialise(), "Certificate authority created.")}
        >
          <ShieldCheck size={15} aria-hidden="true" />
          Create the certificate authority
        </button>
        <p className="muted">
          Requires the certificate-authority role and ODM_CA_DIR in the secrets file.
        </p>
      </main>
    );
  }

  return (
    <main className="content">
      <div className="page-header">
        <h1>Certificates</h1>
        <span className="spacer" />
        <a className="ghost button-link" href={api.ca.rootUrl} download>
          <Download size={15} aria-hidden="true" />
          Root certificate
        </a>
        <button
          type="button"
          className="ghost"
          onClick={() =>
            void run(
              () => api.ca.publish(),
              "Published. Every trusted certificate is now in one policy object; agents install them on their next refresh.",
            )
          }
        >
          Publish to domain
        </button>
        <button type="button" className="ghost" onClick={() => setDialog("console")}>
          Replace console certificate
        </button>
        <button type="button" className="primary" onClick={() => setDialog("issue")}>
          <Plus size={15} aria-hidden="true" />
          Issue certificate
        </button>
      </div>

      {status?.subject && (
        <table className="data" style={{ maxWidth: "860px", marginBottom: "18px" }}>
          <tbody>
            <tr>
              <th scope="row">Authority</th>
              <td className="mono">{status.subject}</td>
            </tr>
            <tr>
              <th scope="row">Fingerprint</th>
              <td className="mono">{status.fingerprint}</td>
            </tr>
            <tr>
              <th scope="row">Valid until</th>
              <td>{status.not_after && new Date(status.not_after).toLocaleDateString()}</td>
            </tr>
            <tr>
              <th scope="row">Issued</th>
              <td>
                {status.issued ?? 0} active
                {(status.expiring_soon ?? 0) > 0 && (
                  <span className="badge failure">{status.expiring_soon} expiring within 30 days</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <nav className="tabs" aria-label="Certificate views">
        {(["issued", "trusted"] as const).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "issued" ? "Issued by this domain" : "Trusted"}
          </button>
        ))}
      </nav>

      {tab === "trusted" && <TrustedTab onChanged={() => void load()} />}

      {tab === "issued" && (
        <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={includeRevoked}
          onChange={(e) => setIncludeRevoked(e.target.checked)}
        />
        Show revoked
      </label>

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Subject</th>
            <th scope="col">Profile</th>
            <th scope="col">Expires</th>
            <th scope="col">Serial</th>
            <th scope="col">
              <span className="sr-only">Revoke</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {certificates.map((certificate) => (
            <tr key={certificate.serial}>
              <td>
                <strong>{certificate.subject}</strong>
                {certificate.sans.length > 1 && (
                  <p className="muted">{certificate.sans.slice(1).join(", ")}</p>
                )}
              </td>
              <td>{certificate.profile}</td>
              <td>
                {new Date(certificate.not_after).toLocaleDateString()}
                {certificate.revoked_at && <span className="badge failure">revoked</span>}
              </td>
              <td className="mono">{certificate.serial}</td>
              <td>
                {!certificate.revoked_at && (
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Revoke ${certificate.subject}`}
                    onClick={() =>
                      void run(
                        () => api.ca.revoke(certificate.serial, "revoked from the console"),
                        "Revoked. Publish the revocation list where relying parties read it.",
                      )
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </td>
            </tr>
          ))}
          {certificates.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nothing issued yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

        </>
      )}

      {dialog === "issue" && (
        <IssueDialog
          onClose={() => setDialog(null)}
          onIssued={(certificate) => {
            setDialog(null);
            setIssued(certificate);
            void load();
          }}
        />
      )}
      {dialog === "console" && (
        <ConsoleDialog
          onClose={() => setDialog(null)}
          onApplied={(message) => {
            setDialog(null);
            setNotice(message);
          }}
        />
      )}
      {issued && <MaterialDialog certificate={issued} onClose={() => setIssued(null)} />}
    </main>
  );
}

function IssueDialog({
  onClose,
  onIssued,
}: {
  onClose: () => void;
  onIssued: (certificate: IssuedCertificate) => void;
}) {
  const [commonName, setCommonName] = useState("");
  const [sans, setSans] = useState("");
  const [profile, setProfile] = useState("server");
  const [days, setDays] = useState(397);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="Issue a certificate"
      submitLabel="Issue"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          onIssued(
            await api.ca.issue({
              common_name: commonName,
              sans: sans
                .split(/[\s,]+/)
                .map((value) => value.trim())
                .filter(Boolean),
              profile,
              validity_days: days,
            }),
          );
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Common name" hint="Host name for a server, account name for a client">
        <input value={commonName} required onChange={(e) => setCommonName(e.target.value)} />
      </Field>
      <Field label="Additional names" hint="Host names or IP addresses, comma separated">
        <input value={sans} onChange={(e) => setSans(e.target.value)} />
      </Field>
      <Field label="Profile">
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="server">Server — TLS service</option>
          <option value="client">Client — authentication</option>
        </select>
      </Field>
      <Field label="Validity in days">
        <input
          type="number"
          min={1}
          max={1825}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
      </Field>
      <p className="muted">The private key is shown once and never stored.</p>
    </Modal>
  );
}

function MaterialDialog({
  certificate,
  onClose,
}: {
  certificate: IssuedCertificate;
  onClose: () => void;
}) {
  return (
    <Modal title="Issued" submitLabel="Done" onClose={onClose} onSubmit={onClose}>
      <p className="muted">
        Copy both parts now. The private key is not stored and cannot be shown again.
      </p>
      <Field label="Certificate">
        <textarea readOnly rows={8} className="mono" value={certificate.certificate_pem ?? ""} />
      </Field>
      <Field label="Private key">
        <textarea readOnly rows={8} className="mono" value={certificate.private_key_pem ?? ""} />
      </Field>
      <p className="mono muted">Serial {certificate.serial}</p>
    </Modal>
  );
}

function ConsoleDialog({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const [commonName, setCommonName] = useState(window.location.hostname);
  const [sans, setSans] = useState("");
  const [days, setDays] = useState(397);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="Replace the console certificate"
      submitLabel="Issue and apply"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await api.ca.consoleCertificate({
            common_name: commonName,
            sans: sans
              .split(/[\s,]+/)
              .map((value) => value.trim())
              .filter(Boolean),
            validity_days: days,
          });
          onApplied(
            result.applied
              ? "Issued and installed. The console restarts; reload in a few seconds."
              : "Issued and staged, but the privileged helper is not installed, so nothing was replaced.",
          );
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">
        Issues a certificate for this console from the domain authority and installs it. The
        console restarts and is briefly unavailable. Publish the root first so browsers trust it.
      </p>
      <Field label="Common name" hint="The name operators use to reach the console">
        <input value={commonName} required onChange={(e) => setCommonName(e.target.value)} />
      </Field>
      <Field label="Additional names">
        <input value={sans} onChange={(e) => setSans(e.target.value)} />
      </Field>
      <Field label="Validity in days">
        <input
          type="number"
          min={1}
          max={1825}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
      </Field>
    </Modal>
  );
}


/** Certificates the domain trusts that ODM did not issue. */
function TrustedTab({ onChanged }: { onChanged: () => void }) {
  const [trusted, setTrusted] = useState<TrustAnchor[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTrusted((await api.ca.trusted()).trusted);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <p className="muted">
        Published to every domain member together with this domain&rsquo;s own root, as one
        policy object. Use <strong>Publish to domain</strong> above after a change.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="actions-row">
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Plus size={15} aria-hidden="true" />
          Trust a certificate
        </button>
      </div>

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Subject</th>
            <th scope="col">Expires</th>
            <th scope="col">Kind</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {trusted.map((anchor) => (
            <tr key={anchor.id}>
              <td>
                <strong>{anchor.name}</strong>
                {anchor.description && <p className="muted">{anchor.description}</p>}
              </td>
              <td className="mono">{anchor.subject}</td>
              <td>{anchor.not_after && new Date(anchor.not_after).toLocaleDateString()}</td>
              <td>
                <span className="badge">{anchor.is_ca ? "authority" : "certificate"}</span>
              </td>
              <td>
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => {
                    await api.ca.untrust(anchor.id).catch(() => undefined);
                    await load();
                    onChanged();
                  }}
                >
                  Stop trusting
                </button>
              </td>
            </tr>
          ))}
          {trusted.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                Only this domain&rsquo;s own authority is trusted.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {adding && (
        <TrustDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </>
  );
}

function TrustDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pem, setPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="Trust a certificate"
      submitLabel="Trust"
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.ca.trust({ name, description, certificate_pem: pem });
          onAdded();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" hint="How it appears in the trust store on each machine">
        <input value={name} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="What it is for">
        <input
          value={description}
          placeholder="The authority in front of the internal wiki"
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Certificate" hint="PEM, beginning with -----BEGIN CERTIFICATE-----">
        <textarea
          rows={10}
          className="mono"
          value={pem}
          required
          onChange={(e) => setPem(e.target.value)}
        />
      </Field>
      <p className="muted">
        It is read before it is stored, so the subject and expiry shown afterwards come from the
        certificate itself.
      </p>
    </Modal>
  );
}
