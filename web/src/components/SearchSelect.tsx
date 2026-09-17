import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export interface SearchOption {
  value: string;
  label: string;
  /** Shown beside the label, in the list and in the box: the code itself. */
  hint?: string;
  /** Extra words a search should find it by. */
  keywords?: string;
}

/**
 * A dropdown with a search box, for lists nobody should have to know by
 * heart: locales, keyboard layouts, time zones. Same look as Select, with
 * a filter on top; typing narrows the list, Enter takes the first match.
 *
 * `multiple` turns it into chips — each chosen item shown with its own ×,
 * the list adding to them. `allowCustom` keeps a value the list does not
 * know (an unusual locale) rather than losing it, and lets one be typed:
 * the typed text is offered as a choice of its own at the bottom.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder,
  multiple = false,
  allowCustom = false,
  emptyLabel = "",
  ariaLabel,
  id,
}: {
  options: SearchOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  placeholder?: string;
  multiple?: boolean;
  allowCustom?: boolean;
  /** For single selects: what an empty value is called ("Same as the language"). */
  emptyLabel?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, flip: false });
  const trigger = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const chosen = useMemo(
    () => (Array.isArray(value) ? value : value ? [value] : []),
    [value],
  );
  const byValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const candidates = multiple ? options.filter((option) => !chosen.includes(option.value)) : options;
    const matches = needle
      ? candidates.filter((option) =>
          `${option.label} ${option.value} ${option.hint ?? ""} ${option.keywords ?? ""}`
            .toLowerCase()
            .includes(needle),
        )
      : candidates;
    const list = matches.slice(0, 200);
    if (allowCustom && needle && !byValue.has(query.trim()) && !chosen.includes(query.trim())) {
      list.push({ value: query.trim(), label: `Use “${query.trim()}”`, keywords: "" });
    }
    return list;
  }, [options, query, multiple, chosen, allowCustom, byValue]);

  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const flip = below < 300 && rect.top > below;
    setBox({ left: rect.left, top: flip ? rect.top : rect.bottom + 4, width: rect.width, flip });
  };

  useLayoutEffect(() => {
    if (open) {
      place();
      search.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const reposition = () => place();
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function pick(option: SearchOption) {
    if (multiple) {
      onChange([...chosen, option.value]);
      setQuery("");
      search.current?.focus();
    } else {
      onChange(option.value);
      setOpen(false);
      setQuery("");
    }
  }

  function remove(item: string) {
    onChange(multiple ? chosen.filter((entry) => entry !== item) : "");
  }

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        setActive((current) => Math.min(current + 1, shown.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
        break;
      case "Enter":
        event.preventDefault();
        if (shown[active]) pick(shown[active]);
        break;
      case "Backspace":
        if (multiple && !query && chosen.length) remove(chosen[chosen.length - 1]);
        break;
    }
  }

  const describe = (item: string) => {
    const option = byValue.get(item);
    return option ? option.label : item;
  };

  return (
    <>
      <div
        ref={trigger}
        id={id}
        className={`search-select${open ? " open" : ""}${multiple ? " multiple" : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        tabIndex={0}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (!open && ["Enter", " ", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {multiple ? (
          <span className="search-select-chips">
            {chosen.map((item) => (
              <span key={item} className="chip">
                {describe(item)}
                <button
                  type="button"
                  aria-label={`Remove ${describe(item)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(item);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
            {chosen.length === 0 && <span className="search-select-placeholder">{placeholder}</span>}
          </span>
        ) : chosen.length ? (
          <span className="search-select-value">
            {describe(chosen[0])}
            {byValue.get(chosen[0])?.hint && <small>{byValue.get(chosen[0])!.hint}</small>}
          </span>
        ) : (
          <span className="search-select-placeholder">{emptyLabel || placeholder}</span>
        )}
        <ChevronDown size={16} aria-hidden="true" className="search-select-caret" />
      </div>
      {open && (
        <div
          ref={menu}
          className="select-menu search-select-menu"
          style={{
            left: box.left,
            minWidth: box.width,
            maxWidth: `calc(100vw - ${box.left + 12}px)`,
            ...(box.flip ? { bottom: window.innerHeight - box.top + 4 } : { top: box.top }),
          }}
        >
          <input
            ref={search}
            className="search-select-search"
            value={query}
            placeholder="Search…"
            aria-label="Search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul role="listbox">
            {!multiple && emptyLabel && !query && (
              <li>
                <button type="button" role="option" aria-selected={chosen.length === 0} onClick={() => { onChange(""); setOpen(false); }}>
                  <span>{emptyLabel}</span>
                  {chosen.length === 0 && <Check size={16} aria-hidden="true" />}
                </button>
              </li>
            )}
            {shown.length === 0 && <li className="select-empty">Nothing matches</li>}
            {shown.map((option, index) => (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={chosen.includes(option.value)}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(option)}
                >
                  <span>
                    {option.label}
                    {option.hint && <small>{option.hint}</small>}
                  </span>
                  {chosen.includes(option.value) && <Check size={16} aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
