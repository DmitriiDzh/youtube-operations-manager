import { createHash } from "node:crypto";
import { parseWithSchema } from "@/lib/shared-domain";
import type {
  StoryboardComment,
  StoryboardCommentTarget,
  StoryboardDecision,
  StoryboardKeyframe,
  StoryboardPick,
  StoryboardProp,
  StoryboardRecord,
  StoryboardRender,
  StoryboardRenderDecision,
  StoryboardSegment,
  StoryboardVersion,
} from "@/lib/sync-gateway";
import {
  DomainError,
  FROM_YTM_PREFIX,
  SENT_TO_YTM_PREFIX,
  STORYBOARD_IMAGE_EXTENSIONS,
  STORYBOARD_RENDER_EXTENSIONS,
  type IsTake,
  type KeyframeFileStatus,
  type StoryboardActor,
  type StoryboardsPorts,
} from "./contracts";
import { requireApprovedOf } from "./gate";
import { approvedVersion, diffVersions, latestVersion, latestVersionNumber, storyboardState, type StoryboardState, type VersionDiff } from "./model";
import {
  attachRenderInputSchema,
  createStoryboardInputSchema,
  gateSettingInputSchema,
  listStoryboardsInputSchema,
  operatorReplyInputSchema,
  ownerCommentInputSchema,
  ownerCommentStateInputSchema,
  ownerDecisionInputSchema,
  ownerPickInputSchema,
  ownerRenderDecisionInputSchema,
  ownerReplyInputSchema,
  ownerVideoInputSchema,
  storyboardRefSchema,
  updateStoryboardInputSchema,
  type StoryboardContentInput,
} from "./schemas";

// BL-184 (FO-REQ-0024 §4 B1-B3, C; STORYBOARD_PLAN.md §2-§3 stage 1): what the Operator and the owner may do with a storyboard.
// The Operator (Factory API) writes versions, submits them and answers comments; the owner (Web UI) comments, requests changes
// and approves. Every rule that is not just "the shape of the input" lives here.

export type StoryboardSummary = {
  storyboardId: string;
  channelId: string;
  title: string;
  planId: string | null;
  /** BL-194: the channel's video number this storyboard is for, or null. */
  video: string | null;
  state: StoryboardState;
  latestVersion: number;
  keyframes: number;
  segments: number;
  loop: boolean;
  createdAt: string;
  createdBy: StoryboardRecord["createdBy"];
  submittedAt: string | null;
  lastDecision: Pick<StoryboardDecision, "kind" | "versionNumber" | "at" | "by" | "device" | "note"> | null;
  openComments: number;
  /** The newest thing that happened to it: a version, a submission, a decision, a comment or a reply. */
  updatedAt: string;
};

export type StoryboardDetail = StoryboardSummary & {
  versions: StoryboardVersion[];
  submissions: Array<{ versionNumber: number; at: string; contentHash: string }>;
  decisions: StoryboardDecision[];
  comments: Array<Omit<StoryboardComment, "replies"> & { replies: Array<StoryboardComment["replies"][string]> }>;
  /** BL-184 stage 3: the owner's take per segment, by version number then segment id. */
  picks: Record<string, Record<string, StoryboardPick>>;
  /** BL-189 (FO-REQ-0025 B): the Operator's attached final files, newest first, each with the owner's verdicts. */
  renders: RenderView[];
};

export type RenderState = "in_review" | "approved" | "changes_requested";
export type RenderView = Omit<StoryboardRender, "id"> & { renderId: string; state: RenderState; decisions: Array<Omit<StoryboardRenderDecision, "renderId">> };

/** A render's state is the owner's newest verdict on it (none yet: in review). */
export function renderStateOf(decisions: readonly Pick<StoryboardRenderDecision, "kind" | "at" | "id">[]): RenderState {
  const last = [...decisions].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id)).at(-1);
  return last ? last.kind : "in_review";
}

