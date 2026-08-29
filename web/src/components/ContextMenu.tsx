import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label?: string;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a heading rather than a command. */
  heading?: boolean;
  /** Renders a divider; every other field is ignored. */
  separator?: boolean;
}

interface Position {
  x: number;
  y: number;
}

/**
 * Right-click menus, as a hook rather than a wrapper component.
 *
 * `bind(items)` goes on whatever should be right-clickable; `menu` is rendered
 * once by the same component. Keeping the open menu in one place means a
 * second right-click anywhere closes the first.
 */
export function useContextMenu() {
  const [at, setAt] = useState<Position | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setAt(null);
    // `click` rather than `mousedown` so the menu's own buttons still fire.
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  // Keep the menu on screen when opened near an edge.
  useEffect(() => {
    const element = box.current;
    if (!element || !at) return;
    const rect = element.getBoundingClientRect();
    const x = Math.min(at.x, window.innerWidth - rect.width - 8);
    const y = Math.min(at.y, window.innerHeight - rect.height - 8);
    if (x !== at.x || y !== at.y) setAt({ x, y });
  }, [at]);

  function bind(next: MenuItem[]) {
    return {
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setItems(next);
        setAt({ x: event.clientX, y: event.clientY });
      },
    };
  }

  const menu = at ? (
    <div
      className="context-menu"
      role="menu"
      ref={box}
      style={{ left: at.x, top: at.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <ul>
        {items.map((item, index) => {
          if (item.separator) return <hr key={`sep-${index}`} />;
          if (item.heading)
            return (
              <li key={`head-${index}`} className="group-label">
                {item.label}
              </li>
            );
          return (
            <li key={item.label ?? index}>
              <button
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : ""}
                disabled={item.disabled}
                onClick={() => {
                  setAt(null);
                  item.onSelect?.();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  return { bind, menu };
}
