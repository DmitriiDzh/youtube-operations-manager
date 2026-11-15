import { DomainError } from "@/lib/shared-domain";
import type { StoredPublishingUpload } from "@/lib/db";
import type { PackageScanResult } from "./package-scan";

// BL-261 (owner TG 3521 via the Factory Operator, 2026-11-15: the WWE Short folders get the « Short» suffix): rename one release
// package's folder under `04 Videos/` -- the folder moves as a whole (manifest, video, thumbnails, the upload record), and this
// computer's upload rows that name it are rewritten in one transaction (their manifest path and the package's file paths). Refused
// while the video is being sent or finished here, while another computer reports an upload of it not finished, or while a
// cross-post of it uploads its file. Never a YouTube call; the manifest, its SHA-256 and every review or approval stay the same.

export type ReleaseFolderRenameInput = { channelId: string; video: string; newName: string; dryRun?: boolean };

export type ReleaseFolderRenameResult = {
  dryRun: boolean;
  video: string;
  /** The folder relative to the workspace, before and after. */
  from: string;
  to: string;
  /** This computer's upload rows naming the folder (rewritten, or to rewrite on a dry run). */
  uploads: number;
  /** false: nothing to do (the folder already has that name). */
  changed: boolean;
  /** After a real rename: the new folder holds the package, the old one is gone, every row names the new folder. */
  readBack: "verified" | "mismatch" | null;
};

export type ReleaseFolderRenameDeps = {
  workspace(channelId: string): Promise<string | null>;
  /** A fresh scan of the channel's packages (never a cached one). */
  scan(channelId: string): Promise<PackageScanResult>;
  /** This computer's upload rows of the channel (every status). */
  uploads(channelId: string): Promise<StoredPublishingUpload[]>;
  /** Other computers' uploads of the channel by video number (`uploaded`: finished there). */
  peerUploads(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>>;
  /** Whether a cross-post of the video is uploading or processing its file now. */
  socialBusy(channelId: string, video: string): Promise<boolean>;
  /** Whether a path exists (any kind, symlinks not followed). */
  exists(absolutePath: string): Promise<boolean>;
  /** Whether the folder is a real directory inside the workspace (its real path, no symlink). */
  isRealFolder(workspace: string, relativeFolder: string): Promise<boolean>;
  rename(fromAbsolute: string, toAbsolute: string): Promise<void>;
  rewriteUploads(updates: Array<{ id: string; fromManifestPath: string; manifestPath: string; packageJson: string }>): Promise<number>;
  assertMutationAllowed(): Promise<void>;
  audit(entry: { channelId: string; video: string; detail: Record<string, unknown> }): Promise<void>;
  /** The package scan caches are stale once the folder moved. */
  invalidate(channelId: string): void;
  join(...parts: string[]): string;
};

/** Rows that read the folder now or soon in a way a rename would break: sending, YouTube processing, the finishing steps, paused. */
const BUSY = new Set(["uploading", "processing", "finishing", "paused"]);
/** Characters no folder name may hold on either computer (macOS and Windows). */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

const refuse = (code: "release_folder_not_found" | "release_folder_ambiguous" | "release_folder_name_invalid" | "release_folder_target_exists" | "release_folder_busy", message: string, details: Record<string, unknown>) =>
  new DomainError({ code, message, details });

/** The name check (pure): a single folder name, valid on macOS and Windows, that still names the video (`V65` as a word). */
export function folderNameProblem(name: string, video: string): string | null {
  if (name.length === 0 || name.length > 120) return "length";
  if (BAD_NAME.test(name)) return "characters";
  if (name !== name.trim() || name.endsWith(".") || name === "." || name === "..") return "edges";
  if (!new RegExp(`(^|[^A-Za-z0-9])${video}([^0-9]|$)`).test(name)) return "missing_video";
  return null;
}

/** Every string in the stored package that starts with `from/` now starts with `to/` (manifest path, video, thumbnails). */
export function rewritePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value === from || value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewritePaths(v, from, to)]));
  return value;
}

