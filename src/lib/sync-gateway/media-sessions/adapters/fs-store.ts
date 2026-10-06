import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import type { MediaSessionsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsMediaSessionsReportStore(dir: string): MediaSessionsReportStore {
  const peersDir = path.join(dir, "peers");
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
        const text = await readOrNull(path.join(peersDir, name));
        if (text) out[name.slice(0, -".json".length)] = text;
      }
      return out;
    },
    async writePeer(deviceId, json) {
      await mkdir(peersDir, { recursive: true });
      await writeFileAtomic(path.join(peersDir, `${safe(deviceId)}.json`), new TextEncoder().encode(json));
    },
  };
}
