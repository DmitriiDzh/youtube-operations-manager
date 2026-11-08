import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { decidingRecordOf, wellFormedAttachments } from "@/lib/clip-reviews";
import {
  deleteReviewNotifyLedgerBefore,
  getReviewNotifySettingsJson,
  getReviewNotifyStateJson,
  insertReviewNotifyLedgerEntries,
  listReviewNotifyLedgerKeys,
  setReviewNotifySettingsJson,
  setReviewNotifyStateJson,
} from "@/lib/db";
import { stat } from "node:fs/promises";
import path from "node:path";
import { listOutgoingPlanReviewActions, listPlanReviewActivity, type PlanReviewActivity } from "@/lib/generation-plans";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import {
  createInboxWriter,
  createReviewNotify,
  defaultInboxOf,
  isDirectory,
  planNoneFitsEntryId,
  planPickEntryId,
  planVerdictEntryId,
  producerFolderOf,
  sweepInboxTemp,
  workspaceRootOf,
  type PlanEntryMark,
  type PlanReviewEntry,
  type PlanReviewFeed,
  type ReviewDecisionNotice,
  type ReviewNotify,
} from "@/lib/review-notify";
import { createDefaultLogger } from "@/lib/shared-logger";
import { latestVersion } from "@/lib/storyboards";
import {
  createClipReviewsCoreForProduction,
  createGenerationPlansShareCoreForProduction,
  createPublishingPlansCoreForProduction,
  createStoryboardsCoreForProduction,
  type ClipReviewsSnapshot,
  type PublishingPlansSnapshot,
  type SharedPickAction,
  type SharedPlan,
  type SharedVerdict,
  type StoryboardCommentTarget,
  type StoryboardRecord,
} from "@/lib/sync-gateway";

/**
 * BL-248 (ADR 0066, docs/roadmap/plans/REVIEW_NOTIFY_PLAN.md): the review-notify writer composed at the app layer (AGENTS.md §M) --
 * its sources are the feature modules' documents and plans, read here; review-notify itself imports none of them. The mappers
 * below are pure (exported for their test): only the OWNER's decisions become notices.
 */

type Channel = { channelId: string; name: string | null };

const after = (iso: string, sinceMs: number) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= sinceMs;
};
const json = (value: Record<string, string>) => JSON.stringify(value);

// --- clips -----------------------------------------------------------------------------------------------------------------

/** REVIEW_NOTIFY_PLAN.md §2: an owner `approved` / `returned` record; never the Producer's withdrawal or a submit. */
export function clipNoticesOf(channel: Channel, snapshot: ClipReviewsSnapshot, sinceMs: number): ReviewDecisionNotice[] {
  const all = Object.values(snapshot.decisions);
  const out: ReviewDecisionNotice[] = [];
  for (const decision of all) {
    if (decision.by !== "owner" || (decision.kind !== "approved" && decision.kind !== "returned") || !after(decision.at, sinceMs)) continue;
    const clip = snapshot.clips[decision.clipId];
    const deciding = decidingRecordOf(decision.clipId, all);
    const context = [
      ...(clip ? [{ label: "Scene", value: clip.sceneId }, { label: "Clip file", value: clip.clipPath }, { label: "Producer's note", value: clip.note }] : []),
      ...(deciding && deciding.id !== decision.id ? [{ label: "Counts", value: `no: an earlier owner decision (${deciding.id}) decides this clip` }] : []),
    ];
    out.push({
      kind: "clip",
      channelId: channel.channelId,
      channelName: channel.name,
      itemId: decision.clipId,
      decisionId: decision.id,
      status: decision.kind,
      comment: decision.comment,
      decidedAt: decision.at,
      decidedOn: decision.device,
      context,
      attachments: wellFormedAttachments(decision.attachments).map((a) => a.path),
      ytmPlace: "Медиа → «Клипы»",
      readTool: `producer_clip_review_get ${json({ channelId: channel.channelId, clipId: decision.clipId })}`,
    });
  }
  return out;
}

