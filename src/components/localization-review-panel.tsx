"use client";

import { errorText } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalizationVersion } from "./use-localization-version";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";
import { RequestTranslationDialog } from "./request-translation-dialog";
import type { Translate, UiTextKey } from "@/lib/ui-text";

// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §2, mockup approved in owner msg 3581): translation review by video. Left: the
// videos waiting for the owner; right: one video, one row per language (title and description together) with the app's checks and
// the agent's report. Approve/reject go through the existing change routes; the send goes through the existing send-together route
// (`videoIds`), started by the caller's batch runner.

type Verdict = "pass" | "warn" | "fail";
type Check = { id: string; result: Verdict; detail: string };
type Row = {
  changeId: string;
  changeSetId: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  approvalStatus: "pending" | "approved" | "rejected";
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  conflictStatus: "none" | "conflict";
  written: boolean;
  checks: Check[];
  report: { verdict: Verdict; checks: Check[]; note: string | null; backTranslation: string | null; reportId: string; reportedAt: string; reportedBy: string } | null;
  note: string | null;
  createdBy: string | null;
  setCreatedAt: string;
  originalChanged: boolean | null;
};
type Language = { language: string; title: Row | null; description: Row | null; verdict: Verdict; unchecked: boolean; untitled: boolean };
type Counts = { pass: number; warn: number; fail: number; unchecked: number; pending: number; approvedNotWritten: number };
type VideoInfo = { videoId: string; title: string; description: string; thumbnailUrl: string | null; publishedAt: string | null; privacyStatus: string | null; ownLanguage: string | null };
type Upload = { video: string | null; slotId: string | null; publishAt: string | null } | null;
type QueueEntry = { video: VideoInfo; upload: Upload; counts: Counts; languages: number };
type Review = { video: VideoInfo; upload: Upload; languages: Language[]; counts: Counts };
type RequestStatus = "requested" | "in_progress" | "done" | "partly_done" | "failed" | "cancelled";
type TranslationRequest = {
  requestId: string;
  videoIds: string[];
  languages: string[];
  mode: "fill_missing" | "redo";
  status: RequestStatus;
  overdue: boolean;
  claimedBy: "factory" | "worker" | null;
  results: Array<{ videoId: string; changeSetId: string }>;
  failReason: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};
/** Finished requests stay listed this long, so the owner sees what came of them. */
const FINISHED_SHOWN_MS = 3 * 24 * 60 * 60 * 1000;
const REQUEST_STATUS_CLASS: Record<RequestStatus, string> = {
  requested: "bg-zinc-800 text-zinc-300",
  in_progress: "bg-sky-950 text-sky-300",
  done: "bg-green-950 text-green-400",
  partly_done: "bg-amber-950 text-amber-400",
  failed: "bg-red-950 text-red-400",
  cancelled: "bg-zinc-800 text-zinc-500",
};

const VERDICT_ICON: Record<Verdict, string> = { pass: "✓", warn: "!", fail: "✗" };
const VERDICT_TEXT: Record<Verdict, string> = { pass: "text-green-400", warn: "text-amber-400", fail: "text-red-400" };
const VERDICT_BORDER: Record<Verdict, string> = { pass: "border-zinc-800", warn: "border-amber-900", fail: "border-red-900" };
const CHECK_KEYS: Record<string, UiTextKey> = {
  title_length: "langReview.check.title_length",
  description_bytes: "langReview.check.description_bytes",
  angle_brackets: "langReview.check.angle_brackets",
  own_language: "langReview.check.own_language",
  script: "langReview.check.script",
  tracked_language: "langReview.check.tracked_language",
  identical_to_original: "langReview.check.identical_to_original",
  timestamps: "langReview.check.timestamps",
  hashtags: "langReview.check.hashtags",
  links: "langReview.check.links",
  characters: "langReview.check.characters",
};

/** The release date: the upload's scheduled time, or the publish time of a video that is out; null = none yet (a private upload's
 * publishedAt is only when it was uploaded). */
