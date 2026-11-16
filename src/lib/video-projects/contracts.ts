import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { VideoReservationsReport } from "@/lib/sync-gateway";
import type { VideoFolder, VideoRegistryRow } from "@/lib/workspace-videos";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-194 stage 1 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2, ADR 0040): the channel's videos by number (`V49`). YT Manager gives the
// number when work on a video starts («Новый ролик», `factory_video_create`); the factory still makes the `MMDD Vn` folder and
// the date is set only at publishing. A shared module (AGENTS.md §M): the storyboards, the plans and both media modules link to a
// video through it; it depends on no feature module (`boundaries.test.ts`) -- a storyboard's or a plan's video reaches it through
// ports wired by the composition layer.
// ---------------------------------------------------------------------------

/** A video code: `V1`, `V49` or (BL-263) `S14` -- the series letter and a number without leading zeros (`src/lib/shared-video-code`). */
export { VIDEO_NUMBER_PATTERN } from "@/lib/sync-gateway";

/**
 * BL-263 (ADR 0071 §5): `recoded` -- a V code some computer reports cancelled with `replacedBy` an S code (`factory_release_recode`
 * moved the video to that S); `recodedTo` names it. A recoded V is never in dispute, names no YouTube video, takes no new link and
 * still counts toward the next V.
 */
export type VideoState = "in_work" | "packaged" | "published" | "cancelled" | "recoded";
export const VIDEO_STATES: readonly VideoState[] = ["in_work", "packaged", "published", "cancelled", "recoded"];

/** BL-243: what the synced copy says of the channel's videos (for `existsOnChannel` / `removedAt`). */
export type ChannelCopy = { listed: ReadonlyMap<string, string>; removed: ReadonlyMap<string, string>; checkedAt: string | null };

/** Where the app knows a number from. */
export type VideoSource = "reservation" | "folder" | "registry" | "upload";

/** A reservation of this computer, as stored. */
export type OwnReservation = {
  channelId: string;
  video: string;
  workingTitle: string | null;
  reservedAt: string;
  state: "in_work" | "cancelled";
  cancelledAt: string | null;
  replacedBy: string | null;
};

/** A reservation as the list shows it: whose it is. */
export type ReservationView = {
  deviceId: string;
  hostName: string | null;
  thisComputer: boolean;
  reservedAt: string;
  workingTitle: string | null;
  state: "in_work" | "cancelled";
  replacedBy: string | null;
};

/**
 * Two computers reserved the same number (within the sync delay, or while one was offline). The earlier reservation keeps it;
 * equal times go to the lower device id. Nothing is renumbered silently: the losing computer is offered `suggestedVideo`.
 */
export type VideoConflict = {
  /** The reservations in dispute, the winner first. */
  reservations: ReservationView[];
  winnerDeviceId: string;
  /** This computer holds one of the disputed reservations. */
  thisComputerInvolved: boolean;
  /** This computer's reservation is the one that loses. */
  thisComputerLoses: boolean;
  /** The next free number, offered to the losing computer (null on the others, and always null for an S code: BL-263). */
  suggestedVideo: string | null;
};

export type VideoProject = {
  channelId: string;
  video: string;
  /** The number of `video` (49 for V49, 14 for S14), for sorting. */
  number: number;
  /** BL-263: the series of `video` -- `V` (YTM gives the next one) or `S` (a Short; the factory's piece number). */
  series: "V" | "S";
  /** BL-263: the S code a recoded V became (state `recoded`), else null. */
  recodedTo: string | null;
  workingTitle: string | null;
  state: VideoState;
  sources: VideoSource[];
  /** The `MMDD Vn` folder (workspace-relative), once the factory made it. */
  folder: string | null;
  /** The (winning) reservation: when, and on which computer; null for a video known only from the workspace or uploads. */
  createdAt: string | null;
  deviceId: string | null;
  hostName: string | null;
  thisComputer: boolean;
  conflict: VideoConflict | null;
  /**
   * BL-221: the YouTube video this number became -- from the folder's `Vn_youtube.json`, else this computer's upload, else
   * `video_registry.csv`; null while none of them names one.
   */
  youtubeVideoId: string | null;
  /** BL-221: the folder holds the release video file (`Vn <name>.mp4`/`.mov`/`.m4v`). */
  hasVideoFile: boolean;
  /** BL-221: an upload of this number on this computer is queued or running (not failed/cancelled) -- never linked by hand then. */
  uploading: boolean;
  /**
   * BL-243 (ADR 0063): whether `youtubeVideoId` is still on the channel, by the calendar's rule (`existsOnChannelOf`): false --
   * a completed owner sync found it removed on YouTube (deleted; `state` still says how far the number got here); true -- in the
   * synced copy as of a completed removed check; null -- unknown (no video id, not in the copy, or no check yet).
   */
  existsOnChannel: boolean | null;
  /** BL-243: when the sync found `youtubeVideoId` removed (ISO), else null. */
  removedAt: string | null;
};

