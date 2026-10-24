import type { CostRun } from "@/lib/video-costs";
import type { SpendFacts, SpendFilter, SpendHistoryJob, SpendHistoryPage, SpendHistoryRow, SpendInputs, SpendMoneyCount, SpendSummary, SpendWho } from "./contracts";

// BL-219 (SERVERS_ANALYTICS_PLAN.md AC-SA-01..07): pure aggregation -- no database, no network. Every amount is the runs' own USD
// (video-costs: a RunPod job's share of its session's charge, a session without jobs, a Gemini job's cost or estimate).

const DAY_MS = 24 * 60 * 60_000;
const HISTORY_PAGE = 30;

const money = (value: number) => Math.round(value * 10_000) / 10_000;
const isFailed = (run: CostRun) => run.status === "failed" || run.status === "cancelled";

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function dayKey(at: Date | string, tz: string): string {
  // Review (BL-219): one formatter per time zone -- building one per call made a summary of a few thousand runs take ~1 s.
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(tz, formatter);
  }
  return formatter.format(new Date(at));
}

/** The last `count` calendar days in `tz`, oldest first, ending with the day of `now`. */
export function lastDays(now: Date, count: number, tz: string): string[] {
  const keys: string[] = [];
  // Step back in half days so a DST day (23 or 25 hours) is never skipped; duplicates are dropped.
  for (let t = now.getTime(); keys.length < count; t -= DAY_MS / 2) {
    const key = dayKey(new Date(t), tz);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys.reverse();
}

/** Every day from `first` to `last` (YYYY-MM-DD, inclusive). */
function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${first}T12:00:00Z`); t <= Date.parse(`${last}T12:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Who started a run: known for this computer's runs only (`null` for another computer's). */
export function whoOf(run: CostRun, facts: SpendFacts): SpendWho | null {
  if (!run.thisComputer) return null;
  const id = run.runId.slice(run.runId.indexOf(":") + 1);
  const raw =
    run.kind === "session" ? facts.sessions.get(id)?.requestedBy : run.source === "gemini" ? facts.gemini.get(id)?.createdBy : facts.jobs.get(id)?.createdBy;
  // RunPod sessions/jobs started in the Web UI say `operator`; Gemini jobs started there say `owner`.
  if (raw === "operator" || raw === "owner") return "owner";
  if (raw === "agent") return "agent";
  return raw === "factory" ? "factory" : null;
}

/** A session without jobs that ended `failed` on this computer: a start that never ran anything. */
function isFailedStart(run: CostRun, facts: SpendFacts): boolean {
  return run.kind === "session" && run.thisComputer && facts.sessions.get(run.runId.slice("session:".length))?.status === "failed";
}

function passes(run: CostRun, filter: SpendFilter, facts: SpendFacts): boolean {
  if (filter.channelId && run.channelId !== filter.channelId) return false;
  if (filter.device === "this" && !run.thisComputer) return false;
  if (filter.who !== "all" && whoOf(run, facts) !== filter.who) return false;
  return true;
}

function sortDesc<T extends { usd: number }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, usd: money(row.usd) })).sort((a, b) => b.usd - a.usd);
}


