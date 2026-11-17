import { pipelinePhase, type PipelineProject } from "./video-pipeline";

// BL-266 (owner TG 4730/4732): «Ролики и релизы» is gone; «План» carries what it showed -- how many videos in work have no plan slot
// yet, and this channel's uploads (on the slot card and in one queue line). Pure: derived for display from the existing reads
// (`video-projects`, `publishing/packages`, `publishing/uploads`); nothing here decides or writes anything.

export type PlanProjectRef = PipelineProject & { video: string };
/** A row of the package scan, as far as slots are concerned: the package names its plan slot in `pkg.slotId` (package v2). */
export type PlanPackageRef = { video: string | null; pkg: { slotId?: string | null } | null };

/** The phases of a number still in work before YouTube (the board's «Подготовка», «Монтаж», «Пакет»). */
const IN_WORK = new Set(["prep", "edit", "package"]);

/**
 * The video numbers in work (not on YouTube, not published, not cancelled) that no release package assigns to a plan slot -- the
 * «Без слота: N» line. A number counts once, in the order the projects list gives.
 */
export function unslottedVideos(projects: readonly PlanProjectRef[], packages: readonly PlanPackageRef[]): string[] {
  const slotted = new Set(packages.filter((p) => p.video && p.pkg?.slotId).map((p) => p.video as string));
  const out: string[] = [];
  for (const project of projects) {
    const phase = pipelinePhase(project, null);
    if (!phase || !IN_WORK.has(phase) || slotted.has(project.video) || out.includes(project.video)) continue;
    out.push(project.video);
  }
  return out;
}

export type UploadStatus = "queued" | "uploading" | "processing" | "finishing" | "paused" | "done" | "failed" | "cancelled";
export type PlanUploadRef = { video: string; status: UploadStatus; totalBytes: number; storedBytes: number; errorCode?: string | null; queuePosition?: number | null };
export type ActiveUpload = { status: UploadStatus; percent: number };

/** Waiting, sending, processing on YouTube, finishing (date, playlist, translations) or paused: not over yet. */
export const ACTIVE_UPLOAD_STATUSES: ReadonlySet<UploadStatus> = new Set(["queued", "uploading", "processing", "finishing", "paused"]);
/** Which active row of one video the card shows when there are several: the one furthest along. */
const PRECEDENCE: UploadStatus[] = ["finishing", "processing", "uploading", "paused", "queued"];

/** The share of the file already stored on YouTube, 0..100 (0 when the size is unknown). */
export function uploadPercent(row: Pick<PlanUploadRef, "totalBytes" | "storedBytes">): number {
  if (!(row.totalBytes > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((row.storedBytes / row.totalBytes) * 100)));
}

/** Each video number with an upload not over yet -> its status and percent (the slot card's chip). */
export function activeUploadsByVideo(rows: readonly PlanUploadRef[]): Map<string, ActiveUpload> {
  const out = new Map<string, ActiveUpload>();
  for (const row of rows) {
    if (!ACTIVE_UPLOAD_STATUSES.has(row.status)) continue;
    const current = out.get(row.video);
    if (current && PRECEDENCE.indexOf(current.status) <= PRECEDENCE.indexOf(row.status)) continue;
    out.set(row.video, { status: row.status, percent: uploadPercent(row) });
  }
  return out;
}

/**
 * The queue line: how many of this channel's uploads on this computer are not over yet, the one being sent now (else the next in
 * the queue) with its percent, and how many failed with an unknown outcome -- the only failure that waits for the owner's decision
 * («Отпустить»).
 */
export function uploadQueueSummary(rows: readonly PlanUploadRef[]): { active: number; current: { video: string; status: UploadStatus; percent: number } | null; needsDecision: number } {
  const active = rows.filter((r) => ACTIVE_UPLOAD_STATUSES.has(r.status));
  const moving = active.find((r) => r.status === "uploading") ?? active.find((r) => r.status === "processing" || r.status === "finishing");
  const next = [...active].filter((r) => r.status === "queued").sort((a, b) => (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER))[0];
  const pick = moving ?? active.find((r) => r.status === "paused") ?? next ?? null;
  return {
    active: active.length,
    current: pick ? { video: pick.video, status: pick.status, percent: uploadPercent(pick) } : null,
    needsDecision: rows.filter((r) => r.status === "failed" && r.errorCode === "unknown_outcome").length,
  };
}
