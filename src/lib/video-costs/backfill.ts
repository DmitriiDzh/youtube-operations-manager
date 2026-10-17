import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { VIDEO_NUMBER_PATTERN } from "@/lib/sync-gateway";
import { DomainError } from "./contracts";

// BL-194 stage 4 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 4, criterion 7, ADR 0041): older runs. Each computer goes over the
// jobs ITS database still holds (whatever has left every database cannot be recovered). A storyboard with no video whose render file
// is the video file of a `MMDD Vn` folder -- the same name and size, then the same sha256 -- is proposed for that video; the owner
// confirms each proposal or picks the video by hand, and only then is the storyboard linked (through the storyboards module, so the
// link syncs) and its unlinked runs here with it. Runs of a storyboard or plan that already has a video are linked on the owner's
// click too. Old RunPod shares are split by media-generation (estimated, sequential per pod) -- nothing to do here.

export type BackfillStoryboard = {
  id: string;
  title: string;
  video: string | null;
  /** Renders of any version: the file relative to `99 Data Exchange`, frozen sha256 and size. */
  renders: Array<{ file: string; sha256: string; bytes: number; versionNumber: number }>;
};

export type BackfillDeps = {
  isChannelConnected(channelId: string): Promise<boolean>;
  storyboards(channelId: string): Promise<BackfillStoryboard[]>;
  /** The channel's `MMDD Vn` folders and their files (name, size); throws when the workspace cannot be read. */
  videoFolders(channelId: string): Promise<Array<{ video: string; folder: string; files: Array<{ name: string; bytes: number }> }>>;
  /** sha256 of a workspace file (workspace-relative). */
  hashOf(channelId: string, relativePath: string): Promise<string>;
  /** This computer's unlinked jobs of the channel, per storyboard and per plan. */
  unlinkedRuns(channelId: string): Promise<Array<{ kind: "storyboard" | "plan"; id: string; runs: number }>>;
  plans(channelId: string, ids: string[]): Promise<Array<{ id: string; title: string; video: string | null }>>;
  /** The video-projects rule for every link (known, not cancelled, not in dispute). */
  assertAttachable(channelId: string, video: unknown): Promise<string>;
  /** The storyboards module's own owner action (absent: a storyboard cannot be confirmed here). */
  setStoryboardVideo?(channelId: string, storyboardId: string, video: string): Promise<void>;
  linkRuns(channelId: string, target: { storyboardId: string } | { planId: string }, video: string): Promise<number>;
  log?(line: string): void;
};

export type BackfillProposals = {
  channelId: string;
  workspace: "ok" | "unavailable";
  /** A storyboard and the video whose folder holds its render (same name, size and sha256). */
  matches: Array<{ storyboardId: string; title: string; video: string; folder: string; file: string; bytes: number; runs: number }>;
  /** Storyboards with no video that have unlinked runs here: the owner may pick their video by hand. */
  withoutVideo: Array<{ storyboardId: string; title: string; runs: number }>;
  /** Storyboards and plans that already have a video, with runs here not linked to it yet. */
  linkable: Array<{ kind: "storyboard" | "plan"; id: string; title: string; video: string; runs: number }>;
};

const channelId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const id = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const video = z.string().regex(VIDEO_NUMBER_PATTERN, "a video number such as V49");
const proposalsInput = z.object({ channelId }).strict();
const confirmInput = z.object({ channelId, storyboardId: id, video }).strict();
const linkInput = z.object({ channelId, kind: z.enum(["storyboard", "plan"]), id }).strict();

const unavailable = (cid: string, why: string) => new DomainError({ code: "video_costs_unavailable", message: `Older runs of ${cid}: ${why}`, details: { channelId: cid } });

