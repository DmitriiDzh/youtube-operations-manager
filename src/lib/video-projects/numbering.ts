import { isNamedAfterRelease, isVideoFileName, releaseManifestFileName, uploadRecordFileName, type VideoFolder, type VideoRegistryRow } from "@/lib/workspace-videos";
import { VIDEO_NUMBER_PATTERN } from "@/lib/sync-gateway";
import type { OwnReservation, ReservationView, UploadRecordLink, VideoConflict, VideoProject, VideoSource, VideoState } from "./contracts";

// BL-194 stage 1 (VIDEO_COST_PLAN.md §2, ADR 0040): the pure rules -- the next number, the list of a channel's videos, and the
// duplicates two computers made. No I/O.

/** 49 for `V49`; null for anything that is not a video number. */
export function videoNumberValue(video: string): number | null {
  return VIDEO_NUMBER_PATTERN.test(video) ? Number(video.slice(1)) : null;
}

/** One above the highest number known, `V1` when none is. */
export function nextVideoNumber(known: Iterable<string>): string {
  let highest = 0;
  for (const video of known) {
    const value = videoNumberValue(video);
    if (value !== null && value > highest) highest = value;
  }
  return `V${highest + 1}`;
}

export type PeerReservations = { deviceId: string; hostName: string | null; reservations: OwnReservation[] };

export type VideoListInput = {
  channelId: string;
  own: { deviceId: string; hostName: string | null; reservations: OwnReservation[] };
  peers: PeerReservations[];
  /** Null while the workspace cannot be read: the list is then the reservations and uploads only. */
  folders: VideoFolder[] | null;
  registry: VideoRegistryRow[] | null;
  uploads: Array<{ video: string; status: string; videoId?: string | null }>;
  /** BL-221: the videos the folders' `Vn_youtube.json` files name (absent: none read). */
  uploadRecords?: UploadRecordLink[];
};

/** Every number of the channel the inputs know -- cancelled reservations included: a number is never given twice. */
export function knownNumbers(input: VideoListInput): string[] {
  const all = [
    ...input.own.reservations.filter((r) => r.channelId === input.channelId).map((r) => r.video),
    ...input.peers.flatMap((p) => p.reservations.filter((r) => r.channelId === input.channelId).map((r) => r.video)),
    ...(input.folders ?? []).map((f) => f.video),
    ...(input.registry ?? []).map((r) => r.vNumber ?? ""),
    ...input.uploads.map((u) => u.video),
  ];
  return all.filter((v) => videoNumberValue(v) !== null);
}

