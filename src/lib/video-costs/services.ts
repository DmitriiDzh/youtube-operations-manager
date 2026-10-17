import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { VIDEO_COSTS_REPORT_FORMAT, VIDEO_COSTS_REPORT_MAX, VIDEO_COSTS_REPORT_VERSION, VIDEO_NUMBER_PATTERN, type SharedCostRun, type VideoCostsReport } from "@/lib/sync-gateway";
import {
  COST_FILE_SCHEMA,
  DomainError,
  type CostComputer,
  type CostRun,
  type CostRunResult,
  type CostTotals,
  type OwnRunRows,
  type StoryboardPicks,
  type VideoCostDetail,
  type VideoCostFile,
  type VideoCostsDeps,
  type VideoCostSummary,
  type VideoStateInfo,
} from "./contracts";

// BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3, ADR 0041): this computer's runs as cost lines, its bounded report, every computer's
// lines merged per video, the totals, and `Vn_cost.json`.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A published video's runs stay in its computer's report this long after the run (its `Vn_cost.json` is the durable record). */
export const PUBLISHED_RUNS_KEEP_DAYS = 120;
/** Runs linked to no video stay in the report this long (they count only for «не привязано»). */
export const UNLINKED_RUNS_KEEP_DAYS = 90;
/** The report is written when it changed, and at least this often (so its age shows the computer is alive). */
const REPUBLISH_MS = 10 * 60 * 1000;
const UNITS = 10_000;

const channelIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a channel id");
const videoNumberSchema = z.string().regex(VIDEO_NUMBER_PATTERN, "a video number such as V49");
const summaryInputSchema = z.object({ channelId: channelIdSchema }).strict();
const videoInputSchema = z.object({ channelId: channelIdSchema, video: videoNumberSchema }).strict();
/** Workspace-relative, `/`-separated, never `.`/`..`/empty segments. */
const folderSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "a folder inside the workspace");
const costFileInputSchema = z.object({ channelId: channelIdSchema, video: videoNumberSchema, folder: folderSchema }).strict();

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const money = (n: number) => Math.round(n * UNITS) / UNITS;

function runpodMediaKind(outputsJson: string | null): SharedCostRun["mediaKind"] {
  if (!outputsJson) return null;
  try {
    const outputs = JSON.parse(outputsJson) as Array<{ kind?: unknown }>;
    const kinds = new Set(outputs.map((o) => (typeof o.kind === "string" ? o.kind : "")));
    if (["videos", "gifs", "video"].some((k) => kinds.has(k))) return "video";
    if (kinds.has("images")) return "image";
    if (kinds.has("audio")) return "audio";
    return outputs.length > 0 ? "other" : null;
  } catch {
    return null;
  }
}

const label = (value: string | null) => (value ? value.slice(0, 200) : null);
const safeId = (value: string | null) => (value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null);
const safeVideo = (value: string | null) => (value && VIDEO_NUMBER_PATTERN.test(value) ? value : null);

/** This computer's runs as cost lines (every channel). Field by field: nothing else of a row can reach the report. */
export function buildOwnRuns(rows: OwnRunRows): SharedCostRun[] {
  const runs: SharedCostRun[] = [];
  for (const j of rows.runpod) {
    const active = !["done", "failed", "cancelled"].includes(j.status);
    const split = j.allocatedUsd !== null && j.allocationBasis !== null;
    runs.push({
      runId: `runpod:${j.id}`,
      source: "runpod",
      kind: "job",
      channelId: j.channelId,
      video: safeVideo(j.video),
      label: label(j.templateName ?? j.templateId),
      mediaKind: runpodMediaKind(j.outputsJson),
      storyboardId: safeId(j.storyboardId),
      storyboardVersion: j.storyboardVersion,
      segmentId: safeId(j.segmentId),
      planId: j.planId ? j.planId.slice(0, 128) : null,
      status: active ? "active" : (j.status as "done" | "failed" | "cancelled"),
      usd: split ? money(j.allocatedUsd!) : 0,
      basis: split ? j.allocationBasis! : "pending",
      overheadUsd: split && j.overheadUsd !== null ? money(j.overheadUsd) : null,
      gpuSeconds: split ? j.gpuSeconds : null,
      createdAt: j.createdAt.toISOString(),
      finishedAt: iso(j.finishedAt),
    });
  }
  for (const s of rows.sessions) {
    runs.push({
      runId: `session:${s.id}`,
      source: "runpod",
      kind: "session",
      channelId: s.channelId,
      video: safeVideo(s.planVideo),
      label: null,
      mediaKind: null,
      storyboardId: null,
      storyboardVersion: null,
      segmentId: null,
      planId: s.planId ? s.planId.slice(0, 128) : null,
      status: "done",
      usd: money(s.usdCharged),
      basis: "measured",
      overheadUsd: money(s.usdCharged),
      gpuSeconds: 0,
      createdAt: s.createdAt.toISOString(),
      finishedAt: iso(s.stoppedAt),
    });
  }
  for (const g of rows.gemini) {
    const active = g.status !== "done" && g.status !== "failed";
    const known = g.costUsd !== null && g.costBasis !== null && ["usage", "price_table", "not_charged", "unknown_outcome"].includes(g.costBasis);
    runs.push({
      runId: `gemini:${g.jobId}`,
      source: "gemini",
      kind: "job",
      channelId: g.channelId,
      video: safeVideo(g.video),
      label: label(g.model),
      mediaKind: g.kind,
      storyboardId: safeId(g.storyboardId),
      storyboardVersion: g.storyboardVersion,
      segmentId: safeId(g.segmentId),
      planId: null,
      status: active ? "active" : g.status === "done" ? "done" : "failed",
      usd: money(known ? g.costUsd! : g.estimateUsd),
      basis: known ? (g.costBasis as SharedCostRun["basis"]) : "estimate",
      overheadUsd: null,
      gpuSeconds: null,
      createdAt: g.createdAt.toISOString(),
      finishedAt: iso(g.finishedAt),
    });
  }
  return runs;
}