export function buildSummary(inputs: SpendInputs, filter: SpendFilter, now: Date): SpendSummary {
  const { facts } = inputs;
  const all = inputs.runs.filter((run) => passes(run, filter, facts));
  const days = filter.days
    ? lastDays(now, filter.days, filter.tz)
    : all.length > 0
      ? daysBetween(all.map((run) => dayKey(run.createdAt, filter.tz)).sort()[0], dayKey(now, filter.tz))
      : [dayKey(now, filter.tz)];
  const inPeriod = new Set(days);
  const runs = all.filter((run) => inPeriod.has(dayKey(run.createdAt, filter.tz)));

  let previousTotalUsd: number | null = null;
  if (filter.days) {
    const before = new Set(lastDays(new Date(now.getTime() - filter.days * DAY_MS), filter.days, filter.tz).filter((day) => !inPeriod.has(day)));
    previousTotalUsd = money(all.filter((run) => before.has(dayKey(run.createdAt, filter.tz))).reduce((sum, run) => sum + run.usd, 0));
  }

  const kinds = { image: { usd: 0, count: 0 }, video: { usd: 0, count: 0 }, audio: { usd: 0, count: 0 }, other: { usd: 0, count: 0 } };
  const losses = { idle: { usd: 0, count: 0 }, failedJobs: { usd: 0, count: 0 }, failedGemini: { usd: 0, count: 0 }, failedStarts: { usd: 0, count: 0 } };
  const daily = new Map(days.map((day) => [day, { day, runpodWorkUsd: 0, runpodIdleUsd: 0, geminiUsd: 0 }]));
  const byLabel = new Map<string, { label: string; source: "runpod" | "gemini"; mediaKind: string | null; runs: number; usd: number }>();
  const byVideo = new Map<string, { channelId: string; video: string; runs: number; usd: number }>();
  const byChannel = new Map<string, number>();
  const byWho = new Map<SpendWho | "other_computer", number>();
  let runpodUsd = 0;
  let geminiUsd = 0;
  let unlinkedUsd = 0;
  let done = 0;
  let failed = 0;
  let workSeconds = 0;
  let estimated = false;

  for (const run of runs) {
    const usd = run.usd;
    estimated ||= run.estimate;
    const bucket = daily.get(dayKey(run.createdAt, filter.tz))!;
    if (run.source === "gemini") {
      geminiUsd += usd;
      bucket.geminiUsd += usd;
    } else {
      runpodUsd += usd;
      const idle = run.kind === "session" ? usd : Math.min(usd, run.overheadUsd ?? 0);
      bucket.runpodIdleUsd += idle;
      bucket.runpodWorkUsd += usd - idle;
      workSeconds += run.kind === "job" ? (run.gpuSeconds ?? 0) : 0;
    }

    if (run.kind === "job") {
      if (run.status === "done") {
        done += 1;
        const kind = kinds[(run.mediaKind ?? "other") as keyof typeof kinds] ?? kinds.other;
        kind.usd += usd;
        kind.count += 1;
      } else if (isFailed(run)) {
        failed += 1;
      }
      const label = run.label ?? (run.source === "gemini" ? "Gemini" : "RunPod");
      const key = `${run.source}|${label}`;
      const entry = byLabel.get(key) ?? { label, source: run.source, mediaKind: run.mediaKind, runs: 0, usd: 0 };
      entry.runs += 1;
      entry.usd += usd;
      byLabel.set(key, entry);
    }

    // Losses (AC-SA-03): a failed or cancelled job counts whole; a finished job's idle part and a session without jobs as idle;
    // a session that failed to start apart.
    if (run.source === "gemini") {
      if (isFailed(run)) {
        losses.failedGemini.usd += usd;
        losses.failedGemini.count += 1;
      }
    } else if (run.kind === "session") {
      if (isFailedStart(run, facts)) {
        losses.failedStarts.usd += usd;
        losses.failedStarts.count += 1;
      } else {
        losses.idle.usd += usd;
        losses.idle.count += 1;
      }
    } else if (isFailed(run)) {
      losses.failedJobs.usd += usd;
      losses.failedJobs.count += 1;
    } else if ((run.overheadUsd ?? 0) > 0) {
      losses.idle.usd += Math.min(usd, run.overheadUsd ?? 0);
    }

    if (run.video) {
      const key = `${run.channelId}|${run.video}`;
      const entry = byVideo.get(key) ?? { channelId: run.channelId, video: run.video, runs: 0, usd: 0 };
      entry.runs += 1;
      entry.usd += usd;
      byVideo.set(key, entry);
    } else {
      unlinkedUsd += usd;
    }
    byChannel.set(run.channelId, (byChannel.get(run.channelId) ?? 0) + usd);
    const who = whoOf(run, facts) ?? "other_computer";
    byWho.set(who, (byWho.get(who) ?? 0) + usd);
  }

  // GPU types and paid session time: this computer's sessions that have a run in the period.
  const gpu = new Map<string, { gpuTypeId: string; sessions: Set<string>; usd: number }>();
  let paidSeconds = 0;
  const countedSessions = new Set<string>();
  for (const run of runs) {
    if (run.source !== "runpod" || !run.thisComputer) continue;
    const id = run.runId.slice(run.runId.indexOf(":") + 1);
    const sessionId = run.kind === "session" ? id : facts.jobs.get(id)?.sessionId;
    const session = sessionId ? facts.sessions.get(sessionId) : undefined;
    const gpuTypeId = session?.gpuTypeId ?? "—";
    const entry = gpu.get(gpuTypeId) ?? { gpuTypeId, sessions: new Set<string>(), usd: 0 };
    entry.usd += run.usd;
    if (sessionId) entry.sessions.add(sessionId);
    gpu.set(gpuTypeId, entry);
    if (session && sessionId && !countedSessions.has(sessionId)) {
      countedSessions.add(sessionId);
      paidSeconds += session.secondsUsed ?? 0;
    }
  }

  const totalUsd = runpodUsd + geminiUsd;
  const lossesTotal = losses.idle.usd + losses.failedJobs.usd + losses.failedGemini.usd + losses.failedStarts.usd;
  const roundCount = (entry: SpendMoneyCount): SpendMoneyCount => ({ usd: money(entry.usd), count: entry.count });
  return {
    period: { days: days.length, firstDay: days[0], lastDay: days[days.length - 1] },
    totals: { totalUsd: money(totalUsd), runpodUsd: money(runpodUsd), geminiUsd: money(geminiUsd), previousTotalUsd, estimated },
    results: {
      done,
      failed,
      byKind: { image: roundCount(kinds.image), video: roundCount(kinds.video), audio: roundCount(kinds.audio), other: roundCount(kinds.other) },
    },
    costPerResultUsd: done > 0 ? money(totalUsd / done) : null,
    gpu: { workHours: Math.round((workSeconds / 3600) * 10) / 10, paidHours: countedSessions.size > 0 ? Math.round((paidSeconds / 3600) * 10) / 10 : null },
    losses: { idle: roundCount(losses.idle), failedJobs: roundCount(losses.failedJobs), failedGemini: roundCount(losses.failedGemini), failedStarts: roundCount(losses.failedStarts), totalUsd: money(lossesTotal) },
    daily: [...daily.values()].map((d) => ({ day: d.day, runpodWorkUsd: money(d.runpodWorkUsd), runpodIdleUsd: money(d.runpodIdleUsd), geminiUsd: money(d.geminiUsd) })),
    byLabel: sortDesc([...byLabel.values()]),
    byVideo: { videos: sortDesc([...byVideo.values()]), unlinkedUsd: money(unlinkedUsd) },
    byChannel: sortDesc([...byChannel.entries()].map(([channelId, usd]) => ({ channelId, usd }))),
    byWho: sortDesc([...byWho.entries()].map(([who, usd]) => ({ who, usd }))),
    byGpu: sortDesc([...gpu.values()].map((entry) => ({ gpuTypeId: entry.gpuTypeId, sessions: entry.sessions.size, usd: entry.usd }))),
    computers: inputs.computers,
  };
}

