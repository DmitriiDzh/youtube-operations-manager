import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

/**
 * BL-248 (FO-REQ-0052, PRD-REQ-0063, ADR 0066, docs/roadmap/plans/REVIEW_NOTIFY_PLAN.md): the owner's review decisions wake the
 * Producer. For each owner decision (a clip, a storyboard, a render, a generation plan's review pass, a weekly-plan slot) ONE
 * Markdown file goes into the Producer's Inbox -- its only wake signal is a new non-dot file there. A shared module (AGENTS.md §M):
 * it imports no feature module and no database; the decisions reach it through the sources `src/composition/review-notify.ts`
 * composes, and the feature modules know it only as the `notifyOwnerDecision` nudge their own index.ts injects.
 */

/** How often the server's loop looks for new decisions. */
export const REVIEW_NOTIFY_TICK_MS = 30_000;
/** The loop's first look after the server starts. */
export const REVIEW_NOTIFY_FIRST_TICK_MS = 45_000;
/** A nudge (an owner decision on this server) runs the loop this much later, so a burst gives one run. */
export const REVIEW_NOTIFY_NUDGE_DELAY_MS = 2_000;
/** A plan's review pass is written after this long without a new verdict, pick or «ни один не подходит» in that plan. */
export const PLAN_PASS_QUIET_MS = 5 * 60_000;
/** A `group_reviewed` event this much before the pass's earliest entry still counts (event times have one-second resolution). */
export const PLAN_WAVE_SLACK_MS = 2_000;
/** Decisions older than this are never looked at (the scan window). */
export const REVIEW_NOTIFY_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Ledger rows older than this are removed (well past the scan window, so a removed row can never be found again). */
export const REVIEW_NOTIFY_LEDGER_KEEP_MS = 90 * 24 * 60 * 60_000;
/** The first time the switch is on, single decisions are written from here (the backfill, FO-REQ-0052 acceptance). */
export const REVIEW_NOTIFY_BACKFILL_FROM = "2026-11-08T00:00:00.000Z";

/** The Producer's folder below the workspace root, and its Inbox. */
export const PRODUCER_FOLDER_NAME = "00 YT Producer";
export const PRODUCER_INBOX_NAME = "Inbox";
export const REVIEW_NOTICE_FORMAT = "ytm-review-decision/1";
export const REVIEW_NOTICE_FILE_PREFIX = "REVIEW-DECISION";

export type ReviewNoticeKind = "clip" | "storyboard" | "render" | "plan" | "slot";
export type SingleNoticeKind = Exclude<ReviewNoticeKind, "plan">;

/** One line of an item's context in the file ("Scene: Tobacco Field Barn"). */
export type ReviewNoticeLine = { label: string; value: string };

/** One owner decision that gets a file of its own (clip, storyboard, render, slot). */
export type ReviewDecisionNotice = {
  kind: SingleNoticeKind;
  channelId: string;
  channelName: string | null;
  itemId: string;
  /** The decision's own id (the record's, comment's or reply's): the file's name is built from it. */
  decisionId: string;
  /** approved / returned / changes_requested / commented / replied / vetoed / revoked / restored. */
  status: string;
  /** The owner's comment verbatim, or null. */
  comment: string | null;
  /** ISO time the decision was made (the decision's own time). */
  decidedAt: string;
  /** The computer the decision was made on, as the record names it. */
  decidedOn: string | null;
  /** What the item is: scene, Vn, storyboard name, slot date... */
  context: ReviewNoticeLine[];
  /** Files the owner attached, relative to the channel folder. */
  attachments: string[];
  /** Where the owner and the Producer find it in YTM ("Медиа → «Клипы»"). */
  ytmPlace: string;
  /** The read tool and its arguments (`producer_clip_review_get <clipId>`). */
  readTool: string;
};

export type PlanEntryType = "verdict" | "pick" | "none_fits";
export type PlanEntryMark = { start: number; end: number | null; note: string | null; region: { x: number; y: number; r: number } | null };

