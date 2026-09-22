"use client";

import type { ReactNode } from "react";

/**
 * Left/right layout for a Settings section: title + toggle on the left, traffic stats and quota
 * bar on the right, instead of stacking everything vertically under the toggle (owner
 * instruction, 2026-09-22, Telegram: "статистику и прогресс бар сделаем крупнее, но перенесем
 * это все в правую часть поля. Чтобы по высоте блоки занимали меньше места"). One shared layout
 * so every Settings section that has both a control and stats/quota to show uses the same split,
 * rather than each section re-implementing it. Stacks vertically below the `sm` breakpoint so it
 * doesn't crush a narrow viewport.
 */
export function SettingsSectionRow({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">{left}</div>
      {right && <div className="w-full shrink-0 sm:w-72">{right}</div>}
    </div>
  );
}
