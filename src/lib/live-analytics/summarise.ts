import { MAX_GAP_MS, type LiveSummary, type LiveSummaryFigures } from "./contracts";

export type LiveSampleInput = { sampledAt: number; broadcastId: string; viewers: number | null; lifeCycleStatus: string | null };
export type LiveEventInput = { at: number; kind: string; cause: string | null };

/** An encoder run that ended before its pass did: the helper restarted it (`encoder-helper.mjs`, `run_exit`). */
function isInterruption(event: LiveEventInput): boolean {
  return event.kind === "encoder_run_exit" && event.cause !== null && event.cause !== "pass_end";
}

type Acc = { samples: number; onAirMs: number; notLiveMs: number; dataGaps: number; viewerMs: number; knownMs: number; peak: number | null; interruptions: number };

const newAcc = (): Acc => ({ samples: 0, onAirMs: 0, notLiveMs: 0, dataGaps: 0, viewerMs: 0, knownMs: 0, peak: null, interruptions: 0 });

function figures(acc: Acc): LiveSummaryFigures {
  return {
    samples: acc.samples,
    onAirMs: acc.onAirMs,
    notLiveMs: acc.notLiveMs,
    dataGaps: acc.dataGaps,
    viewerHours: acc.viewerMs / 3_600_000,
    averageViewers: acc.knownMs > 0 ? acc.viewerMs / acc.knownMs : null,
    peakViewers: acc.peak,
    interruptions: acc.interruptions,
  };
}

function bucket<K>(map: Map<K, Acc>, key: K): Acc {
  let acc = map.get(key);
  if (!acc) map.set(key, (acc = newAcc()));
  return acc;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcHour = (ms: number) => `${new Date(ms).toISOString().slice(0, 13)}:00:00.000Z`;

/**
 * The summary of a stream's samples and events (LIVE_ANALYTICS_PLAN.md §3): an interval a→b of at most MAX_GAP_MS belongs to
 * sample a -- its state, UTC day, hour and broadcast; a longer one is a data gap. Unknown stays null, never 0.
 */
export function summariseLive(input: { samples: readonly LiveSampleInput[]; events: readonly LiveEventInput[] }): LiveSummary {
  const samples = [...input.samples].sort((a, b) => a.sampledAt - b.sampledAt);
  const total = newAcc();
  const days = new Map<string, Acc>();
  const hours = new Map<string, Acc>();
  const broadcasts = new Map<string, Acc>();
  const spans = new Map<string, { first: number; last: number }>();

  samples.forEach((a, i) => {
    const targets = [total, bucket(days, utcDate(a.sampledAt)), bucket(hours, utcHour(a.sampledAt)), bucket(broadcasts, a.broadcastId)];
    const span = spans.get(a.broadcastId);
    spans.set(a.broadcastId, span ? { first: span.first, last: a.sampledAt } : { first: a.sampledAt, last: a.sampledAt });
    for (const acc of targets) {
      acc.samples += 1;
      if (a.viewers !== null) acc.peak = acc.peak === null ? a.viewers : Math.max(acc.peak, a.viewers);
    }
    const b = samples[i + 1];
    if (!b) return;
    const dt = b.sampledAt - a.sampledAt;
    for (const acc of targets) {
      if (dt > MAX_GAP_MS) acc.dataGaps += 1;
      else if (a.lifeCycleStatus !== "live") acc.notLiveMs += dt;
      else {
        acc.onAirMs += dt;
        if (a.viewers !== null) {
          acc.viewerMs += a.viewers * dt;
          acc.knownMs += dt;
        }
      }
    }
  });

  for (const event of input.events) {
    if (!isInterruption(event)) continue;
    total.interruptions += 1;
    bucket(days, utcDate(event.at)).interruptions += 1;
    for (const [broadcastId, span] of spans) if (event.at >= span.first && event.at <= span.last) broadcasts.get(broadcastId)!.interruptions += 1;
  }

  return {
    totals: figures(total),
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, acc]) => ({ date, ...figures(acc) })),
    hours: [...hours.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, acc]) => {
      const f = figures(acc);
      return { hour, averageViewers: f.averageViewers, peakViewers: f.peakViewers };
    }),
    broadcasts: [...spans.entries()].map(([broadcastId, span]) => ({ broadcastId, firstSampleAt: span.first, lastSampleAt: span.last, ...figures(broadcasts.get(broadcastId)!) })),
    analytics: null,
  };
}