// --- storyboards and renders -----------------------------------------------------------------------------------------------

function targetText(target: StoryboardCommentTarget): string {
  switch (target.kind) {
    case "storyboard":
      return "the whole storyboard";
    case "keyframe":
      return `keyframe ${target.keyframeId}${target.region ? ` (region x=${target.region.x} y=${target.region.y} r=${target.region.r})` : ""}`;
    case "segment":
      return `segment ${target.segmentId}`;
    case "prop":
      return `prop ${target.propId} on keyframe ${target.keyframeId}`;
  }
}

const excerpt = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

/**
 * §2: the owner's version decisions, the owner's comments and replies (`storyboard`) and the owner's verdicts on a final file
 * (`render`). The Operator's comments and replies, submissions and versions never.
 */
export function storyboardNoticesOf(channel: Channel, records: readonly StoryboardRecord[], sinceMs: number): ReviewDecisionNotice[] {
  const out: ReviewDecisionNotice[] = [];
  for (const record of records) {
    const name = latestVersion(record)?.title ?? null;
    const base = [...(name ? [{ label: "Storyboard", value: name }] : []), ...(record.video ? [{ label: "Video", value: record.video }] : [])];
    const common = {
      channelId: channel.channelId,
      channelName: channel.name,
      itemId: record.id,
      attachments: [] as string[],
      ytmPlace: `Медиа → «Раскадровка» → ${name ? `«${name}»` : record.id} (/media/storyboards/${record.id})`,
      readTool: `factory_storyboard_get ${json({ channelId: channel.channelId, storyboardId: record.id })}`,
    };
    for (const d of Object.values(record.decisions)) {
      if (d.by !== "owner" || !after(d.at, sinceMs)) continue;
      out.push({ ...common, kind: "storyboard", decisionId: d.id, status: d.kind, comment: d.note, decidedAt: d.at, decidedOn: d.device, context: [...base, { label: "Version", value: String(d.versionNumber) }] });
    }
    for (const c of Object.values(record.comments)) {
      if (c.author === "owner" && after(c.createdAt, sinceMs)) {
        out.push({
          ...common,
          kind: "storyboard",
          decisionId: c.id,
          status: "commented",
          comment: c.text,
          decidedAt: c.createdAt,
          decidedOn: c.device,
          context: [...base, { label: "Version", value: String(c.versionNumber) }, { label: "On", value: targetText(c.target) }],
        });
      }
      for (const r of Object.values(c.replies ?? {})) {
        if (r.author !== "owner" || !after(r.createdAt, sinceMs)) continue;
        out.push({
          ...common,
          kind: "storyboard",
          decisionId: r.id,
          status: "replied",
          comment: r.text,
          decidedAt: r.createdAt,
          decidedOn: r.device,
          context: [...base, { label: "Version", value: String(c.versionNumber) }, { label: "Reply to", value: `${c.author}'s comment ${c.id}: ${excerpt(c.text)}` }],
        });
      }
    }
    for (const d of Object.values(record.renderDecisions ?? {})) {
      if (d.by !== "owner" || !after(d.at, sinceMs)) continue;
      const render = record.renders?.[d.renderId];
      out.push({
        ...common,
        kind: "render",
        decisionId: d.id,
        status: d.kind,
        comment: d.note,
        decidedAt: d.at,
        decidedOn: d.device,
        context: [...base, { label: "Render", value: d.renderId }, ...(render ? [{ label: "Version", value: String(render.versionNumber) }, { label: "File (in 99 Data Exchange)", value: render.file }] : [])],
        ytmPlace: `Медиа → «Раскадровка» → ${name ? `«${name}»` : record.id} → «Ролик целиком» (/media/storyboards/${record.id})`,
      });
    }
  }
  return out;
}

// --- weekly-plan slots -----------------------------------------------------------------------------------------------------