/**
 * The bounded window of the report: a cancelled video's runs go; a published video's stay {@link PUBLISHED_RUNS_KEEP_DAYS} days
 * after the run; unlinked runs {@link UNLINKED_RUNS_KEEP_DAYS}; at most the report's bound, newest first. A channel whose videos
 * cannot be listed keeps every run (nothing is dropped on a guess).
 */
export function selectReportRuns(runs: SharedCostRun[], now: Date, states: Map<string, Map<string, VideoStateInfo> | null>): SharedCostRun[] {
  const age = (r: SharedCostRun) => now.getTime() - Date.parse(r.createdAt);
  return runs
    .filter((r) => {
      if (!r.video) return age(r) <= UNLINKED_RUNS_KEEP_DAYS * DAY_MS;
      const state = states.get(r.channelId)?.get(r.video)?.state;
      if (state === "cancelled") return false;
      if (state === "published") return age(r) <= PUBLISHED_RUNS_KEEP_DAYS * DAY_MS;
      return true;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.runId < b.runId ? -1 : 1))
    .slice(0, VIDEO_COSTS_REPORT_MAX);
}

const ESTIMATE_BASES = new Set<SharedCostRun["basis"]>(["estimated", "pending", "estimate", "unknown_outcome"]);

/** The takes the owner chose: picks of every version, and every take a render uses (`media` = RunPod). */
function chosenTakes(storyboards: StoryboardPicks[]): Set<string> {
  const chosen = new Set<string>();
  const add = (pick: { source: "media" | "gemini"; jobId: string }) => chosen.add(`${pick.source === "media" ? "runpod" : "gemini"}:${pick.jobId}`);
  for (const sb of storyboards) {
    for (const bySegment of Object.values(sb.picks ?? {})) for (const pick of Object.values(bySegment)) add(pick);
    for (const render of Object.values(sb.renders ?? {})) for (const pick of Object.values(render.picks ?? {})) add(pick);
  }
  return chosen;
}

export function resultOf(run: SharedCostRun, chosen: Set<string>): CostRunResult {
  if (run.kind === "session") return "session";
  if (run.status === "active") return "active";
  if (run.status !== "done") return "failed";
  if (chosen.has(run.runId)) return "chosen";
  return run.storyboardId && run.segmentId ? "rejected" : "test";
}

export function totalsOf(runs: Array<Pick<SharedCostRun, "source" | "usd" | "basis">>): CostTotals {
  let runpod = 0;
  let gemini = 0;
  for (const r of runs) {
    const units = Math.round(r.usd * UNITS);
    if (r.source === "runpod") runpod += units;
    else gemini += units;
  }
  return { runpodUsd: runpod / UNITS, geminiUsd: gemini / UNITS, totalUsd: (runpod + gemini) / UNITS, runs: runs.length, estimated: runs.some((r) => ESTIMATE_BASES.has(r.basis)) };
}

const noChannel = (channelId: string) =>
  new DomainError({ code: "video_costs_unavailable", message: `The cost of ${channelId}'s videos is read only for a channel connected on this computer.`, details: { channelId } });