export function createReleaseFolderRename(deps: ReleaseFolderRenameDeps) {
  return {
    async rename(input: ReleaseFolderRenameInput): Promise<ReleaseFolderRenameResult> {
      const { channelId, video, newName } = input;
      const dryRun = input.dryRun === true;
      const details = { channelId, video, newName };
      if (!/^V\d{1,6}$/.test(video)) throw refuse("release_folder_name_invalid", "video must be a video number like V65", { ...details, reason: "video" });
      const nameProblem = folderNameProblem(newName, video);
      if (nameProblem) throw refuse("release_folder_name_invalid", `The new folder name is not usable (${nameProblem})`, { ...details, reason: nameProblem });
      const workspace = await deps.workspace(channelId);
      if (!workspace) throw refuse("release_folder_not_found", "The channel has no workspace on this computer", details);
      const scanned = await deps.scan(channelId);
      if (scanned.status !== "ok") throw refuse("release_folder_not_found", "The channel's packages cannot be read now", { ...details, scan: scanned.status });
      const matches = scanned.packages.filter((p) => p.video === video);
      if (matches.length === 0) throw refuse("release_folder_not_found", `No release package of ${video} in the channel's folders`, details);
      if (new Set(matches.map((p) => p.folder)).size > 1) throw refuse("release_folder_ambiguous", `${video} has packages in several folders; rename it by hand`, { ...details, folders: matches.map((p) => p.folder) });
      const from = matches[0].folder;
      if (!from.startsWith("04 Videos/")) throw refuse("release_folder_not_found", "The package is not under 04 Videos/", { ...details, folder: from });
      const parent = from.slice(0, from.lastIndexOf("/"));
      const to = `${parent}/${newName}`;
      const ownRows = (await deps.uploads(channelId)).filter((row) => row.manifestPath === from || row.manifestPath.startsWith(`${from}/`));
      if (to === from) return { dryRun, video, from, to, uploads: ownRows.length, changed: false, readBack: null };
      if (!(await deps.isRealFolder(workspace, from))) throw refuse("release_folder_not_found", "The package's folder is not a real folder inside the workspace", { ...details, folder: from });
      if (await deps.exists(deps.join(workspace, ...to.split("/")))) throw refuse("release_folder_target_exists", `A folder named ${newName} already exists there`, { ...details, to });
      const sending = ownRows.filter((row) => BUSY.has(row.status));
      if (sending.length > 0) throw refuse("release_folder_busy", `${video} is being uploaded on this computer; rename it when the upload finished`, { ...details, reason: "upload_here", uploads: sending.map((r) => ({ uploadId: r.id, status: r.status })) });
      const peer = (await deps.peerUploads(channelId)).get(video);
      if (peer && !peer.uploaded) throw refuse("release_folder_busy", `${video} has an upload not finished on ${peer.host ?? "another computer"}; rename it there or when it finished`, { ...details, reason: "upload_elsewhere", host: peer.host });
      if (await deps.socialBusy(channelId, video)) throw refuse("release_folder_busy", `A cross-post of ${video} is uploading its file; rename it when that finished`, { ...details, reason: "cross_post" });

      const updates = ownRows.map((row) => {
        let pkg: unknown;
        try {
          pkg = JSON.parse(row.packageJson);
        } catch {
          pkg = null;
        }
        return { id: row.id, fromManifestPath: row.manifestPath, manifestPath: rewritePaths(row.manifestPath, from, to) as string, packageJson: pkg === null ? row.packageJson : JSON.stringify(rewritePaths(pkg, from, to)) };
      });
      if (dryRun) return { dryRun, video, from, to, uploads: updates.length, changed: true, readBack: null };

      await deps.assertMutationAllowed();
      const fromAbs = deps.join(workspace, ...from.split("/"));
      const toAbs = deps.join(workspace, ...to.split("/"));
      await deps.rename(fromAbs, toAbs);
      try {
        await deps.rewriteUploads(updates);
      } catch (error) {
        // The rows still name the old folder: put it back, so nothing points at a folder that is not there.
        await deps.rename(toAbs, fromAbs).catch(() => undefined);
        deps.invalidate(channelId);
        throw error;
      }
      deps.invalidate(channelId);
      // Read back: the new folder holds the package, the old one is gone, every row names the new folder.
      const after = await deps.scan(channelId);
      const found = after.status === "ok" && after.packages.some((p) => p.video === video && p.folder === to);
      const rows = (await deps.uploads(channelId)).filter((row) => updates.some((u) => u.id === row.id));
      const rowsOk = rows.length === updates.length && rows.every((row) => row.manifestPath.startsWith(`${to}/`));
      const readBack = found && rowsOk && !(await deps.exists(fromAbs)) ? "verified" : "mismatch";
      await deps.audit({ channelId, video, detail: { event: "release_folder.renamed", from, to, uploads: updates.map((u) => u.id), readBack } });
      return { dryRun, video, from, to, uploads: updates.length, changed: true, readBack };
    },
  };
}

export type ReleaseFolderRename = ReturnType<typeof createReleaseFolderRename>;
