"use client";

import { useEffect, type RefObject } from "react";

// BL-175 (review round 1): a whole-window layer or a dialog of the review screen holds the keyboard focus like ConfirmDialog -- it
// takes the focus when it opens, Tab and Shift+Tab stay inside it, and the focus goes back where it was when it closes.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(ref: RefObject<HTMLElement | null>, options: { initial?: "first" | "container" } = {}): void {
  const initial = options.initial ?? "first";
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    // An element that already took the focus itself (autoFocus) keeps it.
    if (!root.contains(document.activeElement)) {
      if (initial === "first") (items()[0] ?? root).focus();
      else root.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = items();
      if (list.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (before && document.contains(before)) before.focus();
    };
  }, [initial, ref]);
}
