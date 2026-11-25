"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftTimedComment, IssueAction } from "@/lib/package-reviews/timed-comments";
import type { UiTextKey } from "@/lib/ui-text";
import { SkeletonLines } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { formatPlayerTime } from "./media-review-player";
import { PackageReviewWorkspace } from "./package-review-workspace";
import {
  actionsOf,
  decisionBody,
  decisionReady,
  notesCount,
  durationLabel,
  mediaSrcOf,
  type DraftSaveState,
  type PackageReviewDraftDto,
  type PackageReviewDto,
  type PackageReviewState,
  type PackageReviewsDto,
} from "./package-reviews-model";
import { ToggleSwitch } from "./toggle-switch";
import { useT, useUiText } from "./ui-text-provider";
import { useUserTimezone } from "./use-user-timezone";

// BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md stage 2; owner msgs 4514/4516/4519), BL-265 (ADR 0072 §1-§2): Медиа → «Видео на проверку».
// The owner approves or returns the VIDEO (the mp4); packaging gets «Комментарий к упаковке» on any package, uploaded ones included. The owner's questions in
// order: is the gate on for this channel (the switch on top), does anything wait for me (the line and the waiting cards first), what
// does the finished video look like (the player streams the package's own file by Range -- any length, on the phone too), what goes
// with it (thumbnail, title, description, translations, slot). He answers on the card: «Одобрить» or «Вернуть» (a comment required),
// each confirmed in the app's own dialog. On a phone (< 768 px) the player fills the width and the actions stay in a bar at the
// bottom of the card while it scrolls (AC-PR-15).

const STATE_STYLES: Record<PackageReviewState, string> = {
  pending: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  returned: "bg-red-500/15 text-red-300 ring-red-500/30",
  uploaded: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
};
const STATE_KEYS: Record<PackageReviewState, UiTextKey> = {
  pending: "packageReviews.state.pending",
  approved: "packageReviews.state.approved",
  returned: "packageReviews.state.returned",
  uploaded: "packageReviews.state.uploaded",
};
const ERROR_KEYS: Record<string, UiTextKey> = {
  package_review_no_sha256: "packageReviews.error.package_review_no_sha256",
  package_review_video_missing: "packageReviews.error.package_review_video_missing",
  package_review_video_mismatch: "packageReviews.error.package_review_video_mismatch",
  package_review_thumbnail_missing: "packageReviews.error.package_review_thumbnail_missing",
  package_review_not_found: "packageReviews.error.package_review_not_found",
  package_review_uploaded: "packageReviews.error.package_review_uploaded",
  package_review_draft_changed: "packageReviews.error.package_review_draft_changed",
  package_review_issue_unknown: "packageReviews.error.package_review_issue_unknown",
};

type DecisionKind = "approved" | "returned" | "packaging_comment";
/** Owner TG 4836: `reapprove` -- an approval of an already approved video, with notes for future videos (it stays approved). */
type Asking = { item: PackageReviewDto; kind: DecisionKind; reapprove: boolean } | null;
const REAPPROVE_KEYS = { title: "packageReviews.reapprove.title", description: "packageReviews.reapprove.description", confirm: "packageReviews.reapprove.confirm", placeholder: "packageReviews.reapprove.placeholder" } as const satisfies Record<string, UiTextKey>;
const DIALOG_KEYS: Record<DecisionKind, { title: UiTextKey; description: UiTextKey; confirm: UiTextKey; placeholder: UiTextKey }> = {
  approved: { title: "packageReviews.approve.title", description: "packageReviews.approve.description", confirm: "packageReviews.approve.confirm", placeholder: "packageReviews.approve.placeholder" },
  returned: { title: "packageReviews.return.title", description: "packageReviews.return.description", confirm: "packageReviews.return.confirm", placeholder: "packageReviews.return.placeholder" },
  packaging_comment: { title: "packageReviews.comment.title", description: "packageReviews.comment.description", confirm: "packageReviews.comment.confirm", placeholder: "packageReviews.comment.placeholder" },
};

