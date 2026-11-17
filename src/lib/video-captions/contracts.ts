// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.2, §3.7; ADR 0074): the captions writer -- one English caption track onto a video of the channel
// (insert), or, only on an explicit overwrite by the owner or the Producer, the content of the video's one English standard track
// (update). Never a delete, never an ASR track. Imports nothing from `publishing` (§M): its callers pass the file and the record.
import type { BackupHealth, BackupRecord, BackupSnapshot } from "@/lib/backup/contracts";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import type { VideoCaptionContext, VideoCaptionTrack } from "@/lib/youtube-read-gateway";

export { DomainError, isDomainError } from "@/lib/shared-domain";
export type { VideoCaptionContext, VideoCaptionTrack };

/** list 50 + insert 400 + read-back list 50 + one bounded re-read 50 (the video read's 1 unit aside; `costs.ts`). */
export const CAPTIONS_INSERT_UNITS = 550;
/** list 50 + download 200 (the backup) + update 450 + read-back list 50 + one bounded re-read 50. */
export const CAPTIONS_OVERWRITE_UNITS = 800;
/** A dry run: the video read (1) and the track list (50). */
export const CAPTIONS_DRY_RUN_UNITS = 51;
/** `syncing` right after the write is read again once, this long later. */
export const CAPTIONS_REREAD_DELAY_MS = 20_000;

/** Who writes: the upload runner (never an overwrite), the owner (Web UI) or the Producer (its own endpoint). */
/** `upload.userId`: the Google user who approved the upload (the row's credentials). */
export type CaptionActor = { kind: "upload"; uploadId: string; userId: string } | { kind: "owner"; userId: string } | { kind: "producer" };

export type CaptionWriteInput = {
  channelId: string;
  videoId: string;
  /** The release's code (V27; an S code is always refused). */
  video: string;
  /** The file as the caller read it once: its name (for the format) and its bytes -- hashed and parsed again here, then sent. */
  file: { name: string; bytes: Uint8Array };
  /** What the package states. */
  language: string;
  name: string;
  sha256: string;
  /** The duration the cues are checked against (the manifest's when the mp4 is gone); null: not checked. */
  durationSeconds: number | null;
  /** The tracks the app recorded as its own (upload rows here, `Vn_youtube.json`), with the SHA-256 of what was sent. */
  ownTracks: ReadonlyArray<{ trackId: string; sha256: string }>;
  /** The frame this computer last knew, used only when YouTube's `fileDetails` has none. */
  frameFallback?: "vertical" | "horizontal" | null;
  dryRun?: boolean;
  /** Owner msg 4660: replace the existing English standard track (owner / Producer only; refused for the upload runner). */
  overwrite?: boolean;
  /** The track the owner's preview showed would be replaced (null: "none, an insert"); a different one now refuses. */
  expectedTrackId?: string | null;
  /**
   * The upload runner's lost-answer rule (§3.3): an earlier attempt was marked with the track ids listed before it and its time -- a
   * `standard` English track with exactly the package's name, absent from that list and last updated at or after the mark (review
   * #3: an unknown time is not adopted), is this upload's own and is adopted, not inserted again.
   */
  adoptAfterAttempt?: { trackIdsBefore: string[]; at: string } | null;
};

export type CaptionTrackSummary = { trackId: string; language: string | null; name: string | null; trackKind: string | null; lastUpdated: string | null; ours: boolean };

export type CaptionWriteResult = {
  channelId: string;
  videoId: string;
  dryRun: boolean;
  /** `insert` (a new track), `update` (the explicit overwrite) or `none` (already present: nothing to write). */
  mode: "insert" | "update" | "none";
  units: number;
  file: { bytes: number; sha256: string; format: "srt" | "vtt" };
  /** The English track an overwrite replaces (or replaced); null for an insert. */
  target: CaptionTrackSummary | null;
  /** The English non-ASR tracks found before. */
  englishTracks: CaptionTrackSummary[];
  written: boolean;
  /** The lost-answer rule found this upload's own track (no second insert). */
  adopted: boolean;
  /** The track now holding the package's captions (new, adopted, updated or already present); null on a dry run of an insert. */
  trackId: string | null;
  /** That track's name as YouTube shows it (an overwrite keeps the old name). */
  trackName: string | null;
  alreadyPresent: boolean;
  backupPath: string | null;
  verified: boolean | null;
  verificationDetail: string | null;
  /** Not verified only because YouTube is still processing the track (`syncing`): the upload step reads it again later. */
  pending: boolean;
  /** What the real run budgets (`units` of a dry run is what the dry run itself read). */
  writeUnits: number;
};

