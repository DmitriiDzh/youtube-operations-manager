"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-236 (FO-REQ-0050, ADR 0057): the channel's «Голоса» under Media → Music. The Operator designs a voice (paid, over MCP); here the
// owner listens to its previews and approves one (only an approved voice speaks), renames or archives a voice. Its own fetches and
// state: a failure here never touches the music library or the plans next to it (AGENTS.md §M).

type Preview = { previewId: string; file: string; mimeType: string; durationSeconds: number | null };
type Voice = {
  voiceId: string;
  name: string;
  provider: "gemini" | "elevenlabs";
  description: string;
  status: "draft" | "approved" | "archived";
  previews: Preview[];
  approvedPreviewId: string | null;
  createdAt: string;
};

const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

export function ChannelVoicesPanel({ channelId }: { channelId: string | null | undefined }) {
  const t = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ voiceId: string; name: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<Voice | null>(null);

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/voices` : null;
  const load = useCallback(() => {
    if (!base) return Promise.resolve();
    return requestJson<{ voices: Voice[] }>(`${base}${archived ? "?archived=1" : ""}`, undefined, t("settings.loadFailed"), t).then(
      (data) => {
        setVoices(data.voices);
        setError(null);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : t("settings.loadFailed"))
    );
  }, [base, archived, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("speech.voices.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const approve = (voice: Voice, previewId: string) => act(() => requestJson(`${base}/${encodeURIComponent(voice.voiceId)}/approve`, json("POST", { previewId }), t("speech.voices.actionFailed"), t), t("speech.voices.approved"));
  const rename = (voiceId: string, name: string) =>
    act(async () => {
      await requestJson(`${base}/${encodeURIComponent(voiceId)}`, json("PATCH", { name }), t("speech.voices.actionFailed"), t);
      setRenaming(null);
    }, t("common.saved"));
  const archive = (voice: Voice) => {
    setConfirmArchive(null);
    void act(() => requestJson(`${base}/${encodeURIComponent(voice.voiceId)}`, json("PATCH", { archived: true }), t("speech.voices.actionFailed"), t), t("common.saved"));
  };

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("speech.voices.title")}
          <InfoTooltip>{t("speech.voices.info")}</InfoTooltip>
        </h3>
        {base && (
          <div className="flex items-center gap-2">
            <ToggleSwitch checked={archived} onChange={setArchived} label={t("speech.voices.showArchived")} />
            <span className="text-xs text-zinc-400">{t("speech.voices.showArchived")}</span>
          </div>
        )}
      </div>
      {!base ? (
        <p className="text-sm text-zinc-500">{t("speech.voices.noChannel")}</p>
      ) : voices === null ? (
        error ? <p className="text-sm text-red-400">{error}</p> : <LoadingIndicator className="text-sm text-zinc-400" />
      ) : voices.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("speech.voices.none")}</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {voices.map((voice) => (
            <li key={voice.voiceId} className="space-y-2 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {renaming?.voiceId === voice.voiceId ? (
                  <span className="flex items-center gap-2">
                    <input
                      type="text"
                      value={renaming.name}
                      onChange={(e) => setRenaming({ voiceId: voice.voiceId, name: e.target.value })}
                      aria-label={t("speech.voices.renameAria")}
                      maxLength={60}
                      className="w-48 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100"
                    />
                    <button onClick={() => void rename(voice.voiceId, renaming.name.trim())} disabled={busy || renaming.name.trim().length === 0} className={primaryClass}>
                      {t("speech.voices.saveName")}
                    </button>
                    <button onClick={() => setRenaming(null)} disabled={busy} className={buttonClass}>
                      {t("common.cancel")}
                    </button>
                  </span>
                ) : (
                  <span className="text-sm font-medium text-zinc-100">{voice.name}</span>
                )}
                <span className="text-xs text-zinc-400">{t(voice.provider === "gemini" ? "speech.voices.provider.gemini" : "speech.voices.provider.elevenlabs")}</span>
                <span className={`text-xs ${voice.status === "approved" ? "text-emerald-400" : voice.status === "draft" ? "text-amber-400" : "text-zinc-500"}`}>
                  {t(voice.status === "draft" ? "speech.voices.status.draft" : voice.status === "approved" ? "speech.voices.status.approved" : "speech.voices.status.archived")}
                </span>
                {voice.status !== "archived" && renaming?.voiceId !== voice.voiceId && (
                  <span className="flex gap-2">
                    <button onClick={() => setRenaming({ voiceId: voice.voiceId, name: voice.name })} disabled={busy} className={buttonClass}>
                      {t("speech.voices.rename")}
                    </button>
                    <button onClick={() => setConfirmArchive(voice)} disabled={busy} className={`${buttonClass} text-red-300`}>
                      {t("speech.voices.archive")}
                    </button>
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500">{voice.description}</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {voice.previews.map((preview, index) => (
                  <div key={preview.previewId} className={`space-y-1 rounded-lg border p-2 ${voice.approvedPreviewId === preview.previewId ? "border-emerald-700" : "border-zinc-800"}`}>
                    <p className="text-xs text-zinc-400">
                      {t("speech.voices.preview", { n: index + 1 })}
                      {voice.approvedPreviewId === preview.previewId && <span className="text-emerald-400"> · {t("speech.voices.chosen")}</span>}
                    </p>
                    <audio controls preload="none" src={`${base}/${encodeURIComponent(voice.voiceId)}/previews/${encodeURIComponent(preview.previewId)}`} className="w-full" />
                    {voice.status === "draft" && (
                      <button onClick={() => void approve(voice, preview.previewId)} disabled={busy} className={primaryClass}>
                        {t("speech.voices.approve")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {voices !== null && error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmArchive && (
        <ConfirmDialog
          title={t("speech.voices.archiveTitle")}
          description={t("speech.voices.archiveDescription")}
          confirmLabel={t("speech.voices.archive")}
          confirmVariant="danger"
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => archive(confirmArchive)}
        />
      )}
    </div>
  );
}
