// YouTube Operations Manager - macOS system service runner (BL-158).
//
// launchd starts THIS file with node itself (ProgramArguments of the daemon written by install-service.sh). macOS
// privacy protection (TCC) judges a launchd job's file access by the job's own executable, and both the repository
// (~/Documents) and the sync folder (an external drive) are protected -- so node, which the owner gives Full Disk
// Access, has to be that executable, not a shell. If node lacks it, node cannot even load this file: launchd's log
// (service.log) then shows "EPERM ... service-run.mjs".
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
// A failing check, build or start must not loop every ThrottleInterval (a build is minutes of CPU each time).
const FAILURE_PAUSE_MS = 5 * 60_000;
// A server that exits this soon after starting failed to start (e.g. the port is taken): pause before the next run.
const EARLY_EXIT_MS = 60_000;
// Nobody watches this process build: it builds and migrates the real database only from an accepted branch.
const SERVICE_BRANCHES = ["dev", "main"];

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function failAfterPause(message) {
  log(`[ERROR] ${message}`);
  log(`Next attempt in ${FAILURE_PAUSE_MS / 60_000} minutes.`);
  setTimeout(() => process.exit(1), FAILURE_PAUSE_MS);
}

/** The checked-out branch, or null when this is not a git checkout (a published copy builds as before). */
function checkedOutBranch() {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "(detached HEAD)";
}

function main() {
  log(`Service run starting (pid ${process.pid}, node ${process.version}, ${root}).`);
  if (!fs.existsSync(path.join(root, ".env.local"))) {
    failAfterPause(`.env.local not found in ${root} -- copy .env.example to .env.local first (docs/getting-started.md).`);
    return;
  }
  const branch = checkedOutBranch();
  if (branch !== null && !SERVICE_BRANCHES.includes(branch)) {
    failAfterPause(
      `The repository folder is on '${branch}', not on ${SERVICE_BRANCHES.join("/")}. The service builds and runs only an ` +
        "accepted branch (an unreviewed build would migrate the real database). Switch the folder back, e.g. git switch dev."
    );
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
  const startedAt = Date.now();
  let running = true;
  let stopRequested = false;
  const server = spawn("npm", ["run", "start"], {
    cwd: root,
    env: { ...process.env, YTOM_SERVICE_MODE: "1" },
    stdio: ["ignore", out, out],
  });
  log(`Server starting (npm pid ${server.pid}); its output is in ${logPath}.`);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopRequested = true;
      if (!running) process.exit(0); // nothing to stop (e.g. during the failure pause)
      server.kill(signal); // npm passes it on to the server
    });
  }
  let spawnFailed = false;
  server.on("error", (error) => {
    running = false;
    spawnFailed = true;
    failAfterPause(`Could not start the server: ${error.message}`);
  });
  server.on("exit", (code, signal) => {
    running = false;
    if (spawnFailed) return;
    log(`Server exited (${signal ?? `exit ${code}`}); launchd starts the next run.`);
    // Stopped on purpose (stop.sh signals the server; 143/130 = SIGTERM/SIGINT) is a restart, never a failure.
    const stopped = stopRequested || signal !== null || code === 143 || code === 130;
    if (!stopped && code !== 0 && Date.now() - startedAt < EARLY_EXIT_MS) {
      failAfterPause(`The server stopped within ${EARLY_EXIT_MS / 1000} s of starting -- see ${logPath}.`);
      return;
    }
    process.exit(code ?? 1);
  });
}

main();
