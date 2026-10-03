import { isWriteMethod, startOfYoutubeQuotaDay } from "@/lib/youtube-quota";

export type QuotaCallLike = {
  occurredAt: number; // unix seconds
  method: string;
  units: number | null;
  outcome: "ok" | "error" | "quota_exceeded";
  contextKind: string | null;
  contextId: string | null;
  contextLabel: string | null;
};

export type QuotaHistoryEntry = {
  kind: string;
  contextId: string | null;
  label: string;
  startedAt: string;
  endedAt: string;
  calls: number;
  /** Successful content-changing calls (videos.update, playlistItems.insert, ...). */
  writeCalls: number;
  failedCalls: number;
  /** Sum of the known unit costs. */
  units: number;
  /** Calls whose method has no known cost (not counted in `units`). */
  unknownUnitCalls: number;
};

/** Calls of one run closer together than this belong to the same entry; a gap longer than this starts a new one (a resumed batch). */
export const RUN_GAP_SECONDS = 30 * 60;

/**
 * Groups ledger rows into one entry per piece of work (BL-117): rows with the same context kind + id form a run, split
 * where the gap between consecutive calls exceeds `RUN_GAP_SECONDS` (so a batch resumed later is its own entry). Calls
 * with no context are "other" and are bucketed per quota (Pacific) day, so background noise is a few lines, not hundreds.
 * Newest entry first.
 */
export function groupQuotaCalls(calls: readonly QuotaCallLike[]): QuotaHistoryEntry[] {
  const sorted = [...calls].sort((a, b) => a.occurredAt - b.occurredAt);
  type Bucket = { kind: string; contextId: string | null; label: string; calls: QuotaCallLike[] };
  const open = new Map<string, Bucket>();
  const closed: Bucket[] = [];

  for (const call of sorted) {
    const kind = call.contextKind ?? "other";
    const contextId = call.contextKind ? call.contextId : null;
    const day = call.contextKind ? "" : startOfYoutubeQuotaDay(new Date(call.occurredAt * 1000)).toISOString();
    const key = `${kind}\u0000${contextId ?? ""}\u0000${day}`;
    const existing = open.get(key);
    const last = existing?.calls[existing.calls.length - 1];
    if (existing && last && call.occurredAt - last.occurredAt <= RUN_GAP_SECONDS) {
      existing.calls.push(call);
      continue;
    }
    if (existing) closed.push(existing);
    open.set(key, { kind, contextId, label: call.contextLabel ?? "Other API calls", calls: [call] });
  }
  closed.push(...open.values());

  return closed
    .map((bucket): QuotaHistoryEntry => {
      const first = bucket.calls[0];
      const last = bucket.calls[bucket.calls.length - 1];
      return {
        kind: bucket.kind,
        contextId: bucket.contextId,
        label: bucket.label,
        startedAt: new Date(first.occurredAt * 1000).toISOString(),
        endedAt: new Date(last.occurredAt * 1000).toISOString(),
        calls: bucket.calls.length,
        writeCalls: bucket.calls.filter((c) => c.outcome === "ok" && isWriteMethod(c.method)).length,
        failedCalls: bucket.calls.filter((c) => c.outcome !== "ok").length,
        units: bucket.calls.reduce((sum, c) => sum + (c.units ?? 0), 0),
        unknownUnitCalls: bucket.calls.filter((c) => c.units === null).length,
      };
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.label.localeCompare(b.label));
}
