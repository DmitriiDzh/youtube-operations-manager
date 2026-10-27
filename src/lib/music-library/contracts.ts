// BL-229 part A (MUSIC_LIBRARY_PLAN.md §2, ADR 0054): the music library per genre, read-only, from the factory's one snapshot per
// channel. The Manager reads only this file -- never the factory's profiles, CSVs, ledger or durations -- and runs no factory script.

/** Relative to the channel workspace; the factory writes it (DEV-RESP-0043 Part 2 A). */
export const MUSIC_LIBRARY_RELATIVE_PATH = "99 Data Exchange/Sent to YTM/music/library.json";

/** A snapshot larger than this is refused unread (a real one is a few kilobytes). */
export const MUSIC_LIBRARY_MAX_BYTES = 5 * 1024 * 1024;

/** Older than this, the snapshot is marked stale (DEV-RESP-0043: "older than 24 h"). Exactly 24 h is not stale. */
export const MUSIC_LIBRARY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type MusicBatchRow = {
  batch: string;
  playlist: string | null;
  briefVersion: string | null;
  tracks: number;
  date: string | null;
  source: string | null;
  reviewed: number | null;
  accepted: number | null;
  /** Whole percent of reviewed tracks accepted; null when none were reviewed (shown «—», never 0 %). */
  acceptancePercent: number | null;
};

export type MusicGenreRow = {
  id: string;
  title: string;
  label: string | null;
  color: string | null;
  playlist: string | null;
  status: "active" | "stub";
  batches: number;
  tracks: number;
  /** Hours rounded to one decimal (70 200 s → 19.5). */
  hours: number;
  neverUsedHours: number;
  daysLeft: number | null;
  batchRows: MusicBatchRow[];
};

export type MusicLibraryView = {
  generatedAt: string;
  /** Whole minutes since `generatedAt` (0 when the snapshot's time is ahead of this computer's clock). */
  ageMinutes: number;
  stale: boolean;
  genres: MusicGenreRow[];
  /** Present only when the snapshot has tracks without a genre; their batches (genre null) are listed under it. */
  withoutGenre: { tracks: number; batchRows: MusicBatchRow[] } | null;
};

export type MusicLibraryResult =
  | { status: "no_workspace" }
  | { status: "workspace_unavailable"; reason: string }
  | { status: "no_file" }
  | { status: "unreadable"; reason: string }
  | { status: "ok"; view: MusicLibraryView };

/** What the files adapter found for a workspace. */
export type MusicLibraryFileRead =
  | { kind: "workspace_unavailable"; reason: string }
  | { kind: "missing" }
  | { kind: "refused"; reason: string }
  | { kind: "text"; text: string };

export type MusicLibraryFilesPort = { read(workspace: string): Promise<MusicLibraryFileRead> };

export type WorkspaceLookup = (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>;

export type MusicLibraryServiceDeps = {
  /** The channel's own workspace on this computer (channel-workspaces). */
  getWorkspace: WorkspaceLookup;
  files: MusicLibraryFilesPort;
  now: () => Date;
};
