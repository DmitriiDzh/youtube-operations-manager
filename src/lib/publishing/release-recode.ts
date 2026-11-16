import { createHash } from "node:crypto";
import { DomainError } from "@/lib/shared-domain";
import type { StoredPublishingUpload, VideoRecodePlan, VideoRecodeSnapshot } from "@/lib/db";
import { isStrictSCode, isStrictVCode } from "@/lib/shared-video-code";
import { stripBom, videoNumberOfFolder } from "@/lib/workspace-videos";
import type { PackageScanResult, ScannedPackage } from "./package-scan";
import { rewritePaths } from "./release-folder-rename";
import type { SlotDecision } from "./slot-decision";

// BL-263 (docs/roadmap/plans/SHORT_VIDEO_CODE_PLAN.md §6, ADR 0071 §4; owner TG 2334 / 4553 / 4555 via the Producer and the Operator):
// the one-shot recode of a WWE Short's release package from its V code to its S code -- LOCAL ONLY, never a YouTube call. Modelled on
// BL-261 (`release-folder-rename.ts`): every refusal is checked before anything changes (a dry run runs them all); then, with a journal
// and backups written first, the files named after the code are renamed, the manifest's `video` and file fields rewritten (never free
// text), the records' `video` field rewritten, the folder renamed, this computer's rows moved in one transaction and the storyboards
// relinked. Any failure undoes the done steps in reverse; a crash leaves the journal and the next call for the channel undoes it first.

export type ReleaseRecodeInput = { channelId: string; video: string; newCode: string; dryRun?: boolean };

export type ReleaseRecodeRows = { uploads: number; reservations: number; jobs: number; plans: number; storyboards: number; socialJobs: number; orientation: number };

export type ReleaseRecodeResult = {
  dryRun: boolean;
  video: string;
  newCode: string;
  /** The release folder relative to the workspace, before and after. */
  from: string;
  to: string;
  /** Every file renamed (relative to the release folder), old → new name. */
  files: Array<{ from: string; to: string }>;
  manifest: { fields: string[]; oldSha256: string; newSha256: string };
  /** Whether `<code>_youtube.json` / `<code>_cost.json` are there and get their `video` rewritten. */
  records: { youtube: boolean; cost: boolean };
  rows: ReleaseRecodeRows;
  /** The frame as the scan knows it (an unknown frame with the « Short» suffix is allowed and reported). */
  frame: "vertical" | "horizontal" | null;
  /** Other computers' own rows that name the old code (they follow the recode alias, never edited from here). */
  peerLinks: Array<{ deviceId: string; hostName: string | null; kind: "reservation" | "cost_run"; count: number }>;
  changed: boolean;
  readBack: "verified" | "mismatch" | null;
  /** The journal of an earlier recode of this channel that crashed and was undone first. */
  recoveredFrom?: string;
};

/** The video list of the channel, as the recode needs it (`src/lib/video-projects` listVideos, wired by the composition layer). */
export type RecodeVideoList = {
  videos: Array<{ video: string; state: string; sources: string[]; recodedTo?: string | null; youtubeVideoId: string | null }>;
  nextVideo: string | null;
};

/** The journal of one recode: what it planned, which steps are done, and the backups to undo them. */
export type ReleaseRecodeJournal = {
  schema: "ytm-release-recode-journal/1";
  channelId: string;
  video: string;
  newCode: string;
  workspace: string;
  from: string;
  to: string;
  files: Array<{ from: string; to: string }>;
  /** Original text of the manifest and records, by their OLD name in the release folder. */
  backups: Record<string, string>;
  /** New text written for the manifest and records, by their NEW name. */
  written: Record<string, string>;
  snapshot: VideoRecodeSnapshot;
  plan: VideoRecodePlan;
  storyboards: string[];
  done: ReleaseRecodeStep[];
  startedAt: string;
};

export const RELEASE_RECODE_STEPS = ["files", "manifest", "records", "folder", "rows", "storyboards"] as const;
export type ReleaseRecodeStep = (typeof RELEASE_RECODE_STEPS)[number];