/** BL-263: an unfinished recode journal of the channel (`src/lib/release-recode-journals`). */
export type PendingRecode = { journal: string; video: string; newCode: string; startedAt: string | null; done: string[] };

/** BL-221: a synced video of the channel the owner may link a number to (a local read; never YouTube). */
export type LinkCandidate = {
  videoId: string;
  title: string;
  publishedAt: string;
  publishAt: string | null;
  privacyStatus: string;
  durationSeconds: number | null;
  liveBroadcastContent: string | null;
  thumbnailUrl: string | null;
};

/** BL-221: the video a folder's `Vn_youtube.json` names. */
export type UploadRecordLink = { video: string; videoId: string };

export type WorkspaceVideos =
  | { status: "ok"; folders: VideoFolder[]; registry: VideoRegistryRow[]; uploadRecords?: UploadRecordLink[] }
  | { status: "not_configured" }
  | { status: "unavailable"; reason: string };

export type VideoProjectsDeps = {
  store: {
    list(channelId?: string): Promise<OwnReservation[]>;
    /** false when this computer already holds the number for the channel. */
    insert(row: OwnReservation): Promise<boolean>;
    cancel(channelId: string, video: string, set: { cancelledAt: string; replacedBy: string | null }): Promise<boolean>;
  };
  /** The other computers' latest reports (never this computer's own). */
  peers(): Promise<VideoReservationsReport[]>;
  /** Hands this computer's report to the sync family. */
  publishReport(report: VideoReservationsReport): Promise<void>;
  ownDevice(): Promise<{ deviceId: string; hostName: string | null }>;
  /** Whether the channel is connected on this computer. */
  isChannelConnected(channelId: string): Promise<boolean>;
  /** The channel workspace's `MMDD Vn` folders and `video_registry.csv`. */
  workspace(channelId: string): Promise<WorkspaceVideos>;
  /**
   * BL-243: the channel's synced copy as the removed check left it -- the listed videos with YouTube's publishedAt, the removed
   * ones with when, and when a removed check last completed -- for `videoIds` only (the YouTube videos the list names). Absent or
   * failing: none known (every video unknown).
   */
  channelCopy?(channelId: string, videoIds: string[]): Promise<ChannelCopy>;
  /** This computer's upload queue for the channel (`publishing_uploads`). */
  uploads(channelId: string): Promise<Array<{ video: string; status: string; videoId?: string | null }>>;
  /** The video a storyboard of the channel is linked to (the storyboards document), null when none or no such storyboard. */
  storyboardVideo(channelId: string, storyboardId: string): Promise<string | null>;
  /** The video a plan of this computer is linked to, with the plan's channel; null when there is no such plan. */
  planVideo(planId: string): Promise<{ channelId: string; video: string | null } | null>;
  /** BL-221: the channel's synced videos (without the ones removed on YouTube); a local read. */
  channelVideos?(channelId: string): Promise<LinkCandidate[]>;
  /** BL-221: writes a `Vn_youtube.json` (workspace-relative path) that must not exist yet, inside the channel workspace. */
  writeUploadRecord?(channelId: string, relativePath: string, record: unknown): Promise<void>;
  /**
   * BL-263: the channel's unfinished `factory_release_recode` journals (a crashed recode the next real call undoes); while one exists
   * its V and S take no new link and the S is not given. Absent or failing: none known.
   */
  pendingRecodes?(channelId: string): Promise<PendingRecode[]>;
  now(): Date;
  /** Reservations of one process run one at a time (read the highest number, then take the next). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  log?(line: string): void;
};