const releaseOf = (video: VideoInfo, upload: Upload): string | null => upload?.publishAt ?? (video.privacyStatus === "public" ? video.publishedAt : null);

const rows = (language: Language) => [language.title, language.description].filter((row): row is Row => row !== null);
const isOpen = (row: Row) => !row.written && row.approvalStatus !== "rejected";
const canApprove = (language: Language) =>
  language.verdict !== "fail" && rows(language).some((row) => row.approvalStatus === "pending" && !row.written) && rows(language).every((row) => row.validationStatus === "valid" && row.conflictStatus === "none");

function statusLabel(t: Translate, language: Language): string {
  const present = rows(language);
  if (present.length > 0 && present.every((row) => row.written)) return t("langReview.status.written");
  if (present.some((row) => row.approvalStatus === "pending" && !row.written)) return t("langReview.status.pending");
  if (present.every((row) => row.approvalStatus === "rejected")) return t("langReview.status.rejected");
  return t("langReview.status.approved");
}

function CheckLine({ check, agent }: { check: Check; agent: boolean }) {
  const t = useT();
  const label = !agent && CHECK_KEYS[check.id] ? t(CHECK_KEYS[check.id]) : check.id;
  return (
    <div className={VERDICT_TEXT[check.result]}>
      {VERDICT_ICON[check.result]} {agent ? t("langReview.agentCheck", { label }) : label}
      {check.detail ? `: ${check.detail}` : ""}
    </div>
  );
}