function rendersOf(record: StoryboardRecord): RenderView[] {
  const decisions = Object.values(record.renderDecisions ?? {});
  return Object.values(record.renders ?? {})
    .map(({ id, ...render }): RenderView => {
      const own = decisions.filter((d) => d.renderId === id).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
      return { renderId: id, ...render, state: renderStateOf(own), decisions: own.map((d) => ({ id: d.id, kind: d.kind, by: d.by, device: d.device, at: d.at, note: d.note })) };
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.renderId.localeCompare(a.renderId));
}

const byTime = <T>(at: (item: T) => string, id: (item: T) => string) => (a: T, b: T) => Date.parse(at(a)) - Date.parse(at(b)) || id(a).localeCompare(id(b));

function summaryOf(channelId: string, record: StoryboardRecord): StoryboardSummary {
  const latest = latestVersion(record)!;
  const latestNumber = latest.number;
  const decisions = Object.values(record.decisions).sort(byTime((d) => d.at, (d) => d.id));
  const last = decisions.filter((d) => d.versionNumber === latestNumber).at(-1) ?? null;
  const comments = Object.values(record.comments);
  const times = [
    record.createdAt,
    ...Object.values(record.versions).map((v) => v.createdAt),
    ...Object.values(record.submissions).map((s) => s.at),
    ...decisions.map((d) => d.at),
    ...comments.flatMap((c) => [c.createdAt, c.stateChangedAt ?? c.createdAt, ...Object.values(c.replies).map((r) => r.createdAt)]),
    ...Object.values(record.renders ?? {}).map((r) => r.createdAt),
    ...Object.values(record.renderDecisions ?? {}).map((d) => d.at),
  ];
  return {
    storyboardId: record.id,
    channelId,
    title: latest.title,
    planId: record.planId,
    video: record.video ?? null,
    state: storyboardState(record),
    latestVersion: latestNumber,
    keyframes: latest.keyframes.length,
    segments: latest.segments.length,
    loop: latest.loop,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    submittedAt: isSubmitted(record, latestNumber) ? record.submissions[String(latestNumber)].at : null,
    lastDecision: last ? { kind: last.kind, versionNumber: last.versionNumber, at: last.at, by: last.by, device: last.device, note: last.note } : null,
    openComments: comments.filter((c) => c.state === "open").length,
    updatedAt: times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
  };
}

function detailOf(channelId: string, record: StoryboardRecord): StoryboardDetail {
  return {
    ...summaryOf(channelId, record),
    versions: Object.values(record.versions).sort((a, b) => a.number - b.number),
    submissions: Object.entries(record.submissions)
      .map(([versionNumber, s]) => ({ versionNumber: Number(versionNumber), at: s.at, contentHash: s.contentHash }))
      .sort((a, b) => a.versionNumber - b.versionNumber),
    decisions: Object.values(record.decisions).sort(byTime((d) => d.at, (d) => d.id)),
    comments: Object.values(record.comments)
      .sort(byTime((c) => c.createdAt, (c) => c.id))
      .map((c) => ({ ...c, replies: Object.values(c.replies).sort(byTime((r) => r.createdAt, (r) => r.id)) })),
    picks: record.picks ?? {},
    renders: rendersOf(record),
  };
}

const invalid = (message: string, details: Record<string, unknown>) => new DomainError({ code: "validation_failed", message, details });

/** A keyframe `file` (relative to `99 Data Exchange/`) in the form the exchange resolver takes, or null when it is in neither folder. */
export function exchangeRelativePath(file: string): string | null {
  if (file.startsWith(SENT_TO_YTM_PREFIX) && file.length > SENT_TO_YTM_PREFIX.length) return file.slice(SENT_TO_YTM_PREFIX.length);
  if (file.startsWith(FROM_YTM_PREFIX) && file.length > FROM_YTM_PREFIX.length) return file;
  return null;
}

/**
 * The rules of a version's content that are not its shape (B1): unique ids; a parent is another keyframe of the version; the
 * segments are exactly the chain K0 -> K1 -> ... -> Kn (and Kn -> K0 when looped), one per pair; a prop cell names a keyframe.
 * Returns the segments in chain order.
 */
export function checkContent(content: StoryboardContentInput): StoryboardContentInput["segments"] {
  const unique = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw invalid(`Two ${kind} have the id ${id}`, { field: kind, id });
      seen.add(id);
    }
  };
  unique("keyframes", content.keyframes.map((k) => k.id));
  unique("segments", content.segments.map((s) => s.id));
  unique("props", content.props.map((p) => p.id));
  const keyframeIds = new Set(content.keyframes.map((k) => k.id));
  for (const keyframe of content.keyframes) {
    const parent = keyframe.parentKeyframeId;
    if (parent != null && (parent === keyframe.id || !keyframeIds.has(parent))) {
      throw invalid(`Keyframe ${keyframe.id}: parentKeyframeId ${parent} is not another keyframe of this storyboard`, { field: "keyframes", keyframeId: keyframe.id });
    }
  }
  const ids = content.keyframes.map((k) => k.id);
  const pairs = ids.slice(0, -1).map((from, i) => [from, ids[i + 1]] as const);
  if (content.loop) pairs.push([ids[ids.length - 1], ids[0]] as const);
  const ordered: StoryboardContentInput["segments"] = [];
  for (const [from, to] of pairs) {
    const matches = content.segments.filter((s) => s.fromKeyframeId === from && s.toKeyframeId === to);
    if (matches.length === 0) throw invalid(`No segment from ${from} to ${to}: every neighbouring pair of keyframes needs one${content.loop ? " (with loop: also the last back to the first)" : ""}`, { field: "segments", from, to });
    if (matches.length > 1) throw invalid(`More than one segment from ${from} to ${to}`, { field: "segments", from, to });
    ordered.push(matches[0]);
  }
  const extra = content.segments.find((s) => !ordered.includes(s));
  if (extra) {
    throw invalid(`Segment ${extra.id} (${extra.fromKeyframeId} -> ${extra.toKeyframeId}) does not join two neighbouring keyframes${content.loop ? "" : " (the last keyframe goes back to the first only with loop: true)"}`, { field: "segments", segmentId: extra.id });
  }
  for (const prop of content.props) {
    const stray = Object.keys(prop.cells).find((id) => !keyframeIds.has(id));
    if (stray) throw invalid(`Prop ${prop.id}: a cell names ${stray}, which is not a keyframe of this storyboard`, { field: "props", propId: prop.id, keyframeId: stray });
  }
  return ordered;
}

