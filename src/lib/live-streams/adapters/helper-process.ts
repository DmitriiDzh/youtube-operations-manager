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
      new Promise((resolve, reject) => {
        execFile("ps", ["-ww", "-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
          // `ps` exits 1 when the pid is gone: not ours. Any other failure must not read as "no helper" (independent review:
          // that would start a second encoder beside a running one), so it is an error.
          if (error && (error as { code?: unknown }).code !== 1) return reject(new Error(`could not check the encoder process (${error.message})`));
          const command = error ? "" : String(stdout).trim();
          resolve(command.includes("encoder-helper.mjs") && command.endsWith(streamDir));
        });
      }),
    // An ffmpeg whose helper was killed outright keeps sending: it is found by its run list, `<streamDir>/run.ffconcat`.
    killStrayEncoders: (streamDir) =>
      new Promise((resolve, reject) => {
        execFile("ps", ["-ww", "-A", "-o", "pid=,command="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          if (error) return reject(new Error(`could not list processes (${error.message})`));
          const marker = path.join(streamDir, "run.ffconcat");
          const pids = String(stdout)
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
            .filter((m): m is RegExpExecArray => Boolean(m) && m![2].includes(marker) && !m![2].includes("encoder-helper.mjs"))
            .map((m) => Number(m[1]))
            .filter((p) => p !== process.pid);
          for (const p of pids) {
            try {
              process.kill(p, "SIGKILL");
            } catch {
              // already gone
            }
          }
          resolve(pids.length);
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
