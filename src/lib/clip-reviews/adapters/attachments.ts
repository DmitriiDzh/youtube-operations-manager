import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { resolveFromYtmFolder, resolveFromYtmFolderFile } from "@/lib/workspace-exchange";
import type { AttachmentToWrite, ClipReviewsPorts, StagedAttachment } from "../contracts";
import { workspaceRuleArgs } from "./files";

// BL-246 (ADR 0065, CLIP_REVIEWS_PLAN.md items 13-16): the owner's comment attachments on this computer -- staged in app data
// (never the channel folder, so Syncthing never carries a half-sent file), then copied into the decision's folder under
// `99 Data Exchange/From YTM/clip-reviews/` through the shared `workspace-exchange` rule.

const UPLOAD_ID = /^[a-f0-9]{32}$/;
const SUBFOLDER = "clip-reviews";

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest("hex");
}

/** Uploads staged in `dir`: `<uploadId>.json` (what the browser declared) and `<uploadId>.part` (the bytes so far). */
export function createAttachmentStaging(dir: string): ClipReviewsPorts["staging"] {
  const files = (uploadId: string) => {
    if (!UPLOAD_ID.test(uploadId)) throw new Error("not an upload id");
    return { meta: path.join(dir, `${uploadId}.json`), part: path.join(dir, `${uploadId}.part`) };
  };
  const remove = async (uploadId: string) => {
    const { meta, part } = files(uploadId);
    await rm(part, { force: true });
    await rm(meta, { force: true });
  };
  return {
    async create(upload: StagedAttachment) {
      await mkdir(dir, { recursive: true });
      const { meta, part } = files(upload.uploadId);
      await writeFile(part, new Uint8Array(), { flag: "wx" });
      await writeFile(meta, JSON.stringify(upload), { flag: "wx" });
    },
    async get(uploadId) {
      if (!UPLOAD_ID.test(uploadId)) return null;
      const { meta, part } = files(uploadId);
      const upload = await readFile(meta, "utf8").then((text) => JSON.parse(text) as StagedAttachment, () => null);
      const info = await stat(part).catch(() => null);
      if (!upload || !info?.isFile() || upload.uploadId !== uploadId) return null;
      return { upload, received: info.size, path: part };
    },
    async append(uploadId, bytes) {
      const { part } = files(uploadId);
      await appendFile(part, bytes);
      return (await stat(part)).size;
    },
    async head(uploadId, count) {
      const handle = await open(files(uploadId).part, "r");
      try {
        const buffer = Buffer.alloc(count);
        const { bytesRead } = await handle.read(buffer, 0, count, 0);
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
    readAll: async (uploadId) => new Uint8Array(await readFile(files(uploadId).part)),
    hash: (uploadId) => sha256Of(files(uploadId).part),
    remove,
    async removeOlderThan(cutoff) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const match = /^([a-f0-9]{32})\.(json|part)$/.exec(name);
        if (!match) continue;
        const info = await stat(path.join(dir, name)).catch(() => null);
        if (info && info.mtimeMs < cutoff.getTime()) await remove(match[1]).catch(() => undefined);
      }
    },
  };
}

/** The decision folders in the channel workspace, through the shared rule (plain folders, real paths inside the workspace). */
export function createAttachmentFiles(): ClipReviewsPorts["attachmentFiles"] {
  const decisionFolder = (workspace: string, clipId: string, decisionId: string) =>
    resolveFromYtmFolder({ ...workspaceRuleArgs(workspace), segments: [SUBFOLDER, clipId, decisionId], create: false });

  async function removeFolder(workspace: string, clipId: string, decisionId: string): Promise<void> {
    const folder = await decisionFolder(workspace, clipId, decisionId);
    if (!folder) return;
    await rm(folder, { recursive: true, force: true });
    // The clip's folder goes too when this was its only decision (rmdir refuses a folder that is not empty).
    await rmdir(path.dirname(folder)).catch(() => undefined);
  }

  return {
    async write(workspace, clipId, decisionId, list: readonly AttachmentToWrite[]) {
      const clipFolder = await resolveFromYtmFolder({ ...workspaceRuleArgs(workspace), segments: [SUBFOLDER, clipId], create: true });
      if (!clipFolder) throw new Error("the clip's folder could not be made");
      // A fresh folder per decision: an existing one (it never should) is refused rather than written into.
      await mkdir(path.join(clipFolder, decisionId));
      try {
        const folder = await decisionFolder(workspace, clipId, decisionId);
        if (!folder) throw new Error("the decision folder disappeared");
        for (const file of list) {
          if (!file.name || /[/\\\u0000]/.test(file.name) || file.name === "." || file.name === "..") throw new Error("not a file name");
          const target = path.join(folder, file.name);
          const temporary = path.join(folder, `.upload-${randomBytes(6).toString("hex")}.tmp`);
          await pipeline(createReadStream(file.sourcePath), createWriteStream(temporary, { flags: "wx" }));
          const written = await stat(temporary);
          if (written.size !== file.size) throw new Error(`${file.name}: ${written.size} bytes written, ${file.size} expected`);
          if ((await sha256Of(temporary)) !== file.sha256) throw new Error(`${file.name}: the written bytes differ`);
          if (await lstat(target).catch(() => null)) throw new Error(`${file.name} already exists`);
          await rename(temporary, target);
        }
      } catch (error) {
        await removeFolder(workspace, clipId, decisionId).catch(() => undefined);
        throw error;
      }
    },
    remove: removeFolder,
    async resolve(workspace, clipId, decisionId, name) {
      return resolveFromYtmFolderFile({ ...workspaceRuleArgs(workspace), segments: [SUBFOLDER, clipId, decisionId], fileName: name });
    },
  };
}
