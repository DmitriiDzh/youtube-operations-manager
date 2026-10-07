"use client";

import { useEffect, useState } from "react";
import { formatValue, settingLabel, SETTING_LABELS } from "./conflict-values";

// BL-150 (docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md): Setup says that its settings are shared with the other
// computers, what came from them, and what is waiting here and why (volume in use, invalid here, another account, a choice).

type Status = {
  checkedAt: string | null;
  lastApplied: { fields: string[]; at: string } | null;
  pending: Array<{ field: string; value: unknown; reason: string }>;
  conflicts: Array<{ field: string }>;
  error: string | null;
};

export function SettingsSyncNotice() {
  const [status, setStatus] = useState<Status | null>(null);
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
      <p className="text-zinc-300">These settings are the same on all your computers: a change here reaches the others within about a minute (RunPod keys stay on each computer).</p>
      {status?.lastApplied && (
        <p className="mt-1 text-zinc-500">
          From the other computer: {status.lastApplied.fields.map(settingLabel).join(", ")} ({new Date(status.lastApplied.at).toLocaleString()}).
        </p>
      )}
      {status && status.conflicts.length > 0 && <p className="mt-1 text-amber-300">Set differently on the two computers: {status.conflicts.map((c) => settingLabel(c.field)).join(", ")} — choose in Merge.</p>}
      {held.map((p) => (
        <p key={p.field} className="mt-1 text-amber-300">
          {settingLabel(p.field)} = {formatValue(p.value, SETTING_LABELS[p.field]?.unit)}: {p.reason}
        </p>
      ))}
      {status?.error && <p className="mt-1 text-red-400">Could not check the shared settings: {status.error}</p>}
    </div>
  );
}
