// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01..09): the owner's comments bound to a moment of the package's video. Pure and
// import-free on purpose: the review screen (a client component) uses the same rules and time spelling as the server.

/** One comment at a moment of the video, as stored in the owner's decision. */
export type TimedComment = { atSeconds: number; text: string };

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
  return { atSeconds: roundSeconds(c.atSeconds), text };
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
