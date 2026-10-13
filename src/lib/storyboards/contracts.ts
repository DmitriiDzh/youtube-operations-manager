import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { StoryboardsCore } from "@/lib/sync-gateway";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-184 (FO-REQ-0024, docs/roadmap/plans/STORYBOARD_PLAN.md, ADR 0038): storyboards -- keyframes, the segments between them and a
// prop table, reviewed and approved by the owner before any video is made from them. A feature module of its own (AGENTS.md §M):
// it depends on the storyboards sync family (its store), the workspace exchange (its keyframe files) and the channel lookups --
// never on `generation-plans`, `media-generation` or `gemini-media`.
// ---------------------------------------------------------------------------

/** Where a keyframe file may be, relative to the channel's `99 Data Exchange/` (DEV-RESP-0029). */
export const SENT_TO_YTM_PREFIX = "Sent to YTM/";
export const FROM_YTM_PREFIX = "From YTM/";
/** The `From YTM/<subdir>/<jobId>/` job folders a keyframe may be read from in place: Gemini's and the GPU media jobs'. */
export const STORYBOARD_JOB_OUTPUT_SUBDIRS: readonly string[] = ["gemini", "media"];

/** This computer's copy of a keyframe against the sha256 frozen in the version (plan §2.3): review is never blocked by it. */
export type KeyframeFileStatus = "ok" | "missing" | "differs";

export type StoryboardActor = "owner" | "operator";

/** The sync family's operations the module uses (one document per channel, merged between the computers). */
export type StoryboardStorePort = Pick<StoryboardsCore, "read" | "create" | "addVersion" | "submit" | "addDecision" | "addComment" | "addReply" | "setCommentState">;

export type StoryboardFilesPort = {
  /** The channel's workspace folder on this computer, or null when none is set. */
  workspaceOf(channelId: string): Promise<string | null>;
  /**
   * A file in the workspace's exchange folders, by the workspace-exchange rules (plain folders, the real file inside, a regular
   * file): `relativePath` is relative to `Sent to YTM/`, or `From YTM/<subdir>/<jobId>/...`. Throws an Error naming the reason.
   */
  resolve(workspace: string, relativePath: string): Promise<{ path: string; bytes: number }>;
  sha256(path: string): Promise<string>;
};

export type StoryboardsPorts = {
  store: StoryboardStorePort;
  files: StoryboardFilesPort;
  /** Whether the channel is connected on this computer. */
  isChannelConnected(channelId: string): Promise<boolean>;
  /** This computer's name for comments and decisions ("Mac", a host name), or null. */
  deviceLabel(): Promise<string | null>;
  now(): Date;
  /** A fresh random id part (letters, digits, '-'); the services prefix it. */
  randomId(): string;
  /** Write operations of one process run one at a time (read the latest version, then write the next one). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
};