/** §2: every slot decision (approved / revoked / vetoed / restored) -- all are the owner's. */
export function slotNoticesOf(channel: Channel, snapshot: PublishingPlansSnapshot, sinceMs: number): ReviewDecisionNotice[] {
  const out: ReviewDecisionNotice[] = [];
  for (const d of Object.values(snapshot.decisions)) {
    if (d.by !== "owner" || !after(d.at, sinceMs)) continue;
    out.push({
      kind: "slot",
      channelId: channel.channelId,
      channelName: channel.name,
      itemId: `${d.weekStart}_${d.slotId}`,
      decisionId: d.id,
      status: d.kind,
      comment: null,
      decidedAt: d.at,
      decidedOn: d.device,
      context: [
        { label: "Week", value: d.weekStart },
        { label: "Slot", value: d.slotId },
        { label: "Publish at", value: `${d.snapshot.publishAt} (${d.snapshot.timeZone})` },
        ...(d.snapshot.note ? [{ label: "Slot note", value: d.snapshot.note }] : []),
        ...(d.package ? [{ label: "Package", value: `${d.package.video}${d.package.videoId ? ` (${d.package.videoId})` : ""}` }] : []),
        ...(d.replacedBy ? [{ label: "Vetoed because", value: `the owner approved slot ${d.replacedBy}, which replaces this one` }] : []),
      ],
      attachments: [],
      ytmPlace: "Контент → «План недели»",
      readTool: `factory_publishing_plan_get ${json({ channelId: channel.channelId, weekStart: d.weekStart })}`,
    });
  }
  return out;
}

// --- generation plans ------------------------------------------------------------------------------------------------------

const marksOf = (markers: ReadonlyArray<{ start: number; end: number | null; note: string | null; region?: { x: number; y: number; r: number } }>): PlanEntryMark[] =>
  markers.map((m) => ({ start: m.start, end: m.end, note: m.note, region: m.region ?? null }));

const planPlace = (planId: string, title: string | null) => `Медиа → план ${title ? `«${title}»` : planId} → проверка (/media/plans/${planId}/review)`;

/** §2: this computer's plan -- every owner verdict of the history (either computer's), the active picks and «ни один не подходит». */
export function planFeedOfActivity(activity: PlanReviewActivity, channelName: string | null): PlanReviewFeed {
  const entries: PlanReviewEntry[] = [];
  for (const h of activity.history) {
    entries.push({
      entryId: planVerdictEntryId(activity.planId, h.itemKey, h.attemptRef, h.at, h.result),
      type: "verdict",
      itemKey: h.itemKey,
      attemptRef: h.attemptRef,
      groupId: activity.groupOf[h.itemKey] ?? null,
      at: h.at,
      device: h.device,
      result: h.result,
      rating: h.rating,
      reasons: h.reasons,
      marks: marksOf(h.markers),
      note: h.kept ? `(re-check answered: verdict kept) ${h.note ?? ""}`.trim() : h.note,
    });
  }
  for (const p of activity.picks) {
    const none = p.kind === "none_fits";
    entries.push({
      entryId: none ? planNoneFitsEntryId(activity.planId, p.itemKey, p.at) : planPickEntryId(activity.planId, p.itemKey, p.attemptRef ?? "", p.at),
      type: none ? "none_fits" : "pick",
      itemKey: p.itemKey,
      attemptRef: none ? null : p.attemptRef,
      groupId: activity.groupOf[p.itemKey] ?? null,
      at: p.at,
      device: p.device,
      result: null,
      rating: null,
      reasons: [],
      marks: [],
      note: p.note,
    });
  }
  return {
    planId: activity.planId,
    channelId: activity.channelId,
    channelName,
    title: activity.title,
    video: activity.video,
    entries,
    waveFinishedAt: activity.waveFinishedAt,
    ytmPlace: planPlace(activity.planId, activity.title),
    readTool: `factory_plan_get ${json({ planId: activity.planId })}`,
  };
}

