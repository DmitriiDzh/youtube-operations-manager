"use client";

import { useEffect, useRef, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { formatValue, settingLabel, SETTING_LABELS } from "./conflict-values";
import { useT } from "./ui-text-provider";

// BL-150 (docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md): Setup says that its settings are shared with the other
// computers, what came from them, and what is waiting here and why (volume in use, invalid here, another account, a choice).

type Status = {
  checkedAt: string | null;
  lastApplied: { fields: string[]; at: string } | null;
  pending: Array<{ field: string; value: unknown; reason: string }>;
  conflicts: Array<{ field: string }>;
  error: string | null;
};

export function SettingsSyncNotice({ onApplied }: { onApplied?: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  // BL-150 review: when a value from the other computer has been applied, the cards re-read the settings at once, so no form
  // keeps showing (and later re-sending) the old value.
  const appliedAt = status?.lastApplied?.at ?? null;
  const seenAppliedAt = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seenAppliedAt.current !== undefined && appliedAt !== seenAppliedAt.current) onApplied?.();
    seenAppliedAt.current = appliedAt;
  }, [appliedAt, onApplied]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/media-generation/settings-sync")
        .then((res) => (res.ok ? (res.json() as Promise<Status>) : null))
        .then((data) => {
          if (!cancelled && data) setStatus(data);
        })
        .catch(() => undefined);
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  const held = status?.pending.filter((p) => !p.reason.startsWith("set differently")) ?? [];
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <p className="text-zinc-300">{t("settingsSync.intro")}</p>
      {status?.lastApplied && (
        <p className="mt-1 text-zinc-500">
          {t("settingsSync.fromOther", { fields: status.lastApplied.fields.map((f) => settingLabel(t, f)).join(", "), time: formatDisplayDateTime(status.lastApplied.at) })}
        </p>
      )}
      {status && status.conflicts.length > 0 && <p className="mt-1 text-amber-300">{t("settingsSync.conflicts", { fields: status.conflicts.map((c) => settingLabel(t, c.field)).join(", ") })}</p>}
      {held.map((p) => (
        <p key={p.field} className="mt-1 text-amber-300">
          {settingLabel(t, p.field)} = {formatValue(t, p.value, SETTING_LABELS[p.field]?.unit)}: {p.reason}
        </p>
      ))}
      {status?.error && <p className="mt-1 text-red-400">{t("settingsSync.error", { error: status.error })}</p>}
    </div>
  );
}