export function PackageReviewsPanel({ channelId, visible, onWaiting }: { channelId: string | null; visible: boolean; onWaiting?: (count: number) => void }) {
  const t = useT();
  const { language } = useUiText();
  const ownerZone = useUserTimezone();
  const [data, setData] = useState<PackageReviewsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ manifest: string; text: string } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState<Asking>(null);
  const [comment, setCommentState] = useState("");
  // Owner msg 4556: a comment that was not saved (an error, a closed dialog) comes back when he opens the same dialog again, also
  // after a reload (this browser only), so he never loses or has to retype it. Cleared once the decision is saved.
  const draftKey = (manifest: string, kind: string) => `packageReviews.draft.${channelId ?? ""}.${manifest}.${kind}`;
  const setComment = (value: string) => {
    setCommentState(value);
    if (asking) {
      try {
        if (value) window.localStorage.setItem(draftKey(asking.item.manifestSha256, asking.kind), value);
        else window.localStorage.removeItem(draftKey(asking.item.manifestSha256, asking.kind));
      } catch {
        // storage unavailable: the draft lives only while the page is open
      }
    }
  };
  const openDialog = (item: PackageReviewDto, kind: DecisionKind) => {
    let draft = "";
    try {
      draft = window.localStorage.getItem(draftKey(item.manifestSha256, kind)) ?? "";
    } catch {
      // storage unavailable
    }
    setCommentState(draft);
    setAsking({ item, kind, reapprove: kind === "approved" && item.state === "approved" });
  };
  const [busy, setBusy] = useState<string | null>(null);

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/package-reviews` : null;

  // Owner TG 4817 (AC-TC-03/05): each package's draft of timed comments -- the server's (device-local), loaded when its card opens and
  // saved whole on every change, one save at a time per package (the last one wins). Kept apart from the list the minute poll reloads.
  // Review fixes 1-2: nothing is written before the draft has loaded (`loaded`); every save names the stored draft it replaces (the
  // server's stamp, `stamps`) and the decision names the draft it was made from, so a draft saved meanwhile elsewhere is never
  // overwritten or deleted unsent -- the server refuses (`package_review_draft_changed`) and the screen reloads it.
  type DraftEntry = { comments: DraftTimedComment[]; actions: IssueAction[]; state: DraftSaveState; loaded: boolean; changed: boolean };
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const requested = useRef<Set<string>>(new Set());
  const stamps = useRef<Map<string, string | null>>(new Map());
  const saveChains = useRef<Map<string, Promise<unknown>>>(new Map());
  const saveSeq = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    requested.current = new Set();
    stamps.current = new Map();
    setDrafts({});
  }, [base]);
  const loadDraft = useCallback(
    async (manifest: string, force = false) => {
      if (!base || (requested.current.has(manifest) && !force)) return;
      requested.current.add(manifest);
      saveSeq.current.set(manifest, (saveSeq.current.get(manifest) ?? 0) + 1);
      setDrafts((d) => ({ ...d, [manifest]: { comments: d[manifest]?.comments ?? [], actions: d[manifest]?.actions ?? [], state: "loading", loaded: false, changed: force } }));
      try {
        const res = await fetch(`${base}/draft?manifest=${encodeURIComponent(manifest)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as PackageReviewDraftDto;
        stamps.current.set(manifest, body.updatedAt);
        setDrafts((d) => ({ ...d, [manifest]: { comments: body.comments, actions: body.issueActions ?? [], state: "saved", loaded: true, changed: d[manifest]?.changed ?? false } }));
      } catch {
        requested.current.delete(manifest);
        setDrafts((d) => ({ ...d, [manifest]: { comments: d[manifest]?.comments ?? [], actions: d[manifest]?.actions ?? [], state: "error", loaded: false, changed: false } }));
      }
    },
    [base]
  );
  const saveDraft = useCallback(
    (manifest: string, comments: DraftTimedComment[], actions: IssueAction[]) => {
      if (!base) return;
      const seq = (saveSeq.current.get(manifest) ?? 0) + 1;
      saveSeq.current.set(manifest, seq);
      setDrafts((d) => ({ ...d, [manifest]: { comments, actions, state: "saving", loaded: true, changed: false } }));
      const run = async () => {
        // The base is read when the save runs: the answer of the save before it in the chain.
        const res = await fetch(`${base}/draft`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ manifestSha256: manifest, baseUpdatedAt: stamps.current.get(manifest) ?? null, comments, issueActions: actions }),
        });
        const body = (await res.json().catch(() => ({}))) as Partial<PackageReviewDraftDto> & { error?: string };
        if (!res.ok) throw new Error(body.error ?? String(res.status));
        stamps.current.set(manifest, body.updatedAt ?? null);
      };
      const chain = (saveChains.current.get(manifest) ?? Promise.resolve()).then(run, run);
      saveChains.current.set(manifest, chain.catch(() => undefined));
      chain.then(
        () => {
          if (saveSeq.current.get(manifest) === seq) setDrafts((d) => ({ ...d, [manifest]: { ...d[manifest], comments: d[manifest]?.comments ?? comments, state: "saved", loaded: true, changed: false } }));
        },
        (error: unknown) => {
          if (error instanceof Error && error.message === "package_review_draft_changed") void loadDraft(manifest, true);
          else if (saveSeq.current.get(manifest) === seq) setDrafts((d) => ({ ...d, [manifest]: { ...d[manifest], comments: d[manifest]?.comments ?? comments, state: "error", loaded: true, changed: false } }));
        }
      );
    },
    [base, loadDraft]
  );
  const draftOf = (manifest: string) => drafts[manifest]?.comments ?? [];
  const draftActionsOf = (manifest: string) => drafts[manifest]?.actions ?? [];
  /** The decision buttons wait for the draft: loaded, and not failing (review fix 1). */
  const draftReady = (manifest: string) => drafts[manifest]?.loaded === true && drafts[manifest]?.state !== "error" && drafts[manifest]?.state !== "loading" && drafts[manifest]?.state !== "saving";

  const accept = useCallback(
    (body: PackageReviewsDto) => {
      setData(body);
      setError(null);
      onWaiting?.(body.waiting);
    },
    [onWaiting]
  );

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(String(res.status));
      accept((await res.json()) as PackageReviewsDto);
    } catch {
      setError(t("packageReviews.loadFailed"));
    }
  }, [base, accept, t]);

  // On the channel's change, then every minute while the tab is shown (the factory's packages and the other computer's answers
  // arrive by sync); the waiting count feeds the tab's badge.
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [visible, load]);

  const at = useCallback(
    (iso: string) => {
      try {
        return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", ...(ownerZone ? { timeZone: ownerZone } : {}) }).format(new Date(iso));
      } catch {
        return iso;
      }
    },
    [language, ownerZone]
  );

  async function setRequired(required: boolean) {
    if (!base) return;
    setBusy("switch");
    setSwitchError(null);
    try {
      const res = await fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ required }) });
      const body = (await res.json().catch(() => ({}))) as PackageReviewsDto & { error?: string; message?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? String(res.status));
      accept(body);
    } catch (cause) {
      setSwitchError(t("packageReviews.switch.failed", { message: cause instanceof Error ? cause.message : "network" }));
    } finally {
      setBusy(null);
    }
  }

  async function decide() {
    if (!base || !asking) return;
    const { item, kind } = asking;
    setBusy(item.manifestSha256);
    setActionError(null);
    try {
      // A draft save still on its way would otherwise land after the decision cleared the draft and bring it back.
      await saveChains.current.get(item.manifestSha256);
      const res = await fetch(`${base}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // AC-TC-05: the draft's timed comments go with an approval or a return, as one batch.
        body: JSON.stringify(decisionBody(item.manifestSha256, kind, comment, draftOf(item.manifestSha256), stamps.current.get(item.manifestSha256) ?? null, draftActionsOf(item.manifestSha256))),
      });
      const body = (await res.json().catch(() => ({}))) as { view?: PackageReviewsDto; error?: string; message?: string };
      if (!res.ok || !body.view) {
        const key = body.error ? ERROR_KEYS[body.error] : undefined;
        // Review fix 1: the draft changed meanwhile (another tab, the phone) -- reload it; nothing was decided.
        if (body.error === "package_review_draft_changed") void loadDraft(item.manifestSha256, true);
        // An issue that is not this video's any more (the list changed elsewhere): the list is reloaded below.
        setActionError({ manifest: item.manifestSha256, text: key ? t(key) : t("packageReviews.error.generic", { message: body.message ?? body.error ?? String(res.status) }) });
        setAsking(null);
        await load();
        return;
      }
      accept(body.view);
      // The server cleared the draft once the decision was stored (a packaging comment never carries it).
      if (kind !== "packaging_comment") {
        saveSeq.current.set(item.manifestSha256, (saveSeq.current.get(item.manifestSha256) ?? 0) + 1);
        stamps.current.set(item.manifestSha256, null);
        setDrafts((d) => ({ ...d, [item.manifestSha256]: { comments: [], actions: [], state: "saved", loaded: true, changed: false } }));
      }
      try {
        window.localStorage.removeItem(draftKey(item.manifestSha256, kind));
      } catch {
        // storage unavailable
      }
      setAsking(null);
      setCommentState("");
    } catch {
      setActionError({ manifest: item.manifestSha256, text: t("packageReviews.error.generic", { message: "network" }) });
    } finally {
      setBusy(null);
    }
  }

  // AC-TC-03: an open card that takes comments loads its draft once (a reload brings it back from the server).
  useEffect(() => {
    if (!data) return;
    const off = data.readable && !data.required;
    for (const item of data.items) {
      if (item.state === "uploaded") continue;
      const isOpen = item.state === "pending" && !off ? !open.has(item.manifestSha256) : open.has(item.manifestSha256);
      if (isOpen) void loadDraft(item.manifestSha256);
    }
  }, [data, open, loadDraft]);

  if (!channelId) return null;
  const dialogKeys = asking ? (asking.reapprove ? REAPPROVE_KEYS : DIALOG_KEYS[asking.kind]) : DIALOG_KEYS.approved;
  const gateOff = data !== null && data.readable && !data.required;
  // A waiting video is open by default (that is what the owner came for); the others fold until opened.
  const isExpanded = (item: PackageReviewDto) => (item.state === "pending" && !gateOff ? !open.has(item.manifestSha256) : open.has(item.manifestSha256));
  // Owner TG 4856: with one video open, its watching keys work without clicking it first.
  const openCount = (data?.items ?? []).filter(isExpanded).length;
  const toggle = (manifest: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(manifest)) next.delete(manifest);
      else next.add(manifest);
      return next;
    });

  const renderCard = (item: PackageReviewDto) => {
    // A waiting video is open by default (that is what the owner came for); the others fold until opened.
    const expanded = isExpanded(item);
    const actions = actionsOf(item);
    const rowBusy = busy === item.manifestSha256;
    return (
      <li key={item.manifestSha256} className={`rounded-lg border ${item.state === "pending" ? "border-zinc-700 bg-zinc-900" : "border-zinc-800 bg-zinc-950/60"}`}>
        <button
          type="button"
          onClick={() => toggle(item.manifestSha256)}
          aria-expanded={expanded}
          title={t(expanded ? "packageReviews.collapse" : "packageReviews.expand")}
          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/40"
        >
          {/* Review M2: with the gate off a not-reviewed package waits for nobody -- a neutral label instead of «Ждёт». */}
          {gateOff && item.state === "pending" ? (
            <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-400 ring-1 ring-zinc-700">{t("packageReviews.state.off")}</span>
          ) : (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATE_STYLES[item.state]}`}>{t(STATE_KEYS[item.state])}</span>
          )}
          <span className="shrink-0 font-medium tabular-nums text-zinc-100">{item.video}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{item.title}</span>
          {/* Owner TG 4846 (AC-IS-06): the open / resolved issues at a glance. */}
          {(item.issues ?? []).length > 0 && (
            <>
              {/* Review 2 #10: on a phone a compact count, so a folded card still says what is open. */}
              <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] tabular-nums text-violet-200 sm:hidden">{t("packageReviews.issues.countsShort", { open: item.issueCounts?.open ?? 0, resolved: item.issueCounts?.resolved ?? 0 })}</span>
              <span className="hidden shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-200 sm:inline">{t("packageReviews.issues.counts", { open: item.issueCounts?.open ?? 0, resolved: item.issueCounts?.resolved ?? 0 })}</span>
            </>
          )}
          <span className="shrink-0 text-xs tabular-nums text-zinc-500">{durationLabel(item.durationSeconds)}</span>
          <span aria-hidden className="shrink-0 text-zinc-500">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-zinc-800">
            {/* Owner TG 4817: the video first and large, with the comments at moments beside it (below it on a narrower screen). */}
            <div className="space-y-4 p-3">
              <PackageReviewWorkspace
                src={mediaSrcOf(base!, item.manifestSha256, "video")}
                editable={item.state !== "uploaded"}
                draft={draftOf(item.manifestSha256)}
                saveState={drafts[item.manifestSha256]?.state ?? "loading"}
                ready={drafts[item.manifestSha256]?.loaded === true}
                changed={drafts[item.manifestSha256]?.changed === true}
                issues={item.issues ?? []}
                issueActions={draftActionsOf(item.manifestSha256)}
                onIssueActions={(next) => saveDraft(item.manifestSha256, draftOf(item.manifestSha256), next)}
                alone={openCount === 1 && visible}
                onDraft={(next) => saveDraft(item.manifestSha256, next, draftActionsOf(item.manifestSha256))}
                onRetry={() => {
                  if (drafts[item.manifestSha256]?.loaded) saveDraft(item.manifestSha256, draftOf(item.manifestSha256), draftActionsOf(item.manifestSha256));
                  else void loadDraft(item.manifestSha256, true);
                }}
              />
              {/* Owner TG 4887: the text under the player keeps a readable line length on a wide screen. */}
              <div className="min-w-0 max-w-[90ch] space-y-3 text-sm">
                {item.thumbnailPath ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local file streamed by the route, not an optimisable asset
                  <img src={mediaSrcOf(base!, item.manifestSha256, "thumbnail")} alt={t("packageReviews.thumbnail")} className="aspect-video w-full max-w-xs rounded-md bg-black object-contain" loading="lazy" />
                ) : (
                  <p className="text-orange-300">{t("packageReviews.noThumbnail")}</p>
                )}
                <p className="font-medium text-zinc-100">{item.title}</p>
                <details className="group rounded-md bg-zinc-900/60 px-2 py-1">
                  <summary className="cursor-pointer text-xs text-zinc-400">{t("packageReviews.description")}</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-zinc-300">{item.description}</p>
                </details>
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                  <dd>{item.languages.length > 0 ? t("packageReviews.languages", { languages: item.languages.join(", ") }) : t("packageReviews.noLanguages")}</dd>
                  {item.slotId && <dd>{t("packageReviews.slot", { slot: item.slotId })}</dd>}
                  {item.plannedPublishDate && <dd>{t("packageReviews.planned", { date: item.plannedPublishDate })}</dd>}
                </dl>
                {item.otherProblems.length > 0 && <p className="text-xs text-amber-300">{t("packageReviews.otherProblems", { count: item.otherProblems.length })}</p>}
                {!item.hasVideoSha256 && item.state !== "uploaded" && <p className="text-xs text-orange-300">{t("packageReviews.noSha256")}</p>}
                {item.decidedAt && item.decision && (
                  <div className="rounded-md bg-zinc-900 px-3 py-2">
                    <p className="text-zinc-300">
                      {/* Owner TG 4836: an approval with notes says so -- the notes are for future videos, this one stays approved. */}
                      {t(
                        item.decision === "returned"
                          ? "packageReviews.decided.returned"
                          : item.comment || (item.timedComments ?? []).length > 0
                            ? "packageReviews.decided.approvedWithNotes"
                            : "packageReviews.decided.approved",
                        { when: at(item.decidedAt) }
                      )}
                      {item.decidedOn ? ` ${t("packageReviews.decidedOn", { device: item.decidedOn })}` : ""}
                    </p>
                    {item.comment && (
                      <p className="mt-1 whitespace-pre-wrap text-zinc-400">
                        <span className="text-zinc-500">{t(item.decision === "approved" ? "packageReviews.yourNotes" : "packageReviews.yourComment")}: </span>
                        {item.comment}
                      </p>
                    )}
                  </div>
                )}
                {(item.packagingComments ?? []).length > 0 && (
                  <div className="rounded-md bg-zinc-900 px-3 py-2">
                    <p className="text-xs font-medium text-zinc-400">{t("packageReviews.packagingComments")}</p>
                    <ul className="mt-1 space-y-1">
                      {(item.packagingComments ?? []).map((c) => (
                        <li key={c.id} className="text-zinc-300">
                          <span className="whitespace-pre-wrap">{c.comment}</span>
                          <span className="ml-2 text-xs text-zinc-500">
                            {at(c.at)}
                            {c.device ? ` ${t("packageReviews.decidedOn", { device: c.device })}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {item.state === "uploaded" && (
                  <p className="text-xs text-zinc-400">
                    {t("packageReviews.uploadedHint")}{" "}
                    <Link href="/content/week-plan" className="text-violet-300 underline hover:text-violet-200">
                      {t("packageReviews.uploadedLink")}
                    </Link>
                  </p>
                )}
                {actionError?.manifest === item.manifestSha256 && <p className="text-red-400">{actionError.text}</p>}
              </div>
            </div>
            {(actions.approve || actions.reapprove || actions.ret || actions.comment) && (
              // AC-PR-15: on a phone the actions stay at the bottom of the screen while the card scrolls -- just above the shell's fixed
              // bottom navigation (56 px + the safe area), which overlays the scrolling main area; on a wider screen in place.
              <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 flex gap-2 border-t border-zinc-800 bg-zinc-900/95 px-3 py-2 backdrop-blur md:static md:bg-transparent md:backdrop-blur-none">
                {(actions.approve || actions.reapprove) && (
                  <button
                    type="button"
                    disabled={busy !== null || !draftReady(item.manifestSha256)}
                    onClick={() => openDialog(item, "approved")}
                    className="flex-1 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40 md:flex-none md:py-1"
                  >
                    {t(actions.reapprove ? "packageReviews.action.reapprove" : "packageReviews.action.approve")}
                  </button>
                )}
                {actions.ret && (
                  <button
                    type="button"
                    disabled={busy !== null || !draftReady(item.manifestSha256)}
                    onClick={() => openDialog(item, "returned")}
                    className="flex-1 rounded-md border border-zinc-600 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 md:flex-none md:py-1"
                  >
                    {t("packageReviews.action.return")}
                  </button>
                )}
                {actions.comment && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => openDialog(item, "packaging_comment")}
                    className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 md:flex-none md:py-1"
                  >
                    {t("packageReviews.action.comment")}
                  </button>
                )}
                {rowBusy && <span className="self-center text-xs text-zinc-400">{t("packageReviews.action.saving")}</span>}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 md:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-zinc-100">{t("packageReviews.title")}</h2>
          <p className="max-w-3xl text-sm text-zinc-400">{t("packageReviews.help")}</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800">
          {t("packageReviews.refresh")}
        </button>
      </header>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!data && !error && <SkeletonLines lines={3} />}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
            <ToggleSwitch checked={data.required} disabled={busy !== null || !data.readable} onChange={(value) => void setRequired(value)} label={t("packageReviews.switch.label")} tone="violet" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-zinc-100">{t("packageReviews.switch.label")}</p>
              <p className="text-xs text-zinc-500">
                {t("packageReviews.switch.hint")}
                {data.requiredUpdatedAt ? ` ${t("packageReviews.switch.updated", { when: at(data.requiredUpdatedAt) })}` : ""}
              </p>
            </div>
          </div>
          {switchError && <p className="text-sm text-red-400">{switchError}</p>}
          {!data.readable && <p className="rounded-md border border-orange-900 bg-orange-950/40 px-3 py-2 text-sm text-orange-200">{t("packageReviews.unreadable")}</p>}
          {data.packages === "no_workspace" && <p className="text-sm text-zinc-500">{t("packageReviews.noWorkspace")}</p>}
          {data.packages === "workspace_unavailable" && <p className="text-sm text-orange-300">{t("packageReviews.workspaceUnavailable")}</p>}
          {data.packages === "ok" && data.items.length === 0 && <p className="text-sm text-zinc-500">{t("packageReviews.empty")}</p>}
          {data.items.length > 0 && (
            <>
              <p className={`text-sm font-medium ${data.waiting > 0 ? "text-amber-300" : "text-zinc-400"}`}>
                {gateOff ? t("packageReviews.gateOff") : data.waiting > 0 ? t("packageReviews.waiting", { count: data.waiting }) : t("packageReviews.noneWaiting")}
              </p>
              <ul className="space-y-2">{data.items.map(renderCard)}</ul>
            </>
          )}
        </>
      )}
      {asking && (
        <ConfirmDialog
          title={t(dialogKeys.title, { video: asking.item.video })}
          description={t(dialogKeys.description)}
          cancelLabel={t("packageReviews.action.cancel")}
          confirmLabel={t(dialogKeys.confirm)}
          confirmVariant={asking.kind === "returned" ? "danger" : "default"}
          confirmDisabled={busy !== null || !decisionReady(asking.kind, comment, asking.kind === "packaging_comment" ? 0 : asking.reapprove ? draftOf(asking.item.manifestSha256).length + draftActionsOf(asking.item.manifestSha256).length : notesCount(draftOf(asking.item.manifestSha256), draftActionsOf(asking.item.manifestSha256)), asking.reapprove)}
          confirmBusyLabel={busy === asking.item.manifestSha256 ? t(asking.kind === "approved" ? "packageReviews.action.checking" : "packageReviews.action.saving") : null}
          onCancel={() => {
            if (busy === null) setAsking(null);
          }}
          onConfirm={() => void decide()}
        >
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={2000}
            rows={asking.kind === "approved" ? 2 : 4}
            aria-label={t(dialogKeys.placeholder)}
            placeholder={t(dialogKeys.placeholder)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          {/* Owner TG 4817 (AC-TC-05/06): what goes with the decision -- the draft's comments at moments, in one batch. */}
          {(() => {
            const timed = draftOf(asking.item.manifestSha256);
            const answers = draftActionsOf(asking.item.manifestSha256);
            if (timed.length === 0 && answers.length === 0) return null;
            if (asking.kind === "packaging_comment") return timed.length > 0 ? <p className="mt-2 text-xs text-zinc-500">{t("packageReviews.timed.notSent", { count: timed.length })}</p> : null;
            return (
              <div className="mt-2 space-y-1">
                {asking.kind === "returned" && <p className="text-xs text-zinc-500">{t("packageReviews.timed.returnOptional")}</p>}
                {answers.length > 0 && <p className="text-xs text-violet-200">{t("packageReviews.issues.willSend", { count: answers.length })}</p>}
                {timed.length > 0 && <p className="text-xs text-zinc-300">{t("packageReviews.timed.willSend", { count: timed.length })}</p>}
                <ol className={`max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-zinc-950 p-2 text-xs ${timed.length === 0 ? "hidden" : ""}`}>
                  {timed.map((c, i) => (
                    <li key={c.id} className="flex gap-2">
                      <span className="shrink-0 tabular-nums text-amber-300">{i + 1}.</span>
                      <span className="shrink-0 font-mono text-amber-200">{formatPlayerTime(c.atSeconds)}</span>
                      <span className="min-w-0 break-words text-zinc-300">{c.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })()}
        </ConfirmDialog>
      )}
    </section>
  );
}