export function createVideoCostsBackfill(deps: BackfillDeps) {
  async function requireConnected(cid: string) {
    if (!(await deps.isChannelConnected(cid))) throw unavailable(cid, "the channel is not connected on this computer.");
  }

  return {
    async proposals(raw: unknown): Promise<BackfillProposals> {
      const input = parseWithSchema(proposalsInput, raw, "older runs");
      await requireConnected(input.channelId);
      const [storyboards, unlinked] = await Promise.all([deps.storyboards(input.channelId), deps.unlinkedRuns(input.channelId)]);
      const runsOf = (kind: "storyboard" | "plan", key: string) => unlinked.find((u) => u.kind === kind && u.id === key)?.runs ?? 0;
      const matches: BackfillProposals["matches"] = [];
      let workspace: BackfillProposals["workspace"] = "ok";
      const pending = storyboards.filter((s) => !s.video && s.renders.length > 0);
      if (pending.length > 0) {
        try {
          const folders = await deps.videoFolders(input.channelId);
          for (const sb of pending) {
            const seen = new Set<string>();
            for (const render of sb.renders) {
              const name = render.file.slice(render.file.lastIndexOf("/") + 1);
              for (const folder of folders) {
                const file = folder.files.find((f) => f.name === name && f.bytes === render.bytes);
                if (!file || seen.has(folder.video)) continue;
                const relative = `${folder.folder}/${file.name}`;
                let same = false;
                try {
                  same = (await deps.hashOf(input.channelId, relative)) === render.sha256;
                } catch (error) {
                  deps.log?.(`[video-costs] ${relative} not hashed: ${error instanceof Error ? error.message : String(error)}`);
                }
                if (!same) continue;
                seen.add(folder.video);
                matches.push({ storyboardId: sb.id, title: sb.title, video: folder.video, folder: folder.folder, file: file.name, bytes: file.bytes, runs: runsOf("storyboard", sb.id) });
              }
            }
          }
        } catch (error) {
          workspace = "unavailable";
          deps.log?.(`[video-costs] the video folders of ${input.channelId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const byId = new Map(storyboards.map((s) => [s.id, s]));
      const planIds = unlinked.filter((u) => u.kind === "plan").map((u) => u.id);
      const plans = new Map((await deps.plans(input.channelId, planIds)).map((p) => [p.id, p]));
      const linkable: BackfillProposals["linkable"] = [];
      const withoutVideo: BackfillProposals["withoutVideo"] = [];
      for (const u of unlinked) {
        if (u.kind === "storyboard") {
          const sb = byId.get(u.id);
          if (!sb) continue;
          if (sb.video) linkable.push({ kind: "storyboard", id: sb.id, title: sb.title, video: sb.video, runs: u.runs });
          else withoutVideo.push({ storyboardId: sb.id, title: sb.title, runs: u.runs });
        } else {
          const plan = plans.get(u.id);
          if (plan?.video) linkable.push({ kind: "plan", id: plan.id, title: plan.title, video: plan.video, runs: u.runs });
        }
      }
      return { channelId: input.channelId, workspace, matches, withoutVideo, linkable };
    },

    /** The owner's confirmation of a proposal, or a video picked by hand: links the storyboard, then its unlinked runs here. */
    async confirmStoryboard(raw: unknown): Promise<{ storyboardId: string; video: string; linkedRuns: number }> {
      const input = parseWithSchema(confirmInput, raw, "storyboard video");
      await requireConnected(input.channelId);
      if (!deps.setStoryboardVideo) throw unavailable(input.channelId, "storyboards cannot be changed here now.");
      const sb = (await deps.storyboards(input.channelId)).find((s) => s.id === input.storyboardId);
      if (!sb) throw new DomainError({ code: "not_found", message: `No storyboard ${input.storyboardId} in ${input.channelId}.`, details: { storyboardId: input.storyboardId } });
      if (sb.video && sb.video !== input.video) {
        throw new DomainError({ code: "validation_failed", message: `${input.storyboardId} is already linked to ${sb.video}; change it on the storyboard itself.`, details: { storyboardId: input.storyboardId, video: sb.video } });
      }
      const linked = await deps.assertAttachable(input.channelId, input.video);
      if (!sb.video) await deps.setStoryboardVideo(input.channelId, input.storyboardId, linked);
      const linkedRuns = await deps.linkRuns(input.channelId, { storyboardId: input.storyboardId }, linked);
      return { storyboardId: input.storyboardId, video: linked, linkedRuns };
    },

    /** The owner's click: this computer's runs of a storyboard or plan that already has a video are linked to it. */
    async linkRuns(raw: unknown): Promise<{ video: string; linkedRuns: number }> {
      const input = parseWithSchema(linkInput, raw, "link runs");
      await requireConnected(input.channelId);
      const current =
        input.kind === "storyboard"
          ? ((await deps.storyboards(input.channelId)).find((s) => s.id === input.id)?.video ?? null)
          : ((await deps.plans(input.channelId, [input.id])).find((p) => p.id === input.id)?.video ?? null);
      if (!current) throw new DomainError({ code: "validation_failed", message: `${input.id} has no video yet: confirm or pick one first.`, details: { kind: input.kind, id: input.id } });
      const linked = await deps.assertAttachable(input.channelId, current);
      const linkedRuns = await deps.linkRuns(input.channelId, input.kind === "storyboard" ? { storyboardId: input.id } : { planId: input.id }, linked);
      return { video: linked, linkedRuns };
    },
  };
}

export type VideoCostsBackfill = ReturnType<typeof createVideoCostsBackfill>;
