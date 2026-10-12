import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupervisorDependencies } from "../supervisor";

// BL-176 (LIVE_STREAMS_PLAN.md §3.6, spike A §6.1): the encoder helper runs as its own node process in its own process
// group (`detached`), so it survives the server's restart and the launchd job's restart. The key goes to its stdin and
// the pipe is closed at once; nothing else of the server is shared with it.

export const HELPER_SCRIPT = path.join("src", "lib", "live-streams", "helper", "encoder-helper.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
      return isAlive(pid);
    },
    // A pid is ours only if its command line is `node …/encoder-helper.mjs <this stream's folder>`: after a reboot or a crash
    // the number may belong to anything (independent review).
    isOurHelper: (pid, streamDir) =>
      new Promise((resolve) => {
        execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
          const command = error ? "" : String(stdout).trim();
          resolve(command.includes("encoder-helper.mjs") && command.endsWith(streamDir));
        });
      }),
    // The helper is spawned `detached` (its own process group, ffmpeg inside it): the group goes down together.
    signalGroup(pid, signal) {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // already gone
        }
      }
    },
    async waitForExit(pid, timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (!isAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return !isAlive(pid);
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