/** JSON with every object's keys sorted: a version read back from the synced document lists its keys in its own order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type VersionContent = Omit<StoryboardVersion, "number" | "createdAt" | "contentHash">;

/** The sha256 of a version's content (the title, loop, keyframes with their frozen sha256, segments, props and notes). */
export function contentHashOf(v: VersionContent): string {
  return createHash("sha256").update(canonical([v.title, v.loop, v.keyframes, v.segments, v.props, v.notes])).digest("hex");
}

/** Two versions hold the same content. */
function sameContent(a: VersionContent, b: StoryboardVersion): boolean {
  return contentHashOf(a) === contentHashOf(b);
}

/** The version was submitted as it is now (its submission names this content). */
function isSubmitted(record: StoryboardRecord, versionNumber: number): boolean {
  const version = record.versions[String(versionNumber)];
  return !!version && record.submissions[String(versionNumber)]?.contentHash === version.contentHash;
}

/** The comment's target exists in the version it is made on. */
function checkTarget(version: StoryboardVersion, target: StoryboardCommentTarget): void {
  const keyframe = (id: string) => version.keyframes.some((k) => k.id === id);
  const missing = (what: string, id: string) => invalid(`Version ${version.number} has no ${what} ${id}`, { field: "target", [`${what}Id`]: id });
  if (target.kind === "keyframe" && !keyframe(target.keyframeId)) throw missing("keyframe", target.keyframeId);
  if (target.kind === "segment" && !version.segments.some((s) => s.id === target.segmentId)) throw missing("segment", target.segmentId);
  if (target.kind === "prop") {
    if (!version.props.some((p) => p.id === target.propId)) throw missing("prop", target.propId);
    if (!keyframe(target.keyframeId)) throw missing("keyframe", target.keyframeId);
  }
}

