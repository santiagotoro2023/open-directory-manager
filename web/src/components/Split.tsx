import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// Pane widths are per-operator furniture, not domain state: they belong in the
// browser, and a browser that refuses to store them must not break the layout.
function remember(key: string, width: number) {
  try {
    localStorage.setItem(`odm.split.${key}`, String(width));
  } catch {
    /* private windows and blocked site data are not an error here */
  }
}

function recall(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(`odm.split.${key}`));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Two panes with a draggable border between them.
 *
 * The divider is a real separator control: it takes focus and moves with the
 * arrow keys, so the layout is not mouse-only.
 */
export function Split({
  id,
  label,
  initial = 260,
  min = 180,
  max = 640,
  side,
  aside,
  children,
}: {
  id: string;
  label: string;
  initial?: number;
  min?: number;
  max?: number;
  side: ReactNode;
  // A detail panel pinned to the far edge, outside the resizable pair.
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(() => recall(id, initial));
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max]);

  useEffect(() => {
    if (!dragging) return;
    function move(event: MouseEvent) {
      const left = frame.current?.getBoundingClientRect().left ?? 0;
      setWidth(clamp(event.clientX - left));
    }
    function stop() {
      setDragging(false);
    }
    // The cursor has to survive leaving the divider, so it is set on the body
    // for the duration of the drag and taken off again when it ends.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [dragging, clamp]);

  useEffect(() => remember(id, width), [id, width]);

  return (
    <div className="split" ref={frame}>
      <div className="split-side" style={{ width }}>
        {side}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        className={dragging ? "split-handle dragging" : "split-handle"}
        onMouseDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setWidth(initial)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 48 : 16;
          if (event.key === "ArrowLeft") setWidth((w) => clamp(w - step));
          else if (event.key === "ArrowRight") setWidth((w) => clamp(w + step));
          else return;
          event.preventDefault();
        }}
      />
      <div className="split-main">{children}</div>
      {aside}
    </div>
  );
}