/** One owner verdict, pick or «ни один не подходит» of a generation plan. */
export type PlanReviewEntry = {
  /** Stable across sources and computers (REVIEW_NOTIFY_PLAN.md §4): `v|plan|item|attempt|at|result`, `p|…`, `n|…`. */
  entryId: string;
  type: PlanEntryType;
  itemKey: string;
  attemptRef: string | null;
  groupId: string | null;
  at: string;
  device: string | null;
  result: "accepted" | "rejected" | null;
  rating: number | null;
  reasons: string[];
  marks: PlanEntryMark[];
  note: string | null;
};

/** What one source knows of one plan: its entries and when its waves were finished. */
export type PlanReviewFeed = {
  planId: string;
  channelId: string;
  channelName: string | null;
  title: string | null;
  video: string | null;
  entries: PlanReviewEntry[];
  /** The times of the plan's `group_reviewed` events (a wave's waiting count reached zero). */
  waveFinishedAt: string[];
  ytmPlace: string;
  readTool: string;
};

/** The owner's choices on this computer (`app_settings`, never synced). null = never set (the default applies). */
export type ReviewNotifySettings = { enabled: boolean | null; inboxPath: string | null };
export const DEFAULT_REVIEW_NOTIFY_SETTINGS: ReviewNotifySettings = { enabled: null, inboxPath: null };

/** What the loop remembers between runs (its own `app_settings` row; only the loop writes it). */
export type ReviewNotifyState = {
  /** When the switch was last seen turning on (the plan floor); null while it is off. */
  activeSince: string | null;
  /** Single decisions are written from here: the backfill start the first time, `activeSince` after that. */
  singlesFloor: string | null;
  /** The first enable's backfill was set up (a later enable never backfills again). */
  backfillDone: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  lastFile: string | null;
  lastWrittenAt: string | null;
  writtenCount: number;
};
export const INITIAL_REVIEW_NOTIFY_STATE: ReviewNotifyState = {
  activeSince: null,
  singlesFloor: null,
  backfillDone: false,
  lastTickAt: null,
  lastError: null,
  lastFile: null,
  lastWrittenAt: null,
  writtenCount: 0,
};

/** One row of the notice ledger: a decision (or plan entry) already written, and the file it went into. */
export type ReviewLedgerEntry = { key: string; kind: ReviewNoticeKind; fileName: string };

export type InboxWriteOutcome = "written" | "exists";

export type ReviewNotifyPorts = {
  /** Sources of single decisions; one failing never stops the others. */
  decisionSources: ReadonlyArray<{ name: string; list(sinceIso: string): Promise<ReviewDecisionNotice[]> }>;
  /** Sources of plan entries (this computer's plans, the other computer's plans from its report). */
  planSources: ReadonlyArray<{ name: string; list(sinceIso: string): Promise<PlanReviewFeed[]> }>;
  settings: { read(): Promise<string | null>; write(json: string): Promise<void> };
  state: { read(): Promise<string | null>; write(json: string): Promise<void> };
  ledger: {
    /** The keys of `keys` already in the ledger. */
    has(keys: readonly string[]): Promise<Set<string>>;
    record(entries: readonly ReviewLedgerEntry[], at: Date): Promise<void>;
    prune(before: Date): Promise<void>;
  };
  inbox: {
    /** `<workspace root>/00 YT Producer/Inbox`, or null when there is no one workspace root on this computer. */
    defaultPath(): Promise<string | null>;
    /** Whether the workspace's `00 YT Producer` folder exists on this computer (the switch's default). */
    producerFolderExists(): Promise<boolean>;
    isDirectory(absolutePath: string): Promise<boolean>;
    /** Writes `name` once (`.tmp-<random>` then rename); an existing file is left alone. */
    writeOnce(dir: string, name: string, content: string): Promise<InboxWriteOutcome>;
  };
  now(): Date;
  log(event: string, context: Record<string, unknown>): void;
};

/** The Settings card's view. */
export type ReviewNotifyView = {
  enabled: boolean;
  enabledSetting: boolean | null;
  defaultEnabled: boolean;
  inboxPath: string | null;
  inboxPathSetting: string | null;
  defaultInboxPath: string | null;
  inboxExists: boolean;
  activeSince: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastFile: string | null;
  lastWrittenAt: string | null;
  writtenCount: number;
};

export type ReviewNotifyTickResult = { ran: boolean; written: string[]; errors: string[] };