/**
 * The image outputs of a job that are on this computer, in order, as paths RELATIVE TO THE JOB FOLDER ("a.png", or "sub/a.png" when a
 * Save node nested a subfolder: the puller keeps the remote key's path below `exchange/<jobId>/`) -- the one rule for the history's
 * preview count and the preview route's index. An .mp4 that ComfyUI lists under `images` is not an image; an output never pulled
 * (no `localPath`) has no file; a path with an empty, `.` or `..` segment is never served.
 */
export function imageFileNames(outputsJson: string | null): string[] {
  try {
    const outputs = JSON.parse(outputsJson ?? "[]") as Array<{ kind?: unknown; filename?: unknown; path?: unknown; remoteKey?: unknown; localPath?: unknown; mimeType?: unknown }>;
    if (!Array.isArray(outputs)) return [];
    const names: string[] = [];
    for (const o of outputs) {
      if (!(o.kind === "images" || o.kind === "image" || (typeof o.mimeType === "string" && o.mimeType.startsWith("image/")))) continue;
      if (typeof o.localPath !== "string" || o.localPath.length === 0) continue;
      let relative: string | null = null;
      if (typeof o.remoteKey === "string") relative = o.remoteKey.split("/").slice(2).join("/"); // exchange/<jobId>/<...>
      else if (typeof o.path === "string") relative = o.path.split("/").slice(2).join("/"); // gemini/<jobId>/<...>
      else if (typeof o.filename === "string") relative = o.filename;
      if (!relative) continue;
      const segments = relative.split("/");
      if (segments.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) continue;
      if (!/\.(png|jpe?g|webp)$/i.test(relative)) continue;
      names.push(relative);
    }
    return names;
  } catch {
    return [];
  }
}

const imagesIn = (outputsJson: string | null) => imageFileNames(outputsJson).length;

function errorOf(text: string | null): { code: string | null; text: string } | null {
  if (!text) return null;
  const code = /^([a-z][a-z0-9_]{2,60}):/.exec(text)?.[1] ?? null;
  return { code, text: text.length > 240 ? `${text.slice(0, 239)}…` : text };
}

