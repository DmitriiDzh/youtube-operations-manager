"use client";

import { useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { useUiText } from "./ui-text-provider";
import { formatBytes } from "./volume-usage-bar";

// BL-255 (ADR 0069, owner msgs 4380/4383): replace the custom thumbnail of a video already on YouTube with an image from the
// channel's `04 Videos/` -- a dry run first («Проверить»), then the write through `src/lib/video-thumbnails/`.

type CandidateFolder = { folder: string; video: string | null; images: string[]; own: boolean };
type ReplaceResult = {
  dryRun: boolean;
  file: { bytes: number; contentType: string; sha256: string };
  before: { privacyStatus: string | null; publishAt: string | null; url: string | null };
  after: { url: string | null } | null;
  units: number;
  written: boolean;
  verified: boolean | null;
  verificationDetail: string | null;
};

const PRIVACY_KEYS = { public: "content.privacy.public", unlisted: "content.privacy.unlisted", private: "content.privacy.private" } as const;

function previewSrc(channelId: string, path: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/publishing/packages/thumbnail?path=${encodeURIComponent(path)}`;
}

export function ThumbnailReplaceButton(props: { channelId: string; videoId: string; currentUrl: string | null; className?: string; onReplaced?: () => void }) {
  const { t } = useUiText();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={props.className ?? "rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800"}
      >
        {t("thumbReplace.button")}
      </button>
      {open && <ThumbnailReplaceDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ThumbnailReplaceDialog(props: { channelId: string; videoId: string; currentUrl: string | null; onClose: () => void; onReplaced?: () => void }) {
  const { t, formatNumber, language } = useUiText();
  const base = `/api/channels/${encodeURIComponent(props.channelId)}/videos/${encodeURIComponent(props.videoId)}/thumbnail`;
  const [folders, setFolders] = useState<CandidateFolder[] | null>(null);
  const [storedUrl, setStoredUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReplaceResult | null>(null);
  const [done, setDone] = useState<ReplaceResult | null>(null);
  const [busy, setBusy] = useState<"check" | "replace" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(base, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as { folders?: CandidateFolder[]; currentUrl?: string | null } | null;
        if (cancelled) return;
        if (!response.ok) return setLoadError(errorText(t, body, t("thumbReplace.loadFailed")));
        const list = body?.folders ?? [];
        setFolders(list);
        setStoredUrl(body?.currentUrl ?? null);
        // Preselected only when this video's own folder offers exactly one image.
        const own = list.find((folder) => folder.own && folder.images.length > 0);
        if (own && own.images.length === 1) setChosen(own.images[0]);
      } catch {
        if (!cancelled) setLoadError(t("thumbReplace.loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, t]);

  async function send(dryRun: boolean) {
    if (!chosen) return;
    setBusy(dryRun ? "check" : "replace");
    setError(null);
    try {
      const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: chosen, dryRun }) });
      const body = (await response.json().catch(() => null)) as (ReplaceResult & { path?: string }) | null;
      if (!response.ok || !body) {
        setError(errorText(t, body, t("thumbReplace.failed")));
        return;
      }
      // A check counts only for the image it checked (another may have been chosen meanwhile).
      if (dryRun) setChecked(body.path === chosen ? body : null);
      else {
        setDone(body);
        props.onReplaced?.();
      }
    } catch {
      setError(t("thumbReplace.failed"));
    } finally {
      setBusy(null);
    }
  }

  const dateText = (iso: string) => new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const privacyText = (value: string | null) => (value && value in PRIVACY_KEYS ? t(PRIVACY_KEYS[value as keyof typeof PRIVACY_KEYS]) : (value ?? ""));
  const currentUrl = done?.after?.url ?? props.currentUrl ?? storedUrl;
  const anyImages = (folders ?? []).some((folder) => folder.images.length > 0);

  return (
    <ConfirmDialog
      title={t("thumbReplace.title")}
      description={t("thumbReplace.description")}
      size="wide"
      cancelLabel={done ? t("thumbReplace.close") : t("thumbReplace.cancel")}
      confirmLabel={done ? t("thumbReplace.close") : t("thumbReplace.confirm")}
      confirmDisabled={!done && (!checked || checked.dryRun !== true || busy !== null)}
      confirmBusyLabel={busy === "replace" ? t("thumbReplace.replacing") : null}
      onCancel={props.onClose}
      onConfirm={() => (done ? props.onClose() : void send(false))}
    >
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <figure className="space-y-1">
            <figcaption className="text-xs text-zinc-400">{t("thumbReplace.current")}</figcaption>
            {currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- YouTube's own thumbnail URL
              <img src={currentUrl} alt="" className="aspect-video w-full rounded-md border border-zinc-700 object-cover" />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-zinc-700 text-xs text-zinc-500">{t("thumbReplace.noCurrent")}</div>
            )}
          </figure>
          <figure className="space-y-1">
            <figcaption className="text-xs text-zinc-400">{t("thumbReplace.chosen")}</figcaption>
            {chosen ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local file served by the app's own route
              <img src={previewSrc(props.channelId, chosen)} alt="" className="aspect-video w-full rounded-md border border-violet-500 object-cover" />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-zinc-700 text-xs text-zinc-500">{t("thumbReplace.pick")}</div>
            )}
            {chosen && <div className="truncate text-xs text-zinc-500">{chosen}</div>}
          </figure>
        </div>

        {!done && (
          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {loadError && <div className="text-red-300">{loadError}</div>}
            {!folders && !loadError && <div className="text-zinc-400">{t("thumbReplace.loading")}</div>}
            {folders && !anyImages && <div className="text-zinc-400">{t("thumbReplace.none")}</div>}
            {(folders ?? [])
              .filter((folder) => folder.images.length > 0)
              .map((folder) => (
                <div key={folder.folder}>
                  <div className="mb-1 text-xs text-zinc-400">
                    {t(folder.own ? "thumbReplace.ownFolder" : "thumbReplace.otherFolder")} · {folder.folder}
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {folder.images.map((image) => (
                      <button
                        key={image}
                        type="button"
                        title={image}
                        disabled={busy !== null}
                        onClick={() => {
                          setChosen(image);
                          setChecked(null);
                          setError(null);
                        }}
                        className={`overflow-hidden rounded-md border ${chosen === image ? "border-violet-500 ring-2 ring-violet-500/50" : "border-zinc-700 hover:border-zinc-500"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- a local file served by the app's own route */}
                        <img src={previewSrc(props.channelId, image)} alt="" className="aspect-video w-full object-cover" loading="lazy" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

        {!done && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!chosen || busy !== null}
              onClick={() => void send(true)}
              className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy === "check" ? t("thumbReplace.checking") : t("thumbReplace.check")}
            </button>
            {checked ? (
              <span className="text-emerald-300">
                {t("thumbReplace.checked", {
                  size: formatBytes(t, formatNumber, checked.file.bytes),
                  type: checked.file.contentType === "image/png" ? "PNG" : "JPEG",
                  privacy: privacyText(checked.before.privacyStatus).toLowerCase(),
                  date: checked.before.publishAt ? t("thumbReplace.checkedDate", { date: dateText(checked.before.publishAt) }) : "",
                  units: checked.units,
                })}
              </span>
            ) : (
              chosen && <span className="text-zinc-400">{t("thumbReplace.checkFirst")}</span>
            )}
          </div>
        )}

        {error && <div className="text-red-300" role="alert">{error}</div>}
        {done && (
          <div className={done.verified ? "text-emerald-300" : "text-amber-300"} role="status">
            {done.verified ? t("thumbReplace.done") : t("thumbReplace.doneUnverified", { detail: done.verificationDetail ?? "" })}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}
