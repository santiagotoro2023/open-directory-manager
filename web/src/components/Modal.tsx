import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function Modal({
  title,
  submitLabel,
  busy,
  error,
  onSubmit,
  onClose,
  wide,
  children,
}: {
  title: string;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  /** For dialogs carrying a table or several groups of fields. */
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [stale, setStale] = useState(false);

  // A message about a value stops being true the moment somebody changes one.
  // Leaving it up while the field it names is being corrected reads as a
  // second, different failure; it comes back if the next attempt fails too.
  useEffect(() => setStale(false), [error]);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  /* Through a portal, because a dialog opened from inside another dialog
     would otherwise be a <form> nested inside a <form>: the browser gives the
     inner submit button the outer form as its owner, so the inner dialog's
     button did nothing at all. */
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={wide ? "modal wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialog}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <form
          onSubmit={submit}
          onInput={() => setStale(true)}
          onKeyDown={(event) => searching(event) && event.preventDefault()}
        >
          <div className="modal-body">{children}</div>
          {error && !stale && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Working…" : submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Enter in a search box searches; it does not submit the dialog.
 *
 * Typing a name and pressing return is reflex, and inside a form that reflex
 * activated the submit button — closing the picker on whatever happened to be
 * selected at the time. */
function searching(event: React.KeyboardEvent): boolean {
  if (event.key !== "Enter") return false;
  const target = event.target as HTMLInputElement | null;
  if (!target) return false;
  return target.type === "search" || Boolean(target.closest?.(".search"));
}