/** `day`: only runs of that calendar day (YYYY-MM-DD in the filter's time zone) -- the chart's click. */
export type HistoryOptions = { kind: "all" | "runpod" | "gemini"; errorsOnly: boolean; cursor: string | null; day?: string | null };

export function buildHistory(inputs: SpendInputs, filter: SpendFilter, options: HistoryOptions, now: Date): SpendHistoryPage {
  const { facts } = inputs;
  const days = filter.days ? new Set(lastDays(now, filter.days, filter.tz)) : null;
  const runs = inputs.runs.filter(
    (run) => passes(run, filter, facts) && (!days || days.has(dayKey(run.createdAt, filter.tz))) && (!options.day || dayKey(run.createdAt, filter.tz) === options.day)
  );

  const sessions = new Map<string, Extract<SpendHistoryRow, { type: "session" }>>();
  const rows: SpendHistoryRow[] = [];
  for (const run of runs) {
    const id = run.runId.slice(run.runId.indexOf(":") + 1);
    if (!run.thisComputer) {
      rows.push({ type: "other_computer", id: run.runId, at: run.createdAt, channelId: run.channelId, source: run.source, status: run.status, label: run.label, video: run.video, usd: run.usd, computer: run.hostName ?? run.deviceId });
      continue;
    }
    if (run.source === "gemini") {
      const fact = facts.gemini.get(id);
      rows.push({ type: "gemini", id, at: run.createdAt, channelId: run.channelId, status: run.status, who: whoOf(run, facts) ?? "factory", label: run.label, mediaKind: run.mediaKind, video: run.video, usd: run.usd, images: imagesIn(fact?.outputsJson ?? null), errorCode: fact?.errorCode ?? null });
      continue;
    }
    const sessionId = run.kind === "session" ? id : facts.jobs.get(id)?.sessionId;
    if (!sessionId) continue;
    const fact = facts.sessions.get(sessionId);
    let row = sessions.get(sessionId);
    if (!row) {
      row = {
        type: "session",
        id: sessionId,
        at: fact?.createdAt.toISOString() ?? run.createdAt,
        channelId: run.channelId,
        status: fact?.status ?? "done",
        who: whoOf(run, facts) ?? "factory",
        gpuTypeId: fact?.gpuTypeId ?? null,
        seconds: fact?.secondsUsed ?? null,
        usd: 0,
        idleUsd: 0,
        results: 0,
        videos: [],
        error: fact?.status === "failed" ? errorOf(fact.error ?? fact.stopReason) : null,
        jobs: [],
      };
      sessions.set(sessionId, row);
      rows.push(row);
    }
    row.usd += run.usd;
    if (run.kind === "session") {
      row.idleUsd += run.usd;
    } else {
      row.idleUsd += Math.min(run.usd, run.overheadUsd ?? 0);
      if (run.status === "done") row.results += 1;
      if (run.video && !row.videos.includes(run.video)) row.videos.push(run.video);
      const job: SpendHistoryJob = { jobId: id, label: run.label, planId: run.planId, video: run.video, status: run.status, gpuSeconds: run.gpuSeconds, usd: run.usd, images: imagesIn(facts.jobs.get(id)?.outputsJson ?? null) };
      row.jobs.push(job);
    }
  }

  const filtered = rows
    .filter((row) => options.kind === "all" || (options.kind === "gemini" ? row.type === "gemini" || (row.type === "other_computer" && row.source === "gemini") : row.type === "session" || (row.type === "other_computer" && row.source === "runpod")))
    .filter((row) => {
      if (!options.errorsOnly) return true;
      if (row.type === "session") return row.status === "failed" || row.jobs.some((job) => job.status === "failed" || job.status === "cancelled");
      return row.status === "failed" || row.status === "cancelled";
    })
    .map((row) => (row.type === "session" ? { ...row, usd: money(row.usd), idleUsd: money(row.idleUsd), jobs: row.jobs.sort((a, b) => (a.jobId < b.jobId ? -1 : 1)) } : { ...row, usd: money(row.usd) }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1));

  const start = options.cursor && /^\d+$/.test(options.cursor) ? Number(options.cursor) : 0;
  const page = filtered.slice(start, start + HISTORY_PAGE);
  return { rows: page, total: filtered.length, nextCursor: start + HISTORY_PAGE < filtered.length ? String(start + HISTORY_PAGE) : null };
}