/**
 * §2, §8: the other computer's plans as its report shows them (its review entries' verdict history, its active picks and «ни один не
 * подходит», its last events) -- how the owner's verdicts there reach this computer's writer.
 */
export function planFeedOfPeerPlan(plan: SharedPlan, channelName: string | null, sinceMs: number): PlanReviewFeed {
  const groupOf = new Map(plan.items.map((i) => [i.itemKey, i.groupId]));
  const entries: PlanReviewEntry[] = [];
  for (const entry of plan.review) {
    for (const h of entry.history ?? []) {
      if (!after(h.at, sinceMs)) continue;
      // The current verdict row carries the reasons and marks of the newest verdict (the history keeps rating and note only).
      const row = entry.verdict && entry.verdict.reportedBy === "owner" && Date.parse(entry.verdict.at) === Date.parse(h.at) && entry.verdict.result === h.result ? entry.verdict : null;
      entries.push({
        entryId: planVerdictEntryId(plan.planId, entry.itemKey, entry.attemptRef, h.at, h.result),
        type: "verdict",
        itemKey: entry.itemKey,
        attemptRef: entry.attemptRef,
        groupId: entry.groupId,
        at: h.at,
        device: h.device,
        result: h.result,
        rating: h.rating,
        reasons: row?.reasons ?? [],
        marks: row ? marksOf(row.markers) : [],
        note: h.kept ? `(re-check answered: verdict kept) ${h.note ?? ""}`.trim() : h.note,
      });
    }
  }
  for (const p of plan.picks ?? []) {
    if (!after(p.at, sinceMs)) continue;
    entries.push({ entryId: planPickEntryId(plan.planId, p.itemKey, p.attemptRef, p.at), type: "pick", itemKey: p.itemKey, attemptRef: p.attemptRef, groupId: groupOf.get(p.itemKey) ?? null, at: p.at, device: p.device, result: null, rating: null, reasons: [], marks: [], note: p.note });
  }
  for (const n of plan.noneFits ?? []) {
    if (!after(n.at, sinceMs)) continue;
    entries.push({ entryId: planNoneFitsEntryId(plan.planId, n.itemKey, n.at), type: "none_fits", itemKey: n.itemKey, attemptRef: null, groupId: groupOf.get(n.itemKey) ?? null, at: n.at, device: n.device, result: null, rating: null, reasons: [], marks: [], note: n.note });
  }
  return {
    planId: plan.planId,
    channelId: plan.channelId,
    channelName,
    title: plan.title,
    video: null,
    entries,
    waveFinishedAt: plan.events.filter((e) => e.kind === "group_reviewed").map((e) => e.at),
    ytmPlace: planPlace(plan.planId, plan.title),
    readTool: `factory_plan_get ${json({ planId: plan.planId })}`,
  };
}

/**
 * Review N1: the verdicts and pick actions this computer gave on the other computer's plans, before that computer's report shows them
 * applied. Their entry ids are the ones `planFeedOfPeerPlan` gives later (times in whole seconds), so one verdict is written once. A
 * plan no report of the other computer names (channel unknown) waits until one does.
 */
