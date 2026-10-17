import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { SharedCostRun, VideoCostsReport } from "@/lib/sync-gateway";
import type { VideoCostRunpodJobRow, VideoCostGeminiJobRow } from "@/lib/db";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-194 stage 3 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 3, ADR 0041): the visual cost of each video -- every RunPod and
// Gemini run linked to it on every computer, one total, the list of runs behind it, and `Vn_cost.json` next to the release package.
// A module of its own (AGENTS.md §M): it reads this computer's run rows (`db.ts`), the other computers' `video-costs` reports and the
// storyboards document through the sync gateway, and the videos' states through the shared video-projects module. No media module
// depends on it, and Publishing reaches it only through an optional port: Servers, Media and Publishing work when it fails.
// ---------------------------------------------------------------------------

/**
 * What a run came to for its video: `chosen` (the owner's take of its storyboard segment, or a take a render uses), `rejected` (a
 * take of a storyboard segment that was not chosen), `failed` (failed or cancelled -- still paid when it ran), `active` (running),
 * `test` (a finished run outside any storyboard segment: a test, a plan attempt, a still), `session` (a RunPod session that ran no
 * job: the pod's time alone).
 */
export type CostRunResult = "chosen" | "rejected" | "failed" | "active" | "test" | "session";

export type CostComputer = { deviceId: string; hostName: string | null; thisComputer: boolean; updatedAt: string | null };

export type CostRun = SharedCostRun & {
  deviceId: string;
  hostName: string | null;
  thisComputer: boolean;
  result: CostRunResult;
  /** The cost is not final: a RunPod share from estimated times or a session not ended yet, or a Gemini estimate. */
  estimate: boolean;
};

export type CostTotals = { runpodUsd: number; geminiUsd: number; totalUsd: number; runs: number; estimated: boolean };

export type VideoCostSummary = {
  channelId: string;
  /** Every video with at least one run, highest number first. */
  videos: Array<{ video: string; totals: CostTotals }>;
  /** Runs linked to no video («не привязано»). */
  unlinked: CostTotals;
  computers: CostComputer[];
};

export type VideoCostDetail = {
  channelId: string;
  video: string;
  totals: CostTotals;
  /** Newest first. */
  runs: CostRun[];
  /** Every computer whose report was read, with its age (a total is final only once each has reported). */
  computers: CostComputer[];
};

/** The storyboard facts the result of a run needs (from the synced storyboards document). */
export type StoryboardPicks = {
  id: string;
  picks?: Record<string, Record<string, { source: "media" | "gemini"; jobId: string }>>;
  renders?: Record<string, { picks: Record<string, { source: "media" | "gemini"; jobId: string }> }>;
};

export type OwnRunRows = {
  runpod: VideoCostRunpodJobRow[];
  sessions: Array<{ id: string; channelId: string; planId: string | null; planVideo: string | null; usdCharged: number; createdAt: Date; stoppedAt: Date | null }>;
  gemini: VideoCostGeminiJobRow[];
};

export type VideoStateInfo = { state: "in_work" | "packaged" | "published" | "cancelled"; folder: string | null };

export const COST_FILE_SCHEMA = "ytm.video-cost";

/** `Vn_cost.json`: the durable record of a video's visual cost, next to `Vn_release.json` (cleaning a report window never loses it). */
export type VideoCostFile = {
  schema: typeof COST_FILE_SCHEMA;
  schemaVersion: 1;
  channelId: string;
  video: string;
  computedAt: string;
  /** 1 when first written at upload; +1 each time a later report changed the total and the file was written again. */
  revision: number;
  totals: CostTotals;
  computers: Array<{ deviceId: string; hostName: string | null; reportUpdatedAt: string | null; runs: number }>;
  runs: Array<Omit<CostRun, "thisComputer" | "channelId" | "video">>;
  /** The total this file replaced, and why (null on the first write). */
  previous: { totalUsd: number; computedAt: string } | null;
  note: string | null;
};

export type VideoCostsDeps = {
  ownRows(): Promise<OwnRunRows>;
  /** The other computers' latest reports (never this computer's own). */
  peers(): Promise<VideoCostsReport[]>;
  publishReport(report: VideoCostsReport): Promise<void>;
  ownDevice(): Promise<{ deviceId: string; hostName: string | null }>;
  isChannelConnected(channelId: string): Promise<boolean>;
  storyboards(channelId: string): Promise<StoryboardPicks[]>;
  /** The channel's videos by number (state, folder); throws when they cannot be listed (then nothing is dropped from the report). */
  videoStates(channelId: string): Promise<Map<string, VideoStateInfo>>;
  costFiles: {
    /** The parsed file, or null when it is not there. */
    read(channelId: string, relativePath: string): Promise<unknown | null>;
    /** Inside the channel workspace, whole or not at all. */
    write(channelId: string, relativePath: string, document: VideoCostFile): Promise<void>;
  };
  now(): Date;
  log?(line: string): void;
};
