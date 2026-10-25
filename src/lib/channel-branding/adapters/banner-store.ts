import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelBannerMimeType } from "../draft";
import type { ChannelBrandingDependencies } from "../contracts";

// BL-223 (CHANNEL_BRANDING_PLAN.md §1): the draft's banner, copied into the app data folder on save --
// `<root>/<channelId>/banner.<jpg|png>` -- so the file the owner previewed cannot change before «Применить» (the service also checks
// its SHA-256 at apply). Written to a temporary name and renamed; the other extension is removed so one banner exists per channel.

const EXTENSION: Record<ChannelBannerMimeType, string> = { "image/jpeg": "jpg", "image/png": "png" };

function channelDir(root: string, channelId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) throw new Error("not a channel id");
  return path.join(root, channelId);
}

export function createBannerStore(root: string): ChannelBrandingDependencies["banners"] {
  return {
    async write(channelId, banner) {
      const dir = channelDir(root, channelId);
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `banner.${EXTENSION[banner.mimeType]}`);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, banner.bytes);
      await rename(temporary, target);
      for (const [mimeType, extension] of Object.entries(EXTENSION)) {
        if (mimeType !== banner.mimeType) await rm(path.join(dir, `banner.${extension}`), { force: true });
      }
    },
    async read(channelId, mimeType) {
      try {
        return await readFile(path.join(channelDir(root, channelId), `banner.${EXTENSION[mimeType]}`));
      } catch {
        return null;
      }
    },
    async remove(channelId) {
      const dir = channelDir(root, channelId);
      for (const extension of Object.values(EXTENSION)) await rm(path.join(dir, `banner.${extension}`), { force: true });
    },
  };
}