export function planFeedsOfOutgoing(
  actions: { verdicts: readonly SharedVerdict[]; picks: readonly SharedPickAction[] },
  plans: ReadonlyMap<string, { channelId: string; title: string; groupOf: Map<string, string | null> }>,
  names: ReadonlyMap<string, string | null>,
  sinceMs: number
): PlanReviewFeed[] {
  const feeds = new Map<string, PlanReviewFeed>();
  const feedOf = (planId: string) => {
    const plan = plans.get(planId);
    if (!plan) return null;
    let feed = feeds.get(planId);
    if (!feed) {
      feed = { planId, channelId: plan.channelId, channelName: names.get(plan.channelId) ?? null, title: plan.title, video: null, entries: [], waveFinishedAt: [], ytmPlace: planPlace(planId, plan.title), readTool: `factory_plan_get ${json({ planId })}` };
      feeds.set(planId, feed);
    }
    return { feed, groupOf: plan.groupOf };
  };
  for (const v of actions.verdicts) {
    const target = after(v.at, sinceMs) ? feedOf(v.planId) : null;
    if (!target) continue;
    target.feed.entries.push({
      entryId: planVerdictEntryId(v.planId, v.itemKey, v.attemptRef, v.at, v.result),
      type: "verdict",
      itemKey: v.itemKey,
      attemptRef: v.attemptRef,
      groupId: target.groupOf.get(v.itemKey) ?? null,
      at: v.at,
      device: null,
      result: v.result,
      rating: v.rating,
      reasons: v.reasons,
      marks: marksOf(v.markers),
      note: v.kept ? `(re-check answered: verdict kept) ${v.note ?? ""}`.trim() : v.note,
    });
  }
  for (const p of actions.picks) {
    if (p.action !== "pick" && p.action !== "none_fits") continue;
    const target = after(p.at, sinceMs) ? feedOf(p.planId) : null;
    if (!target) continue;
    const none = p.action === "none_fits";
    target.feed.entries.push({
      entryId: none ? planNoneFitsEntryId(p.planId, p.itemKey, p.at) : planPickEntryId(p.planId, p.itemKey, p.attemptRef ?? "", p.at),
      type: none ? "none_fits" : "pick",
      itemKey: p.itemKey,
      attemptRef: none ? null : p.attemptRef,
      groupId: target.groupOf.get(p.itemKey) ?? null,
      at: p.at,
      device: null,
      result: null,
      rating: null,
      reasons: [],
      marks: [],
      note: p.note,
    });
  }
  return [...feeds.values()].filter((f) => f.entries.length > 0);
}

// --- production wiring -----------------------------------------------------------------------------------------------------

/** Review N7: the connected channels once per run (the sources run one after another within seconds). */
let channelsMemo: { at: number; value: Promise<Channel[]> } | null = null;
function connectedChannels(): Promise<Channel[]> {
  if (!channelsMemo || Date.now() - channelsMemo.at > 10_000) {
    const value = createChannelConnectionsCore()
      .listConnectedChannels()
      .then((list) => list.map((c) => ({ channelId: c.channelId, name: c.title || null })));
    channelsMemo = { at: Date.now(), value };
    value.catch(() => {
      channelsMemo = null;
    });
  }
  return channelsMemo.value;
}

/**
 * Review N7: a channel's document is read again only when its file changed (size and mtime) -- every 30 s, most documents did not.
 * Keyed by the document's file; a file that cannot be stat'ed is always read.
 */
const documentMemo = new Map<string, { signature: string; value: unknown }>();
async function readDocument<T>(dir: string, channelId: string, read: () => Promise<T>): Promise<T> {
  const file = path.join(dir, `${channelId.replace(/[^a-zA-Z0-9_-]/g, "_")}.automerge`);
  const info = await stat(file).catch(() => null);
  const signature = info ? `${info.size}:${info.mtimeMs}` : null;
  const cached = documentMemo.get(file);
  if (signature !== null && cached && cached.signature === signature) return cached.value as T;
  const value = await read();
  if (signature !== null) documentMemo.set(file, { signature, value });
  return value;
}

async function workspaceRoot(): Promise<string | null> {
  const entries = await createChannelWorkspacesCore().listWorkspaces();
  return workspaceRootOf(entries.map((e) => e.path).filter((p): p is string => typeof p === "string" && p.length > 0));
}

