"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Small "?" icon that reveals a section's explanatory text in a local popover, on hover or click,
 * instead of that text sitting inline under every Settings section header (owner instruction,
 * 2026-09-22, Telegram: "Спрячь это описание под маленькую иконку вопросительного знака в кружке
 * после названия раздела... Пусть это всплывает как тултип отдельным локальным окном при
 * наведении или клике"). One shared component so every Settings section renders this the same
 * way, rather than each section re-implementing its own show/hide logic.
 */
export function InfoTooltip({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <span
      ref={containerRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="More info"
        aria-describedby={tooltipId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-600 text-[10px] font-normal leading-none text-zinc-400 hover:border-zinc-400 hover:text-zinc-200"
      >
        ?
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute left-1/2 top-full z-20 mt-2 w-72 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-xs font-normal leading-relaxed text-zinc-300 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
