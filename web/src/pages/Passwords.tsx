import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { ApiError, api, type PasswordManagerStatus } from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Loading } from "../components/Loading";
import { PickerField } from "../components/Picker";

/**
 * The password manager: Vaultwarden on a member server, with the directory
 * deciding who has a seat.
 *
 * Three things are decided here and nowhere else: where the vault is, which
 * groups' members get a seat (the directory connector on the node keeps the
 * organisation's groups and members in step with them), and how the vault
 * sends its invitations. Everything about what is *in* the vault — the
 * organisation, its collections, which group sees which — is decided in the
 * vault itself, by its own administrator, because the server cannot read a
 * vault and neither can the console; that is the point of it.
 */
export function Passwords() {
  const [status, setStatus] = useState<PasswordManagerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    vault_url: "",
    org_client_id: "",
    org_client_secret: "",
    sync_groups: "",
    sync_every_hours: 1,
    sso_enabled: true,
    sso_only: true,
    smtp_host: "",
    smtp_port: 587,
    smtp_from: "",
    smtp_username: "",
    smtp_password: "",
  });

  const load = useCallback(async () => {
    try {
      const result = await api.passwords.status();
      setStatus(result);
      setForm((current) => ({
        ...current,
        vault_url: result.vault_url,
        org_client_id: result.org_client_id,
        sync_groups: result.sync_groups.map((group) => `%${group}`).join(", "),
        sync_every_hours: result.sync_every_hours,
        sso_enabled: result.sso_enabled,
        sso_only: result.sso_only,
        smtp_host: result.smtp_host,
        smtp_port: result.smtp_port,
        smtp_from: result.smtp_from,
        smtp_username: result.smtp_username,
      }));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const groups = form.sync_groups
        .split(",")
        .map((part) => part.trim().replace(/^%/, ""))
        .filter(Boolean);
      await api.passwords.configure({
        vault_url: form.vault_url,
        org_client_id: form.org_client_id,
        org_client_secret: form.org_client_secret,
        sync_groups: groups,
        sync_every_hours: form.sync_every_hours,
        sso_enabled: form.sso_enabled,
        sso_only: form.sso_only,
        smtp_host: form.smtp_host,
        smtp_port: form.smtp_port,
        smtp_from: form.smtp_from,
        smtp_username: form.smtp_username,
        smtp_password: form.smtp_password,
      });
      setForm((current) => ({ ...current, org_client_secret: "", smtp_password: "" }));
      setNotice("Saved and sent to the node; the first sync runs now.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyNow() {
    setBusy(true);
    setNotice(null);
    try {
      await api.passwords.apply();
      setNotice("Sent to the node; a sync runs now.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) return <Loading />;

  return (
    <>
      <div className="page-header">
        <h1>
          <KeyRound size={20} aria-hidden="true" /> Passwords
        </h1>
        <span className="spacer" />
        {status?.installed && (
          <>
            <a className="button secondary" href={status.vault_url} target="_blank" rel="noopener">
              <ExternalLink size={15} aria-hidden="true" />
              Open the vault
            </a>
            <button type="button" className="secondary" disabled={busy} onClick={() => void applyNow()}>
              <RefreshCw size={15} aria-hidden="true" />
              Apply and sync now
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <InfoPanel page="password-manager">
        Vaultwarden, the open-source Bitwarden server, run by the password-manager role. People
        get a seat by being in a domain group and sign in with their domain account; inside the
        vault, an organisation holds the collections and its administrator gives each group its
        collection once. The browser extension and the desktop app are installed and pointed at
        the vault by the <em>Password manager</em> policy setting.
      </InfoPanel>

      {status && !status.installed && (
        <div className="detail-card">
          <h3 className="section-title">Not installed yet</h3>
          <p className="muted">
            Install the <strong>Password manager</strong> role on a member server under Server
            Roles. It takes port 443 of that machine, so choose one that does not already serve
            HTTPS. The vault, its data and the sync all live there.
          </p>
        </div>
      )}

      {status?.installed && (
        <>
          <div className="detail-grid">
            <div className="detail-card">
              <h3 className="section-title">The vault</h3>
              <dl className="definition">
                <dt>Server</dt>
                <dd className="mono">{status.node_fqdn}</dd>
                <dt>Address</dt>
                <dd className="mono">{status.vault_url}</dd>
                <dt>Organisation key</dt>
                <dd>{status.org_configured ? "set — the directory sync runs" : "not set — no sync yet"}</dd>
                <dt>Sign-in</dt>
                <dd>
                  {status.sso_enabled
                    ? status.sso_only
                      ? "domain account, through the console"
                      : "domain account or the vault's own password"
                    : "the vault's own password only"}
                </dd>
                <dt>Sync account</dt>
                <dd className="mono">{status.sync_account || "—"}</dd>
                <dt>Last applied</dt>
                <dd>
                  {status.last_applied_at ? new Date(status.last_applied_at).toLocaleString() : "never"}
                  {status.last_result && <span className="muted"> · {status.last_result}</span>}
                </dd>
              </dl>
            </div>
            <div className="detail-card">
              <h3 className="section-title">First time</h3>
              <ol className="wiki-steps">
                <li>Open the vault and create the first account: it will be the organisation's owner.</li>
                <li>In the vault, create an organisation (Example Corp) and its collections — one per team.</li>
                <li>Organisation → Settings → API key: paste the client id and secret below.</li>
                <li>Choose the groups whose members get a seat, and save.</li>
                <li>Back in the organisation: Groups now mirror those directory groups — give each its collection.</li>
              </ol>
            </div>
          </div>

          <div className="detail-card">
            <h3 className="section-title">Directory sync</h3>
            <div className="field-grid">
              <label className="field">
                <span>Vault address</span>
                <input
                  value={form.vault_url}
                  placeholder={`https://${status.node_fqdn}`}
                  onChange={(e) => setForm({ ...form, vault_url: e.target.value })}
                />
                <small>What people and the browser extension connect to. The server's name unless you front it with another.</small>
              </label>
              <label className="field">
                <span>Organisation client id</span>
                <input
                  value={form.org_client_id}
                  placeholder="organization.xxxxxxxx-…"
                  onChange={(e) => setForm({ ...form, org_client_id: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Organisation client secret</span>
                <input
                  type="password"
                  value={form.org_client_secret}
                  placeholder={status.org_configured ? "unchanged" : ""}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, org_client_secret: e.target.value })}
                />
                <small>From the organisation's settings in the vault. Shown once there; never shown here.</small>
              </label>
              <label className="field">
                <span>Groups whose members get a seat</span>
                <PickerField
                  kind="principal"
                  as="principal"
                  ariaLabel="Groups"
                  placeholder="%Sales, %Finance"
                  multiple
                  value={form.sync_groups}
                  onChange={(value) => setForm({ ...form, sync_groups: value })}
                />
                <small>Each becomes a group of the organisation with the same members. Empty invites nobody.</small>
              </label>
              <label className="field">
                <span>Sync every (hours)</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={form.sync_every_hours}
                  onChange={(e) => setForm({ ...form, sync_every_hours: Number(e.target.value) })}
                />
              </label>
            </div>

            <h3 className="section-title">Sign-in</h3>
            <p className="muted">
              The console is the domain&rsquo;s OpenID provider: the vault sends people here, and a
              browser on a domain-joined desktop signs them in with the ticket it already holds.
              Each person still sets a master password of their own — it is what encrypts their
              vault, and nothing on the server can stand in for it.
            </p>
            <div className="field-grid">
              <div className="field">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.sso_enabled}
                    onChange={(e) => setForm({ ...form, sso_enabled: e.target.checked })}
                  />
                  Sign in with the domain account
                </label>
                <small>Off, the vault asks for its own account password, as Bitwarden does anywhere.</small>
              </div>
              <div className="field">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.sso_only}
                    disabled={!form.sso_enabled}
                    onChange={(e) => setForm({ ...form, sso_only: e.target.checked })}
                  />
                  … and only that way
                </label>
                <small>The vault&rsquo;s own password sign-in is switched off, so the directory is the only door.</small>
              </div>
            </div>

            <h3 className="section-title">Invitations by mail</h3>
            <p className="muted">
              A person invited is told by mail. Without a relay the invitation still exists — the
              organisation's administrator sees it in the vault and can hand the link over — but
              a relay is what makes joining self-service.
            </p>
            <div className="field-grid">
              <label className="field">
                <span>Mail server</span>
                <input
                  value={form.smtp_host}
                  placeholder="mail.corp.example.internal"
                  onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Port</span>
                <input
                  type="number"
                  value={form.smtp_port}
                  onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })}
                />
                <small>587 with STARTTLS, or 465.</small>
              </label>
              <label className="field">
                <span>From</span>
                <input
                  value={form.smtp_from}
                  placeholder="vault@corp.example.internal"
                  onChange={(e) => setForm({ ...form, smtp_from: e.target.value })}
                />
              </label>
              <label className="field">
                <span>User name</span>
                <input value={form.smtp_username} onChange={(e) => setForm({ ...form, smtp_username: e.target.value })} />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={form.smtp_password}
                  placeholder={status.smtp_configured ? "unchanged" : ""}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, smtp_password: e.target.value })}
                />
              </label>
            </div>
            <div className="actions-row">
              <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save and apply"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