/** Review N2: one channel's broken document is reported and never stops the other channels. */
async function perChannel<T>(read: (channel: Channel) => Promise<T[]>): Promise<{ items: T[]; errors: string[] }> {
  const items: T[] = [];
  const errors: string[] = [];
  for (const channel of await connectedChannels()) {
    try {
      items.push(...(await read(channel)));
    } catch (error) {
      errors.push(`${channel.channelId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { items, errors };
}

function createProductionReviewNotify(): ReviewNotify {
  const logger = createDefaultLogger();
  const paths = getProductionAppPaths();
  const writeOnce = createInboxWriter();
  return createReviewNotify({
    decisionSources: [
      {
        name: "clips",
        list: (since) => perChannel(async (ch) => clipNoticesOf(ch, await readDocument(paths.clipReviewsDocDir, ch.channelId, () => createClipReviewsCoreForProduction().read(ch.channelId)), Date.parse(since))),
      },
      {
        name: "storyboards",
        list: (since) => perChannel(async (ch) => storyboardNoticesOf(ch, await readDocument(paths.storyboardsDocDir, ch.channelId, () => createStoryboardsCoreForProduction().read(ch.channelId)), Date.parse(since))),
      },
      {
        name: "weekly plans",
        list: (since) => perChannel(async (ch) => slotNoticesOf(ch, await readDocument(paths.publishingPlansDocDir, ch.channelId, () => createPublishingPlansCoreForProduction().read(ch.channelId)), Date.parse(since))),
      },
    ],
    planSources: [
      {
        name: "plans (this computer)",
        async list(since) {
          const names = new Map((await connectedChannels()).map((c) => [c.channelId, c.name]));
          return (await listPlanReviewActivity(since)).map((a) => planFeedOfActivity(a, names.get(a.channelId) ?? null));
        },
      },
      {
        name: "plans (other computer)",
        async list(since) {
          const names = new Map((await connectedChannels()).map((c) => [c.channelId, c.name]));
          const reports = await createGenerationPlansShareCoreForProduction().listPeerReports();
          return reports.flatMap((r) => r.plans.map((p) => planFeedOfPeerPlan(p, names.get(p.channelId) ?? null, Date.parse(since)))).filter((f) => f.entries.length > 0);
        },
      },
      {
        name: "plans (sent from this computer)",
        async list(since) {
          const names = new Map((await connectedChannels()).map((c) => [c.channelId, c.name]));
          const plans = new Map<string, { channelId: string; title: string; groupOf: Map<string, string | null> }>();
          for (const report of await createGenerationPlansShareCoreForProduction().listPeerReports()) {
            for (const p of report.plans) if (!plans.has(p.planId)) plans.set(p.planId, { channelId: p.channelId, title: p.title, groupOf: new Map(p.items.map((i) => [i.itemKey, i.groupId])) });
          }
          return planFeedsOfOutgoing(await listOutgoingPlanReviewActions(since), plans, names, Date.parse(since));
        },
      },
    ],
    settings: { read: () => getReviewNotifySettingsJson(), write: (value) => setReviewNotifySettingsJson(value) },
    state: { read: () => getReviewNotifyStateJson(), write: (value) => setReviewNotifyStateJson(value) },
    ledger: {
      has: (keys) => listReviewNotifyLedgerKeys(keys),
      record: (entries, at) => insertReviewNotifyLedgerEntries(entries, at),
      prune: async (before) => void (await deleteReviewNotifyLedgerBefore(before)),
    },
    inbox: {
      async defaultPath() {
        const root = await workspaceRoot();
        return root ? defaultInboxOf(root) : null;
      },
      async producerFolderExists() {
        const root = await workspaceRoot();
        return root ? isDirectory(producerFolderOf(root)) : false;
      },
      isDirectory: (absolutePath) => isDirectory(absolutePath),
      writeOnce: (dir, name, content) => writeOnce(dir, name, content),
      sweepTemp: (dir, before) => sweepInboxTemp(dir, before),
    },
    platform: () => process.platform,
    now: () => new Date(),
    log: (event, context) => logger.error({ event, context }),
  });
}

const CORE_KEY = Symbol.for("youtube-operations-manager.review-notify");

/** One instance per process (the Settings routes and the server's loop are separate bundles; its run lock lives in it). */
export function getReviewNotifyCore(): ReviewNotify {
  const holder = globalThis as unknown as Record<symbol, ReviewNotify | undefined>;
  return (holder[CORE_KEY] ??= createProductionReviewNotify());
}

