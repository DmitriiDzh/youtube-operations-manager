"use client";

import { useState } from "react";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { useUiText } from "./ui-text-provider";

// BL-269 (ADR 0074 §8, §10; VIDEO_CAPTIONS_PLAN.md §3.5, §3.7): on an uploaded package's row in «Ролики и релизы» whose package states
// captions -- «Субтитры» previews from a fresh read (dry run: the English tracks, the units), then «Добавить субтитры». When the video
// already has an English track (foreign, or the app's own from another file), «Перезаписать субтитры» previews the overwrite (the
// track it replaces) and the confirm replaces it (owner msg 4660). The apply pins what the preview showed (manifest + track).

type Track = { trackId: string; language: string | null; name: string | null; trackKind: string | null; lastUpdated: string | null; ours: boolean };
type Preview = {
  mode: "insert" | "update" | "none";
  manifestSha256: string;
  target: Track | null;
  englishTracks: Track[];
  writeUnits: number;
  alreadyPresent: boolean;
  verified: boolean | null;
};
type Result = { mode: string; written: boolean; alreadyPresent: boolean; verified: boolean | null; verificationDetail: string | null; pending: boolean };

const NEEDS_OVERWRITE = new Set(["captions_foreign_track", "captions_own_track_differs"]);

class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
  }
}

export function CaptionsActions({ channelId, video, onChanged }: { channelId: string; video: string; onChanged: () => void }) {
  const { t } = useUiText();
  const [open, setOpen] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [offerOverwrite, setOfferOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function post(body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing/package-captions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new RequestError(errorText(t, data, t("captionsActions.failed")), typeof data.error === "string" ? data.error : null);
    return data;
  }

  async function load(withOverwrite: boolean) {
    setOpen(true);
    setOverwrite(withOverwrite);
    setPreview(null);
    setError(null);
    setNotice(null);
    setOfferOverwrite(false);
    setBusy(true);
    try {
      setPreview((await post({ video, dryRun: true, overwrite: withOverwrite })) as unknown as Preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("captionsActions.failed"));
      if (!withOverwrite && e instanceof RequestError && e.code && NEEDS_OVERWRITE.has(e.code)) setOfferOverwrite(true);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await post({ video, overwrite, expectedManifestSha256: preview.manifestSha256, expectedTrackId: preview.target?.trackId ?? null })) as unknown as Result;
      setOpen(false);
      setNotice(
        result.alreadyPresent
          ? t("captionsActions.alreadyPresent")
          : result.verified
            ? t(result.mode === "update" ? "captionsActions.overwritten" : "captionsActions.added")
            : result.pending
              ? t("captionsActions.pending")
              : t("captionsActions.notVerified", { detail: result.verificationDetail ?? "" })
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("captionsActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  const trackLine = (track: Track) =>
    t("captionsActions.track", { name: track.name || t("captionsActions.unnamed"), language: track.language ?? "?", kind: track.trackKind ?? "?", owner: track.ours ? t("captionsActions.ours") : t("captionsActions.foreign") });
  const canWrite = preview !== null && preview.mode !== "none";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={() => void load(false)} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">
        {t("captionsActions.open")}
      </button>
      {notice && <span className="text-emerald-300">{notice}</span>}
      {open && (
        <ConfirmDialog
          title={t(overwrite ? "captionsActions.overwriteTitle" : "captionsActions.title", { video })}
          description={t(overwrite ? "captionsActions.overwriteDescription" : "captionsActions.description")}
          cancelLabel={t("captionsActions.cancel")}
          confirmLabel={t(preview?.mode === "update" ? "captionsActions.overwrite" : "captionsActions.add")}
          confirmVariant={preview?.mode === "update" ? "danger" : undefined}
          size="wide"
          confirmDisabled={busy || !canWrite}
          confirmBusyLabel={busy && preview ? t("captionsActions.writing") : null}
          onCancel={() => {
            if (!busy) setOpen(false);
          }}
          onConfirm={() => void apply()}
        >
          <div className="max-h-[55vh] space-y-2 overflow-y-auto text-xs text-zinc-300">
            {!preview && busy && <p className="text-zinc-400">{t("captionsActions.reading")}</p>}
            {preview && (
              <>
                {preview.mode === "none" && <p className="text-emerald-300">{t("captionsActions.alreadyPresent")}</p>}
                {preview.mode === "insert" && <p>{t("captionsActions.willAdd")}</p>}
                {preview.mode === "update" && preview.target && <p className="text-amber-200">{t("captionsActions.willReplace", { track: trackLine(preview.target) })}</p>}
                {preview.englishTracks.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-zinc-400">
                    {preview.englishTracks.map((track) => (
                      <li key={track.trackId}>{trackLine(track)}</li>
                    ))}
                  </ul>
                )}
                {canWrite && <p className="text-zinc-400">{t("captionsActions.quota", { units: preview.writeUnits })}</p>}
              </>
            )}
            {error && <p className="text-red-400">{error}</p>}
            {offerOverwrite && (
              <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 p-2">
                <span>{t("captionsActions.overwriteOffer")}</span>
                <button type="button" disabled={busy} onClick={() => void load(true)} className="rounded border border-red-800 px-2 py-0.5 text-red-200 hover:bg-red-950/40 disabled:opacity-40">
                  {t("captionsActions.overwritePreview")}
                </button>
              </div>
            )}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
