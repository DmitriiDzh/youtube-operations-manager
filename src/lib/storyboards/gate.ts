import type { StoryboardGateSetting } from "@/lib/sync-gateway";
import { DomainError, type StoryboardStorePort } from "./contracts";
import { approvedVersion } from "./model";

// BL-184 stage 2 (FO-REQ-0024 §4 B4; owner 1183; ADR 0038 §4): no first/last-frame video from two different images without an
// approved storyboard. The video modules (Gemini, the GPU media jobs, plan runs through them) ask this before anything is sent,
// uploaded or charged; they get it injected and know nothing else about storyboards.

/** What a video job names: the storyboard and the segment it renders (both or neither). */
export type StoryboardLink = { storyboardId: string; segmentId: string };
/** What a job records once the gate let it through with a link: the approved version it was made from. */
export type StoryboardJobLink = { storyboardId: string; versionNumber: number; segmentId: string };

export type FramePairCheck = {
  channelId: string;
  /** The sha256 of the job's first and last frame, as the video module read them (null = no such frame). */
  firstFrameSha256: string | null;
  lastFrameSha256: string | null;
  link: StoryboardLink | null;
};

export type StoryboardNotApprovedReason = "no_link" | "not_found" | "not_approved" | "segment_not_found" | "frames_mismatch";

export type StoryboardGate = {
  /** Lets the job through (with the link it may record) or throws `storyboard_not_approved`; any other failure propagates. */
  check(input: FramePairCheck): Promise<StoryboardJobLink | null>;
};

/** The setting when the owner never changed it: on (owner 1183). */
export const DEFAULT_REQUIRE_APPROVED = true;

export function requireApprovedOf(setting: StoryboardGateSetting | null): boolean {
  return setting ? setting.requireApproved : DEFAULT_REQUIRE_APPROVED;
}

const MESSAGES: Record<StoryboardNotApprovedReason, string> = {
  no_link:
    "A video from two different first and last frames needs an approved storyboard: name its storyboardId and segmentId (factory_storyboard_list, state approved), or ask the owner to approve one.",
  not_found: "No storyboard with this id in this channel.",
  not_approved: "This storyboard's latest version is not approved: the owner approves it in Media → Раскадровка (a new version needs a new approval).",
  segment_not_found: "The approved version has no segment with this id.",
  frames_mismatch: "The job's first and last frames are not exactly the segment's two keyframes (same files by sha256, first = from, last = to).",
};

export function createStoryboardGate(store: Pick<StoryboardStorePort, "read" | "readGate">): StoryboardGate {
  return {
    async check(input) {
      const refuse = (reason: StoryboardNotApprovedReason, extra: Record<string, unknown> = {}) =>
        new DomainError({ code: "storyboard_not_approved", message: MESSAGES[reason], details: { reason, channelId: input.channelId, ...(input.link ?? {}), ...extra } });
      const twoImages = !!input.firstFrameSha256 && !!input.lastFrameSha256 && input.firstFrameSha256 !== input.lastFrameSha256;

      // A job that names a storyboard segment is always checked against it (B4, first rule), whatever the setting says.
      if (input.link) {
        const record = (await store.read(input.channelId)).find((r) => r.id === input.link!.storyboardId);
        if (!record) throw refuse("not_found");
        const version = approvedVersion(record);
        if (!version) throw refuse("not_approved");
        const segment = version.segments.find((s) => s.id === input.link!.segmentId);
        if (!segment) throw refuse("segment_not_found", { versionNumber: version.number });
        const from = version.keyframes.find((k) => k.id === segment.fromKeyframeId);
        const to = version.keyframes.find((k) => k.id === segment.toKeyframeId);
        if (!from || !to || input.firstFrameSha256 !== from.sha256 || input.lastFrameSha256 !== to.sha256) {
          throw refuse("frames_mismatch", { versionNumber: version.number, expected: { first: from?.id ?? null, last: to?.id ?? null } });
        }
        return { storyboardId: record.id, versionNumber: version.number, segmentId: segment.id };
      }

      // Without a link: only two different images are gated, and only while the channel's setting is on (B4, owner 1183).
      if (!twoImages) return null;
      if (!requireApprovedOf(await store.readGate(input.channelId))) return null;
      throw refuse("no_link");
    },
  };
}
