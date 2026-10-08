// YouTube Operations Manager - macOS system service runner (BL-158).
//
// launchd starts THIS file with node itself (ProgramArguments of the daemon written by install-service.sh). macOS
// privacy protection (TCC) judges a launchd job's file access by the job's own executable, and both the repository
// (~/Documents) and the sync folder (an external drive) are protected -- so node, which the owner gives Full Disk
// Access, has to be that executable, not a shell. Everything started from here inherits that access.
//
// One run = build when needed (build-if-stale.sh, the launcher's own rule) -> `npm run start` in the foreground with
// YTOM_SERVICE_MODE=1 (idleness ends the browser session, never the process). When the server exits, this exits too
// and launchd starts the next run (KeepAlive), which rebuilds first if the checked-out commit changed -- so stopping
// the server (stop.sh) is how it is restarted.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
// A failing check or build must not loop every ThrottleInterval (a build is minutes of CPU each time).
const FAILURE_PAUSE_MS = 5 * 60_000;

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function failAfterPause(message) {
  log(`[ERROR] ${message}`);
  log(`Next attempt in ${FAILURE_PAUSE_MS / 60_000} minutes.`);
  setTimeout(() => process.exit(1), FAILURE_PAUSE_MS);
}

function main() {
  log(`Service run starting (pid ${process.pid}, node ${process.version}, ${root}).`);
  try {
    fs.accessSync(path.join(root, ".env.local"), fs.constants.R_OK);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      failAfterPause(
        `macOS does not let node read ${root} (${error.code}). Give Full Disk Access to ${fs.realpathSync(process.execPath)} ` +
          "in System Settings > Privacy & Security > Full Disk Access -- again after every node upgrade."
      );
    } else {
      failAfterPause(`.env.local not found in ${root} -- copy .env.example to .env.local first (docs/getting-started.md).`);
    }
    return;
  }

  const build = spawnSync("/bin/sh", [path.join(scriptDir, "build-if-stale.sh")], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) {
    failAfterPause(`Building the application failed (${build.signal ?? `exit ${build.status}`}) -- see the output above.`);
    return;
  }

  // Same log file as the launcher's server (start.sh), truncated per run.
  const logPath = path.join(root, ".launcher.log");
  const out = fs.openSync(logPath, "w");
  // Not detached: the server stays in this job's process group, so launchd cleans it up if this process ever dies.
  const server = spawn("npm", ["run", "start"], {
    cwd: root,
    env: { ...process.env, YTOM_SERVICE_MODE: "1" },
    stdio: ["ignore", out, out],
  });
  log(`Server starting (npm pid ${server.pid}); its output is in ${logPath}.`);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      try {
        server.kill(signal); // npm passes it on to the server
      } catch {
        // already gone
      }
    });
  }
  server.on("error", (error) => failAfterPause(`Could not start the server: ${error.message}`));
  server.on("exit", (code, signal) => {
    log(`Server exited (${signal ?? `exit ${code}`}); launchd starts the next run.`);
    process.exit(code ?? 1);
  });
}

main();
