"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../ui-text-provider";
import { NOTICE_OK_MS } from "./busy-state";

export type Notice = { tone: "ok" | "error"; text: string };

/** BL-195 (AC-FB-05): one message line -- a success hides itself after 4 s, an error stays until it is closed. */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = setTimeout(() => setNotice((n) => (n === notice ? null : n)), NOTICE_OK_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const show = useCallback((tone: Notice["tone"], text: string) => setNotice({ tone, text }), []);
  const clear = useCallback(() => setNotice(null), []);
  return { notice, show, clear };
}

/**
 * The message line itself. A success closes itself after 4 s (through `onClose`, so a screen with its own `notice` / `error`
 * state needs no timer of its own); an error stays until its × is pressed.
 */
export function StatusNotice({ notice, onClose, className = "" }: { notice: Notice | null; onClose: () => void; className?: string }) {
  const t = useT();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const okText = notice?.tone === "ok" ? notice.text : null;
  useEffect(() => {
    if (okText === null) return;
    const timer = setTimeout(() => closeRef.current(), NOTICE_OK_MS);
    return () => clearTimeout(timer);
  }, [okText]);
  if (!notice) return null;
  const error = notice.tone === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${error ? "border-red-900/60 bg-red-950/40 text-red-300" : "border-emerald-900/60 bg-emerald-950/30 text-emerald-300"} ${className}`}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
      {error && (
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
          <span aria-hidden>✕</span>
        </button>
      )}
    </div>
  );
}
