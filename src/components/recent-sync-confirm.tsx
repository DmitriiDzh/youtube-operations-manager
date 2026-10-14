"use client";

import { useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { useT } from "./ui-text-provider";

/** Owner, 2026-10-14 (Telegram msg 2770): a manual sync this soon after the last one asks first; it is never blocked. */
export const RECENT_SYNC_CONFIRM_MS = 10 * 60 * 1000;

/**
 * The manual "Sync" buttons' guard: `request()` runs the sync at once, or, when the channel was synced less than
 * RECENT_SYNC_CONFIRM_MS ago, opens the shared ConfirmDialog first. Automatic syncs never go through it.
 */
export function useRecentSyncConfirm(lastSyncedAt: string | null | undefined, run: () => void) {
  const t = useT();
  const [minutesAgo, setMinutesAgo] = useState<number | null>(null);

  function request() {
    const elapsed = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : Number.NaN;
    if (elapsed >= 0 && elapsed < RECENT_SYNC_CONFIRM_MS) setMinutesAgo(Math.floor(elapsed / 60_000));
    else run();
  }

  const dialog =
    minutesAgo === null ? null : (
      <ConfirmDialog
        title={t("common.syncRecent.title")}
        description={t("common.syncRecent.description", { minutes: minutesAgo })}
        confirmLabel={t("common.syncRecent.confirm")}
        onCancel={() => setMinutesAgo(null)}
        onConfirm={() => {
          setMinutesAgo(null);
          run();
        }}
      />
    );

  return { request, dialog };
}
