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
            A code from your phone or password manager, as well as your password. It protects this
            console only — signing in to a workstation is unaffected.
          </p>
          <div className="actions-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void begin()}>
              Set one up
            </button>
          </div>
        </>
      )}
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
