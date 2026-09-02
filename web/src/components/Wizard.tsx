import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

export interface WizardStep {
  /** The step's name in the rail on the left. */
  title: string;
  /** One line under the heading saying what this step decides. */
  hint?: string;
  fields: ReactNode;
  /** Why this step cannot be left yet. Undefined means it can. */
  incomplete?: string;
}

/**
 * A setup taken a few fields at a time.
 *
 * For the handful of things with too many parts to meet as one form — a VPN
 * tunnel, a DHCP scope, a RADIUS device — where the order the questions come
 * in is most of the explanation.
 *
 * It never becomes the only way in. Every step is reachable by clicking it,
 * so nothing has to be answered before anything else can be looked at, and
 * "Show every setting" lays the whole thing out as the plain form it would
 * otherwise have been. The wizard is a route through the form, not a gate in
 * front of it.
 */
export function Wizard({
  title,
  steps,
  submitLabel,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  steps: WizardStep[];
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [flat, setFlat] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;
  // What is still missing, wherever it is: the operator finds out here rather
  // than from the server after pressing the last button.
  const blocking = steps.find((step) => step.incomplete)?.incomplete;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (flat || last) {
      if (!blocking) onSubmit();
      return;
    }
    setIndex(index + 1);
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide wizard" role="dialog" aria-modal="true" aria-label={title} ref={dialog}>
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={submit}>
          <div className="wizard-body">
            {!flat && (
              <ol className="wizard-rail" aria-label="Steps">
                {steps.map((step, position) => (
                  <li key={step.title}>
                    <button
                      type="button"
                      className={position === index ? "active" : ""}
                      aria-current={position === index ? "step" : undefined}
                      onClick={() => setIndex(position)}
                    >
                      <span className="wizard-number">
                        {step.incomplete ? position + 1 : <Check size={12} aria-hidden="true" />}
                      </span>
                      <span className="truncate">{step.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}

            <div className="wizard-step modal-body">
              {flat ? (
                steps.map((step) => (
                  <section key={step.title}>
                    <h3 className="section-title">{step.title}</h3>
                    {step.hint && <p className="muted">{step.hint}</p>}
                    {step.fields}
                  </section>
                ))
              ) : (
                <>
                  <h3>{current.title}</h3>
                  {current.hint && <p className="muted">{current.hint}</p>}
                  {current.fields}
                </>
              )}
            </div>
          </div>

          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}

          <footer>
            <button type="button" className="ghost" onClick={() => setFlat(!flat)}>
              {flat ? "Take me through it" : "Show every setting"}
            </button>
            <span className="spacer" />
            {!flat && index > 0 && (
              <button type="button" className="ghost" onClick={() => setIndex(index - 1)}>
                Back
              </button>
            )}
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            {flat || last ? (
              <button type="submit" className="primary" disabled={busy || Boolean(blocking)}>
                {busy ? "Working…" : submitLabel}
              </button>
            ) : (
              <button type="submit" className="primary">
                Next
              </button>
            )}
          </footer>
          {/* Said once, at the end, rather than as a red field the moment
              somebody tabs past it. */}
          {(flat || last) && blocking && <p className="wizard-blocking">{blocking}</p>}
        </form>
      </div>
    </div>,
    document.body,
  );
}
