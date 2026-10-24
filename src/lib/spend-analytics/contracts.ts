import type { CostComputer, CostRun } from "@/lib/video-costs";
import type { SpendGeminiFact, SpendJobFact, SpendSessionFact } from "@/lib/db";

// ---------------------------------------------------------------------------
// BL-219 (docs/roadmap/plans/SERVERS_ANALYTICS_PLAN.md): Servers → «Аналитика» -- what was generated and what it cost, on every
// computer. A module of its own (AGENTS.md §M): it reads the video-costs module's runs (one USD row per RunPod job, session without
// jobs and Gemini job, of every computer) and this computer's session / job facts; nothing imports it but its own routes. Read-only.
// ---------------------------------------------------------------------------

export type SpendWho = "owner" | "factory" | "agent";

export type SpendFilter = {
  /** The period in days ending today (in `tz`); null = everything known. */
  days: 7 | 30 | 90 | null;
  channelId: string | null;
  /** `this`: only this computer's runs. */
  device: "all" | "this";
  /** Who started the run; known only for this computer's runs (another computer's runs are left out by any other value). */
  who: "all" | SpendWho;
  /** IANA time zone the days are counted in (the viewer's). */
  tz: string;
};

export type SpendFacts = {
  sessions: Map<string, SpendSessionFact>;
  jobs: Map<string, SpendJobFact>;
  gemini: Map<string, SpendGeminiFact>;
};

export type SpendInputs = { runs: CostRun[]; computers: CostComputer[]; facts: SpendFacts };

export type SpendMoneyCount = { usd: number; count: number };

export type SpendSummary = {
  period: { days: number; firstDay: string; lastDay: string };
  totals: { totalUsd: number; runpodUsd: number; geminiUsd: number; previousTotalUsd: number | null; estimated: boolean };
  results: { done: number; failed: number; byKind: Record<"image" | "video" | "audio" | "other", SpendMoneyCount> };
  /** USD per finished result over the period (null without results). */
  costPerResultUsd: number | null;
  gpu: { workHours: number; paidHours: number | null };
  losses: { idle: SpendMoneyCount; failedJobs: SpendMoneyCount; failedGemini: SpendMoneyCount; failedStarts: SpendMoneyCount; totalUsd: number };
  daily: Array<{ day: string; runpodWorkUsd: number; runpodIdleUsd: number; geminiUsd: number }>;
  byLabel: Array<{ label: string; source: "runpod" | "gemini"; mediaKind: string | null; runs: number; usd: number }>;
  byVideo: { videos: Array<{ channelId: string; video: string; runs: number; usd: number }>; unlinkedUsd: number };
  byChannel: Array<{ channelId: string; usd: number }>;
  byWho: Array<{ who: SpendWho | "other_computer"; usd: number }>;
  byGpu: Array<{ gpuTypeId: string; sessions: number; usd: number }>;
  computers: CostComputer[];
};

export type SpendHistoryJob = {
  jobId: string;
  label: string | null;
  planId: string | null;
  video: string | null;
  status: CostRun["status"];
  gpuSeconds: number | null;
  usd: number;
  /** How many image outputs a preview can show. */
  images: number;
};

export type SpendHistoryRow =
  | {
      type: "session";
      id: string;
      at: string;
      channelId: string;
      status: string;
      who: SpendWho;
      gpuTypeId: string | null;
      seconds: number | null;
      usd: number;
      idleUsd: number;
      results: number;
      videos: string[];
      error: { code: string | null; text: string } | null;
      jobs: SpendHistoryJob[];
    }
  | {
      type: "gemini";
      id: string;
      at: string;
      channelId: string;
      status: CostRun["status"];
      who: SpendWho;
      label: string | null;
      mediaKind: string | null;
      video: string | null;
      usd: number;
      images: number;
      errorCode: string | null;
    }
  | {
      type: "other_computer";
      id: string;
      at: string;
      channelId: string;
      source: "runpod" | "gemini";
      status: CostRun["status"];
      label: string | null;
      video: string | null;
      usd: number;
      computer: string | null;
    };

export type SpendHistoryPage = { rows: SpendHistoryRow[]; total: number; nextCursor: string | null };
