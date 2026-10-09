"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §2): a button that opens a small panel under it -- a menu, a picker, a settings panel --
 * closed by an outside click or Escape. One implementation for every such control on the Media screens, never a native
 * browser dialog. `children` may be a function that gets `close` (a menu item closes the panel when chosen).
 */
export function Popover({
  trigger,
  triggerClassName,
  label,
  align = "left",
  panelClassName = "",
  children,
}: {
  trigger: ReactNode;
  triggerClassName: string;
  /** The trigger's accessible name and tooltip when it shows only an icon. */
  label?: string;
  /** Which edge of the trigger the panel lines up with. */
  align?: "left" | "right";
  panelClassName?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="true" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((v) => !v)} className={triggerClassName}>
        {trigger}
      </button>
      {open && (
        <div className={`absolute top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