export type CaptionCredentials = { credentialRef: { userId: string }; credentials: ResolvedCredentials };

export type VideoCaptionsDeps = {
  /** The channel's write credentials with youtube.force-ssl (the owner's own, or the channel's connected user). */
  credentials(channelId: string, actor: CaptionActor): Promise<CaptionCredentials>;
  /** The channel's captions switch NOW (the synced publishing default). */
  captionsEnabled(channelId: string): Promise<boolean>;
  readVideo(credentials: ResolvedCredentials, videoId: string): Promise<VideoCaptionContext | null>;
  listTracks(credentials: ResolvedCredentials, videoId: string): Promise<VideoCaptionTrack[]>;
  /** The overwrite's backup: the replaced track's current content (`captions.download`). */
  downloadTrack(credentials: ResolvedCredentials, trackId: string): Promise<Buffer>;
  /** The quota guard (`checkUnits`). */
  checkUnits(units: number): Promise<{ decision: "allow" | "insufficient" | "unknown"; remainingUnits?: number; resetsAt?: string | null }>;
  /** The device mutation gate (operation lock / recovery mode); the owner and Producer paths only. */
  assertDeviceAvailable(): Promise<void>;
  backup: {
    checkInfrastructureHealth(): Promise<BackupHealth>;
    captureBackup(args: { channelId: string; operationId: string; videoId: string; snapshot: BackupSnapshot }): Promise<BackupRecord>;
  };
  assertWriteChannel(args: { channelId: string } & CaptionCredentials): Promise<void>;
  /** Persists "an insert was attempted" with the track ids listed before it (the runner's lost-answer rule); others: nothing. */
  markAttempt(args: { channelId: string; videoId: string; trackIdsBefore: string[] }): Promise<void>;
  /** Takes that mark back when the error proves nothing was sent (the client or the Live writes check failed: review #3). */
  clearAttempt(args: { channelId: string; videoId: string }): Promise<void>;
  /** The two writes; each checks Live writes immediately before its gateway call (the adapter). */
  insert(credentials: ResolvedCredentials, args: { videoId: string; language: string; name: string; media: { mimeType: string; bytes: Buffer } }): Promise<{ trackId: string }>;
  update(credentials: ResolvedCredentials, args: { trackId: string; media: { mimeType: string; bytes: Buffer } }): Promise<void>;
  audit(args: { channelId: string; videoId: string; eventType: "BACKUP" | "RESULT" | "VERIFICATION"; detail: Record<string, unknown> }): Promise<void>;
  newOperationId(): string;
  sleep(ms: number): Promise<void>;
};

/**
 * Review #3: an error thrown BEFORE a caption write was sent (the client could not be made, or Live writes refused) carries this
 * mark, so the runner's attempt mark is taken back -- no insert was sent, nothing may be adopted later on its strength.
 */
const NOT_SENT = Symbol.for("ytm.videoCaptions.notSent");

/** Marks `error` as "nothing was sent" (the same object, so its code still decides a pause); a non-object is wrapped. */
export function markCaptionWriteNotSent(error: unknown): unknown {
  const target = error !== null && (typeof error === "object" || typeof error === "function") ? error : new Error(String(error));
  try {
    Object.defineProperty(target, NOT_SENT, { value: true, enumerable: false });
  } catch {
    /* a frozen object: treated as possibly sent (the mark stays, adoption still needs the time rule) */
  }
  return target;
}

export function wasCaptionWriteNotSent(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as Record<symbol, unknown>)[NOT_SENT] === true;
}
