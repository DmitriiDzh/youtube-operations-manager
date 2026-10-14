import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { DomainError } from "../contracts";
import type { ThumbnailStore } from "../video-settings";

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §3.1): each channel's stream thumbnail on this computer, `<dir>/<channelId>.jpg|png`, written
// atomically; choosing a new one removes the other kind. Device-local like the rest of `live_streams`.
const EXTENSIONS = { jpeg: "jpg", png: "png" } as const;

export function createThumbnailFs(dir: string): ThumbnailStore {
  function fileOf(channelId: string, kind: "jpeg" | "png"): string {
    // A channel id names the file: only YouTube's id characters, never a path.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) throw new DomainError({ code: "validation_failed", message: "Invalid channel id" });
    return path.join(dir, `${channelId}.${EXTENSIONS[kind]}`);
  }
  return {
    async write(channelId, kind, bytes) {
      await writeFileAtomic(fileOf(channelId, kind), bytes);
      await rm(fileOf(channelId, kind === "jpeg" ? "png" : "jpeg"), { force: true });
    },
    async read(channelId) {
      for (const kind of ["jpeg", "png"] as const) {
        const bytes = await readFile(fileOf(channelId, kind)).catch(() => null);
        if (bytes) return { kind, bytes: new Uint8Array(bytes) };
      }
      return null;
    },
    async remove(channelId) {
      for (const kind of ["jpeg", "png"] as const) await rm(fileOf(channelId, kind), { force: true });
    },
  };
}
