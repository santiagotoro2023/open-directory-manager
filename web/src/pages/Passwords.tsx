import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import { ApiError, api, type PasswordManagerStatus } from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Loading } from "../components/Loading";
import { PickerField } from "../components/Picker";

type Tab = "vault" | "setup";

/**
 * The password manager: Vaultwarden on a member server, reached at the
 * console's own address and shown here, with the directory deciding who
 * has a seat.
 *
 * The Vault tab is the vault itself — its address is /vault on this
 * console, the same one the extension and the app use, so what an
 * administrator does here is what they would do there: the organisation,
 * its collections, which group sees which. That work stays in the vault
 * because the server cannot read a vault and neither can the console; that
 * is the point of it. The Setup tab walks through everything else in
 * order, saying at each step whether it is done, what to do and where.
 */
export function Passwords() {
  const [tab, setTab] = useState<Tab | null>(null);
  const [status, setStatus] = useState<PasswordManagerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [form, setForm] = useState({
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
      // The vault once it is usable; the walkthrough until then.
      setTab((current) => current ?? (result.installed && result.org_configured ? "vault" : "setup"));
      setForm((current) => ({
        ...current,
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
      setNotice("Saved and sent to the server; the first sync runs now.");
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
      setNotice("Sent to the server; a sync runs now.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) {
    return (
      <div className="content">
        <Loading />
      </div>
    );
  }

  const usable = Boolean(status?.installed && status.ca_ready);
  const groupCount = form.sync_groups.split(",").filter((part) => part.trim()).length;
  const vaultUrl = status?.vault_url ?? "";
  // The vault at this console's own origin, whichever name the browser
  // reached the console by: the page, the frame and the vault's own
  // requests then share one origin, which is what its frame-ancestors and
  // the browser's cookie rules require.
  const vaultHere = "/vault/";

  return (
    <div className="content">
      <div className="page-header">
        <h1>
          <KeyRound size={20} aria-hidden="true" /> Passwords
        </h1>
        <span className="spacer" />
        {usable && (
          <>
            <button
              type="button"
              className="ghost"
              onClick={() => window.open(vaultHere, "_blank", "noopener")}
            >
              <ExternalLink size={15} aria-hidden="true" />
              Open in a tab
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void applyNow()}>
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

      <nav className="tabs" aria-label="Password manager views">
        {(["vault", "setup"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            disabled={current === "vault" && !usable}
            onClick={() => setTab(current)}
          >
            {current === "vault" ? "Vault" : "Setup"}
          </button>
        ))}
      </nav>

      {tab === "vault" && status && (
        <div className="vault-frame">
          <iframe src={vaultHere} title="The vault" />
        </div>
      )}

      {tab === "setup" && status && (
        <>
          <InfoPanel page="password-manager">
            Vaultwarden, the open-source Bitwarden server, as part of the domain: reached at this
            console&rsquo;s own address, seats and teams from domain groups, sign-in with the domain
            account. The steps below are in the order they happen; a green one is done.
          </InfoPanel>

          <ol className="setup-steps">
            <Step
              n={1}
              done={status.ca_ready}
              title="A certificate authority"
              what="The console carries the vault's traffic over TLS it checks against the domain's own authority, so the domain needs one."
            >
              {status.ca_ready ? (
                <p className="muted">The domain has one. Nothing to do.</p>
              ) : (
                <Link className="button-link" to="/certificates">
                  Set one up under Certificates
                </Link>
              )}
            </Step>

            <Step
              n={2}
              done={status.installed}
              title="The password-manager role on a server"
              what="Any member server. Nobody connects to it directly: the vault lives at the console's address, and the console sends the server its address and certificate the moment the install finishes."
            >
              {status.installed ? (
                <dl className="definition">
                  <dt>Vault</dt>
                  <dd className="mono">{vaultUrl}</dd>
                  <dt>Carried to</dt>
                  <dd className="mono">{status.node_fqdn}</dd>
                  <dt>Last applied</dt>
                  <dd>
                    {status.last_applied_at ? new Date(status.last_applied_at).toLocaleString() : "never"}
                    {status.last_result && <span className="muted"> · {status.last_result}</span>}
                  </dd>
                  <dt>Admin page</dt>
                  <dd>
                    <a href={vaultHere + "admin"} target="_blank" rel="noopener">
                      {vaultUrl}/admin
                    </a>
                    <div className="muted">
                      Vaultwarden&rsquo;s own page for users, organisations and a test mail. It asks
                      for this token:
                    </div>
                    {status.admin_token ? (
                      <div className="token-row">
                        <code className="mono">
                          {showToken ? status.admin_token : "•".repeat(24)}
                        </code>
                        <button
                          type="button"
                          className="ghost small"
                          aria-label={showToken ? "Hide the token" : "Show the token"}
                          onClick={() => setShowToken((was) => !was)}
                        >
                          {showToken ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          aria-label="Copy the token"
                          onClick={() => void navigator.clipboard?.writeText(status.admin_token)}
                        >
                          <Copy size={14} aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <div className="muted">
                        Not reported yet — press <strong>Apply and sync now</strong>; the server sends
                        it back with the result. (It is also in{" "}
                        <span className="mono">/etc/odm/vaultwarden/admin-token</span> there.)
                      </div>
                    )}
                  </dd>
                </dl>
              ) : (
                <Link className="button-link" to="/roles">
                  Install it under Server Roles
                </Link>
              )}
            </Step>

            <Step
              n={3}
              done={usable && status.org_configured}
              title="The organisation, in the vault"
              what="A vault holds passwords per person; an organisation is what teams share. It is made inside the vault, by a person, because the server cannot read a vault and neither can this console."
              disabled={!usable}
            >
              <ol className="wiki-steps">
                <li>
                  Open the{" "}
                  <button type="button" className="inline-link" onClick={() => setTab("vault")}>
                    Vault tab
                  </button>
                  . The vault asks for an e-mail address first: type the domain account&rsquo;s
                  address &mdash; its mail attribute, or <em>name@domain</em> where it has none
                  (an administrator here: <span className="mono">administrator@{status.mail_domain}</span>) &mdash;
                  then <strong>Use single sign-on</strong>. The console signs you in, the vault
                  makes your account, and you choose a master password. This first account is
                  the organisation&rsquo;s owner.
                </li>
                <li>
                  <strong>New organisation</strong> &mdash; the domain&rsquo;s name will do. Inside
                  it, <strong>Collections</strong> → one per team (Sales, Finance, IT).
                </li>
                <li>
                  <strong>Organisation</strong> → <strong>Settings</strong> → <strong>API key</strong>{" "}
                  → <strong>View API key</strong>. Copy the client id and secret into step 4.
                </li>
              </ol>
            </Step>

            <Step
              n={4}
              done={status.org_configured}
              title="Connect the organisation"
              what="With its API key, the server keeps the organisation's members and groups in step with the directory. The secret is shown once in the vault and never here."
              disabled={!usable}
            >
              <div className="field-grid">
                <label className="field">
                  <span>Client id</span>
                  <input
                    value={form.org_client_id}
                    placeholder="organization.xxxxxxxx-…"
                    onChange={(e) => setForm({ ...form, org_client_id: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Client secret</span>
                  <input
                    type="password"
                    value={form.org_client_secret}
                    placeholder={status.org_configured ? "unchanged" : ""}
                    autoComplete="new-password"
                    onChange={(e) => setForm({ ...form, org_client_secret: e.target.value })}
                  />
                </label>
              </div>
            </Step>

            <Step
              n={5}
              done={status.org_configured && status.sync_groups.length > 0}
              title="Who gets a seat"
              what="Everyone in these domain groups is invited; each group becomes a group of the organisation with the same members. Someone who leaves them all loses the seat at the next sync."
              disabled={!usable}
            >
              <div className="field-grid">
                <label className="field">
                  <span>Groups</span>
                  <PickerField
                    kind="principal"
                    as="principal"
                    ariaLabel="Groups"
                    placeholder="%Sales, %Finance"
                    multiple
                    value={form.sync_groups}
                    onChange={(value) => setForm({ ...form, sync_groups: value })}
                  />
                  <small>
                    {groupCount === 0
                      ? "Empty invites nobody."
                      : `${groupCount} group${groupCount === 1 ? "" : "s"}.`}
                  </small>
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
                  <small>Also runs at every Save and every Apply.</small>
                </label>
              </div>
            </Step>

            <Step
              n={6}
              done={status.installed}
              title="How people sign in"
              what="The console is the domain's OpenID provider. The vault sends people here; a browser on a domain-joined desktop signs them in with the ticket it already holds, no typing. Each person still chooses a master password the first time — it is what encrypts their vault, and nothing on the server can stand in for it."
              disabled={!usable}
            >
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
                  <small>
                    The vault&rsquo;s own password sign-in is off, so a disabled domain account is a
                    closed vault at once.
                  </small>
                </div>
              </div>
            </Step>

            <Step
              n={7}
              done={status.smtp_configured}
              title="Invitations by mail"
              optional
              what="A person invited is told by mail. Without a relay the invitation still exists — the organisation's owner sees it under Members and can hand the link over — but a relay is what makes joining self-service."
              disabled={!usable}
            >
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
                  <input
                    value={form.smtp_username}
                    onChange={(e) => setForm({ ...form, smtp_username: e.target.value })}
                  />
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
            </Step>

            {usable && (
              <li className="setup-save">
                <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                  {busy ? "Saving…" : "Save and apply steps 4–7"}
                </button>
                <span className="muted">Sends everything to the server and runs a sync now.</span>
              </li>
            )}

            <Step
              n={8}
              title="Give each group its collection"
              what="Once the first sync has run, the organisation's groups mirror the domain groups. Which collection each sees is decided once, in the vault; after that, joining the domain group is what gives someone the team's passwords."
              disabled={!status.org_configured}
            >
              <ol className="wiki-steps">
                <li>
                  <button type="button" className="inline-link" onClick={() => setTab("vault")}>
                    Vault tab
                  </button>{" "}
                  → <strong>Organisation</strong> → <strong>Groups</strong>: each group → its
                  collection.
                </li>
                <li>
                  <strong>Members</strong>: someone who has accepted shows as <em>Accepted</em>{" "}
                  &mdash; tick and <strong>Confirm</strong>. That is the moment the
                  organisation&rsquo;s key is handed to them, which only a person holding that key
                  can do.
                </li>
              </ol>
            </Step>

            <Step
              n={9}
              title="Put it on the workstations"
              what="Bitwarden's browser extension and desktop app arrive by policy, already pointed at this vault, and leave when the policy does."
              disabled={!status.org_configured}
            >
              <p>
                <Link className="button-link" to="/policy">
                  Group Policy
                </Link>{" "}
                → the workstations&rsquo; policy object → <strong>Computer</strong> →{" "}
                <strong>Software and drivers</strong> → <strong>Password manager</strong>.
              </p>
            </Step>
          </ol>
        </>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  what,
  done = false,
  optional = false,
  disabled = false,
  children,
}: {
  n: number;
  title: string;
  what: string;
  done?: boolean;
  optional?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const state = done ? "done" : disabled ? "waiting" : "open";
  return (
    <li className={`setup-step ${state}`} aria-disabled={disabled || undefined}>
      <div className="setup-marker" aria-hidden="true">
        {done ? <Check size={16} /> : n}
      </div>
      <div className="setup-body">
        <h3>
          {title}
          {optional && <span className="badge">optional</span>}
          {done && <span className="badge success">done</span>}
        </h3>
        <p className="muted">{what}</p>
        <div className="setup-content">{children}</div>
      </div>
    </li>
  );
}