function LanguageRow({
  language,
  busy,
  onDecide,
  onRedo,
}: {
  language: Language;
  busy: boolean;
  onDecide: (language: Language, action: "approve" | "reject") => void;
  onRedo: (language: Language) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [showPassed, setShowPassed] = useState(false);
  const [showBack, setShowBack] = useState(false);
  const present = rows(language);
  const allChecks = present.flatMap((row) => [
    ...row.checks.map((check) => ({ check, agent: false, field: row.field })),
    ...(row.report?.checks ?? []).map((check) => ({ check, agent: true, field: row.field })),
  ]);
  const problems = allChecks.filter((entry) => entry.check.result !== "pass");
  const passed = allChecks.filter((entry) => entry.check.result === "pass");
  const notes = present.map((row) => row.note).filter((note): note is string => Boolean(note));
  const reportNotes = present.map((row) => row.report?.note).filter((note): note is string => Boolean(note));
  const back = present.map((row) => row.report?.backTranslation).filter((text): text is string => Boolean(text));
  const errors = present.map((row) => row.validationError).filter((text): text is string => Boolean(text));
  const changed = present.some((row) => row.originalChanged === true);
  const open = present.some(isOpen);

  return (
    <div className={`grid grid-cols-1 gap-3 rounded-lg border bg-zinc-950 p-3 sm:grid-cols-[72px_1fr_170px] ${VERDICT_BORDER[language.verdict]}`}>
      <div>
        <div className="text-sm font-semibold text-zinc-100">{language.language}</div>
        <div className={`mt-1 text-xl leading-none ${VERDICT_TEXT[language.verdict]}`} aria-label={t(`langReview.verdict.${language.verdict}` as UiTextKey)}>
          {VERDICT_ICON[language.verdict]}
        </div>
        {language.unchecked && <div className="mt-1 text-[10px] text-zinc-500">{t("langReview.unchecked")}</div>}
      </div>
      <div className="min-w-0 text-xs">
        {language.title ? <p className="text-sm font-medium text-zinc-100">{language.title.proposedValue}</p> : <p className="text-zinc-500">{t("langReview.noTitleChange")}</p>}
        {language.description && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((v) => !v)}
            // ui-text-ignore: key names, not interface text
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setExpanded((v) => !v)}
            className={`mt-1 cursor-pointer whitespace-pre-wrap text-zinc-400 ${expanded ? "" : "line-clamp-2"}`}
          >
            {language.description.proposedValue}
          </div>
        )}
        <div className="mt-2 space-y-0.5">
          {language.untitled && <div className="text-red-400">✗ {t("langReview.untitled")}</div>}
          {errors.map((error) => (
            <div key={error} className="text-red-400">✗ {error}</div>
          ))}
          {changed && <div className="text-amber-400">! {t("langReview.originalChanged")}</div>}
          {problems.map((entry, index) => (
            <CheckLine key={`${entry.field}-${entry.agent}-${entry.check.id}-${index}`} check={entry.check} agent={entry.agent} />
          ))}
          {passed.length > 0 && (
            <button type="button" onClick={() => setShowPassed((v) => !v)} className="text-green-500 hover:text-green-400">
              ✓ {t("langReview.passed", { count: passed.length })} {showPassed ? "▾" : "▸"}
            </button>
          )}
          {showPassed && passed.map((entry, index) => <CheckLine key={`p-${entry.field}-${entry.agent}-${entry.check.id}-${index}`} check={entry.check} agent={entry.agent} />)}
        </div>
        {notes.map((note) => (
          <p key={`n-${note}`} className="mt-1 text-violet-300">{t("langReview.agentNote", { note })}</p>
        ))}
        {reportNotes.map((note) => (
          <p key={`r-${note}`} className="mt-1 text-violet-300">{t("langReview.reportNote", { note })}</p>
        ))}
        {back.length > 0 && (
          <button type="button" onClick={() => setShowBack((v) => !v)} className="mt-1 block text-left text-zinc-500 hover:text-zinc-300">
            {showBack ? "▾" : "▸"} {t("langReview.backTranslation")}
            {showBack && <span className="mt-1 block whitespace-pre-wrap text-zinc-400">{back.join("\n\n")}</span>}
          </button>
        )}
      </div>
      <div className="flex flex-col items-stretch gap-1.5">
        <span className="text-right text-[11px] text-zinc-500">{statusLabel(t, language)}</span>
        {canApprove(language) && (
          <button type="button" disabled={busy} onClick={() => onDecide(language, "approve")} className="rounded-lg bg-green-700 px-3 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-40">
            {t("langReview.approve")}
          </button>
        )}
        {open && language.verdict !== "pass" && (
          <button type="button" disabled={busy} onClick={() => onRedo(language)} className="rounded-lg border border-indigo-800 px-3 py-1 text-xs font-medium text-indigo-300 hover:border-indigo-500 disabled:opacity-40">
            {t("langReview.requestRedo")}
          </button>
        )}
        {open && (
          <button type="button" disabled={busy} onClick={() => onDecide(language, "reject")} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-40">
            {t("langReview.reject")}
          </button>
        )}
      </div>
    </div>
  );
}

