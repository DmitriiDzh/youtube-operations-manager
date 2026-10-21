import { parseGpuSkipped, type StoredSessionRow } from "./sessions";
import type { MediaGpuPlan } from "./contracts";

/**
 * BL-206 (FO-REQ-0033, docs/roadmap/plans/GPU_STATS_PLAN.md §2.B/§2.C): a session's GPU wait, derived from its row (no table of its
 * own), and the statistics `factory_media_get_gpu_stats` builds from those records and the stored availability snapshots. Pure.
 */

/**
 * ready = ComfyUI answered (readyAt set); failed = the session ended `failed` before that; stopped = it ended otherwise before
 * that (a stop, a reject, an app restart); open = it has not ended yet.
 */
export type GpuWaitOutcome = "ready" | "failed" | "stopped" | "open";

export type GpuWaitRecord = {
  sessionId: string;
  requestedBy: string;
  status: string;
  outcome: GpuWaitOutcome;
  /** The GPU list the session tried: its own plan's, else the Settings' GPU and fallback list (as they are now). */
  candidates: string[];
  datacenterId: string | null;
  firstApprovedAt: string | null;
  /** True for a session from before schema v100: its first approval is its earliest capacity attempt. */
  waitApproximate: boolean;
  readyAt: string | null;
  /** readyAt − first approval, in minutes (two decimals); null unless ready. */
  waitMinutes: number | null;
  /** The GPU the session got (null unless ready). */
  gpuTypeId: string | null;
  capacityAttempts: number;
  skipped: Array<{ gpuTypeId: string; reason: string }> | null;
  /** For a failed session: the code its error starts with (`media_no_capacity`), else its first words as a code. */
  failureReason: string | null;
  usdCharged: number | null;
};

/** `media_no_capacity: …` → `media_no_capacity`; `no GPU candidate qualifies: …` → `no_gpu_candidate_qualifies`. */
export function failureReasonOf(error: string | null): string {
  if (!error) return "unknown";
  const head = error.split(":")[0].trim().toLowerCase();
  const code = head
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return code || "unknown";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildGpuWaitRecord(row: StoredSessionRow, settingsCandidates: string[]): GpuWaitRecord {
  const plan = row.gpuPlanJson ? (JSON.parse(row.gpuPlanJson) as MediaGpuPlan) : null;
  const candidates = plan && plan.candidates.length > 0 ? [...plan.candidates] : [...settingsCandidates];
  const first = row.firstApprovedAt ?? null;
  const outcome: GpuWaitOutcome = row.readyAt ? "ready" : row.status === "failed" ? "failed" : ["done", "rejected", "interrupted"].includes(row.status) ? "stopped" : "open";
  return {
    sessionId: row.id,
    requestedBy: row.requestedBy,
    status: row.status,
    outcome,
    candidates,
    datacenterId: row.datacenterId,
    firstApprovedAt: first ? first.toISOString() : null,
    waitApproximate: row.firstApprovedApproximate === true,
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    waitMinutes: outcome === "ready" && first && row.readyAt ? round2((row.readyAt.getTime() - first.getTime()) / 60_000) : null,
    gpuTypeId: outcome === "ready" ? row.gpuTypeId : null,
    capacityAttempts: row.capacityAttempts ?? 0,
    skipped: parseGpuSkipped(row.gpuSkippedJson ?? null),
    failureReason: outcome === "failed" ? failureReasonOf(row.error) : null,
    usdCharged: row.usdCharged,
  };
}
