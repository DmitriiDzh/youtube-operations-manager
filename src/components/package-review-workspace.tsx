"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReviewIssue } from "@/lib/package-reviews/issues";
import type { DraftTimedComment, IssueAction } from "@/lib/package-reviews/timed-comments";
import { formatPlayerTime } from "./media-review-player";
import { MediaVideoPlayer, type VideoFlag, type VideoPlayerHandle } from "./media-video-player";
import { frameOf, issueLabel, newCommentId, nextMoment, oneLineText, withComment, withEditedComment, withIssueAction, withoutComment, withoutIssueAction, type DraftSaveState } from "./package-reviews-model";
import { useT } from "./ui-text-provider";

// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01..09; the audio review's "mark at the playhead with its note", plan-review-screen):
// one package's video in the app's own review player, large, with the owner's comments bound to moments. He clicks into the comment
// box -- the video pauses and the moment is taken -- types and presses Enter: the comment becomes a numbered flag on the timeline and a
// line in the list (time and text; a click seeks there). He edits or deletes a comment until he sends his decision; the draft is the
// server's (the panel saves every change). After the decision the sent comments stay on the timeline (blue) and in the list.

export function PackageReviewWorkspace({
  src,
  editable,
  draft,
  saveState,
  ready,
  changed,
  issues,
  issueActions,
  onIssueActions,
  alone,
  onDraft,
  onRetry,
}: {
  src: string;
  /** Comments can be written (the package is not uploaded). */
  editable: boolean;
  draft: DraftTimedComment[];
  saveState: DraftSaveState;
  /** Review fix 2: the draft has loaded -- nothing can be written before (a save would replace a draft not seen yet). */
  ready: boolean;
  /** The draft was reloaded because it changed elsewhere (another tab, the phone). */
  changed: boolean;
  /** Owner TG 4846 (AC-IS-06): the video's issues from earlier reviews (any package version), with the factory's answers. */
  issues: ReviewIssue[];
  /** His actions on them waiting in the draft (sent with the next decision). */
  issueActions: IssueAction[];
  onIssueActions: (next: IssueAction[]) => void;
  /** Owner TG 4856: the only video open -- the watching keys work without clicking it first. */
  alone: boolean;
  onDraft: (next: DraftTimedComment[]) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const player = useRef<VideoPlayerHandle | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [frame, setFrame] = useState<"vertical" | "horizontal">("horizontal");
  const [text, setText] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  // Issues are numbered I1, I2... apart from the new draft comments (1, 2...): violet while open, grey when resolved or noted.
  const flags: VideoFlag[] = useMemo(
    () => [
      ...draft.map((c, i) => ({ id: c.id, atSeconds: c.atSeconds, number: i + 1, text: c.text, tone: "draft" as const, active: active === c.id })),
      ...issues.map((issue, i) => ({ id: issue.id, atSeconds: issue.atSeconds, number: issueLabel(i), text: issue.text, tone: issue.state === "open" ? ("issue" as const) : ("closed" as const), active: active === issue.id })),
    ],
    [draft, issues, active]
  );

  /** The moment is taken when he starts writing (nothing typed yet) or asks for it: the video pauses there (review fix 3). */
  const takeMoment = (kind: "focus" | "retake") => {
    player.current?.pause();
    const current = player.current?.currentTime() ?? 0;
    setAt((taken) => nextMoment(taken, kind === "focus" ? { kind, text, current } : { kind, current }));
  };
  // Playing on or seeking drops a taken moment, so a comment never binds to an old one.
  const onPlayingChange = useCallback((playing: boolean) => {
    if (playing) setAt((taken) => nextMoment(taken, { kind: "play" }));
  }, []);
  const onUserSeek = useCallback(() => setAt((taken) => nextMoment(taken, { kind: "seek" })), []);
  const seekTo = (id: string, seconds: number) => {
    setAt((taken) => nextMoment(taken, { kind: "seek" }));
    setActive(id);
    player.current?.seekTo(seconds, "pause");
    listRef.current?.querySelector(`[data-comment="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const add = () => {
    const value = text.trim();
    if (!value) return;
    const moment = at ?? player.current?.currentTime() ?? 0;
    const id = newCommentId();
    onDraft(withComment(draft, { id, atSeconds: moment, text: value }));
    setActive(id);
    setText("");
    setAt(null);
    input.current?.blur();
  };
  const saveEdit = () => {
    if (!editing) return;
    onDraft(withEditedComment(draft, editing.id, editing.text));
    setEditing(null);
  };

  // Owner TG 4887: the player grows with the width but never above 70% of the screen's height -- a 16:9 one by capping its column's
  // width at 70vh x 16/9 (the frame stays 16:9, the timeline under it as wide as the frame), a vertical one by its height.
  const playerClass = frame === "vertical" ? "mx-auto aspect-[9/16] h-[70vh] max-h-[calc(100dvh-11rem)] max-w-full" : "aspect-video w-full";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className={`min-w-0 ${frame === "vertical" ? "" : "w-full max-w-[calc(70vh*16/9)]"}`}>
        {/* The player says itself when the file cannot be played (the package's mp4 not on this computer). */}
        <MediaVideoPlayer
          ref={player}
          src={src}
          markers={[]}
          fps={null}
          autoPlay={false}
          startMuted={false}
          loop={false}
          preload="metadata"
          fullscreen
          rememberRate="ytm.packageReview.playbackRate"
          seekKeys
          keysWithoutFocus={alone}
          compact
          className={playerClass}
          onMetadata={({ width, height }) => setFrame(frameOf(width, height))}
          onPlayingChange={onPlayingChange}
          onUserSeek={onUserSeek}
          flags={flags}
          onFlagClick={(id) => {
            const flag = flags.find((f) => f.id === id);
            if (flag) seekTo(id, flag.atSeconds);
          }}
        />
        {/* Owner TG 4856: the watching keys, said once under the player. */}
        <p className="mt-1 hidden text-[11px] text-zinc-500 md:block">{t("packageReviews.keysHint")}</p>
      </div>
      <aside className="min-w-0 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2 xl:max-h-[82vh] xl:overflow-y-auto">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-zinc-100">{t("packageReviews.timed.title")}</h3>
          {draft.length > 0 && <span className="text-xs text-amber-300">{t("packageReviews.timed.count", { count: draft.length })}</span>}
        </div>
        {editable && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
            className="space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <input
                ref={input}
                value={text}
                disabled={!ready}
                maxLength={500}
                onFocus={() => {
                  takeMoment("focus");
                }}
                onChange={(event) => setText(oneLineText(event.target.value))}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setText("");
                    setAt(null);
                    event.currentTarget.blur();
                  }
                }}
                aria-label={t("packageReviews.timed.placeholder")}
                placeholder={t("packageReviews.timed.placeholder")}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50 md:py-1.5"
              />
              <button type="submit" disabled={!ready || !text.trim()} className="shrink-0 rounded-md bg-amber-500/90 px-3 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-40 md:py-1.5">
                {t("packageReviews.timed.add")}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              {at !== null ? (
                <>
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-amber-200">{t("packageReviews.timed.at", { time: formatPlayerTime(at) })}</span>
                  <button type="button" onClick={() => takeMoment("retake")} className="text-zinc-400 underline decoration-dotted hover:text-zinc-100">
                    {t("packageReviews.timed.retake")}
                  </button>
                </>
              ) : (
                <span>{t("packageReviews.timed.hint")}</span>
              )}
            </div>
          </form>
        )}
        {draft.length > 0 ? (
          <ol ref={listRef} className="space-y-1">
            {draft.map((c, i) => (
              <li key={c.id} data-comment={c.id} className={`flex items-start gap-2 rounded-md px-1.5 py-1 ${active === c.id ? "bg-amber-500/10 ring-1 ring-amber-500/40" : "hover:bg-zinc-900"}`}>
                <span className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm border-l-2 border-amber-400 bg-amber-950 px-1 text-[11px] font-semibold tabular-nums text-amber-100">{i + 1}</span>
                <button type="button" onClick={() => seekTo(c.id, c.atSeconds)} title={t("packageReviews.timed.seek", { time: formatPlayerTime(c.atSeconds) })} className="mt-0.5 shrink-0 font-mono text-xs text-amber-200 hover:text-white">
                  {formatPlayerTime(c.atSeconds)}
                </button>
                {editing?.id === c.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveEdit();
                    }}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
                  >
                    <input
                      autoFocus
                      value={editing.text}
                      maxLength={500}
                      onChange={(event) => setEditing({ id: c.id, text: oneLineText(event.target.value) })}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(null);
                        }
                      }}
                      aria-label={t("packageReviews.timed.edit")}
                      className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
                    />
                    <button type="submit" disabled={!editing.text.trim()} className="rounded-md bg-zinc-200 px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40">
                      {t("packageReviews.timed.save")}
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                      {t("packageReviews.timed.cancel")}
                    </button>
                  </form>
                ) : (
                  <>
                    <p className="min-w-0 flex-1 break-words text-sm text-zinc-200">{c.text}</p>
                    {editable && ready && (
                      <span className="flex shrink-0 items-center">
                        <button type="button" onClick={() => setEditing({ id: c.id, text: c.text })} aria-label={t("packageReviews.timed.edit")} title={t("packageReviews.timed.edit")} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 md:h-6 md:w-6">
                          {/* ui-text-ignore: a symbol */}✎
                        </button>
                        <button type="button" onClick={() => onDraft(withoutComment(draft, c.id))} aria-label={t("packageReviews.timed.delete")} title={t("packageReviews.timed.delete")} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-red-950 hover:text-red-200 md:h-6 md:w-6">
                          {/* ui-text-ignore: a symbol */}×
                        </button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
        ) : editable && saveState !== "loading" ? (
          <p className="text-xs text-zinc-500">{t("packageReviews.timed.empty")}</p>
        ) : null}
        {editable && (
          <p className={`text-xs ${saveState === "error" ? "text-red-400" : "text-zinc-500"}`}>
            {saveState === "loading" && t("packageReviews.timed.loading")}
            {saveState === "saving" && t("packageReviews.timed.saving")}
            {saveState === "saved" && draft.length > 0 && t("packageReviews.timed.saved")}
            {saveState === "error" && (
              <>
                {t(ready ? "packageReviews.timed.saveFailed" : "packageReviews.timed.loadFailed")}{" "}
                <button type="button" onClick={onRetry} className="underline hover:text-red-200">
                  {t("packageReviews.timed.retry")}
                </button>
              </>
            )}
          </p>
        )}
        {editable && changed && saveState !== "loading" && (
          <p className="text-xs text-amber-300">{t("packageReviews.timed.reloaded")}</p>
        )}
        {issues.length > 0 && (
          <IssueList
            issues={issues}
            actions={issueActions}
            canAct={editable && ready}
            active={active}
            onSeek={seekTo}
            onActions={onIssueActions}
          />
        )}
      </aside>
    </div>
  );
}

const STATE_KEYS = { open: "packageReviews.issues.state.open", resolved: "packageReviews.issues.state.resolved", noted: "packageReviews.issues.state.noted" } as const;
const STATUS_KEYS = { fixed: "packageReviews.issues.status.fixed", not_fixed: "packageReviews.issues.status.not_fixed", partly: "packageReviews.issues.status.partly" } as const;
const STATE_STYLE = { open: "bg-violet-500/15 text-violet-200", resolved: "bg-emerald-500/15 text-emerald-300", noted: "bg-zinc-700/50 text-zinc-300" } as const;

/**
 * Owner TG 4846 (AC-IS-04/06): the issues from earlier reviews -- each with its moment, the owner's comment, the factory's answers
 * (status, text, the moment after the edit) and his own later turns. Per issue: «Исправлено, принимаю» or a follow-up, both waiting in
 * the draft until his next approve / return (shown as such, with an undo).
 */
function IssueList({
  issues,
  actions,
  canAct,
  active,
  onSeek,
  onActions,
}: {
  issues: ReviewIssue[];
  actions: IssueAction[];
  canAct: boolean;
  active: string | null;
  onSeek: (id: string, seconds: number) => void;
  onActions: (next: IssueAction[]) => void;
}) {
  const t = useT();
  const [followUp, setFollowUp] = useState<{ id: string; text: string } | null>(null);
  const counts = { open: issues.filter((i) => i.state === "open").length, resolved: issues.filter((i) => i.state === "resolved").length };
  return (
    <div className="space-y-1.5 border-t border-zinc-800 pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-zinc-300">{t("packageReviews.issues.title")}</p>
        <span className="text-[11px] text-zinc-400">{t("packageReviews.issues.counts", { open: counts.open, resolved: counts.resolved })}</span>
      </div>
      <ol className="space-y-2">
        {issues.map((issue, i) => {
          const pending = actions.find((a) => a.issueId === issue.id) ?? null;
          return (
            <li key={issue.id} data-comment={issue.id} className={`space-y-1 rounded-md px-1.5 py-1.5 ${active === issue.id ? "bg-violet-500/10 ring-1 ring-violet-500/40" : "bg-zinc-900/40"}`}>
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 flex h-5 shrink-0 items-center justify-center rounded-sm border-l-2 px-1 text-[11px] font-semibold tabular-nums ${issue.state === "open" ? "border-violet-400 bg-violet-950 text-violet-100" : "border-zinc-500 bg-zinc-900 text-zinc-300"}`}>{issueLabel(i)}</span>
                <button type="button" onClick={() => onSeek(issue.id, issue.atSeconds)} title={t("packageReviews.timed.seek", { time: formatPlayerTime(issue.atSeconds) })} className="mt-0.5 shrink-0 font-mono text-xs text-violet-200 hover:text-white">
                  {formatPlayerTime(issue.atSeconds)}
                </button>
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATE_STYLE[issue.state]}`}>{t(STATE_KEYS[issue.state])}</span>
              </div>
              <ul className="space-y-1 pl-1 text-sm">
                {issue.thread.map((turn, k) => (
                  <li key={k} className="break-words">
                    {turn.by === "owner" ? (
                      <>
                        <span className="mr-1.5 text-xs text-zinc-500">{t(turn.kind === "resolved" ? "packageReviews.issues.turn.resolved" : turn.kind === "follow_up" ? "packageReviews.issues.turn.followUp" : "packageReviews.issues.turn.owner")}</span>
                        {turn.text ? <span className="text-zinc-200">{turn.text}</span> : null}
                      </>
                    ) : (
                      <>
                        <span className="mr-1.5 text-xs text-sky-300">
                          {t("packageReviews.issues.turn.agent", { status: t(STATUS_KEYS[turn.status]) })}
                          {turn.atSeconds !== null ? ` · ${formatPlayerTime(turn.atSeconds)}` : ""}
                        </span>
                        <span className="whitespace-pre-wrap text-zinc-300">{turn.text}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {pending ? (
                <p className="flex flex-wrap items-center gap-2 text-xs text-amber-200">
                  <span>{pending.kind === "resolved" ? t("packageReviews.issues.pendingResolve") : t("packageReviews.issues.pendingFollowUp", { text: pending.text ?? "" })}</span>
                  {canAct && (
                    <button type="button" onClick={() => onActions(withoutIssueAction(actions, issue.id))} className="underline hover:text-white">
                      {t("packageReviews.issues.undo")}
                    </button>
                  )}
                </p>
              ) : canAct ? (
                followUp?.id === issue.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      onActions(withIssueAction(actions, { issueId: issue.id, kind: "follow_up", text: followUp.text }));
                      setFollowUp(null);
                    }}
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    <input
                      autoFocus
                      value={followUp.text}
                      maxLength={500}
                      onChange={(event) => setFollowUp({ id: issue.id, text: oneLineText(event.target.value) })}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setFollowUp(null);
                        }
                      }}
                      aria-label={t("packageReviews.issues.followUpPlaceholder")}
                      placeholder={t("packageReviews.issues.followUpPlaceholder")}
                      className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 md:py-1"
                    />
                    <button type="submit" disabled={!followUp.text.trim()} className="rounded-md bg-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40 md:py-1">
                      {t("packageReviews.timed.save")}
                    </button>
                    <button type="button" onClick={() => setFollowUp(null)} className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 md:py-1">
                      {t("packageReviews.timed.cancel")}
                    </button>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {issue.state !== "resolved" && (
                      <button type="button" onClick={() => onActions(withIssueAction(actions, { issueId: issue.id, kind: "resolved" }))} className="rounded-md border border-emerald-700/70 px-2 py-1.5 text-xs text-emerald-200 hover:bg-emerald-900/30 md:py-1">
                        {t("packageReviews.issues.resolve")}
                      </button>
                    )}
                    <button type="button" onClick={() => setFollowUp({ id: issue.id, text: "" })} className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 md:py-1">
                      {t("packageReviews.issues.followUp")}
                    </button>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
