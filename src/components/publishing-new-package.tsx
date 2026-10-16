"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDisplayDateUtc, parseDisplayDate } from "@/lib/shared-formatting";
import { TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";
import { formatBytes } from "./volume-usage-bar";

type FolderFiles = { videos: string[]; images: string[]; texts: string[]; manifest: string | null; youtubeRecord: string | null };
type Folder = { folder: string; video: string; files: FolderFiles; hasPackage: boolean };
type Problem = { code: string; params?: Record<string, string | number> };
type Draft = {
  folder: string;
  video: string;
  files: FolderFiles;
  picks: { video: string | null; thumbnail: string | null; text: string | null };
  title: string;
  description: string;
  textUnreadable: boolean;
  tags: string[];
  plannedPublishDate: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  languages: { defaultLanguage: string | null; defaultAudioLanguage: string | null };
  problems: Problem[];
  existing: { exists: boolean; replaceable: boolean; reason: "uploaded" | "queued" | null };
};
/** What the owner typed; absent = take the folder's own value. */
type Edits = { title?: string; description?: string; tags?: string; date?: string };

const tagsOf = (text: string) =>
  text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");

/**
 * BL-192 (docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md): «Новый пакет» -- the owner's own release package from a video folder. Step
 * one lists the folders; step two shows what the folder gives (video, thumbnail, title and description from its text file) for the
 * owner to check, change and save as `Vn_release.json`. The server re-checks it as the scan would (shown live); nothing goes to YouTube.
 */
export function PublishingNewPackage({ channelId, onClose, onSaved }: { channelId: string; onClose: () => void; onSaved: () => void }) {
  const { t, formatNumber } = useUiText();
  const base = `/api/channels/${encodeURIComponent(channelId)}/publishing`;
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [picks, setPicks] = useState<{ video?: string | null; thumbnail?: string | null; text?: string | null }>({});
  const [edits, setEdits] = useState<Edits>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${base}/package-folders`);
        const data = await res.json();
        if (!res.ok) throw new Error(errorText(t, data, t("publishingNewPackage.foldersFailed")));
        setFolders(data.folders as Folder[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("publishingNewPackage.foldersFailed"));
      }
    })();
  }, [base, t]);

  const date = edits.date === undefined ? undefined : edits.date.trim() === "" ? null : (parseDisplayDate(edits.date)?.slice(0, 10) ?? "invalid");
  const body = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      folder,
      files: picks,
      ...(edits.title !== undefined ? { title: edits.title } : {}),
      ...(edits.description !== undefined ? { description: edits.description } : {}),
      ...(edits.tags !== undefined ? { tags: tagsOf(edits.tags) } : {}),
      ...(date !== undefined && date !== "invalid" ? { plannedPublishDate: date } : {}),
      ...extra,
    }),
    [folder, picks, edits, date]
  );

  // The draft, again whenever a pick or a field changes (fields after a short pause): the server's own checks, shown live.
  useEffect(() => {
    if (!folder) return;
    const id = ++requestRef.current;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch(`${base}/package-draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
        const data = await res.json();
        if (id !== requestRef.current) return;
        if (!res.ok) throw new Error(errorText(t, data, t("publishingNewPackage.draftFailed")));
        setDraft(data.draft as Draft);
        setError(null);
      } catch (e) {
        if (id === requestRef.current) setError(e instanceof Error ? e.message : t("publishingNewPackage.draftFailed"));
      } finally {
        if (id === requestRef.current) setChecking(false);
      }
    }, edits.title !== undefined || edits.description !== undefined || edits.tags !== undefined ? 500 : 0);
    return () => clearTimeout(timer);
  }, [folder, base, body, edits, t]);

  async function save() {
    if (!draft) return;
    if (draft.existing.exists && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${base}/package`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body({ replace: draft.existing.exists })) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("publishingNewPackage.saveFailed")));
      onSaved();
    } catch (e) {
      setConfirmReplace(false);
      setError(e instanceof Error ? e.message : t("publishingNewPackage.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const pickFolder = (value: string | null) => {
    setFolder(value);
    setPicks({});
    setEdits({});
    setDraft(null);
    setConfirmReplace(false);
    setError(null);
  };
  const problemText = (problem: Problem) => t(`publishingPackages.problem.${problem.code}` as UiTextKey, problem.params ?? {});
  const duration = (seconds: number) => t("duration.hoursMinutes", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
  const title = edits.title ?? draft?.title ?? "";
  const description = edits.description ?? draft?.description ?? "";
  const held = draft !== null && !draft.existing.replaceable;
  const canSave = draft !== null && !held && !saving && date !== "invalid" && draft.picks.video !== null && draft.picks.thumbnail !== null && title.trim() !== "";
  const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none";
  const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500";
  const select = (kind: "video" | "thumbnail" | "text", options: string[], value: string | null, ariaLabel: string) =>
    options.length > 1 ? (
      <select className={field} value={value ?? ""} aria-label={ariaLabel} onChange={(e) => setPicks((prev) => ({ ...prev, [kind]: e.target.value === "" ? null : e.target.value }))}>
        <option value="">{t("publishingNewPackage.choose")}</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    ) : (
      <p className="truncate text-xs text-zinc-200" title={value ?? ""}>
        {value ?? <span className="text-red-400">{t("publishingNewPackage.none")}</span>}
      </p>
    );

  return (
    <ConfirmDialog
      size="wide"
      title={folder && draft ? t("publishingNewPackage.titleFor", { video: draft.video }) : t("publishingNewPackage.title")}
      description={folder ? undefined : t("publishingNewPackage.intro")}
      confirmLabel={confirmReplace ? t("publishingNewPackage.replaceConfirm") : t("publishingNewPackage.save")}
      confirmVariant={confirmReplace ? "danger" : "default"}
      confirmDisabled={!canSave}
      onCancel={confirmReplace ? () => setConfirmReplace(false) : onClose}
      onConfirm={() => void save()}
    >
      <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 text-xs text-zinc-300">
        {!folder && (
          <>
            {!folders && !error && <LoadingIndicator className="text-xs text-zinc-400" />}
            {folders && folders.length === 0 && <p className="text-zinc-400">{t("publishingNewPackage.noFolders")}</p>}
            {folders && folders.length > 0 && (
              <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                {folders.map((f) => (
                  <li key={f.folder}>
                    <button type="button" onClick={() => pickFolder(f.folder)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/60">
                      <span className="w-12 shrink-0 font-mono text-zinc-400">{f.video}</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-200">{f.folder.split("/").slice(1).join(" / ")}</span>
                      {f.hasPackage && <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{t("publishingNewPackage.hasPackage")}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {folder && (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-mono text-[11px] text-zinc-500" title={folder}>
                {folder}
              </p>
              <button type="button" onClick={() => pickFolder(null)} className="shrink-0 text-zinc-400 underline hover:text-zinc-200">
                {t("publishingNewPackage.otherFolder")}
              </button>
            </div>
            {!draft && !error && <LoadingIndicator className="text-xs text-zinc-400" />}
            {draft && (
              <>
                {draft.existing.exists && (
                  <p className={`rounded-md border px-2 py-1.5 ${held ? "border-red-900/60 bg-red-950/30 text-red-300" : "border-amber-800/60 bg-amber-950/20 text-amber-200"}`}>
                    {held ? t(draft.existing.reason === "uploaded" ? "publishingNewPackage.heldUploaded" : "publishingNewPackage.heldQueued") : t("publishingNewPackage.willReplace")}
                  </p>
                )}
                {confirmReplace && <p className="rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-red-300">{t("publishingNewPackage.replaceQuestion", { video: draft.video })}</p>}

                <div className="flex gap-3">
                  <div className="h-[72px] w-32 shrink-0 overflow-hidden rounded bg-zinc-800">
                    {draft.picks.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element -- a local preview through the app's own route
                      <img src={`${base}/packages/thumbnail?path=${encodeURIComponent(`${folder}/${draft.picks.thumbnail}`)}`} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="min-w-0">
                      <span className={label}>{t("publishingNewPackage.video")}</span>
                      {select("video", draft.files.videos, draft.picks.video, t("publishingNewPackage.video"))}
                      {draft.sizeBytes !== null && (
                        <p className="text-[11px] text-zinc-500">
                          {formatBytes(t, formatNumber, draft.sizeBytes)}
                          {draft.durationSeconds !== null ? ` · ${duration(draft.durationSeconds)}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0">
                      <span className={label}>{t("publishingNewPackage.thumbnail")}</span>
                      {select("thumbnail", draft.files.images, draft.picks.thumbnail, t("publishingNewPackage.thumbnail"))}
                    </div>
                  </div>
                </div>

                <div>
                  <span className={label}>{t("publishingNewPackage.textFile")}</span>
                  {select("text", draft.files.texts, draft.picks.text, t("publishingNewPackage.textFile"))}
                  {draft.picks.text === null && draft.files.texts.length === 0 && <p className="text-[11px] text-zinc-500">{t("publishingNewPackage.noTextFile")}</p>}
                  {draft.textUnreadable && <p className="text-[11px] text-amber-300">{t("publishingNewPackage.textUnreadable")}</p>}
                </div>

                <label className="block">
                  <span className={label}>
                    {t("publishingNewPackage.fieldTitle")} <span className="normal-case text-zinc-600">{formatNumber([...title].length)} / {TITLE_MAX_CHARACTERS}</span>
                  </span>
                  <input className={field} value={title} onChange={(e) => setEdits((prev) => ({ ...prev, title: e.target.value }))} />
                </label>
                <label className="block">
                  <span className={label}>{t("publishingNewPackage.fieldDescription")}</span>
                  <textarea className={`${field} min-h-[160px] font-mono leading-relaxed`} value={description} onChange={(e) => setEdits((prev) => ({ ...prev, description: e.target.value }))} />
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className={label}>{t("publishingNewPackage.fieldTags")}</span>
                    <input className={field} value={edits.tags ?? draft.tags.join(", ")} placeholder={t("publishingNewPackage.tagsPlaceholder")} onChange={(e) => setEdits((prev) => ({ ...prev, tags: e.target.value }))} />
                  </label>
                  <label className="block">
                    <span className={label}>{t("publishingNewPackage.fieldDate")}</span>
                    <input
                      className={`${field} ${date === "invalid" ? "border-red-700" : ""}`}
                      value={edits.date ?? (draft.plannedPublishDate ? formatDisplayDateUtc(`${draft.plannedPublishDate}T00:00:00Z`) : "")}
                      placeholder={t("publishingNewPackage.datePlaceholder")}
                      onChange={(e) => setEdits((prev) => ({ ...prev, date: e.target.value }))}
                    />
                    {date === "invalid" && <span className="text-[11px] text-red-400">{t("publishingNewPackage.dateInvalid")}</span>}
                  </label>
                </div>
                <p className="text-[11px] text-zinc-500">
                  {t("publishingNewPackage.languages", { language: draft.languages.defaultLanguage ?? "—", audio: draft.languages.defaultAudioLanguage ?? draft.languages.defaultLanguage ?? "—" })}
                </p>

                <div className="rounded-md border border-zinc-800 px-2 py-1.5">
                  {checking ? (
                    <p className="text-zinc-500">{t("publishingNewPackage.checking")}</p>
                  ) : draft.problems.length === 0 ? (
                    <p className="text-emerald-300">{t("publishingNewPackage.noProblems")}</p>
                  ) : (
                    <>
                      <p className="mb-1 text-amber-200">{t("publishingNewPackage.problems")}</p>
                      <ul className="list-disc space-y-0.5 pl-4 text-amber-100/90">
                        {draft.problems.map((problem) => (
                          <li key={`${problem.code}-${JSON.stringify(problem.params ?? {})}`}>{problemText(problem)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {error && <p className="text-red-400">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}