/** The earlier reservation first; equal times: the lower device id first. */
function byPrecedence(a: ReservationView, b: ReservationView): number {
  const at = Date.parse(a.reservedAt) - Date.parse(b.reservedAt);
  if (at !== 0) return at;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

const PUBLISHED_UPLOAD = new Set(["done"]);
const DEAD_UPLOAD = new Set(["failed", "cancelled"]);

/**
 * The channel's videos, highest number first. A number reserved (in work) on two computers carries a `conflict`: both show it;
 * the earlier reservation is the winner and its working title and computer are the video's. `state` is derived: published when
 * `Vn_youtube.json` is in its folder, the registry lists it or an upload here finished; packaged when `Vn_release.json` is there or
 * an upload is under way; cancelled when every reservation was given up and nothing else knows it; in work otherwise.
 */
export function buildVideoList(input: VideoListInput): VideoProject[] {
  type Entry = {
    reservations: ReservationView[];
    sources: Set<VideoSource>;
    folder: VideoFolder | null;
    registry: boolean;
    uploads: string[];
    recordId: string | null;
    uploadId: string | null;
    registryId: string | null;
  };
  const entries = new Map<string, Entry>();
  const entry = (video: string): Entry => {
    let e = entries.get(video);
    if (!e) {
      e = { reservations: [], sources: new Set(), folder: null, registry: false, uploads: [], recordId: null, uploadId: null, registryId: null };
      entries.set(video, e);
    }
    return e;
  };
  const addReservations = (deviceId: string, hostName: string | null, thisComputer: boolean, list: OwnReservation[]) => {
    for (const r of list) {
      if (r.channelId !== input.channelId || videoNumberValue(r.video) === null) continue;
      const e = entry(r.video);
      e.sources.add("reservation");
      e.reservations.push({ deviceId, hostName, thisComputer, reservedAt: r.reservedAt, workingTitle: r.workingTitle, state: r.state, replacedBy: r.replacedBy });
    }
  };
  addReservations(input.own.deviceId, input.own.hostName, true, input.own.reservations);
  for (const peer of input.peers) if (peer.deviceId !== input.own.deviceId) addReservations(peer.deviceId, peer.hostName, false, peer.reservations);
  for (const folder of input.folders ?? []) {
    const e = entry(folder.video);
    e.sources.add("folder");
    // Two folders with one number: the first by path is shown (the factory's own mistake; nothing here depends on it).
    if (!e.folder) e.folder = folder;
  }
  for (const row of input.registry ?? []) {
    if (!row.vNumber || videoNumberValue(row.vNumber) === null) continue;
    const e = entry(row.vNumber);
    e.sources.add("registry");
    e.registry = true;
    e.registryId ??= row.videoId;
  }
  for (const upload of input.uploads) {
    if (videoNumberValue(upload.video) === null) continue;
    const e = entry(upload.video);
    e.sources.add("upload");
    e.uploads.push(upload.status);
    if (upload.videoId) e.uploadId ??= upload.videoId;
  }
  // A record only counts for a number the list already knows from its folder (it was read from that folder).
  for (const record of input.uploadRecords ?? []) {
    const e = entries.get(record.video);
    if (e?.folder) e.recordId ??= record.videoId;
  }

  const suggestion = nextVideoNumber(knownNumbers(input));
  const out: VideoProject[] = [];
  for (const [video, e] of entries) {
    const sorted = [...e.reservations].sort(byPrecedence);
    const active = sorted.filter((r) => r.state === "in_work");
    const activeDevices = new Set(active.map((r) => r.deviceId));
    let conflict: VideoConflict | null = null;
    if (activeDevices.size > 1) {
      const winner = active[0];
      const thisComputerInvolved = active.some((r) => r.thisComputer);
      const thisComputerLoses = thisComputerInvolved && !winner.thisComputer;
      conflict = { reservations: active, winnerDeviceId: winner.deviceId, thisComputerInvolved, thisComputerLoses, suggestedVideo: thisComputerLoses ? suggestion : null };
    }
    const lead = active[0] ?? sorted[0] ?? null;
    const files = e.folder?.files ?? [];
    const published = files.includes(uploadRecordFileName(video)) || e.registry || e.uploads.some((s) => PUBLISHED_UPLOAD.has(s));
    const packaged = files.includes(releaseManifestFileName(video)) || e.uploads.some((s) => !DEAD_UPLOAD.has(s));
    const onlyCancelled = sorted.length > 0 && active.length === 0 && !e.folder && !e.registry && e.uploads.length === 0;
    const state: VideoState = published ? "published" : packaged ? "packaged" : onlyCancelled ? "cancelled" : "in_work";
    out.push({
      channelId: input.channelId,
      video,
      number: videoNumberValue(video) ?? 0,
      workingTitle: lead?.workingTitle ?? null,
      state,
      sources: (["reservation", "folder", "registry", "upload"] as const).filter((s) => e.sources.has(s)),
      folder: e.folder?.folder ?? null,
      createdAt: lead?.reservedAt ?? null,
      deviceId: lead?.deviceId ?? null,
      hostName: lead?.hostName ?? null,
      thisComputer: lead?.thisComputer ?? false,
      conflict,
      youtubeVideoId: e.recordId ?? e.uploadId ?? e.registryId,
      hasVideoFile: files.some((name) => isVideoFileName(name) && isNamedAfterRelease(name, video)),
      uploading: e.uploads.some((s) => !DEAD_UPLOAD.has(s) && !PUBLISHED_UPLOAD.has(s)),
    });
  }
  return out.sort((a, b) => b.number - a.number);
}
