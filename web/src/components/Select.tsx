import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

/* A native <select> draws its closed control from CSS and its open list from
   the operating system. appearance:none reaches the first and nothing reaches
   the second, which is why the console looked like itself until a dropdown was
   opened. This draws both.

   The props are the ones the native element took, so a call site changes only
   its tag: the children stay <option> elements and onChange still receives
   something with target.value. */

type Option = { value: string; label: ReactNode; text: string; disabled: boolean }

type Props = {
  value?: string
  onChange?: (event: { target: { value: string } }) => void
  children?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
  title?: string
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ""
}

function options(children: ReactNode): Option[] {
  const found: Option[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== "option") return
    const props = child.props as { value?: string; children?: ReactNode; disabled?: boolean }
    found.push({
      value: String(props.value ?? textOf(props.children)),
      label: props.children,
      text: textOf(props.children),
      disabled: Boolean(props.disabled),
    })
  })
  return found
}

export default function Select({
  value,
  onChange,
  children,
  disabled,
  id,
  className,
  title,
  ...rest
}: Props) {
  const items = options(children)
  const selected = items.findIndex((item) => item.value === value)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, flip: false })
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)

  // Fixed, not absolute: a dropdown opened in a modal or a scrolling panel
  // would otherwise be cut off by the ancestor that clips it.
  const place = () => {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    const below = window.innerHeight - rect.bottom
    const flip = below < 240 && rect.top > below
    setBox({
      left: rect.left,
      top: flip ? rect.top : rect.bottom + 4,
      width: rect.width,
      flip,
    })
  }

  useLayoutEffect(() => {
    if (open) place()
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !list.current?.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    const reposition = () => place()
    document.addEventListener("mousedown", close)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    return () => {
      document.removeEventListener("mousedown", close)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    }
  }, [open])

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" })
  }, [open, active])

  const choose = (index: number) => {
    const item = items[index]
    if (!item || item.disabled) return
    setOpen(false)
    button.current?.focus()
    if (item.value !== value) onChange?.({ target: { value: item.value } })
  }

  const move = (step: number) => {
    let next = active
    for (let tries = 0; tries < items.length; tries++) {
      next = (next + step + items.length) % items.length
      if (!items[next].disabled) break
    }
    setActive(next)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault()
        setActive(selected < 0 ? 0 : selected)
        setOpen(true)
      }
      return
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault()
        setOpen(false)
        break
      case "ArrowDown":
        event.preventDefault()
        move(1)
        break
      case "ArrowUp":
        event.preventDefault()
        move(-1)
        break
      case "Home":
        event.preventDefault()
        setActive(0)
        break
      case "End":
        event.preventDefault()
        setActive(items.length - 1)
        break
      case "Enter":
      case " ":
        event.preventDefault()
        choose(active)
        break
    }
  }

  const label = selected >= 0 ? items[selected].label : ""

  return (
    <>
      <button
        {...rest}
        ref={button}
        id={id}
        type="button"
        title={title}
        disabled={disabled}
        className={["select", className].filter(Boolean).join(" ")}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        onKeyDown={onKeyDown}
        onClick={() => {
          setActive(selected < 0 ? 0 : selected)
          setOpen((was) => !was)
        }}
      >
        <span className="select-value">{label}</span>
      </button>
      {open && (
        <ul
          ref={list}
          role="listbox"
          className="select-menu"
          style={{
            left: box.left,
            // The trigger's width is the floor, not the ceiling: a discovered
            // printer's description is longer than the box that opens it, and
            // pinning the list to that width truncated every option to
            // "Brother DCP-…" with nothing to tell them apart.
            minWidth: box.width,
            maxWidth: `calc(100vw - ${box.left + 12}px)`,
            ...(box.flip
              ? { bottom: window.innerHeight - box.top + 4 }
              : { top: box.top }),
          }}
        >
          {items.length === 0 && <li className="select-empty">Nothing to choose</li>}
          {items.map((item, index) => (
            <li key={item.value + index}>
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                data-active={index === active}
                disabled={item.disabled}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span>{item.label}</span>
                {index === selected && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
