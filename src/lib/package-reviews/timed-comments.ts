// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01..09): the owner's comments bound to a moment of the package's video. Pure and
// import-free on purpose: the review screen (a client component) uses the same rules and time spelling as the server.

/** One comment at a moment of the video, as stored in the owner's decision. */
/** Owner TG 4846 (AC-IS-02): `id` -- the issue id, `<decisionId>.<n>`, stored at decide time (absent on a stage-1 comment). */
export type TimedComment = { atSeconds: number; text: string; id?: string };

/** As the agents read it: the seconds, the same moment as `m:ss` (`h:mm:ss` past an hour), and the text. */
export type TimedCommentReadout = { atSeconds: number; time: string; text: string };

/** One comment of the owner's draft (its id is the screen's, for editing and deleting). */
export type DraftTimedComment = TimedComment & { id: string };

export const TIMED_COMMENT_LIMITS = Object.freeze({
  /** Comments per package (a draft or a decision). */
  count: 200,
  text: 500,
  /** A moment past 24 h is not a moment of a release video. */
  maxSeconds: 86_400,
  id: 40,
});

/** A timed comment is one line: no control characters at all (line breaks included). */
export const TIMED_COMMENT_CONTROL = /[\u0000-\u001f\u007f]/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** An issue id: a decision id (`pr_` + 16) and its comment number. */
export const ISSUE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Seconds kept to one decimal (the player's own precision). */
export const roundSeconds = (seconds: number) => Math.round(seconds * 10) / 10;

/** `83.4` -> `1:23`, `3725` -> `1:02:05` (whole seconds, rounded down: the moment the comment points into). */
export function clockOf(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function wellFormedOne(value: unknown): TimedComment | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.atSeconds !== "number" || !Number.isFinite(c.atSeconds) || c.atSeconds < 0 || c.atSeconds > TIMED_COMMENT_LIMITS.maxSeconds) return null;
  if (typeof c.text !== "string") return null;
  const text = c.text.trim();
  if (text === "" || text.length > TIMED_COMMENT_LIMITS.text || TIMED_COMMENT_CONTROL.test(text)) return null;
  return { atSeconds: roundSeconds(c.atSeconds), text, ...(typeof c.id === "string" && ISSUE_ID.test(c.id) ? { id: c.id } : {}) };
}

/** Earlier first; at the same moment the order they were written in stays. */
const byTime = <T extends TimedComment>(list: T[]): T[] => list.map((c, i) => ({ c, i })).sort((a, b) => a.c.atSeconds - b.c.atSeconds || a.i - b.i).map((x) => x.c);

/**
 * The timed comments of a decision as another computer's document carries them: the well-formed ones, sorted by time, at most the
 * limit. Anything else -- not an array, a malformed entry -- is dropped, never a reason to refuse the decision (AC-TC-07).
 */
export function wellFormedTimedComments(value: unknown): TimedComment[] {
  if (!Array.isArray(value)) return [];
  return byTime(value.map(wellFormedOne).filter((c): c is TimedComment => c !== null)).slice(0, TIMED_COMMENT_LIMITS.count);
}

/** The draft as stored and sent back to the screen (ids kept, sorted by time); malformed entries dropped. */
export function wellFormedDraft(value: unknown): DraftTimedComment[] {
  if (!Array.isArray(value)) return [];
  const out: DraftTimedComment[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const c = wellFormedOne(raw);
    const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    if (!c || typeof id !== "string" || !ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ...c });
  }
  return byTime(out).slice(0, TIMED_COMMENT_LIMITS.count);
}

/** What the agents read (AC-TC-08). */
export function timedCommentsReadout(list: readonly TimedComment[]): TimedCommentReadout[] {
  return list.map((c) => ({ atSeconds: c.atSeconds, time: clockOf(c.atSeconds), text: c.text }));
}

