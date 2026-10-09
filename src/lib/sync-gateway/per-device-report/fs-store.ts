import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import type { PerDeviceReportStore } from "./index";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsPerDeviceReportStore(dir: string): PerDeviceReportStore {
  const peersDir = path.join(dir, "peers");
  // BL-162 (review): the review screen asks for the other devices' claims every 3 s; a peer report (up to 4 MB) is read from
  // disk again only when its file changed (size or modification time).
  const peerCache = new Map<string, { mtimeMs: number; size: number; text: string }>();
  const safe = (deviceId: string) => deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const readOrNull = async (file: string) => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    readLocal: () => readOrNull(path.join(dir, "local.json")),
    async writeLocal(json) {
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(path.join(dir, "local.json"), new TextEncoder().encode(json));
    },
    async readPeers() {
      let names: string[];
      try {
        names = await readdir(peersDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
      const out: Record<string, string> = {};
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const file = path.join(peersDir, name);
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        const hit = peerCache.get(name);
        let text: string | null;
        if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
          text = hit.text;
        } else {
          text = await readOrNull(file);
          if (text) peerCache.set(name, { mtimeMs: info.mtimeMs, size: info.size, text });
        }
        if (text) out[name.slice(0, -".json".length)] = text;
      }
      return out;
    },
    async writePeer(deviceId, json) {
      peerCache.delete(`${safe(deviceId)}.json`);
      await mkdir(peersDir, { recursive: true });
      await writeFileAtomic(path.join(peersDir, `${safe(deviceId)}.json`), new TextEncoder().encode(json));
    },
  };
}
