"use client";

import { useEffect } from "react";
import { BlockingDialog } from "../blocking-dialog";
import { Spinner } from "../operation-progress/spinner";
import type { BusyOverlayState } from "./use-busy-action";

/**
 * BL-195 (UI_FEEDBACK_CLARITY_PLAN.md §3 stage A, AC-FB-02): the blurred screen with what is being done, for a short action.
 * It has no Close button -- it goes away when the action ends -- and while shown it takes every key first (capture phase, as
 * `OperationOverlay` does), so no shortcut of the screen behind it runs.
 */
export function BusyOverlay({ state }: { state: BusyOverlayState }) {
  useEffect(() => {
    if (!state.visible) return;
    const swallow = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [state.visible]);
  if (!state.visible) return null;
  return (
    <BlockingDialog label={state.label} busy maxWidthClass="max-w-xs">
      <div className="flex flex-col items-center gap-3 py-2 text-center" aria-live="polite">
        <Spinner className="h-8 w-8 border-[3px]" />
        <p className="text-sm font-medium text-zinc-100">{state.label}</p>
      </div>
    </BlockingDialog>
  );
}
