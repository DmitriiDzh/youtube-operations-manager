"use client";

import { useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { useUiText } from "./ui-text-provider";

// BL-265 (ADR 0072 §2, §5, §8; MEDIA_GATE_PLAN.md §3.1 "Entry point", §3.4): on an uploaded package's own row in «Ролики и релизы», on
// every channel -- «Упаковка отличается от YouTube» when the package's texts differ from the synced copy, «Упаковка» (a preview of the
// three-way diff from a fresh read, then «Применить упаковку» with a per-field «перезаписать» for a conflict; the thumbnail through
// the existing thumbnail writer) and «Комментарий к упаковке» (to the Producer, it blocks nothing). «Переводы упаковки» (owner TG
// 4839/4842, ADR 0072 amendment): the package's translations per language against YouTube and the upload, then «Применить переводы»
// -- no override: any conflict blocks the write (the screen shows which language and field).

type Field = "title" | "description" | "tags";
type Preview = {
  video: string;
  manifestSha256: string;
  videoId: string;
  etag: string | null;
  baseline: "upload_row" | "metadata_apply" | "unknown";
  fields: Array<{ field: Field; youtube: string | string[]; uploaded: string | string[] | null; manifest: string | string[]; status: "same" | "write" | "conflict" }>;
  changed: boolean;
  audioLanguageLeftOut: boolean;
  quotaUnits: number;
  thumbnail: { path: string; differs: boolean | null } | null;
};

type TranslationStatus = "same" | "write" | "conflict";
type TranslationsPreview = {
  video: string;
  manifestSha256: string;
  etag: string | null;
  baseline: "upload_row" | "localizations_apply" | "unknown";
  languages: Array<{ language: string; status: TranslationStatus; fields: Array<{ field: "title" | "description"; youtube: string | null; uploaded: string | null; package: string; status: TranslationStatus }> }>;
  kept: string[];
  ownLanguageSkipped: string[];
  changed: boolean;
  quotaUnits: number;
};

const FIELD_KEYS: Record<Field, UiTextKey> = {
  title: "packagingActions.field.title",
  description: "packagingActions.field.description",
  tags: "packagingActions.field.tags",
};
const STATUS_KEYS: Record<Preview["fields"][number]["status"], UiTextKey> = {
  same: "packagingActions.status.same",
  write: "packagingActions.status.write",
  conflict: "packagingActions.status.conflict",
};
const shown = (value: string | string[] | null) => (value === null ? null : Array.isArray(value) ? value.join(", ") : value);

export function PackagingActions({ channelId, video, manifestSha256, differs, onChanged }: { channelId: string; video: string; manifestSha256: string; differs: Field[] | null; onChanged: () => void }) {
  const { t } = useUiText();
  const [open, setOpen] = useState<"metadata" | "comment" | "translations" | null>(null);
  const [translations, setTranslations] = useState<TranslationsPreview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [overwrite, setOverwrite] = useState<Field[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const base = `/api/channels/${encodeURIComponent(channelId)}`;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(errorText(t, data, t("packagingActions.failed")));
    return data;
  }

  async function openMetadata() {
    setOpen("metadata");
    setPreview(null);
    setOverwrite([]);
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setPreview((await post("/publishing/package-metadata", { video, dryRun: true })) as unknown as Preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("packagingActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await post("/publishing/package-metadata", { video, expectedEtag: preview.etag ?? "", expectedManifestSha256: preview.manifestSha256, overwrite })) as { changed?: boolean; written?: string[] };
      setOpen(null);
      setNotice(result.changed ? t("packagingActions.applied", { count: result.written?.length ?? 0 }) : t("packagingActions.nothingToApply"));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("packagingActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function openTranslations() {
    setOpen("translations");
    setTranslations(null);
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setTranslations((await post("/publishing/package-metadata", { video, dryRun: true, localizations: true })) as unknown as TranslationsPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("packagingActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function applyTranslations() {
    if (!translations) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await post("/publishing/package-metadata", { video, localizations: true, expectedEtag: translations.etag ?? "", expectedManifestSha256: translations.manifestSha256 })) as { changed?: boolean; written?: string[] };
      setOpen(null);
      setNotice(result.changed ? t("packagingActions.translationsApplied", { count: result.written?.length ?? 0 }) : t("packagingActions.translationsNothing"));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("packagingActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function replaceThumbnail() {
    if (!preview?.thumbnail) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/videos/${encodeURIComponent(preview.videoId)}/thumbnail`, { path: preview.thumbnail.path });
      setPreview({ ...preview, thumbnail: { ...preview.thumbnail, differs: false } });
      setNotice(t("packagingActions.thumbnailReplaced"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("packagingActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function sendComment() {
    setBusy(true);
    setError(null);
    try {
      await post("/package-reviews/decision", { manifestSha256, kind: "packaging_comment", comment: comment.trim() });
      setOpen(null);
      setComment("");
      setNotice(t("packagingActions.commentSent"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("packagingActions.failed"));
    } finally {
      setBusy(false);
    }
  }

  const toWrite = preview ? preview.fields.filter((f) => f.status === "write" || (f.status === "conflict" && overwrite.includes(f.field))) : [];
  const translationConflict = translations ? translations.languages.some((l) => l.status === "conflict") : false;
  const translationsToWrite = translations && !translationConflict ? translations.languages.filter((l) => l.status === "write") : [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {differs && differs.length > 0 && (
        <span className="rounded bg-amber-950/50 px-1.5 py-0.5 text-amber-200" title={differs.map((f) => t(FIELD_KEYS[f])).join(", ")}>
          {t("packagingActions.differs")}
        </span>
      )}
      <button type="button" onClick={() => void openMetadata()} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">
        {t("packagingActions.open")}
      </button>
      <button type="button" onClick={() => void openTranslations()} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">
        {t("packagingActions.translations")}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen("comment");
          setError(null);
        }}
        className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
      >
        {t("packagingActions.comment")}
      </button>
      {notice && <span className="text-emerald-300">{notice}</span>}
      {open === "metadata" && (
        <ConfirmDialog
          title={t("packagingActions.title", { video })}
          description={t("packagingActions.description")}
          cancelLabel={t("packagingActions.cancel")}
          confirmLabel={t("packagingActions.apply")}
          confirmVariant="danger"
          size="wide"
          confirmDisabled={busy || !preview || toWrite.length === 0}
          confirmBusyLabel={busy && preview ? t("packagingActions.applying") : null}
          onCancel={() => {
            if (!busy) setOpen(null);
          }}
          onConfirm={() => void apply()}
        >
          <div className="max-h-[55vh] space-y-3 overflow-y-auto text-xs text-zinc-300">
            {!preview && busy && <p className="text-zinc-400">{t("packagingActions.reading")}</p>}
            {preview && (
              <>
                {preview.baseline === "unknown" && <p className="text-amber-300">{t("packagingActions.baselineUnknown")}</p>}
                <ul className="space-y-2">
                  {preview.fields.map((f) => (
                    <li key={f.field} className="rounded border border-zinc-800 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-100">{t(FIELD_KEYS[f.field])}</span>
                        <span className={f.status === "conflict" ? "text-red-300" : f.status === "write" ? "text-amber-200" : "text-zinc-500"}>{t(STATUS_KEYS[f.status])}</span>
                        {f.status === "conflict" && (
                          <label className="ml-auto flex items-center gap-1 text-red-200">
                            <input
                              type="checkbox"
                              checked={overwrite.includes(f.field)}
                              onChange={(e) => setOverwrite((prev) => (e.target.checked ? [...prev, f.field] : prev.filter((x) => x !== f.field)))}
                            />
                            {t("packagingActions.overwrite")}
                          </label>
                        )}
                      </div>
                      {f.status !== "same" && (
                        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                          <dt className="text-zinc-500">{t("packagingActions.onYoutube")}</dt>
                          <dd className="whitespace-pre-wrap break-words">{shown(f.youtube)}</dd>
                          <dt className="text-zinc-500">{t("packagingActions.uploaded")}</dt>
                          <dd className="whitespace-pre-wrap break-words">{shown(f.uploaded) ?? t("packagingActions.unknown")}</dd>
                          <dt className="text-zinc-500">{t("packagingActions.inPackage")}</dt>
                          <dd className="whitespace-pre-wrap break-words text-zinc-100">{shown(f.manifest)}</dd>
                        </dl>
                      )}
                    </li>
                  ))}
                </ul>
                {!preview.changed && <p className="text-zinc-400">{t("packagingActions.allSame")}</p>}
                {preview.audioLanguageLeftOut && <p className="text-zinc-400">{t("packagingActions.audioLeftOut")}</p>}
                <p className="text-zinc-400">{t("packagingActions.quota", { units: preview.quotaUnits })}</p>
                {preview.thumbnail && preview.thumbnail.differs !== false && (
                  <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 p-2">
                    <span>{preview.thumbnail.differs ? t("packagingActions.thumbnailDiffers") : t("packagingActions.thumbnailUnknown")}</span>
                    <button type="button" disabled={busy} onClick={() => void replaceThumbnail()} className="rounded border border-zinc-600 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-40">
                      {t("packagingActions.replaceThumbnail")}
                    </button>
                  </div>
                )}
              </>
            )}
            {error && <p className="text-red-400">{error}</p>}
          </div>
        </ConfirmDialog>
      )}
      {open === "translations" && (
        <ConfirmDialog
          title={t("packagingActions.translationsTitle", { video })}
          description={t("packagingActions.translationsDescription")}
          cancelLabel={t("packagingActions.cancel")}
          confirmLabel={t("packagingActions.translationsApply")}
          confirmVariant="danger"
          size="wide"
          confirmDisabled={busy || !translations || translationsToWrite.length === 0}
          confirmBusyLabel={busy && translations ? t("packagingActions.applying") : null}
          onCancel={() => {
            if (!busy) setOpen(null);
          }}
          onConfirm={() => void applyTranslations()}
        >
          <div className="max-h-[55vh] space-y-3 overflow-y-auto text-xs text-zinc-300">
            {!translations && busy && <p className="text-zinc-400">{t("packagingActions.reading")}</p>}
            {translations && (
              <>
                {translations.baseline === "unknown" && <p className="text-amber-300">{t("packagingActions.translationsBaselineUnknown")}</p>}
                {translationConflict && <p className="text-red-300">{t("packagingActions.translationsConflict")}</p>}
                {translations.languages.length === 0 && <p className="text-zinc-400">{t("packagingActions.translationsNone")}</p>}
                <ul className="space-y-2">
                  {translations.languages.map((l) => (
                    <li key={l.language} className="rounded border border-zinc-800 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-medium text-zinc-100">{l.language}</span>
                        <span className={l.status === "conflict" ? "text-red-300" : l.status === "write" ? "text-amber-200" : "text-zinc-500"}>{t(STATUS_KEYS[l.status])}</span>
                      </div>
                      {l.status !== "same" && (
                        <ul className="mt-1 space-y-1">
                          {l.fields
                            .filter((f) => f.status !== "same")
                            .map((f) => (
                              <li key={f.field}>
                                <div className="flex items-center gap-2">
                                  <span className="text-zinc-400">{t(FIELD_KEYS[f.field])}</span>
                                  <span className={f.status === "conflict" ? "text-red-300" : "text-amber-200"}>{t(STATUS_KEYS[f.status])}</span>
                                </div>
                                <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                                  <dt className="text-zinc-500">{t("packagingActions.onYoutube")}</dt>
                                  <dd className="whitespace-pre-wrap break-words">{f.youtube ?? t("packagingActions.notOnVideo")}</dd>
                                  <dt className="text-zinc-500">{t("packagingActions.uploaded")}</dt>
                                  <dd className="whitespace-pre-wrap break-words">{f.uploaded ?? (translations.baseline === "unknown" ? t("packagingActions.unknown") : t("packagingActions.notOnVideo"))}</dd>
                                  <dt className="text-zinc-500">{t("packagingActions.inPackage")}</dt>
                                  <dd className="whitespace-pre-wrap break-words text-zinc-100">{f.package}</dd>
                                </dl>
                              </li>
                            ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
                {translations.languages.length > 0 && !translations.changed && <p className="text-zinc-400">{t("packagingActions.translationsAllSame")}</p>}
                {translations.kept.length > 0 && <p className="text-zinc-400">{t("packagingActions.translationsKept", { languages: translations.kept.join(", ") })}</p>}
                {translations.ownLanguageSkipped.length > 0 && <p className="text-zinc-400">{t("packagingActions.translationsOwnLanguage", { languages: translations.ownLanguageSkipped.join(", ") })}</p>}
                <p className="text-zinc-400">{t("packagingActions.quota", { units: translations.quotaUnits })}</p>
              </>
            )}
            {error && <p className="text-red-400">{error}</p>}
          </div>
        </ConfirmDialog>
      )}
      {open === "comment" && (
        <ConfirmDialog
          title={t("packagingActions.commentTitle", { video })}
          description={t("packagingActions.commentDescription")}
          cancelLabel={t("packagingActions.cancel")}
          confirmLabel={t("packagingActions.commentSend")}
          confirmDisabled={busy || comment.trim() === ""}
          confirmBusyLabel={busy ? t("packagingActions.applying") : null}
          onCancel={() => {
            if (!busy) setOpen(null);
          }}
          onConfirm={() => void sendComment()}
        >
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={4}
            aria-label={t("packagingActions.commentPlaceholder")}
            placeholder={t("packagingActions.commentPlaceholder")}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