export function createVideoCostsService(deps: VideoCostsDeps) {
  const log = (line: string) => deps.log?.(line);
  let lastPublished: { body: string; at: number } | null = null;

  async function statesFor(channelIds: string[]): Promise<Map<string, Map<string, VideoStateInfo> | null>> {
    const out = new Map<string, Map<string, VideoStateInfo> | null>();
    for (const channelId of channelIds) {
      try {
        out.set(channelId, (await deps.isChannelConnected(channelId)) ? await deps.videoStates(channelId) : null);
      } catch (error) {
        log(`[video-costs] the videos of ${channelId} could not be listed; no run is dropped from the report: ${error instanceof Error ? error.message : String(error)}`);
        out.set(channelId, null);
      }
    }
    return out;
  }

  /** This computer's report as it would be published now. */
  async function ownReport(): Promise<VideoCostsReport> {
    const [device, rows] = await Promise.all([deps.ownDevice(), deps.ownRows()]);
    const runs = buildOwnRuns(rows);
    const states = await statesFor([...new Set(runs.map((r) => r.channelId))]);
    return { format: VIDEO_COSTS_REPORT_FORMAT, version: VIDEO_COSTS_REPORT_VERSION, deviceId: device.deviceId, hostName: device.hostName, updatedAt: deps.now().toISOString(), runs: selectReportRuns(runs, deps.now(), states) };
  }

  async function peerReports(): Promise<VideoCostsReport[]> {
    try {
      return await deps.peers();
    } catch (error) {
      log(`[video-costs] the other computers' cost reports could not be read; this computer's runs only: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Every computer's runs of one channel, with whose they are and what they came to. */
  async function channelRuns(channelId: string): Promise<{ runs: CostRun[]; computers: CostComputer[] }> {
    if (!(await deps.isChannelConnected(channelId))) throw noChannel(channelId);
    const [own, peers, storyboards] = await Promise.all([
      ownReport(),
      peerReports(),
      deps.storyboards(channelId).catch((error: unknown) => {
        log(`[video-costs] storyboards of ${channelId} not read; no take is shown as chosen: ${error instanceof Error ? error.message : String(error)}`);
        return [] as StoryboardPicks[];
      }),
    ]);
    const chosen = chosenTakes(storyboards);
    const reports = [{ report: own, thisComputer: true }, ...peers.filter((p) => p.deviceId !== own.deviceId).map((report) => ({ report, thisComputer: false }))];
    const runs: CostRun[] = [];
    for (const { report, thisComputer } of reports) {
      for (const run of report.runs) {
        if (run.channelId !== channelId) continue;
        runs.push({ ...run, deviceId: report.deviceId, hostName: report.hostName, thisComputer, result: resultOf(run, chosen), estimate: ESTIMATE_BASES.has(run.basis) });
      }
    }
    runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : a.deviceId < b.deviceId ? -1 : 1));
    const computers = reports.map(({ report, thisComputer }) => ({ deviceId: report.deviceId, hostName: report.hostName, thisComputer, updatedAt: thisComputer ? null : report.updatedAt }));
    return { runs, computers };
  }

  async function videoCost(raw: unknown): Promise<VideoCostDetail> {
    const input = parseWithSchema(videoInputSchema, raw, "video cost");
    const { runs, computers } = await channelRuns(input.channelId);
    const mine = runs.filter((r) => r.video === input.video);
    return { channelId: input.channelId, video: input.video, totals: totalsOf(mine), runs: mine, computers };
  }

  async function costFileOf(detail: VideoCostDetail, revision: number, previous: VideoCostFile["previous"], note: string | null): Promise<VideoCostFile> {
    const device = await deps.ownDevice();
    return {
      schema: COST_FILE_SCHEMA,
      schemaVersion: 1,
      channelId: detail.channelId,
      video: detail.video,
      computedAt: deps.now().toISOString(),
      revision,
      writtenBy: { deviceId: device.deviceId, hostName: device.hostName },
      totals: detail.totals,
      computers: detail.computers.map((c) => ({ deviceId: c.deviceId, hostName: c.hostName, reportUpdatedAt: c.updatedAt, runs: detail.runs.filter((r) => r.deviceId === c.deviceId).length })),
      runs: detail.runs.map((r) => ({
        runId: r.runId,
        source: r.source,
        kind: r.kind,
        label: r.label,
        mediaKind: r.mediaKind,
        storyboardId: r.storyboardId,
        storyboardVersion: r.storyboardVersion,
        segmentId: r.segmentId,
        planId: r.planId,
        status: r.status,
        result: r.result,
        usd: r.usd,
        basis: r.basis,
        estimate: r.estimate,
        overheadUsd: r.overheadUsd,
        gpuSeconds: r.gpuSeconds,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        deviceId: r.deviceId,
        hostName: r.hostName,
      })),
      previous,
      note,
    };
  }

  const costFilePath = (folder: string, video: string) => `${folder}/${video}_cost.json`;
  const previousOf = (value: unknown): { totalUsd: number; computedAt: string; revision: number; writtenBy: string | null } | null => {
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<VideoCostFile>;
    if (v.schema !== COST_FILE_SCHEMA || !v.totals || typeof v.totals.totalUsd !== "number" || typeof v.computedAt !== "string") return null;
    return {
      totalUsd: v.totals.totalUsd,
      computedAt: v.computedAt,
      revision: typeof v.revision === "number" && Number.isInteger(v.revision) && v.revision > 0 ? v.revision : 1,
      writtenBy: v.writtenBy && typeof v.writtenBy.deviceId === "string" ? v.writtenBy.deviceId : null,
    };
  };

  return {
    /** Publishes this computer's report when it changed (and at least every 10 minutes). */
    async publishOwnReport(): Promise<boolean> {
      const report = await ownReport();
      const body = JSON.stringify({ hostName: report.hostName, runs: report.runs });
      if (lastPublished && lastPublished.body === body && deps.now().getTime() - lastPublished.at < REPUBLISH_MS) return false;
      await deps.publishReport(report);
      lastPublished = { body, at: deps.now().getTime() };
      return true;
    },

    /** Content: every video of the channel with a run, its RunPod / Gemini / total, and «не привязано». */
    async summary(raw: unknown): Promise<VideoCostSummary> {
      const input = parseWithSchema(summaryInputSchema, raw, "video costs");
      const { runs, computers } = await channelRuns(input.channelId);
      const byVideo = new Map<string, CostRun[]>();
      for (const r of runs) if (r.video) byVideo.set(r.video, [...(byVideo.get(r.video) ?? []), r]);
      const videos = [...byVideo.entries()].map(([video, list]) => ({ video, totals: totalsOf(list) })).sort((a, b) => Number(b.video.slice(1)) - Number(a.video.slice(1)));
      return { channelId: input.channelId, videos, unlinked: totalsOf(runs.filter((r) => !r.video)), computers };
    },

    /** The popup and `factory_video_get_cost`: one video's total and every run behind it. */
    videoCost,

    /** At upload: `Vn_cost.json` next to `Vn_release.json` (the folder of the package, workspace-relative). */
    async writeCostFile(raw: unknown): Promise<VideoCostFile> {
      const input = parseWithSchema(costFileInputSchema, raw, "cost file");
      const detail = await videoCost({ channelId: input.channelId, video: input.video });
      const path = costFilePath(input.folder, input.video);
      const before = previousOf(await deps.costFiles.read(input.channelId, path).catch(() => null));
      const changed = before !== null && before.totalUsd !== detail.totals.totalUsd;
      const file = await costFileOf(
        detail,
        before ? before.revision + (changed ? 1 : 0) : 1,
        changed ? { totalUsd: before.totalUsd, computedAt: before.computedAt } : null,
        changed ? `Written again at the upload: the total changed from ${before.totalUsd} to ${detail.totals.totalUsd} USD.` : null
      );
      await deps.costFiles.write(input.channelId, path, file);
      return file;
    },

    /**
     * Rewrites an existing `Vn_cost.json` whose total a later report changed (a run of another computer that arrived after the
     * upload, a session split later). Only files the upload wrote: a video without one is never given one here. Returns how many.
     */
    async refreshCostFiles(): Promise<number> {
      const [own, peers] = await Promise.all([ownReport(), peerReports()]);
      const deviceId = own.deviceId;
      const channels = new Set<string>();
      for (const report of [own, ...peers]) for (const run of report.runs) if (run.video) channels.add(run.channelId);
      let rewritten = 0;
      for (const channelId of channels) {
        try {
          if (!(await deps.isChannelConnected(channelId))) continue;
          const states = await deps.videoStates(channelId);
          for (const [video, info] of states) {
            if (!info.folder || (info.state !== "packaged" && info.state !== "published")) continue;
            if (!folderSchema.safeParse(info.folder).success) continue;
            const path = costFilePath(info.folder, video);
            const before = previousOf(await deps.costFiles.read(channelId, path).catch(() => null));
            // Only the computer that wrote it at the upload writes it again (one writer per file in the synced folder).
            if (!before || before.writtenBy !== deviceId) continue;
            const detail = await videoCost({ channelId, video });
            if (detail.totals.totalUsd === before.totalUsd) continue;
            const note = `Written again: a later report changed the total from ${before.totalUsd} to ${detail.totals.totalUsd} USD.`;
            await deps.costFiles.write(channelId, path, await costFileOf(detail, before.revision + 1, { totalUsd: before.totalUsd, computedAt: before.computedAt }, note));
            rewritten++;
          }
        } catch (error) {
          log(`[video-costs] cost files of ${channelId} not refreshed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return rewritten;
    },
  };
}

export type VideoCostsService = ReturnType<typeof createVideoCostsService>;
