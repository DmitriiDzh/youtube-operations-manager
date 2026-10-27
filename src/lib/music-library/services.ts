import {
  MUSIC_LIBRARY_STALE_AFTER_MS,
  type MusicBatchRow,
  type MusicGenreRow,
  type MusicLibraryResult,
  type MusicLibraryServiceDeps,
  type MusicLibraryView,
} from "./contracts";
import { musicLibrarySnapshotSchema, type MusicBatch, type MusicLibrarySnapshot } from "./schemas";

// BL-229 part A (MUSIC_LIBRARY_PLAN.md §2/§4): the library card's view, computed from the snapshot alone. Pure, so every figure
// the owner sees is tested by hand-worked values (AC-ML-01..05).

/** Seconds → hours with one decimal (70 200 s → 19.5 h; 36 000 s → 10.0 h). */
export function hoursOf(seconds: number): number {
  return Math.round(seconds / 360) / 10;
}

/** Whole percent of reviewed tracks accepted (24 of 30 → 80); null when none were reviewed or the count is not given. */
export function acceptancePercentOf(reviewed: number | undefined, accepted: number | undefined): number | null {
  if (reviewed === undefined || reviewed === 0 || accepted === undefined) return null;
  return Math.round((accepted / reviewed) * 100);
}

/** Older than 24 h (strictly) is stale. */
export function isStale(generatedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(generatedAt) > MUSIC_LIBRARY_STALE_AFTER_MS;
}

/** The snapshot read strictly: the parsed snapshot, or why it cannot be shown (never a half-read one). */
export function parseSnapshot(text: string): { ok: true; snapshot: MusicLibrarySnapshot } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = musicLibrarySnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, reason: `${where}${issue.message}` };
  }
  return { ok: true, snapshot: parsed.data };
}

function batchRow(batch: MusicBatch): MusicBatchRow {
  return {
    batch: batch.batch,
    playlist: batch.playlist ?? null,
    briefVersion: batch.briefVersion ?? null,
    tracks: batch.tracks,
    date: batch.date ?? null,
    source: batch.source ?? null,
    reviewed: batch.reviewed ?? null,
    accepted: batch.accepted ?? null,
    acceptancePercent: acceptancePercentOf(batch.reviewed, batch.accepted),
  };
}

export function buildView(snapshot: MusicLibrarySnapshot, now: Date): MusicLibraryView {
  const genres: MusicGenreRow[] = snapshot.genres.map((genre) => ({
    id: genre.id,
    title: genre.title,
    label: genre.label ?? null,
    color: genre.color ?? null,
    playlist: genre.playlist ?? null,
    status: genre.status,
    batches: genre.batches,
    tracks: genre.tracks,
    hours: hoursOf(genre.seconds),
    neverUsedHours: hoursOf(genre.neverUsedSeconds),
    daysLeft: genre.daysLeft ?? null,
    batchRows: snapshot.batches.filter((batch) => batch.genre === genre.id).map(batchRow),
  }));
  const ageMs = now.getTime() - Date.parse(snapshot.generatedAt);
  return {
    generatedAt: snapshot.generatedAt,
    ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
    stale: isStale(snapshot.generatedAt, now),
    genres,
    withoutGenre:
      snapshot.tracksWithoutGenre > 0
        ? { tracks: snapshot.tracksWithoutGenre, batchRows: snapshot.batches.filter((batch) => batch.genre === null).map(batchRow) }
        : null,
  };
}

/** The channel in the request picks the workspace (its own, on this computer) and nothing else (AGENTS.md §F, AC-ML-07). */
export function createMusicLibraryService(deps: MusicLibraryServiceDeps) {
  return {
    async read(channelId: string): Promise<MusicLibraryResult> {
      const workspace = await deps.getWorkspace(channelId);
      if (!workspace.configured) return { status: "no_workspace" };
      const file = await deps.files.read(workspace.path);
      if (file.kind === "workspace_unavailable") return { status: "workspace_unavailable", reason: file.reason };
      if (file.kind === "missing") return { status: "no_file" };
      if (file.kind === "refused") return { status: "unreadable", reason: file.reason };
      const parsed = parseSnapshot(file.text);
      if (!parsed.ok) return { status: "unreadable", reason: parsed.reason };
      return { status: "ok", view: buildView(parsed.snapshot, deps.now()) };
    },
  };
}

export type MusicLibraryService = ReturnType<typeof createMusicLibraryService>;
