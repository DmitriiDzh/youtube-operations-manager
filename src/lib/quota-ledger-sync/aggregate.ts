import type { QuotaCallLike } from "@/lib/quota-history/grouping";
import type { QuotaLedgerRow } from "./contracts";

export type LocalCall = {
  occurredAt: number;
  service: "data" | "analytics";
  method: string;
  units: number | null;
  outcome: "ok" | "error" | "quota_exceeded";
  contextKind: string | null;
  contextId: string | null;
  contextLabel: string | null;
};

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/** Collapses individual calls into one row per (minute, service, method, outcome, work): a few thousand calls become a few hundred rows. */
export function aggregateCallsForExport(calls: readonly LocalCall[]): QuotaLedgerRow[] {
  const buckets = new Map<string, QuotaLedgerRow>();
  for (const call of calls) {
    const t = Math.floor(call.occurredAt / 60) * 60;
    const key = [t, call.service, call.method, call.outcome, call.contextKind ?? "", call.contextId ?? ""].join("\u0000");
    const existing = buckets.get(key);
    if (existing) {
      existing.n += 1;
      if (call.units === null) existing.k += 1;
      else existing.u += call.units;
      continue;
    }
    buckets.set(key, {
      t,
      s: call.service,
      m: call.method.slice(0, 120),
      o: call.outcome,
      u: call.units ?? 0,
      n: 1,
      k: call.units === null ? 1 : 0,
      ck: clip(call.contextKind, 60),
      ci: clip(call.contextId, 120),
      cl: clip(call.contextLabel, 200),
    });
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t || a.m.localeCompare(b.m));
}

/** The shape the history grouping reads, for rows published by ANOTHER device (`count` carries the bucket's call count). */
export function rowsToCalls(rows: readonly QuotaLedgerRow[]): QuotaCallLike[] {
  return rows.map((row) => ({
    occurredAt: row.t,
    method: row.m,
    units: row.u,
    outcome: row.o,
    contextKind: row.ck,
    contextId: row.ci,
    contextLabel: row.cl,
    count: row.n,
    unknownCount: row.k,
    otherDevice: true,
  }));
}