export type ReleaseRecodeDeps = {
  workspace(channelId: string): Promise<string | null>;
  /** A fresh scan of the channel's packages (never a cached one). */
  scan(channelId: string): Promise<PackageScanResult>;
  /** This computer's upload rows of the channel (every status). */
  uploads(channelId: string): Promise<StoredPublishingUpload[]>;
  /** Other computers' upload rows of the channel by video code (any state: `uploaded` = finished there). */
  peerUploads(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>>;
  /** Whether a cross-post of the video is uploading or processing its file now. */
  socialBusy(channelId: string, video: string): Promise<boolean>;
  /** The channel's live rotation and source-map files (relative to the workspace). */
  livePaths(channelId: string): Promise<string[]>;
  /** The channel's video list (every computer's reservations, folders, uploads, records, registry); throws when it cannot be read. */
  videoList(channelId: string): Promise<RecodeVideoList>;
  /** The owner's approvals that could still act: package-review approvals (manifest hashes) and the weekly plan's slot decisions. */
  approvals(channelId: string): Promise<{ reviewApproved: ReadonlySet<string>; slots: ReadonlyMap<string, SlotDecision> }>;
  /** Other computers' own rows naming the code (reservations in work, cost runs). */
  peerLinks(channelId: string, video: string): Promise<ReleaseRecodeResult["peerLinks"]>;
  /** Names directly in a folder (files and folders; never following a symlink). */
  listFolder(absolutePath: string): Promise<Array<{ name: string; kind: "file" | "dir" | "other" }>>;
  readText(absolutePath: string): Promise<string>;
  /** Whole or not at all (a temporary file, then a rename). */
  writeText(absolutePath: string, text: string): Promise<void>;
  exists(absolutePath: string): Promise<boolean>;
  isRealFolder(workspace: string, relativeFolder: string): Promise<boolean>;
  rename(fromAbsolute: string, toAbsolute: string): Promise<void>;
  rows: {
    snapshot(channelId: string, from: string, to: string, uploadIds: readonly string[]): Promise<VideoRecodeSnapshot>;
    recode(snapshot: VideoRecodeSnapshot, plan: VideoRecodePlan): Promise<void>;
    undo(snapshot: VideoRecodeSnapshot, plan: VideoRecodePlan): Promise<void>;
  };
  storyboards: {
    /** The channel's storyboards linked to `video`. */
    linked(channelId: string, video: string): Promise<string[]>;
    setVideo(channelId: string, storyboardId: string, video: string): Promise<void>;
  };
  journal: {
    /** Where a new journal of `channelId` is written (absolute). */
    pathFor(channelId: string, video: string, at: Date): string;
    write(path: string, journal: ReleaseRecodeJournal): Promise<void>;
    /** This channel's journals left behind (absolute paths). */
    list(channelId: string): Promise<string[]>;
    read(path: string): Promise<ReleaseRecodeJournal>;
    remove(path: string): Promise<void>;
  };
  /** This computer's reports (uploads, reservations, costs) written now; a failure is only logged. */
  publishReports(): Promise<void>;
  assertMutationAllowed(): Promise<void>;
  audit(entry: { channelId: string; video: string; detail: Record<string, unknown> }): Promise<void>;
  invalidate(channelId: string): void;
  now(): Date;
  join(...parts: string[]): string;
};

/** Rows that read the folder now or soon in a way a recode would break: sending, YouTube processing, the finishing steps, paused. */
const BUSY = new Set(["uploading", "processing", "finishing", "paused"]);
/** Free text of a manifest -- never rewritten, whatever it holds. */
const FREE_TEXT_KEYS = new Set(["title", "description", "localizations", "tags"]);

type RecodeErrorCode =
  | "release_recode_invalid"
  | "release_recode_not_found"
  | "release_recode_ambiguous"
  | "release_recode_not_short"
  | "release_recode_target_exists"
  | "release_recode_busy"
  | "release_recode_elsewhere"
  | "release_recode_approval_standing"
  | "release_recode_rollback_failed";

const refuse = (code: RecodeErrorCode, message: string, details: Record<string, unknown>) => new DomainError({ code, message, details });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The new name of a file of the release folder named after `code` (the Operator's rule, 2026-11-16), else null. The code is matched as
 * a whole token, so `V1` never matches `V12`'s files:
 * - at the start, followed by `_`, a space or `.`: `V14_release.json`, `V14_YouTube_Title_Description.txt`, `V14 WWE.mp4`, `V14.srt`;
 * - inside a thumbnail's name: `Thumbnail_V14.jpg`, `Thumbnail_V14_A.png`, `Thumbnail_V14_base.jpeg`, `Thumbnail_V14_A.logo.json`.
 */
export function renamedForCode(name: string, code: string, newCode: string): string | null {
  if (name.startsWith(code) && /^[ _.]/.test(name.slice(code.length))) return `${newCode}${name.slice(code.length)}`;
  const thumb = new RegExp(`^Thumbnail_${escape(code)}((?:_[A-Z]|_base)?\\.(?:jpe?g|png|logo\\.json))$`, "i").exec(name);
  if (thumb && name.startsWith(`Thumbnail_${code}`)) return `Thumbnail_${newCode}${thumb[1]}`;
  return null;
}

/**
 * The manifest with `video` set to the new code and every string field outside the free text that names a renamed file replaced
 * (`files.video`, `files.thumbnail`, `thumbnails[].file`, any other file field). Returns the JSON paths changed.
 */
export function rewriteManifest(manifest: Record<string, unknown>, newCode: string, renames: ReadonlyMap<string, string>): { manifest: Record<string, unknown>; fields: string[] } {
  const fields: string[] = [];
  const walk = (value: unknown, at: string): unknown => {
    if (typeof value === "string") {
      const renamed = renames.get(value);
      if (renamed !== undefined) {
        fields.push(at);
        return renamed;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${at}[${i}]`));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, at === "" && FREE_TEXT_KEYS.has(k) ? v : walk(v, at === "" ? k : `${at}.${k}`)]));
    }
    return value;
  };
  const out = walk(manifest, "") as Record<string, unknown>;
  if (out.video !== newCode) {
    out.video = newCode;
    fields.unshift("video");
  }
  return { manifest: out, fields };
}

const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
/** A JSON file written back as the factory and the upload runner write them: two-space indent, a newline; a BOM kept when it had one. */
const jsonText = (value: unknown, bom: boolean) => `${bom ? "﻿" : ""}${JSON.stringify(value, null, 2)}\n`;

/** One recode at a time in this process (two recodes of one channel would race on the folder and the journal). */
let recodeQueue: Promise<unknown> = Promise.resolve();

export function createReleaseRecode(deps: ReleaseRecodeDeps) {
  return {
    recode(input: ReleaseRecodeInput): Promise<ReleaseRecodeResult> {
      const run = recodeQueue.then(() => recodeOne(input));
      recodeQueue = run.catch(() => undefined);
      return run;
    },
  };

  /** Undoes the done steps of a journal in reverse (idempotent: a step already undone, or never done, changes nothing). */
  async function undo(journal: ReleaseRecodeJournal): Promise<void> {
    const ws = journal.workspace;
    const abs = (rel: string) => deps.join(ws, ...rel.split("/"));
    const done = new Set(journal.done);
    // A step is undone when it is marked done, and also the step that was running (it may have half-happened): every step's undo
    // only puts back what still holds the new value.
    const running = RELEASE_RECODE_STEPS[journal.done.length];
    const touched = (step: ReleaseRecodeStep) => done.has(step) || step === running;
    if (touched("storyboards")) for (const id of journal.storyboards) await deps.storyboards.setVideo(journal.channelId, id, journal.video);
    if (touched("rows")) await deps.rows.undo(journal.snapshot, journal.plan);
    if (touched("folder")) {
      if ((await deps.exists(abs(journal.to))) && !(await deps.exists(abs(journal.from)))) await deps.rename(abs(journal.to), abs(journal.from));
    }
    const inOld = (name: string) => abs(`${journal.from}/${name}`);
    if (touched("records") || touched("manifest")) {
      for (const [oldName, text] of Object.entries(journal.backups)) {
        const renamed = journal.files.find((f) => f.from === oldName)?.to ?? oldName;
        for (const candidate of [renamed, oldName]) {
          if (await deps.exists(inOld(candidate))) {
            await deps.writeText(inOld(candidate), text);
            break;
          }
        }
      }
    }
    if (touched("files")) {
      for (const file of [...journal.files].reverse()) {
        if ((await deps.exists(inOld(file.to))) && !(await deps.exists(inOld(file.from)))) await deps.rename(inOld(file.to), inOld(file.from));
      }
    }
    deps.invalidate(journal.channelId);
    // Verify on disk: every guard above skips what it cannot see, so an unreachable workspace (not mounted, mid-sync) would otherwise
    // look like a finished undo. The old folder must be back with every old name, the new folder gone.
    if (touched("folder") || touched("files") || touched("manifest") || touched("records")) {
      const missing: string[] = [];
      if (!(await deps.exists(abs(journal.from)))) missing.push(journal.from);
      if (await deps.exists(abs(journal.to))) missing.push(`${journal.to} (still there)`);
      for (const file of journal.files) if (!(await deps.exists(inOld(file.from)))) missing.push(`${journal.from}/${file.from}`);
      if (missing.length > 0) throw new Error(`the undo could not restore: ${missing.slice(0, 5).join(", ")}`);
    }
  }

  /** A journal left by a crashed recode of this channel: undone from its backups, then removed. */
  async function recoverChannel(channelId: string): Promise<string | undefined> {
    const left = await deps.journal.list(channelId);
    let recovered: string | undefined;
    for (const path of left) {
      try {
        const journal = await deps.journal.read(path);
        await undo(journal);
        await deps.publishReports().catch(() => undefined);
        await deps.audit({ channelId, video: journal.video, detail: { event: "release.recode_recovered", journal: path, newCode: journal.newCode, done: journal.done } }).catch(() => undefined);
        await deps.journal.remove(path);
        recovered = path;
      } catch (error) {
        throw refuse("release_recode_rollback_failed", `A recode of this channel left a journal that could not be undone; restore it by hand from ${path}`, {
          channelId,
          journal: path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return recovered;
  }

  async function recodeOne(input: ReleaseRecodeInput): Promise<ReleaseRecodeResult> {
    const { channelId, video, newCode } = input;
    const dryRun = input.dryRun === true;
    const details = { channelId, video, newCode };
    if (!isStrictVCode(video)) throw refuse("release_recode_invalid", "video must be a V code like V14", { ...details, field: "video" });
    if (!isStrictSCode(newCode)) throw refuse("release_recode_invalid", "newCode must be an S code like S12", { ...details, field: "newCode" });

    // A crash left a journal: undo it first (never on a dry run -- a dry run changes nothing).
    const recoveredFrom = dryRun ? undefined : await recoverChannel(channelId);

    // -- Where the package is (BL-261's rules), in THIS channel's workspace only.
    const workspace = await deps.workspace(channelId);
    if (!workspace) throw refuse("release_recode_not_found", "The channel has no workspace on this computer", details);
    const scanned = await deps.scan(channelId);
    if (scanned.status !== "ok") throw refuse("release_recode_not_found", "The channel's packages cannot be read now", { ...details, scan: scanned.status });
    const matches = scanned.packages.filter((p) => p.video === video);
    if (matches.length === 0) throw refuse("release_recode_not_found", `No release package of ${video} in the channel's folders`, details);
    if (new Set(matches.map((p) => p.folder)).size > 1 || matches.length > 1) throw refuse("release_recode_ambiguous", `${video} has several packages; recode it by hand`, { ...details, folders: matches.map((p) => p.folder) });
    const pkg: ScannedPackage = matches[0];
    const from = pkg.folder;
    const parts = from.split("/");
    if (parts.length !== 3 || parts[0] !== "04 Videos" || videoNumberOfFolder(parts[2]) !== video) throw refuse("release_recode_not_found", "The package is not in a release folder of its own under 04 Videos/<month>/", { ...details, folder: from });
    if (!(await deps.isRealFolder(workspace, from))) throw refuse("release_recode_not_found", "The package's folder is not a real folder inside the workspace", { ...details, folder: from });

    // -- Only a Short: the « Short» folder suffix (BL-261), and not a frame known to be horizontal (BL-259). Publishing state is not
    // a refusal (owner TG 4553/4555).
    const frame = pkg.orientation ?? null;
    if (!parts[2].endsWith(" Short")) throw refuse("release_recode_not_short", `${from} is not a Short's folder (no « Short» suffix)`, { ...details, folder: from, reason: "folder" });
    if (frame === "horizontal") throw refuse("release_recode_not_short", `${video}'s video is horizontal`, { ...details, folder: from, reason: "horizontal" });

    // -- The new names.
    const folderName = parts[2];
    const newFolderName = folderName.replace(new RegExp(`^(\\d{4}\\s+)${escape(video)}(?=\\s|$)`, "i"), `$1${newCode}`);
    const to = `${parts[0]}/${parts[1]}/${newFolderName}`;
    const fromAbs = deps.join(workspace, ...from.split("/"));
    const toAbs = deps.join(workspace, ...to.split("/"));
    const files: Array<{ from: string; to: string }> = [];
    for (const entry of await deps.listFolder(fromAbs)) {
      if (entry.kind === "file") {
        const renamed = renamedForCode(entry.name, video, newCode);
        if (renamed) files.push({ from: entry.name, to: renamed });
      } else if (entry.kind === "dir" && entry.name === "work") {
        // The factory's scratch files (`work/<C>_*`): renamed with the rest (cheap; nothing reads them).
        for (const inner of await deps.listFolder(deps.join(fromAbs, "work"))) {
          if (inner.kind !== "file") continue;
          const renamed = renamedForCode(inner.name, video, newCode);
          if (renamed && !renamed.startsWith("Thumbnail_")) files.push({ from: `work/${inner.name}`, to: `work/${renamed}` });
        }
      }
    }
    files.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    const renames = new Map(files.map((f) => [f.from, f.to]));
    const manifestName = pkg.manifestPath.slice(pkg.manifestPath.lastIndexOf("/") + 1);
    const newManifestName = renames.get(manifestName);
    if (!newManifestName) throw refuse("release_recode_not_found", `${manifestName} is not named after ${video}`, { ...details, manifest: manifestName });

    // -- The target must be unknown everywhere (§4's sources) and no target name may exist.
    let list: RecodeVideoList;
    try {
      list = await deps.videoList(channelId);
    } catch (error) {
      throw refuse("release_recode_busy", "The channel's video list cannot be read now; the new code cannot be checked", { ...details, reason: "video_list_unavailable", message: error instanceof Error ? error.message : String(error) });
    }
    const known = list.videos.find((v) => v.video === newCode);
    if (known) throw refuse("release_recode_target_exists", `${newCode} is already known for this channel (${known.sources.join(", ")})`, { ...details, source: known.sources[0] ?? "reservation" });
    const peerUploads = await deps.peerUploads(channelId);
    if (peerUploads.has(newCode)) throw refuse("release_recode_target_exists", `${newCode} has an upload on ${peerUploads.get(newCode)!.host ?? "another computer"}`, { ...details, source: "upload" });
    if (await deps.exists(toAbs)) throw refuse("release_recode_target_exists", `A folder named ${newFolderName} already exists there`, { ...details, to });
    for (const file of files) {
      if (await deps.exists(deps.join(fromAbs, ...file.to.split("/")))) throw refuse("release_recode_target_exists", `${file.to} already exists in the release folder`, { ...details, file: file.to });
    }

    // -- Busy (BL-261's reasons), then a peer holding any upload row of the code.
    const ownRows = (await deps.uploads(channelId)).filter((row) => row.channelId === channelId && row.video === video);
    const nowMs = deps.now().getTime();
    const sending = ownRows.filter((row) => BUSY.has(row.status) || (row.status === "queued" && row.leaseUntil !== null && row.leaseUntil !== undefined && new Date(row.leaseUntil).getTime() > nowMs));
    if (sending.length > 0) throw refuse("release_recode_busy", `${video} is being uploaded on this computer; recode it when the upload finished`, { ...details, reason: "upload_here", uploads: sending.map((r) => ({ uploadId: r.id, status: r.status })) });
    if (await deps.socialBusy(channelId, video)) throw refuse("release_recode_busy", `A cross-post of ${video} is uploading its file; recode it when that finished`, { ...details, reason: "cross_post" });
    if ((await deps.livePaths(channelId)).some((p) => p.replace(/\\/g, "/").startsWith(`${from}/`))) {
      throw refuse("release_recode_busy", `${video}'s file is in the channel's live rotation or source map; take it out there first`, { ...details, reason: "live_rotation" });
    }
    const peer = peerUploads.get(video);
    if (peer) throw refuse("release_recode_elsewhere", `${peer.host ?? "Another computer"} reports an upload of ${video}; run the recode on that computer`, { ...details, host: peer.host, uploaded: peer.uploaded });

    // -- An owner approval that still has an upload or a date to give (the manifest SHA-256 changes, so it would silently stop counting).
    const uploaded = pkg.youtube !== null || ownRows.some((r) => r.videoId !== null && r.videoId !== undefined && r.status === "done");
    const approvals = await deps.approvals(channelId);
    const slot = pkg.pkg?.slotId ? approvals.slots.get(pkg.pkg.slotId) : undefined;
    const slotNamesThis = slot?.kind === "approved" && (!slot.package || slot.package.manifestSha256 === pkg.manifestSha256 || (pkg.youtube !== null && slot.package.videoId === pkg.youtube.videoId));
    if (!uploaded) {
      if (pkg.manifestSha256 && approvals.reviewApproved.has(pkg.manifestSha256)) {
        throw refuse("release_recode_approval_standing", `The owner approved ${video}'s package and it is not uploaded yet; recode it only after asking him`, { ...details, reason: "package_review" });
      }
      if (slotNamesThis) throw refuse("release_recode_approval_standing", `The owner approved the plan slot of ${video}'s package and it is not uploaded yet`, { ...details, reason: "plan_slot", slotId: pkg.pkg?.slotId });
    } else if (slotNamesThis && pkg.state !== "scheduled" && pkg.state !== "published") {
      throw refuse("release_recode_approval_standing", `The owner approved the plan slot of ${video} and the video has no date yet; the plan would still give it one`, { ...details, reason: "plan_slot_date", slotId: pkg.pkg?.slotId });
    }

    // -- What will be written: the manifest and records (text and hash), the rows, the storyboards.
    const manifestOld = await deps.readText(deps.join(fromAbs, manifestName));
    const manifestJson = JSON.parse(stripBom(manifestOld)) as Record<string, unknown>;
    // §6.1: every record the recode rewrites must name this channel -- another channel's package is never touched.
    if (manifestJson.channelId !== channelId) throw refuse("release_recode_not_found", `${manifestName} names another channel`, { ...details, reason: "channel_mismatch", file: manifestName });
    const rewritten = rewriteManifest(manifestJson, newCode, renames);
    const manifestNew = jsonText(rewritten.manifest, manifestOld.startsWith("﻿"));
    const oldSha256 = sha256(manifestOld);
    const newSha256 = sha256(manifestNew);
    const backups: Record<string, string> = { [manifestName]: manifestOld };
    const written: Record<string, string> = { [newManifestName]: manifestNew };
    const records = { youtube: false, cost: false };
    for (const [kind, suffix] of [["youtube", "_youtube.json"], ["cost", "_cost.json"]] as const) {
      const oldName = `${video}${suffix}`;
      if (!renames.has(oldName)) continue;
      const text = await deps.readText(deps.join(fromAbs, oldName));
      const json = JSON.parse(stripBom(text)) as Record<string, unknown>;
      if (json.channelId !== undefined && json.channelId !== channelId) throw refuse("release_recode_not_found", `${oldName} names another channel`, { ...details, reason: "channel_mismatch", file: oldName });
      backups[oldName] = text;
      written[renames.get(oldName)!] = jsonText({ ...json, ...(json.video !== undefined ? { video: newCode } : {}) }, text.startsWith("﻿"));
      records[kind] = true;
    }
    const uploadPlans = ownRows.map((row) => {
      let packageJson = row.packageJson;
      try {
        // The folder moves (BL-261's rule), then each top-level path naming a renamed file follows it (manifestPath, videoFile,
        // thumbnailFile); `video` becomes the new code. Free text (title, description, tags, localizations) stays.
        const moved = rewritePaths(JSON.parse(row.packageJson), from, to) as Record<string, unknown>;
        const mapped = Object.fromEntries(
          Object.entries(moved).map(([k, v]) => [k, typeof v === "string" && v.startsWith(`${to}/`) && renames.has(v.slice(to.length + 1)) ? `${to}/${renames.get(v.slice(to.length + 1))}` : v])
        );
        packageJson = JSON.stringify({ ...mapped, video: newCode });
      } catch {
        // An unreadable package stays as it is (the runner never reads a finished row's package again).
      }
      return { id: row.id, manifestPath: `${to}/${newManifestName}`, manifestSha256: newSha256, packageJson };
    });
    const snapshot = await deps.rows.snapshot(channelId, video, newCode, ownRows.map((r) => r.id));
    const plan: VideoRecodePlan = { uploads: uploadPlans, at: deps.now().toISOString(), manifestSha256: newSha256 };
    const storyboards = await deps.storyboards.linked(channelId, video);
    const rows: ReleaseRecodeRows = {
      uploads: uploadPlans.length,
      reservations: 2,
      jobs: snapshot.mediaJobs.length + snapshot.geminiJobs.length + snapshot.speechJobs.length,
      plans: snapshot.plans.length,
      storyboards: storyboards.length,
      socialJobs: snapshot.socialJobs.length,
      orientation: snapshot.orientation ? 1 : 0,
    };
    const peerLinks = await deps.peerLinks(channelId, video);
    const result: ReleaseRecodeResult = {
      dryRun,
      video,
      newCode,
      from,
      to,
      files,
      manifest: { fields: rewritten.fields, oldSha256, newSha256 },
      records,
      rows,
      frame,
      peerLinks,
      changed: !dryRun,
      readBack: null,
      ...(recoveredFrom ? { recoveredFrom } : {}),
    };
    if (dryRun) return result;

    // -- The recode itself: journal first, then each step; any failure undoes the done ones.
    await deps.assertMutationAllowed();
    const nextBefore = list.nextVideo;
    const journalPath = deps.journal.pathFor(channelId, video, deps.now());
    const journal: ReleaseRecodeJournal = {
      schema: "ytm-release-recode-journal/1",
      channelId,
      video,
      newCode,
      workspace,
      from,
      to,
      files,
      backups,
      written,
      snapshot,
      plan,
      storyboards,
      done: [],
      startedAt: deps.now().toISOString(),
    };
    await deps.journal.write(journalPath, journal);
    const mark = async (step: ReleaseRecodeStep) => {
      journal.done.push(step);
      await deps.journal.write(journalPath, journal);
    };
    let step: ReleaseRecodeStep = "files";
    try {
      step = "files";
      for (const file of files) await deps.rename(deps.join(fromAbs, ...file.from.split("/")), deps.join(fromAbs, ...file.to.split("/")));
      await mark("files");
      step = "manifest";
      await deps.writeText(deps.join(fromAbs, newManifestName), manifestNew);
      await mark("manifest");
      step = "records";
      for (const [name, text] of Object.entries(written)) if (name !== newManifestName) await deps.writeText(deps.join(fromAbs, name), text);
      await mark("records");
      step = "folder";
      await deps.rename(fromAbs, toAbs);
      await mark("folder");
      step = "rows";
      await deps.rows.recode(snapshot, plan);
      await mark("rows");
      step = "storyboards";
      for (const id of storyboards) await deps.storyboards.setVideo(channelId, id, newCode);
      await mark("storyboards");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await undo(journal);
      } catch (undoError) {
        await deps.audit({ channelId, video, detail: { event: "release.recode_failed", newCode, step, reason, rollback: "failed", journal: journalPath } }).catch(() => undefined);
        throw refuse("release_recode_rollback_failed", `The recode failed at ${step} and could not be undone; restore it by hand from ${journalPath}`, {
          ...details,
          step,
          journal: journalPath,
          reason,
          undoReason: undoError instanceof Error ? undoError.message : String(undoError),
        });
      }
      await deps.journal.remove(journalPath).catch(() => undefined);
      await deps.publishReports().catch(() => undefined);
      await deps.audit({ channelId, video, detail: { event: "release.recode_failed", newCode, step, reason, rollback: "done" } }).catch(() => undefined);
      throw refuse("release_recode_busy", `The recode failed at ${step} (${reason}); everything was put back. Try again`, { ...details, reason: "step_failed", step });
    }
    await deps.journal.remove(journalPath).catch(() => undefined);
    deps.invalidate(channelId);
    await deps.publishReports().catch(() => undefined);

    // -- Read back: the new folder holds the S package with the new hash; nothing named after the V is left; the rows moved with their
    // video ids; the list shows the S (with the video id) and the V as recoded; the next V is the same.
    const after = await deps.scan(channelId);
    const found = after.status === "ok" && after.packages.some((p) => p.video === newCode && p.folder === to && p.manifestSha256 === newSha256);
    const leftovers = (await deps.listFolder(toAbs)).some((e) => e.kind === "file" && renamedForCode(e.name, video, newCode) !== null);
    const rowsAfter = (await deps.uploads(channelId)).filter((r) => uploadPlans.some((u) => u.id === r.id));
    const rowsOk =
      rowsAfter.length === uploadPlans.length &&
      rowsAfter.every((r) => r.video === newCode && r.manifestSha256 === newSha256 && r.manifestPath === `${to}/${newManifestName}` && (r.videoId ?? null) === (snapshot.uploads.find((u) => u.id === r.id)?.videoId ?? null));
    const listAfter = await deps.videoList(channelId).catch(() => null);
    const oldEntry = listAfter?.videos.find((v) => v.video === video);
    const newEntry = listAfter?.videos.find((v) => v.video === newCode);
    const videoId = snapshot.uploads.find((u) => u.videoId)?.videoId ?? pkg.youtube?.videoId ?? null;
    const listOk = Boolean(listAfter) && oldEntry?.state === "recoded" && oldEntry?.recodedTo === newCode && newEntry !== undefined && (videoId === null || newEntry.youtubeVideoId === videoId) && listAfter!.nextVideo === nextBefore;
    const readBack = found && !leftovers && rowsOk && listOk && !(await deps.exists(fromAbs)) ? "verified" : "mismatch";
    await deps.audit({ channelId, video, detail: { event: "release.recoded", newCode, from, to, files: files.length, oldSha256, newSha256, uploads: uploadPlans.map((u) => u.id), readBack } });
    return { ...result, readBack };
  }
}

export type ReleaseRecode = ReturnType<typeof createReleaseRecode>;