export function LocalizationReviewPanel({
  channelId,
  channelLanguages,
  sendBusy,
  onSend,
  onChanged,
  requestsVersion,
  onSummary,
}: {
  channelId: string;
  /** The channel's languages (the Languages table's columns), offered in a request. */
  channelLanguages: string[];
  /** Bumped by the caller after it made a request, so the list reloads. */
  requestsVersion?: number;
  /** BL-227 stage 3: what waits for the owner, for the section's strip. */
  onSummary?: (summary: { waiting: number; approvedNotWritten: number; openRequests: number }) => void;
  sendBusy: boolean;
  /** Starts the send of these sets' approved changes of these videos (the caller's batch runner). */
  onSend: (changeSetIds: string[], videoIds: string[]) => void;
  /** Called after an approve/reject, so the caller can refresh its set list. */
  onChanged?: () => void;
}) {
  const t = useT();
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [loadingReview, setLoadingReview] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<TranslationRequest[]>([]);
  const [redoFor, setRedoFor] = useState<Language | null>(null);
  const reviewRequest = useRef(0);
  const base = `/api/channels/${encodeURIComponent(channelId)}`;

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch(`${base}/localization-review`);
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      const videos = (data.videos ?? []) as QueueEntry[];
      setQueue(videos);
      setSelected((current) => (current && videos.some((entry) => entry.video.videoId === current) ? current : videos[0]?.video.videoId ?? null));
    } catch (e) {
      setError(String(e));
    }
  }, [base, t]);

  const loadReview = useCallback(
    async (videoId: string, quiet = false) => {
      const request = ++reviewRequest.current;
      if (!quiet) setLoadingReview(true);
      try {
        const res = await fetch(`${base}/localization-review/${encodeURIComponent(videoId)}`);
        const data = await res.json();
        if (request !== reviewRequest.current) return;
        if (!res.ok) {
          setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
          return;
        }
        setReview(data.review ?? null);
      } catch (e) {
        if (request === reviewRequest.current) setError(String(e));
      } finally {
        if (request === reviewRequest.current && !quiet) setLoadingReview(false);
      }
    },
    [base, t]
  );

  const loadRequests = useCallback(async () => {
    try {
      const res = await fetch(`${base}/localization-requests`);
      const data = await res.json();
      if (res.ok) setRequests((data.requests ?? []) as TranslationRequest[]);
    } catch {
      // The list is secondary: the review still works without it.
    }
  }, [base]);

  async function cancelRequest(requestId: string) {
    setError(null);
    const res = await fetch(`${base}/localization-requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
    }
    await loadRequests();
  }

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);
  useEffect(() => {
    void loadRequests();
  }, [loadRequests, requestsVersion]);
  useEffect(() => {
    if (selected) void loadReview(selected);
    else setReview(null);
  }, [selected, loadReview]);
  // Rows written or changed elsewhere (another computer, an agent's report) show up within ~15 s.
  const refreshQuietly = useCallback(() => {
    void loadQueue();
    void loadRequests();
    if (selected) void loadReview(selected, true);
  }, [loadQueue, loadRequests, loadReview, selected]);
  useLocalizationVersion(channelId, refreshQuietly);

  async function decide(targets: Array<{ row: Row; action: "approve" | "reject" }>) {
    setBusy(true);
    setError(null);
    try {
      for (const { row, action } of targets) {
        const res = await fetch(`${base}/change-sets/${encodeURIComponent(row.changeSetId)}/changes/${encodeURIComponent(row.changeId)}/${action}`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
          break;
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onChanged?.();
      await loadQueue();
      if (selected) await loadReview(selected, true);
    }
  }

  const decideLanguage = (language: Language, action: "approve" | "reject") =>
    void decide(
      rows(language)
        .filter((row) => (action === "approve" ? row.approvalStatus === "pending" && !row.written : isOpen(row)))
        .map((row) => ({ row, action }))
    );

  const languages = review?.languages ?? [];
  const problemCount = languages.filter((language) => language.verdict !== "pass").length;
  const greens = languages.filter((language) => language.verdict === "pass" && canApprove(language));
  const shown = onlyProblems ? languages.filter((language) => language.verdict !== "pass") : languages;
  const approvedRows = languages.flatMap(rows).filter((row) => row.approvalStatus === "approved" && !row.written);
  const reportAt = useMemo(() => {
    const times = (review?.languages ?? []).flatMap(rows).map((row) => row.report?.reportedAt).filter((time): time is string => Boolean(time));
    return times.length > 0 ? times.sort().at(-1)! : null;
  }, [review]);
  const author = languages.flatMap(rows).find((row) => row.createdBy)?.createdBy ?? null;
  const setTime = languages.flatMap(rows).map((row) => row.setCreatedAt).sort().at(-1) ?? null;

  useEffect(() => {
    if (!onSummary || queue === null) return;
    onSummary({
      waiting: queue.filter((entry) => entry.counts.pending > 0).length,
      approvedNotWritten: queue.filter((entry) => entry.counts.approvedNotWritten > 0).length,
      openRequests: requests.filter((request) => request.status === "requested" || request.status === "in_progress").length,
    });
  }, [queue, requests, onSummary]);

  if (queue === null) return <LoadingIndicator className="text-sm text-zinc-500" />;

  const now = Date.now();
  const shownRequests = requests.filter(
    (request) => request.status === "requested" || request.status === "in_progress" || (request.status !== "cancelled" && now - Date.parse(request.updatedAt) < FINISHED_SHOWN_MS)
  );
  const titleOf = (videoId: string) => queue.find((entry) => entry.video.videoId === videoId)?.video.title ?? (review?.video.videoId === videoId ? review.video.title : videoId);

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>}
      {shownRequests.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{t("langRequest.listTitle", { count: shownRequests.length })}</p>
          <ul className="space-y-1 text-xs">
            {shownRequests.map((request) => (
              <li key={request.requestId} className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${REQUEST_STATUS_CLASS[request.status]}`}>{t(`langRequest.status.${request.status}` as UiTextKey)}</span>
                {request.overdue && <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] text-red-400">{t("langRequest.overdue")}</span>}
                <span className="text-zinc-300">
                  {request.videoIds.length === 1 ? titleOf(request.videoIds[0]) : t("langRequest.videos", { count: request.videoIds.length })} · {request.languages.join(", ")}
                  {request.mode === "redo" ? ` · ${t("langRequest.modeRedo")}` : ""}
                </span>
                <span className="text-zinc-500">{formatDisplayDateTime(request.createdAt)}</span>
                {request.status === "partly_done" && <span className="text-amber-400">{t("langRequest.partly", { done: request.results.length, total: request.videoIds.length })}</span>}
                {request.failReason && <span className="text-red-400">{request.failReason}</span>}
                {(request.status === "requested" || request.status === "in_progress") && (
                  <button type="button" onClick={() => void cancelRequest(request.requestId)} className="ml-auto text-zinc-500 hover:text-zinc-300">
                    {t("langRequest.cancelRequest")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {redoFor && review && (
        <RequestTranslationDialog
          channelId={channelId}
          videoIds={[review.video.videoId]}
          languages={channelLanguages}
          defaultLanguages={[redoFor.language]}
          redo={{ changeId: (redoFor.title ?? redoFor.description)!.changeId }}
          onClose={() => setRedoFor(null)}
          onCreated={() => void loadRequests()}
        />
      )}
      {queue.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("langReview.queueEmpty")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[300px_1fr]">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{t("langReview.queueTitle", { count: queue.length })}</p>
            {queue.map((entry) => (
              <button
                key={entry.video.videoId}
                type="button"
                onClick={() => setSelected(entry.video.videoId)}
                className={`flex w-full gap-2 rounded-lg border p-2 text-left ${selected === entry.video.videoId ? "border-zinc-500 bg-zinc-800" : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"}`}
              >
                {entry.video.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.video.thumbnailUrl} alt="" className="h-9 w-16 flex-none rounded object-cover" />
                ) : (
                  <div className="h-9 w-16 flex-none rounded bg-zinc-800" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-xs text-zinc-200">{entry.upload?.video ? `${entry.upload.video} · ` : ""}{entry.video.title}</div>
                  <div className="text-[11px] text-zinc-500">
                    {releaseOf(entry.video, entry.upload)
                      ? t("langReview.queueMeta", { date: formatDisplayDateTime(releaseOf(entry.video, entry.upload)!), count: entry.languages })
                      : t("langReview.queueMetaNoDate", { count: entry.languages })}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 text-[10px]">
                    {entry.counts.pass > 0 && <span className="rounded bg-green-950 px-1.5 text-green-400">✓ {entry.counts.pass}</span>}
                    {entry.counts.warn > 0 && <span className="rounded bg-amber-950 px-1.5 text-amber-400">! {entry.counts.warn}</span>}
                    {entry.counts.fail > 0 && <span className="rounded bg-red-950 px-1.5 text-red-400">✗ {entry.counts.fail}</span>}
                    {entry.counts.unchecked === entry.languages && <span className="rounded bg-zinc-800 px-1.5 text-zinc-400">{t("langReview.unchecked")}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="min-w-0 rounded-lg border border-zinc-800 p-3">
            {loadingReview && !review && <LoadingIndicator className="text-sm text-zinc-500" />}
            {!loadingReview && !review && <p className="text-sm text-zinc-500">{t("langReview.videoDone")}</p>}
            {review && (
              <div className="space-y-3">
                <div className="flex gap-3">
                  {review.video.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={review.video.thumbnailUrl} alt="" className="h-20 w-36 flex-none rounded object-cover" />
                  ) : (
                    <div className="h-20 w-36 flex-none rounded bg-zinc-800" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-100">{review.upload?.video ? `${review.upload.video} · ` : ""}{review.video.title}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-zinc-400">
                      <span className="rounded-full border border-zinc-700 px-2">
                        {releaseOf(review.video, review.upload) ? t("langReview.releaseAt", { date: formatDisplayDateTime(releaseOf(review.video, review.upload)!) }) : t("langReview.noDate")}
                      </span>
                      {review.upload?.slotId && <span className="rounded-full border border-zinc-700 px-2">{t("langReview.slot", { slot: review.upload.slotId })}</span>}
                      {review.video.privacyStatus && <span className="rounded-full border border-zinc-700 px-2">{review.video.privacyStatus}</span>}
                      {review.video.ownLanguage && <span className="rounded-full border border-zinc-700 px-2">{t("langReview.original", { language: review.video.ownLanguage })}</span>}
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-500">
                      {author ? t("langReview.madeBy", { author: t(`langReview.author.${author}` as UiTextKey), date: setTime ? formatDisplayDateTime(setTime) : "—" }) : t("langReview.madeAt", { date: setTime ? formatDisplayDateTime(setTime) : "—" })}
                      {" · "}
                      {reportAt ? t("langReview.reportAt", { date: formatDisplayDateTime(reportAt) }) : t("langReview.noReport")}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs">
                  <p className="text-[10px] uppercase text-zinc-500">{t("langReview.originalLabel", { language: review.video.ownLanguage ?? "—" })}</p>
                  <p className="mt-0.5 font-medium text-zinc-200">{review.video.title}</p>
                  <button type="button" onClick={() => setShowOriginal((v) => !v)} className="mt-1 text-sky-400 hover:text-sky-300">
                    {showOriginal ? "▾" : "▸"} {t("langReview.showDescription")}
                  </button>
                  {showOriginal && <p className="mt-1 whitespace-pre-wrap text-zinc-400">{review.video.description}</p>}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex overflow-hidden rounded-lg border border-zinc-800 text-xs">
                    <button type="button" onClick={() => setOnlyProblems(false)} className={`px-3 py-1 ${onlyProblems ? "text-zinc-400" : "bg-zinc-800 text-white"}`}>
                      {t("langReview.filterAll", { count: languages.length })}
                    </button>
                    <button type="button" onClick={() => setOnlyProblems(true)} className={`px-3 py-1 ${onlyProblems ? "bg-zinc-800 text-white" : "text-zinc-400"}`}>
                      {t("langReview.filterProblems", { count: problemCount })}
                    </button>
                  </div>
                  <span className="flex-1" />
                  <button
                    type="button"
                    disabled={busy || greens.length === 0}
                    onClick={() => void decide(greens.flatMap((language) => rows(language).filter((row) => row.approvalStatus === "pending" && !row.written).map((row) => ({ row, action: "approve" as const }))))}
                    className="rounded-lg bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-40"
                  >
                    {t("langReview.approveGreens", { count: greens.length })}
                  </button>
                </div>

                <div className="space-y-2">
                  {shown.map((language) => (
                    <LanguageRow key={language.language} language={language} busy={busy} onDecide={decideLanguage} onRedo={setRedoFor} />
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
                  <span>{t("langReview.footer", { approved: languages.filter((l) => rows(l).some((r) => r.approvalStatus === "approved" && !r.written)).length, total: languages.length, pending: review.counts.pending })}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    disabled={sendBusy || approvedRows.length === 0}
                    onClick={() => onSend([...new Set(approvedRows.map((row) => row.changeSetId))], [review.video.videoId])}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    {t("langReview.send", { count: approvedRows.length })}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