export function createStoryboardsService(ports: StoryboardsPorts) {
  const stamp = () => ports.now().toISOString();
  const newId = (prefix: string) => `${prefix}_${ports.randomId()}`.slice(0, 40);

  async function assertChannel(channelId: string): Promise<string> {
    if (!(await ports.isChannelConnected(channelId))) {
      throw new DomainError({ code: "storyboard_channel_unavailable", message: "This channel is not connected on this computer", details: { channelId, reason: "not_connected" } });
    }
    const workspace = await ports.files.workspaceOf(channelId);
    if (!workspace) {
      throw new DomainError({ code: "storyboard_channel_unavailable", message: "This channel has no workspace folder on this computer (Settings → Channels)", details: { channelId, reason: "no_workspace" } });
    }
    return workspace;
  }

  async function findRecord(channelId: string, storyboardId: string): Promise<StoryboardRecord> {
    const record = (await ports.store.read(channelId)).find((r) => r.id === storyboardId);
    if (!record) throw new DomainError({ code: "storyboard_not_found", message: "No storyboard with this id in this channel", details: { channelId, storyboardId } });
    return record;
  }

  /** The version's content with every keyframe file found in the channel's exchange folders and its sha256 frozen (B1). */
  async function buildContent(channelId: string, workspace: string, content: StoryboardContentInput): Promise<VersionContent> {
    const segments = checkContent(content);
    const keyframes: StoryboardKeyframe[] = [];
    for (const keyframe of content.keyframes) {
      const relative = exchangeRelativePath(keyframe.file);
      if (!relative) {
        throw invalid(`Keyframe ${keyframe.id}: file must be a path relative to 99 Data Exchange that starts with "Sent to YTM/" or "From YTM/"`, { field: "keyframes", keyframeId: keyframe.id, file: keyframe.file });
      }
      const extension = keyframe.file.slice(keyframe.file.lastIndexOf(".")).toLowerCase();
      if (!keyframe.file.includes(".") || !STORYBOARD_IMAGE_EXTENSIONS.includes(extension)) {
        throw invalid(`Keyframe ${keyframe.id}: only ${STORYBOARD_IMAGE_EXTENSIONS.join(", ")} images can be keyframes`, { field: "keyframes", keyframeId: keyframe.id, file: keyframe.file });
      }
      let found: { path: string; bytes: number };
      try {
        found = await ports.files.resolve(workspace, relative);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new DomainError({ code: "storyboard_file_unavailable", message: `Keyframe ${keyframe.id}: ${reason}`, details: { channelId, keyframeId: keyframe.id, file: keyframe.file, reason } });
      }
      keyframes.push({
        id: keyframe.id,
        file: keyframe.file,
        sha256: await ports.files.sha256(found.path),
        bytes: found.bytes,
        caption: keyframe.caption ?? null,
        parentKeyframeId: keyframe.parentKeyframeId ?? null,
      });
    }
    return {
      title: content.title,
      loop: content.loop,
      keyframes,
      segments: segments.map(
        (s): StoryboardSegment => ({
          id: s.id,
          fromKeyframeId: s.fromKeyframeId,
          toKeyframeId: s.toKeyframeId,
          action: s.action,
          durationSeconds: s.durationSeconds,
          model: s.model ?? null,
          settings: s.settings ?? {},
          estimateUsd: s.estimateUsd ?? null,
        })
      ),
      props: content.props.map((p): StoryboardProp => ({ id: p.id, name: p.name, kind: p.kind, cells: { ...p.cells } })),
      notes: content.notes ?? null,
    };
  }

  async function buildVersion(channelId: string, workspace: string, input: StoryboardContentInput): Promise<Omit<StoryboardVersion, "number" | "createdAt">> {
    const content = await buildContent(channelId, workspace, input);
    return { ...content, contentHash: contentHashOf(content) };
  }

  /** The owner's actions name the version on their screen: it must still be the latest (another computer may have added one). */
  function assertLatest(record: StoryboardRecord, versionNumber: number): StoryboardVersion {
    const latest = latestVersionNumber(record);
    if (versionNumber !== latest) {
      throw new DomainError({
        code: "storyboard_version_not_latest",
        message: `Version ${versionNumber} is not the latest (v${latest}); reload the storyboard`,
        details: { storyboardId: record.id, versionNumber, latestVersion: latest },
      });
    }
    return record.versions[String(latest)];
  }

  function findComment(record: StoryboardRecord, commentId: string): StoryboardComment {
    const comment = record.comments[commentId];
    if (!comment) throw new DomainError({ code: "storyboard_comment_not_found", message: "No comment with this id in this storyboard", details: { storyboardId: record.id, commentId } });
    return comment;
  }

  async function reply(channelId: string, record: StoryboardRecord, commentId: string, author: StoryboardActor, text: string): Promise<string> {
    findComment(record, commentId);
    const id = newId("r");
    await ports.store.addReply(channelId, record.id, commentId, { id, author, device: await ports.deviceLabel(), text, createdAt: stamp() });
    return id;
  }

  /** BL-194: a video number the channel can link to now (video-projects decides), or a refusal. */
  async function attachableVideo(channelId: string, video: string): Promise<string> {
    if (!ports.videos) throw new DomainError({ code: "video_not_found", message: "Video numbers are not available on this server", details: { channelId, video } });
    return ports.videos.assertAttachable(channelId, video);
  }

  return {
    // ---- the Operator (Factory API) -------------------------------------------------------------------------------------

    /** `factory_storyboard_create`: a new storyboard with version 1 (a draft until submitted). */
    async create(input: unknown): Promise<{ storyboard: StoryboardDetail }> {
      const { channelId, storyboardId, planId, videoNumber, ...content } = parseWithSchema(createStoryboardInputSchema, input, "storyboard");
      return ports.withLock(async () => {
        const workspace = await assertChannel(channelId);
        const video = videoNumber ? await attachableVideo(channelId, videoNumber) : null;
        const built = await buildVersion(channelId, workspace, content);
        const id = storyboardId ?? newId("sb");
        const createdAt = stamp();
        await ports.store.create(channelId, { id, createdAt, createdBy: "operator", planId: planId ?? null, ...(video ? { video } : {}) }, { ...built, number: 1, createdAt });
        return { storyboard: detailOf(channelId, await findRecord(channelId, id)) };
      });
    },

    /** `factory_storyboard_update`: a content change (a file's bytes included) makes the next version; the same content changes nothing. */
    async update(input: unknown): Promise<{ storyboard: StoryboardDetail; changed: boolean; versionNumber: number }> {
      const { channelId, storyboardId, videoNumber, ...content } = parseWithSchema(updateStoryboardInputSchema, input, "storyboard");
      return ports.withLock(async () => {
        const workspace = await assertChannel(channelId);
        let record = await findRecord(channelId, storyboardId);
        // BL-194: the video link is not content -- it changes without a new version (absent: kept; null: removed).
        if (videoNumber !== undefined && videoNumber !== (record.video ?? null)) {
          await ports.store.setVideo(channelId, storyboardId, videoNumber ? await attachableVideo(channelId, videoNumber) : null);
          record = await findRecord(channelId, storyboardId);
        }
        const built = await buildVersion(channelId, workspace, content);
        const latest = latestVersion(record)!;
        if (sameContent(built, latest)) return { storyboard: detailOf(channelId, record), changed: false, versionNumber: latest.number };
        const versionNumber = await ports.store.addVersion(channelId, storyboardId, { ...built, createdAt: stamp() });
        return { storyboard: detailOf(channelId, await findRecord(channelId, storyboardId)), changed: true, versionNumber };
      });
    },

    /** `factory_storyboard_submit`: the latest version goes to the owner's review. Submitting it again changes nothing. */
    async submit(input: unknown): Promise<{ storyboard: StoryboardDetail; alreadySubmitted: boolean }> {
      const { channelId, storyboardId } = parseWithSchema(storyboardRefSchema, input, "storyboard");
      return ports.withLock(async () => {
        await assertChannel(channelId);
        const record = await findRecord(channelId, storyboardId);
        const latest = latestVersionNumber(record);
        if (isSubmitted(record, latest)) return { storyboard: detailOf(channelId, record), alreadySubmitted: true };
        await ports.store.submit(channelId, storyboardId, latest, stamp());
        return { storyboard: detailOf(channelId, await findRecord(channelId, storyboardId)), alreadySubmitted: false };
      });
    },

    /** `factory_storyboard_reply`: the Operator's answer in a comment's thread, and/or resolving (or reopening) it. */
    async operatorReply(input: unknown): Promise<{ storyboard: StoryboardDetail; replyId: string | null }> {
      const { channelId, storyboardId, commentId, text, resolve } = parseWithSchema(operatorReplyInputSchema, input, "reply");
      return ports.withLock(async () => {
        await assertChannel(channelId);
        const record = await findRecord(channelId, storyboardId);
        findComment(record, commentId);
        const replyId = text !== undefined ? await reply(channelId, record, commentId, "operator", text) : null;
        if (resolve !== undefined) await ports.store.setCommentState(channelId, storyboardId, commentId, resolve ? "resolved" : "open", "operator", stamp());
        return { storyboard: detailOf(channelId, await findRecord(channelId, storyboardId)), replyId };
      });
    },

    /** `factory_storyboard_get`. */
    async get(input: unknown): Promise<{ storyboard: StoryboardDetail }> {
      const { channelId, storyboardId } = parseWithSchema(storyboardRefSchema, input, "storyboard");
      return { storyboard: detailOf(channelId, await findRecord(channelId, storyboardId)) };
    },

    /**
     * BL-189 (FO-REQ-0025 B) `factory_storyboard_attach_render`: the Operator's final file of the APPROVED LATEST version, its sha256
     * frozen, with the take of each segment it uses -- each checked by `isTake` (a take of exactly that segment and version, on any
     * computer). Without `picks`, the owner's current picks of that version are recorded.
     */
    async attachRender(input: unknown, isTake: IsTake): Promise<{ storyboard: StoryboardDetail; renderId: string }> {
      const { channelId, storyboardId, versionNumber, file, picks, notes } = parseWithSchema(attachRenderInputSchema, input, "render");
      return ports.withLock(async () => {
        const workspace = await assertChannel(channelId);
        const record = await findRecord(channelId, storyboardId);
        const version = record.versions[String(versionNumber)];
        if (!version) throw new DomainError({ code: "storyboard_not_found", message: `No version ${versionNumber}`, details: { storyboardId, versionNumber } });
        const approved = approvedVersion(record);
        if (!approved || approved.number !== versionNumber) {
          throw new DomainError({
            code: "storyboard_not_approved",
            message: `Version ${versionNumber} is not the approved latest version: a final file is attached to the version the owner approved`,
            details: { reason: "not_approved", channelId, storyboardId, versionNumber, latestVersion: latestVersionNumber(record), state: storyboardState(record) },
          });
        }
        const relative = exchangeRelativePath(file);
        if (!relative) throw invalid(`file must be a path relative to 99 Data Exchange that starts with "Sent to YTM/" or "From YTM/"`, { field: "file", file });
        const extension = file.includes(".") ? file.slice(file.lastIndexOf(".")).toLowerCase() : "";
        if (!STORYBOARD_RENDER_EXTENSIONS.includes(extension)) throw invalid(`Only ${STORYBOARD_RENDER_EXTENSIONS.join(", ")} videos can be attached`, { field: "file", file });
        let found: { path: string; bytes: number };
        try {
          found = await ports.files.resolve(workspace, relative);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new DomainError({ code: "storyboard_file_unavailable", message: `The file: ${reason}`, details: { channelId, file, reason } });
        }
        const recorded: StoryboardRender["picks"] = {};
        const given = picks ?? Object.fromEntries(Object.entries(record.picks?.[String(versionNumber)] ?? {}).map(([segmentId, p]) => [segmentId, { source: p.source, jobId: p.jobId }]));
        for (const [segmentId, take] of Object.entries(given)) {
          if (!version.segments.some((s) => s.id === segmentId)) throw invalid(`Version ${versionNumber} has no segment ${segmentId}`, { field: "picks", segmentId });
          if (!(await isTake(take, versionNumber, segmentId))) throw invalid(`Job ${take.jobId} is not a take of segment ${segmentId} of version ${versionNumber}`, { field: "picks", segmentId, ...take });
          recorded[segmentId] = { source: take.source, jobId: take.jobId };
        }
        const id = newId("rn");
        await ports.store.addRender(channelId, storyboardId, {
          id,
          versionNumber,
          contentHash: version.contentHash,
          file,
          sha256: await ports.files.sha256(found.path),
          bytes: found.bytes,
          picks: recorded,
          notes: notes ?? null,
          createdAt: stamp(),
          device: await ports.deviceLabel(),
        });
        return { storyboard: detailOf(channelId, await findRecord(channelId, storyboardId)), renderId: id };
      });
    },

    /** `factory_storyboard_list`: the channel's storyboards, newest activity first, optionally in one state. */
    async list(input: unknown): Promise<{ storyboards: StoryboardSummary[] }> {
      const { channelId, state } = parseWithSchema(listStoryboardsInputSchema, input, "storyboard list");
      const all = (await ports.store.read(channelId)).map((record) => summaryOf(channelId, record));
      return { storyboards: all.filter((s) => !state || s.state === state).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) };
    },

    // ---- the owner (Web UI; the route has checked that the channel is the owner's active one) ------------------------------

    listForOwner: async (channelId: string): Promise<StoryboardSummary[]> =>
      (await ports.store.read(channelId)).map((record) => summaryOf(channelId, record)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),

    async getForOwner(channelId: string, storyboardId: string): Promise<StoryboardDetail> {
      return detailOf(channelId, await findRecord(channelId, storyboardId));
    },

    /** What changed in a version against the one before it (B3); null for version 1. */
    async versionDiff(channelId: string, storyboardId: string, versionNumber: number): Promise<VersionDiff | null> {
      const record = await findRecord(channelId, storyboardId);
      const version = record.versions[String(versionNumber)];
      if (!version) throw new DomainError({ code: "storyboard_not_found", message: `No version ${versionNumber}`, details: { storyboardId, versionNumber } });
      const previous = record.versions[String(versionNumber - 1)];
      return previous ? diffVersions(previous, version) : null;
    },

    /** This computer's copy of each keyframe of a version against its frozen sha256 (plan §2.3). */
    async keyframeFiles(channelId: string, storyboardId: string, versionNumber: number): Promise<Record<string, KeyframeFileStatus>> {
      const record = await findRecord(channelId, storyboardId);
      const version = record.versions[String(versionNumber)];
      if (!version) throw new DomainError({ code: "storyboard_not_found", message: `No version ${versionNumber}`, details: { storyboardId, versionNumber } });
      const workspace = await ports.files.workspaceOf(channelId);
      const statuses: Record<string, KeyframeFileStatus> = {};
      for (const keyframe of version.keyframes) {
        const found = workspace ? await locate(workspace, keyframe.file) : null;
        statuses[keyframe.id] = !found ? "missing" : (await ports.files.sha256(found.path)) === keyframe.sha256 ? "ok" : "differs";
      }
      return statuses;
    },

    /** The keyframe's file on this computer, to show (even when it differs: review is not blocked); null when it is not here. */
    async keyframeFile(channelId: string, storyboardId: string, versionNumber: number, keyframeId: string): Promise<{ path: string; bytes: number; file: string } | null> {
      const record = await findRecord(channelId, storyboardId);
      const keyframe = record.versions[String(versionNumber)]?.keyframes.find((k) => k.id === keyframeId);
      if (!keyframe) throw new DomainError({ code: "storyboard_not_found", message: "No such keyframe", details: { storyboardId, versionNumber, keyframeId } });
      const workspace = await ports.files.workspaceOf(channelId);
      const found = workspace ? await locate(workspace, keyframe.file) : null;
      return found ? { ...found, file: keyframe.file } : null;
    },

    /** BL-194 (ADR 0040): the owner's video picker -- links the storyboard to a video of its channel, or to none (null). */
    async ownerSetVideo(channelId: string, storyboardId: string, input: unknown): Promise<{ storyboard: StoryboardSummary }> {
      const { videoNumber } = parseWithSchema(ownerVideoInputSchema, input, "storyboard video");
      return ports.withLock(async () => {
        await assertChannel(channelId);
        const record = await findRecord(channelId, storyboardId);
        if (videoNumber !== (record.video ?? null)) await ports.store.setVideo(channelId, storyboardId, videoNumber ? await attachableVideo(channelId, videoNumber) : null);
        return { storyboard: summaryOf(channelId, await findRecord(channelId, storyboardId)) };
      });
    },

    async ownerComment(channelId: string, storyboardId: string, input: unknown): Promise<{ commentId: string }> {
      const { versionNumber, target, text } = parseWithSchema(ownerCommentInputSchema, input, "comment");
      return ports.withLock(async () => {
        const record = await findRecord(channelId, storyboardId);
        const normalizedTarget: StoryboardCommentTarget = target.kind === "keyframe" ? { kind: "keyframe", keyframeId: target.keyframeId, region: target.region ?? null } : target;
        checkTarget(assertLatest(record, versionNumber), normalizedTarget);
        const id = newId("c");
        await ports.store.addComment(channelId, storyboardId, {
          id,
          versionNumber,
          target: normalizedTarget,
          author: "owner",
          device: await ports.deviceLabel(),
          text,
          createdAt: stamp(),
          state: "open",
          stateChangedAt: null,
          stateChangedBy: null,
          replies: {},
        });
        return { commentId: id };
      });
    },

    async ownerReply(channelId: string, storyboardId: string, input: unknown): Promise<{ replyId: string }> {
      const { commentId, text } = parseWithSchema(ownerReplyInputSchema, input, "reply");
      return ports.withLock(async () => ({ replyId: await reply(channelId, await findRecord(channelId, storyboardId), commentId, "owner", text) }));
    },

    async ownerSetCommentState(channelId: string, storyboardId: string, input: unknown): Promise<void> {
      const { commentId, state } = parseWithSchema(ownerCommentStateInputSchema, input, "comment state");
      await ports.withLock(async () => {
        findComment(await findRecord(channelId, storyboardId), commentId);
        await ports.store.setCommentState(channelId, storyboardId, commentId, state, "owner", stamp());
      });
    },

    /**
     * B5: the owner picks one take for a segment of a version (or clears it). `isTake` (the route's: it knows the video modules) says
     * whether that job is a take of this storyboard's segment and version; anything else is refused.
     */
    async ownerPick(channelId: string, storyboardId: string, input: unknown, isTake: (take: { source: "media" | "gemini"; jobId: string }, versionNumber: number, segmentId: string) => Promise<boolean>): Promise<{ picks: Record<string, Record<string, StoryboardPick>> }> {
      const { versionNumber, segmentId, take } = parseWithSchema(ownerPickInputSchema, input, "pick");
      return ports.withLock(async () => {
        const record = await findRecord(channelId, storyboardId);
        const version = record.versions[String(versionNumber)];
        if (!version) throw new DomainError({ code: "storyboard_not_found", message: `No version ${versionNumber}`, details: { storyboardId, versionNumber } });
        if (!version.segments.some((s) => s.id === segmentId)) throw invalid(`Version ${versionNumber} has no segment ${segmentId}`, { field: "segmentId", segmentId });
        if (take && !(await isTake(take, versionNumber, segmentId))) {
          throw invalid(`Job ${take.jobId} is not a take of segment ${segmentId} of version ${versionNumber}`, { field: "take", ...take });
        }
        await ports.store.setPick(channelId, storyboardId, versionNumber, segmentId, take ? { ...take, device: await ports.deviceLabel(), at: stamp() } : null);
        return { picks: (await findRecord(channelId, storyboardId)).picks ?? {} };
      });
    },

    /** The channel's gate setting (B4): on unless the owner turned it off. */
    async gateSetting(channelId: string): Promise<{ requireApproved: boolean; changedAt: string | null; changedBy: string | null }> {
      const stored = await ports.store.readGate(channelId);
      return { requireApproved: requireApprovedOf(stored), changedAt: stored?.changedAt ?? null, changedBy: stored?.changedBy ?? null };
    },

    async setGateSetting(channelId: string, input: unknown): Promise<{ requireApproved: boolean; changedAt: string | null; changedBy: string | null }> {
      const { requireApproved } = parseWithSchema(gateSettingInputSchema, input, "storyboard setting");
      return ports.withLock(async () => {
        await ports.store.setGate(channelId, { requireApproved, changedAt: stamp(), changedBy: await ports.deviceLabel() });
        const stored = await ports.store.readGate(channelId);
        return { requireApproved: requireApprovedOf(stored), changedAt: stored?.changedAt ?? null, changedBy: stored?.changedBy ?? null };
      });
    },

    /** BL-189 (FO-REQ-0025 B): «Одобрить ролик» / «Запросить изменения» on an attached render. */
    async ownerRenderDecision(channelId: string, storyboardId: string, renderId: string, input: unknown): Promise<{ decisionId: string; state: RenderState }> {
      const { kind, note } = parseWithSchema(ownerRenderDecisionInputSchema, input, "render decision");
      return ports.withLock(async () => {
        const record = await findRecord(channelId, storyboardId);
        const render = record.renders?.[renderId];
        if (!render) throw new DomainError({ code: "storyboard_render_not_found", message: "No such final file in this storyboard", details: { storyboardId, renderId } });
        // Independent review (BL-189): a verdict counts only for the content the render was attached to (like a version decision's
        // contentHash) -- after two computers wrote the same version number, a render of the body that was not kept is not this one's.
        if (record.versions[String(render.versionNumber)]?.contentHash !== render.contentHash) {
          throw new DomainError({
            code: "storyboard_render_not_found",
            message: "This final file was attached to another content of that version (two computers wrote it at the same time)",
            details: { storyboardId, renderId, reason: "other_version_content", versionNumber: render.versionNumber },
          });
        }
        const id = newId("rd");
        await ports.store.addRenderDecision(channelId, storyboardId, { id, renderId, kind, by: "owner", device: await ports.deviceLabel(), at: stamp(), note: note ?? null });
        const view = rendersOf(await findRecord(channelId, storyboardId)).find((r) => r.renderId === renderId);
        return { decisionId: id, state: view?.state ?? kind };
      });
    },

    /** BL-189: this computer's copy of a render's file against its frozen sha256, and the file to play (null when not here). */
    async renderFile(channelId: string, storyboardId: string, renderId: string): Promise<{ status: KeyframeFileStatus; path: string | null; bytes: number | null; file: string }> {
      const record = await findRecord(channelId, storyboardId);
      const render = record.renders?.[renderId];
      if (!render) throw new DomainError({ code: "storyboard_render_not_found", message: "No such final file in this storyboard", details: { storyboardId, renderId } });
      const workspace = await ports.files.workspaceOf(channelId);
      const found = workspace ? await locate(workspace, render.file) : null;
      if (!found) return { status: "missing", path: null, bytes: null, file: render.file };
      return { status: (await ports.files.sha256(found.path)) === render.sha256 ? "ok" : "differs", path: found.path, bytes: found.bytes, file: render.file };
    },

    /** «Одобрить эту версию» / «Запросить изменения» (B2): on the latest version, once the Operator has submitted it. */
    async ownerDecide(channelId: string, storyboardId: string, input: unknown): Promise<{ decisionId: string; state: StoryboardState }> {
      const { kind, versionNumber, note } = parseWithSchema(ownerDecisionInputSchema, input, "decision");
      return ports.withLock(async () => {
        const record = await findRecord(channelId, storyboardId);
        const version = assertLatest(record, versionNumber);
        if (!isSubmitted(record, versionNumber)) {
          throw new DomainError({ code: "storyboard_not_submitted", message: `Version ${versionNumber} is still a draft: the Operator has not submitted it`, details: { storyboardId, versionNumber } });
        }
        const id = newId("d");
        await ports.store.addDecision(channelId, storyboardId, { id, kind, versionNumber, contentHash: version.contentHash, by: "owner", device: await ports.deviceLabel(), at: stamp(), note: note ?? null });
        return { decisionId: id, state: storyboardState(await findRecord(channelId, storyboardId)) };
      });
    },
  };

  async function locate(workspace: string, file: string): Promise<{ path: string; bytes: number } | null> {
    const relative = exchangeRelativePath(file);
    if (!relative) return null;
    return ports.files.resolve(workspace, relative).catch(() => null);
  }
}

export type StoryboardsService = ReturnType<typeof createStoryboardsService>;
