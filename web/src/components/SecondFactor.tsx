import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ApiError, api } from "../api";
import { Field, Modal } from "./Modal";

/**
 * Enrolling a second factor.
 *
 * Two steps on purpose: a secret is issued, and it only becomes required once
 * a code from the device has been accepted. Nobody locks themselves out with a
 * QR code they never scanned.
 */
export function SecondFactorDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{
    enrolled: boolean;
    pending: boolean;
    left: number;
  } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.auth2fa.state();
      setState({
        enrolled: result.enrolled,
        pending: result.pending,
        left: result.recovery_codes_left,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.auth2fa.begin());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      setRecovery((await api.auth2fa.confirm(code)).recovery_codes);
      setSetup(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.auth2fa.remove(code);
      setCode("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Second factor"
      submitLabel="Close"
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={onClose}
    >
      {recovery ? (
        <>
          <p>
            <strong>Enrolled.</strong> Keep these recovery codes somewhere other than the device
            with the authenticator on it. Each works once, and they are not shown again.
          </p>
          <ul className="permission-list">
            {recovery.map((entry) => (
              <li key={entry} className="mono">
                {entry}
              </li>
            ))}
          </ul>
        </>
      ) : setup ? (
        <>
          <p>
            Scan this with an authenticator app or a password manager, then type the code it shows
            to finish.
          </p>
          <div className="qr">
            <QrCode value={setup.uri} />
          </div>
          <Field label="If you cannot scan it" hint="Enter this key by hand instead">
            <input className="mono" value={setup.secret} readOnly />
          </Field>
          <Field label="Code from the app">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div className="actions-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              Finish
            </button>
          </div>
        </>
      ) : state?.enrolled ? (
        <>
          <p>
            A code is required when you sign in. {state.left} recovery{" "}
            {state.left === 1 ? "code" : "codes"} left.
          </p>
          <Field
            label="Code from the app"
            hint="Required to remove it: otherwise a stolen session could take it off"
          >
            <input
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div className="actions-row">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Stop requiring a code
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            A code from your phone or password manager, as well as your password. The same
            enrolment is used wherever a policy asks for a second factor at a machine.
          </p>
          <div className="actions-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void begin()}>
              Set one up
            </button>
          </div>
        </>
      )}
      {!recovery && !setup && <PhoneApproval onError={setError} />}
    </Modal>
  );
}

/**
 * A QR code, drawn here rather than fetched.
 *
 * The value is an otpauth:// URI containing the secret. Sending it to a
 * rendering service would be sending the secret to a third party, which is the
 * one thing this feature cannot do — so the modules are computed locally and
 * rendered as plain rectangles.
 */
function QrCode({ value }: { value: string }) {
  const symbol = QRCode.create(value, { errorCorrectionLevel: "M" });
  const size = symbol.modules.size;
  const bits = symbol.modules.data;
  const matrix: boolean[][] = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => Boolean(bits[y * size + x])),
  );
  const scale = 6;
  const quiet = 4;
  const side = (size + quiet * 2) * scale;

  return (
    <svg
      width={side}
      height={side}
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label="Enrolment QR code"
    >
      <rect width={side} height={side} fill="#ffffff" />
      {matrix.map((row, y) =>
        row.map((on, x) =>
          on ? (
            <rect
              key={`${x}-${y}`}
              x={(x + quiet) * scale}
              y={(y + quiet) * scale}
              width={scale}
              height={scale}
              fill="#111827"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

/**
 * Approval on a phone, beside the code.
 *
 * The same two steps as a code: a topic is issued and the phone is
 * subscribed to it, and it only counts once the phone has answered a
 * notification — the tap on Confirm is the proof that the right phone is
 * listening. The state is polled while that is pending, so the dialog
 * notices the tap without anybody pressing anything here.
 */
function PhoneApproval({ onError }: { onError: (message: string | null) => void }) {
  const [state, setState] = useState<{
    available: boolean;
    enrolled: boolean;
    pending: boolean;
    subscribe_url: string | null;
    topic: string | null;
    server_url: string;
    trust: "prompt" | "public";
    trust_url: string;
    fingerprint: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.auth2fa.pushState());
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the phone has yet to answer, look again every couple of seconds.
  useEffect(() => {
    if (!state?.pending) return undefined;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [state?.pending, load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  if (!state.available && !state.enrolled && !state.pending) {
    return (
      <>
        <h3 className="section-title">Approval on your phone</h3>
        <p className="muted">
          Not set up on this domain. It needs the notification server that the domain
          controller&rsquo;s setup installs — see Wiki &rarr; Operations &rarr; Phone approvals.
        </p>
      </>
    );
  }

  return (
    <>
      <h3 className="section-title">Approval on your phone</h3>
      {state.enrolled ? (
        <>
          <p>
            Where a policy asks for it, signing in sends your phone an Approve / Deny
            notification instead of asking for a code.
          </p>
          <Field
            label="Code from the app"
            hint="Required to remove the phone when you also have a code enrolled"
          >
            <input
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div className="actions-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void run(() => api.auth2fa.pushRemove(code))}
            >
              Remove this phone
            </button>
          </div>
        </>
      ) : state.pending && state.subscribe_url ? (
        <>
          <ol className="steps">
            <li>
              Install the <strong>ntfy</strong> app (F-Droid, Google Play or the App Store).
            </li>
            <li>
              In the app (1.24 or later): <strong>+</strong> &rarr; <em>Subscribe to topic</em>{" "}
              &rarr; <em>Use another server</em>, then enter the server and the topic below
              {state.trust === "prompt"
                ? " and tap Subscribe. The app says the certificate is not one it knows and shows its fingerprint — compare it with the one below, then tap Trust. Asked once per phone: a phone that has trusted this server before can scan the code instead."
                : " — or scan this with the phone's camera, which opens the app on that dialog."}
            </li>
            <li>Tap <strong>Confirm</strong> on the notification that arrives.</li>
          </ol>
          <div className="qr">
            <QrCode value={state.subscribe_url} />
          </div>
          {state.trust === "prompt" && (
            <Field label="Certificate fingerprint, as the app will show it">
              <input className="mono" value={state.fingerprint} readOnly />
            </Field>
          )}
          <Field label="Server">
            <input className="mono" value={state.server_url} readOnly />
          </Field>
          <Field label="Topic" hint="This is the secret: anyone who knows it receives your approvals">
            <input className="mono" value={state.topic ?? ""} readOnly />
          </Field>
          <div className="actions-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.auth2fa.pushTest();
                  setSent(true);
                })
              }
            >
              {sent ? "Send the confirmation again" : "Send the confirmation"}
            </button>
            <span className="muted">Waiting for the phone&hellip;</span>
          </div>
        </>
      ) : (
        <>
          <p>
            Approve sign-ins with a tap instead of typing a code. Uses the ntfy app on your
            phone.
          </p>
          <div className="actions-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.auth2fa.pushBegin();
                  setSent(false);
                })
              }
            >
              Set up my phone
            </button>
          </div>
        </>
      )}
    </>
  );
}
