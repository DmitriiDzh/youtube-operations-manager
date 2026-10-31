"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { gbLabel } from "./gb-label";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-238 (FO-REQ-0051, ADR 0058): Content → Publishing → «Удалять локальную копию после загрузки». The channel's switch on THIS
// computer (off by default; turning it on asks once more, inline), the space freed, the uploads waiting and why, the last deletes
// and refusals. Reads and writes only `/api/channels/<id>/local-video-cleanup`; wrapped in its own error boundary (AGENTS.md §M).

type View = {
  channelId: string;
  enabled: boolean;
  enabledAt: string | null;
  freedBytes: number;
  deletedCount: number;
  waiting: Array<{ video: string; reason: string; checkedAt: string }>;
  recent: Array<{ video: string; action: "deleted" | "refused"; reason: string | null; bytes: number | null; at: string; path: string }>;
};

const REASON_TEXT: Record<string, UiTextKey> = {
  processing: "cleanup.reason.processing",
  not_public_or_scheduled: "cleanup.reason.notPublicOrScheduled",
  youtube_unavailable: "cleanup.reason.youtubeUnavailable",
  workspace_unavailable: "cleanup.reason.workspaceUnavailable",
  in_live_rotation: "cleanup.reason.inLiveRotation",
  upload_active: "cleanup.reason.uploadActive",
  cannot_verify: "cleanup.reason.cannotVerify",
  path_not_allowed: "cleanup.reason.pathNotAllowed",
  symlink: "cleanup.reason.symlink",
  not_a_file: "cleanup.reason.notAFile",
  upload_incomplete: "cleanup.reason.uploadIncomplete",
  size_mismatch_upload: "cleanup.reason.sizeMismatchUpload",
  size_mismatch_youtube: "cleanup.reason.sizeMismatchYoutube",
  sha256_mismatch: "cleanup.reason.sha256Mismatch",
  duration_mismatch: "cleanup.reason.durationMismatch",
  video_not_on_youtube: "cleanup.reason.videoNotOnYoutube",
  youtube_rejected: "cleanup.reason.youtubeRejected",
  tombstone_mismatch: "cleanup.reason.tombstoneMismatch",
};

const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

export function LocalVideoCleanupCard({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/local-video-cleanup`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorText(t, data, t("cleanup.loadFailed")));
      setView(data as View);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cleanup.loadFailed"));
    }
  }, [channelId, t]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  async function save(enabled: boolean) {
    if (!channelId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/local-video-cleanup`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorText(t, data, t("cleanup.saveFailed")));
      setView(data as View);
      setError(null);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cleanup.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!channelId) return null;
  const reason = (code: string | null) => (code ? t(REASON_TEXT[code] ?? "cleanup.reason.other", { code }) : "");

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        {t("cleanup.title")}
        <InfoTooltip>{t("cleanup.info")}</InfoTooltip>
      </h3>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {view && (
        <>
          <div className="flex items-center gap-3">
            <ToggleSwitch tone="violet" label={t("cleanup.switch")} checked={view.enabled || confirming} disabled={saving} onChange={(checked) => (checked ? setConfirming(true) : (setConfirming(false), void save(false)))} />
            <span className="text-sm text-zinc-300">{t("cleanup.switch")}</span>
          </div>
          {confirming && !view.enabled && (
            <div className="space-y-2 rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              <p>{t("cleanup.confirm")}</p>
              <div className="flex gap-2">
                <button type="button" className={buttonClass} disabled={saving} onClick={() => void save(true)}>
                  {t("cleanup.confirmYes")}
                </button>
                <button type="button" className={buttonClass} disabled={saving} onClick={() => setConfirming(false)}>
                  {t("cleanup.confirmNo")}
                </button>
              </div>
            </div>
          )}
          {view.enabled && view.enabledAt && <p className="text-xs text-zinc-400">{t("cleanup.enabledSince", { at: formatDisplayDateTime(view.enabledAt) })}</p>}
          <p className="text-xs text-zinc-300">{t("cleanup.freed", { size: gbLabel(t, view.freedBytes), count: view.deletedCount })}</p>
          {view.waiting.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-300">{t("cleanup.waitingTitle")}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-400">
                {view.waiting.map((w) => (
                  <li key={w.video}>
                    {w.video}: {reason(w.reason)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.recent.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-300">{t("cleanup.recentTitle")}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-400">
                {view.recent.map((e) => (
                  <li key={`${e.video}-${e.at}`} title={e.path}>
                    {formatDisplayDateTime(e.at)} · {e.video} ·{" "}
                    {e.action === "deleted" ? t("cleanup.deleted", { size: gbLabel(t, e.bytes ?? 0) }) : <span className="text-amber-300">{t("cleanup.refused", { reason: reason(e.reason) })}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
