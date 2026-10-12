import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupervisorDependencies } from "../supervisor";

// BL-176 (LIVE_STREAMS_PLAN.md §3.6, spike A §6.1): the encoder helper runs as its own node process in its own process
// group (`detached`), so it survives the server's restart and the launchd job's restart. The key goes to its stdin and
// the pipe is closed at once; nothing else of the server is shared with it.

export const HELPER_SCRIPT = path.join("src", "lib", "live-streams", "helper", "encoder-helper.mjs");

export function createHelperProcess(root: string = process.cwd()): SupervisorDependencies["process"] {
  return {
    async spawnHelper(streamDir, key) {
      const child = spawn(process.execPath, [path.join(root, HELPER_SCRIPT), streamDir], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("spawn", () => (child.pid ? resolve(child.pid) : reject(new Error("the helper has no pid"))));
        child.once("error", reject);
      });
      child.stdin?.end(`${key}\n`);
      child.unref();
      return pid;
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    },
  };
}

export function createSupervisorFiles(): SupervisorDependencies["files"] {
  return {
    read: async (file) => readFile(file, "utf8").catch(() => null),
    async writeAtomic(file, text) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, text);
      await rename(`${file}.tmp`, file);
    },
  };
}
