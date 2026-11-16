// ---------------------------------------------------------------------------
// BL-195 stage D (docs/roadmap/plans/UI_FEEDBACK_CLARITY_PLAN.md §3) -- what runs in the background right now, for the header's
// Activity centre. Read-only and in codes: kinds, states, counts, times and the names the owner already sees on the tabs (a
// template or model label, a video number). Never a prompt, a path, a key, a URL or an error text.
//
// BL-258 (owner msg 4385, 2026-11-15: «там надо показывать общую очередь. Ведь в фоне делаются все каналы и не надо фильтровать по
// каналу это. Плюс было бы хорошо добавить туда прогресс бар»): every channel's work, not the active channel's -- each item names its
// channel -- the uploads in this computer's shared queue order, and a progress (0-100) where the work reports one.
// ---------------------------------------------------------------------------

export const ACTIVITY_SOURCES = ["operations", "media_jobs", "uploads", "live_streams"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** `ok`: read; `unavailable`: its read failed (the others are still listed). */
export type ActivitySourceState = "ok" | "unavailable";

/** `progress`: 0-100 when the work reports how far it is, null when it does not (waiting, or a step without a measure). */
export type ActivityItem =
  /** A server-run operation on this computer (a sync, an Analytics collection, an AI generation), any channel. `kind` is the registry's. */
  | { source: "operations"; id: string; channelId: string; kind: string; status: "running" | "cancelling"; startedAt: string; done: number; total: number; progress: number | null }
  /** A media job not finished yet, on any computer still reporting, any channel. */
  | { source: "media_jobs"; id: string; channelId: string | null; provider: "runpod" | "gemini"; status: string; label: string; device: string | null; own: boolean; createdAt: string; progress: number | null }
  /**
   * An upload to YouTube not finished yet, on this computer, any channel. `queuePosition`: its place in the shared queue (1 = next)
   * while queued, else null.
   */
  | { source: "uploads"; id: string; channelId: string; video: string; status: "queued" | "uploading" | "processing" | "finishing" | "paused"; storedBytes: number; totalBytes: number; createdAt: string; queuePosition: number | null; progress: number | null }
  /** A stream on this computer that is on (any channel). */
  | { source: "live_streams"; channelId: string; state: string; since: string | null };

export type ActivitySummary = {
  /** The session's active channel (for the screen's own use); the items are every channel's. */
  channelId: string | null;
  items: ActivityItem[];
  sources: Record<ActivitySource, ActivitySourceState>;
  at: string;
};
