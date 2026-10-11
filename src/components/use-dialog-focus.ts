"use client";

import { useEffect, type RefObject } from "react";

// BL-175 (review round 1): a whole-window layer or a dialog of the review screen holds the keyboard focus like ConfirmDialog -- it
// takes the focus when it opens, Tab and Shift+Tab stay inside it, and the focus goes back where it was when it closes.
// Review round 2: holders stack -- only the one opened last keeps Tab (a dialog opened over the layer is not fought by it), and
// the place the focus goes back to is the element focused before the holder opened, even when one of its fields took the focus
// itself (`autoFocus` runs before this effect).

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const holders: HTMLElement[] = [];
/** The element that lost the focus most recently (a focus move's `relatedTarget`). */
let lastBlurred: HTMLElement | null = null;
let tracking = false;
function trackFocus(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("focusin", (event) => {
    lastBlurred = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
  }, true);
}
trackFocus();

export function useDialogFocus(ref: RefObject<HTMLElement | null>, options: { initial?: "first" | "container" } = {}): void {
  const initial = options.initial ?? "first";
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const before = active && root.contains(active) ? (lastBlurred && !root.contains(lastBlurred) ? lastBlurred : null) : active;
    holders.push(root);
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    // An element that already took the focus itself (autoFocus) keeps it.
    if (!root.contains(document.activeElement)) {
      if (initial === "first") (items()[0] ?? root).focus();
      else root.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || holders[holders.length - 1] !== root) return;
      const list = items();
      if (list.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const now = document.activeElement;
      if (event.shiftKey && (now === first || !root.contains(now))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (now === last || !root.contains(now))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const at = holders.lastIndexOf(root);
      if (at >= 0) holders.splice(at, 1);
      // Only when the focus was in the holder (it is gone now: the body has it) -- never away from a field that took the focus
      // meanwhile, e.g. the pin's note box that the screen shows once the layer closes (review round 3).
      const now = document.activeElement;
      if (before && document.contains(before) && (!now || now === document.body || root.contains(now))) before.focus();
    };
  }, [initial, ref]);
}