/** One line per comment, `m:ss text` -- a return's comment when the owner wrote no general one (AC-TC-06). */
export function timedCommentsAsText(list: readonly TimedComment[], maxLength = 2000): string {
  const text = list.map((c) => `${clockOf(c.atSeconds)} ${c.text}`).join("\n");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Review fix 7: whether a decision's comment is only its timed comments written out (a return without a general comment, AC-TC-06) --
 * this build's readers then show the timed comments once, not twice.
 */
export function commentIsTimedText(comment: string | null, list: readonly TimedComment[]): boolean {
  return comment !== null && list.length > 0 && comment === timedCommentsAsText(list);
}

// --- Owner TG 4846 (PACKAGE_REVIEW_PLAN.md AC-IS-01..08): issues across package versions ------------------------------------

/** The factory's answer to one issue, as `reviewReplies` of a re-packaged manifest states it (AC-IS-03). */
export type IssueReply = { issueId: string; status: "fixed" | "not_fixed" | "partly"; text: string; atSeconds?: number };
/** The owner's action on an existing issue, sent with his next approve / return (AC-IS-04). */
export type IssueAction = { issueId: string; kind: "resolved" | "follow_up"; text?: string };

export const ISSUE_LIMITS = Object.freeze({ replies: 200, replyText: 2000, actions: 200 });
const REPLY_STATUSES: readonly string[] = ["fixed", "not_fixed", "partly"];
/** A reply may span lines (no other control characters). */
const REPLY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** `reviewReplies` read leniently: the well-formed answers, one per issue (the last wins); anything else is ignored (AC-IS-03). */
export function wellFormedReplies(value: unknown): IssueReply[] {
  if (!Array.isArray(value)) return [];
  const byIssue = new Map<string, IssueReply>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.issueId !== "string" || !ISSUE_ID.test(r.issueId) || typeof r.status !== "string" || !REPLY_STATUSES.includes(r.status)) continue;
    if (typeof r.text !== "string") continue;
    const text = r.text.trim();
    if (text === "" || text.length > ISSUE_LIMITS.replyText || REPLY_CONTROL.test(text)) continue;
    const at = typeof r.atSeconds === "number" && Number.isFinite(r.atSeconds) && r.atSeconds >= 0 && r.atSeconds <= TIMED_COMMENT_LIMITS.maxSeconds ? roundSeconds(r.atSeconds) : undefined;
    byIssue.set(r.issueId, { issueId: r.issueId, status: r.status as IssueReply["status"], text, ...(at !== undefined ? { atSeconds: at } : {}) });
    if (byIssue.size >= ISSUE_LIMITS.replies) break;
  }
  return [...byIssue.values()];
}

/** The owner's issue actions read leniently: one per issue (the last wins); a follow-up needs a one-line text (AC-IS-04). */
export function wellFormedIssueActions(value: unknown): IssueAction[] {
  if (!Array.isArray(value)) return [];
  const byIssue = new Map<string, IssueAction>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.issueId !== "string" || !ISSUE_ID.test(a.issueId)) continue;
    if (a.kind === "resolved") byIssue.set(a.issueId, { issueId: a.issueId, kind: "resolved" });
    else if (a.kind === "follow_up" && typeof a.text === "string") {
      const text = a.text.trim();
      if (text && text.length <= TIMED_COMMENT_LIMITS.text && !TIMED_COMMENT_CONTROL.test(text)) byIssue.set(a.issueId, { issueId: a.issueId, kind: "follow_up", text });
    }
    if (byIssue.size >= ISSUE_LIMITS.actions) break;
  }
  return [...byIssue.values()];
}

/** AC-IS-02: the issue ids of a decision's timed comments -- `<decisionId>.<n>`, n = 1.. in time order (a stored id is kept). */
export function withIssueIds(decisionId: string, list: readonly TimedComment[]): TimedComment[] {
  return list.map((c, i) => ({ ...c, id: c.id ?? `${decisionId}.${i + 1}` }));
}
