"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/** A menu panel's items, in order (a disabled one is skipped). */
function menuItemsOf(panel: HTMLElement | null): HTMLElement[] {
  return Array.from(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
}

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
  menu = false,
  children,
}: {
  trigger: ReactNode;
  triggerClassName: string;
  /** The trigger's accessible name and tooltip when it shows only an icon. */
  label?: string;
  /** Which edge of the trigger the panel lines up with. */
  align?: "left" | "right";
  panelClassName?: string;
  /**
   * Owner TG 4784 review (the plan rows' «⋯»): the panel is a menu of `role="menuitem"` elements -- the trigger announces a menu,
   * the first item takes the focus on open, ArrowUp/ArrowDown/Home/End move between the items, Escape closes and gives the focus
   * back to the trigger, Tab closes. Off: the panel behaves as before.
   */
  menu?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open && menu) menuItemsOf(panelRef.current)[0]?.focus();
  }, [open, menu]);
  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menu) return;
    const list = menuItemsOf(panelRef.current);
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length].focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? list.length - 1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(list.length - 1);
    else if (event.key === "Tab") setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      if (menu && ref.current?.contains(document.activeElement)) triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, menu]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup={menu ? "menu" : "true"}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          // A menu also opens from the keyboard with ArrowDown (its first item then takes the focus).
          if (menu && event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div ref={panelRef} onKeyDown={onPanelKey} className={`absolute top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
