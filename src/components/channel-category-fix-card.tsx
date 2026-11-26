"use client";

import { useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type PreviewRow = { video: string; videoId: string; title: string | null; current: string | null; status: "write" | "same" | "upload_pending" | "not_on_youtube" | "not_in_channel" | "audio_language_zxx" };
type Preview = { targetCategoryId: string; videos: PreviewRow[]; toWrite: number; quotaUnits: number };
type ResultRow = { video: string; videoId: string; before: string | null; status: "written" | "same" | "upload_pending" | "not_on_youtube" | "not_in_channel" | "audio_language_zxx" | "failed"; error?: { code: string; message: string } };
type Result = { targetCategoryId: string; videos: ResultRow[]; written: string[]; verified: boolean; stoppedAt: string | null };

/**
 * BL-279 (owner TG 4963/4964): «Исправить категорию» -- the category of the channel's videos a release package uploaded, set to the
 * channel's saved publishing setting. Three steps on one card, no browser dialog: check (the dry run lists «было → станет»), confirm
 * (an inline question naming the category and the count), then the write, one video at a time, with each video's outcome.
 */
export function ChannelCategoryFixCard({ channelId }: { channelId: string }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const category = (id: string | null) => (id ? t(`publishingSettings.category.${id}` as UiTextKey) : "—");

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing/category-fix`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(t, data, t("categoryFix.failed")));
    return data;
  }

  async function check() {
    setBusy("preview");
    setError(null);
    setResult(null);
    setConfirming(false);
    try {
      setPreview((await post({ dryRun: true })) as Preview);
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : t("categoryFix.failed"));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy("apply");
    setError(null);
    try {
      const videoIds = preview.videos.filter((v) => v.status === "write").map((v) => v.videoId);
      setResult((await post({ expectedCategoryId: preview.targetCategoryId, videoIds })) as Result);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("categoryFix.failed"));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  const statusText = (status: PreviewRow["status"] | ResultRow["status"]) => t(`categoryFix.status.${status}` as UiTextKey);

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div>
        <h3 className="text-base font-medium text-zinc-100">{t("categoryFix.title")}</h3>
        <p className="mt-1 text-xs text-zinc-400">{t("categoryFix.intro")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void check()} disabled={busy !== null} className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-50">
          {busy === "preview" ? t("categoryFix.checking") : preview || result ? t("categoryFix.checkAgain") : t("categoryFix.check")}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-300">
            {preview.toWrite > 0
              ? t("categoryFix.previewSummary", { count: preview.toWrite, total: preview.videos.length, category: category(preview.targetCategoryId), units: preview.quotaUnits })
              : t("categoryFix.previewNothing", { total: preview.videos.length, category: category(preview.targetCategoryId) })}
          </p>
          {preview.videos.length > 0 && (
            <div className="max-h-80 overflow-auto rounded-lg border border-zinc-800">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t("categoryFix.col.video")}</th>
                    <th className="px-3 py-2 font-medium">{t("categoryFix.col.change")}</th>
                    <th className="px-3 py-2 font-medium">{t("categoryFix.col.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.videos.map((v) => (
                    <tr key={v.videoId} className="border-t border-zinc-800">
                      <td className="px-3 py-1.5 text-zinc-200">
                        <span className="font-mono text-zinc-400">{v.video}</span> {v.title ?? v.videoId}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-300">{v.status === "write" ? `${category(v.current)} → ${category(preview.targetCategoryId)}` : category(v.current)}</td>
                      <td className={`px-3 py-1.5 ${v.status === "write" ? "text-amber-300" : "text-zinc-500"}`}>{statusText(v.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.toWrite > 0 && !confirming && (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">
              {t("categoryFix.fix", { count: preview.toWrite })}
            </button>
          )}
          {confirming && (
            <div role="alertdialog" aria-label={t("categoryFix.confirmTitle")} className="space-y-2 rounded-lg border border-amber-700/70 bg-amber-950/30 p-3">
              <p className="text-xs text-amber-100">{t("categoryFix.confirm", { count: preview.toWrite, category: category(preview.targetCategoryId) })}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void apply()} disabled={busy !== null} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">
                  {busy === "apply" ? t("categoryFix.applying") : t("categoryFix.confirmYes")}
                </button>
                <button type="button" onClick={() => setConfirming(false)} disabled={busy !== null} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <p className={`text-xs ${result.verified ? "text-green-400" : "text-amber-300"}`}>
            {result.verified ? t("categoryFix.done", { count: result.written.length, category: category(result.targetCategoryId) }) : t("categoryFix.stopped", { count: result.written.length })}
          </p>
          <ul className="space-y-1 text-xs">
            {result.videos.map((v) => (
              <li key={v.videoId} className={v.status === "failed" ? "text-red-400" : "text-zinc-300"}>
                <span className="font-mono text-zinc-400">{v.video}</span> {statusText(v.status)}
                {v.error ? ` — ${errorText(t, { error: v.error.code, message: v.error.message }, v.error.message)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
