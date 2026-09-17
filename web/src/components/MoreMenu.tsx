import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MenuItem } from "./ContextMenu";

/**
 * The rest of a page's actions, behind one button.
 *
 * A page header has room for what people do all the time; everything else
 * wrapping onto a second line is worse than one more click. Same look as
 * the right-click menu, opened from a button instead.
 */
export function MoreMenu({ label = "More", items }: { label?: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="more-menu" ref={box}>
      <button
        type="button"
        className="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="context-menu more-menu-list" role="menu">
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
                      setOpen(false);
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
      )}
    </div>
  );
}
