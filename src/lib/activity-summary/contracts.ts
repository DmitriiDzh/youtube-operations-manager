// ---------------------------------------------------------------------------
// BL-195 stage D (docs/roadmap/plans/UI_FEEDBACK_CLARITY_PLAN.md §3) -- what runs in the background right now, for the header's
// Activity centre. Read-only and in codes: kinds, states, counts, times and the names the owner already sees on the tabs (a
// template or model label, a video number). Never a prompt, a path, a key, a URL or an error text.
// ---------------------------------------------------------------------------

export const ACTIVITY_SOURCES = ["operations", "media_jobs", "uploads", "live_streams"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** `ok`: read; `unavailable`: its read failed (the others are still listed); `no_channel`: it needs an active channel and there is none. */
export type ActivitySourceState = "ok" | "unavailable" | "no_channel";

export type ActivityItem =
  /** A server-run operation of the active channel (a sync, an Analytics collection, an AI generation). `kind` is the registry's. */
  | { source: "operations"; id: string; kind: string; status: "running" | "cancelling"; startedAt: string; done: number; total: number }
  /** A media job not finished yet, on any computer, of the active channel. */
  | { source: "media_jobs"; id: string; provider: "runpod" | "gemini"; status: string; label: string; device: string | null; own: boolean; createdAt: string }
  /** An upload to YouTube not finished yet, of the active channel. */
  | { source: "uploads"; id: string; video: string; status: "queued" | "uploading" | "processing" | "finishing" | "paused"; storedBytes: number; totalBytes: number; createdAt: string }
  /** A stream on this computer that is on (any channel). */
  | { source: "live_streams"; channelId: string; state: string; since: string | null };

export type ActivitySummary = {
  channelId: string | null;
  items: ActivityItem[];
  sources: Record<ActivitySource, ActivitySourceState>;
  at: string;
};
