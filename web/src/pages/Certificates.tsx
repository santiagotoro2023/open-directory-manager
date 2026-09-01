import { useCallback, useEffect, useState } from "react";
import { Download, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import {
  ApiError,
  api,
  type CaStatus,
  type CertificateProfile,
  type IssuedCertificate,
  type TrustAnchor,
} from "../api";
import { Field, Modal } from "../components/Modal";
import Select from "../components/Select"

export function Certificates() {
  const [status, setStatus] = useState<CaStatus | null>(null);
  const [certificates, setCertificates] = useState<IssuedCertificate[]>([]);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [tab, setTab] = useState<"issued" | "trusted" | "profiles">("issued");
  const [dialog, setDialog] = useState<"issue" | "console" | null>(null);
  const [issued, setIssued] = useState<IssuedCertificate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishRoot, setPublishRoot] = useState(true);

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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={publishRoot}
            onChange={(e) => setPublishRoot(e.target.checked)}
          />
          Publish the root certificate to every domain computer
        </label>
        <p className="muted">
          Machines install it from Group Policy on their next refresh, so they trust anything this
          authority issues without being touched.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void run(
              () => api.ca.initialise(undefined, publishRoot),
              publishRoot
                ? "Certificate authority created and its root published to the domain."
                : "Certificate authority created.",
            )
          }
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
                  <span className="badge failure">
                    {status.expiring_soon} expiring within 30 days
                  </span>
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
        {(["issued", "trusted", "profiles"] as const).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "issued"
              ? "Issued by this domain"
              : current === "trusted"
                ? "Trusted"
                : "Profiles"}
          </button>
        ))}
      </nav>

      {tab === "trusted" && <TrustedTab onChanged={() => void load()} />}

      {tab === "profiles" && <ProfilesTab />}

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
  const [profiles, setProfiles] = useState<CertificateProfile[]>([]);
  const [days, setDays] = useState(397);

  useEffect(() => {
    void api.ca
      .profiles()
      .then((result) => setProfiles(result.profiles))
      .catch(() => setProfiles([]));
  }, []);
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
        <Select
          value={profile}
          onChange={(e) => {
            setProfile(e.target.value);
            const chosen = profiles.find((one) => one.name === e.target.value);
            if (chosen) setDays(chosen.validity_days);
          }}
        >
          {profiles.map((one) => (
            <option key={one.name} value={one.name}>
              {one.description || one.name}
            </option>
          ))}
        </Select>
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
        Issues a certificate for this console from the domain authority and installs it. The console
        restarts and is briefly unavailable. Publish the root first so browsers trust it.
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
        Published to every domain member together with this domain&rsquo;s own root, as one policy
        object. Use <strong>Publish to domain</strong> above after a change.
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
      <label className="button-link ghost" style={{ alignSelf: "flex-start" }}>
        <Upload size={15} aria-hidden="true" />
        Choose a file
        <input
          type="file"
          accept=".pem,.crt,.cer,.txt,application/x-pem-file"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            // A PEM is text, so it goes straight into the box the operator
            // would otherwise have pasted into, and stays reviewable.
            if (file) setPem((await file.text()).trim());
            e.target.value = "";
          }}
        />
      </label>
      <p className="muted">
        It is read before it is stored, so the subject and expiry shown afterwards come from the
        certificate itself.
      </p>
    </Modal>
  );
}

/** Profiles decide what a certificate is for; AD CS calls these templates. */
function ProfilesTab() {
  const [profiles, setProfiles] = useState<CertificateProfile[]>([]);
  const [purposes, setPurposes] = useState<string[]>([]);
  const [editing, setEditing] = useState<CertificateProfile | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.ca.profiles();
      setProfiles(result.profiles);
      setPurposes(result.purposes);
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
        A profile decides what a certificate may be used for, how long it lasts and how big its key
        is. The two built-in ones cannot be changed.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="primary" onClick={() => setAdding(true)}>
        <Plus size={15} aria-hidden="true" />
        New profile
      </button>

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Used for</th>
            <th scope="col">Purposes</th>
            <th scope="col">Validity</th>
            <th scope="col">Key</th>
            <th scope="col" className="actions" />
          </tr>
        </thead>
        <tbody>
          {profiles.map((one) => (
            <tr key={one.name}>
              <td className="mono">{one.name}</td>
              <td>{one.description}</td>
              <td>{one.purposes.join(", ")}</td>
              <td>{one.validity_days} days</td>
              <td>{one.key_size}-bit</td>
              <td className="actions">
                {one.built_in ? (
                  <span className="badge">built in</span>
                ) : (
                  <>
                    <button type="button" className="ghost" onClick={() => setEditing(one)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`Delete ${one.name}`}
                      onClick={async () => {
                        await api.ca.deleteProfile(one.name);
                        await load();
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {(adding || editing) && (
        <ProfileDialog
          purposes={purposes}
          existing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function ProfileDialog({
  purposes,
  existing,
  onClose,
  onSaved,
}: {
  purposes: string[];
  existing: CertificateProfile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [chosen, setChosen] = useState<string[]>(existing?.purposes ?? ["server"]);
  const [days, setDays] = useState(existing?.validity_days ?? 397);
  const [keySize, setKeySize] = useState(String(existing?.key_size ?? 2048));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "New certificate profile"}
      submitLabel="Save"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.ca.saveProfile({
            name,
            description,
            purposes: chosen,
            validity_days: days,
            key_size: Number(keySize),
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" hint="Lower case, letters, digits and hyphens">
        <input
          value={name}
          required
          disabled={Boolean(existing)}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Used for">
        <input
          value={description}
          placeholder="Mail gateway — TLS and S/MIME"
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Purposes">
        <div className="permission-grid">
          {purposes.map((purpose) => (
            <label className="checkbox" key={purpose}>
              <input
                type="checkbox"
                checked={chosen.includes(purpose)}
                onChange={(e) =>
                  setChosen((was) =>
                    e.target.checked ? [...was, purpose] : was.filter((one) => one !== purpose),
                  )
                }
              />
              {purpose}
            </label>
          ))}
        </div>
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
      <Field label="Key size">
        <Select value={keySize} onChange={(e) => setKeySize(e.target.value)}>
          <option value="2048">2048-bit RSA</option>
          <option value="3072">3072-bit RSA</option>
          <option value="4096">4096-bit RSA</option>
        </Select>
      </Field>
    </Modal>
  );
}
