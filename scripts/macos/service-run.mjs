// YouTube Operations Manager - macOS system service runner (BL-158).
//
// launchd starts THIS file with node itself (ProgramArguments of the daemon written by install-service.sh). macOS
// privacy protection (TCC) judges a launchd job's file access by the job's own executable, and both the repository
// (~/Documents) and the sync folder (an external drive) are protected -- so node, which the owner gives Full Disk
// Access, has to be that executable, not a shell. Without it node cannot even load this file; launchd's log
// (service.log) then shows "EPERM: operation not permitted, open '.../service-run.mjs'" (measured on the Mac).
//
// One run = build when needed (build-if-stale.sh, the launcher's own rule) -> `npm run start` in the foreground with
// YTOM_SERVICE_MODE=1 (idleness ends the browser session, never the process). When the server exits, this exits too
// and launchd starts the next run (KeepAlive), which rebuilds first if the checked-out commit changed -- so stopping
// the server (stop.sh) is how it is restarted. Only an accepted branch is built and run (accepted-branch.sh).
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

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function failAfterPause(message) {
  log(`[ERROR] ${message}`);
  log(`Next attempt in ${FAILURE_PAUSE_MS / 60_000} minutes.`);
  setTimeout(() => process.exit(1), FAILURE_PAUSE_MS);
}

/** null when the folder may be built and run; otherwise why not (accepted-branch.sh is the rule). */
function branchProblem() {
  const result = spawnSync("/bin/sh", [path.join(scriptDir, "accepted-branch.sh")], { encoding: "utf8" });
  const said = `${result.stdout ?? ""}`.trim();
  if (result.status === 0) return null;
  if (result.status === 4) {
    return (
      `The repository folder is on ${said.startsWith("a detached") ? said : `'${said}'`}, not on dev or main. The service ` +
      "builds and runs only an accepted branch (a new build migrates the real database). Switch back: git switch dev."
    );
  }
  return `Cannot tell which branch the repository folder is on: ${said || result.error?.message || `exit ${result.status}`}.`;
}

// What the current step is, so a stop request (launchd's SIGTERM on uninstall/reinstall/shutdown) does the right thing:
// the server gets the signal and drains; anything else stops at once. A build may be stopped: it never opens the real
// database (build-if-stale.sh), and when this process exits launchd ends the rest of the job's process group with it.
let phase = "checking"; // checking | building | serving | done
let server = null;
let build = null;
let stopRequested = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopRequested = true;
    if (phase === "serving" && server) {
      server.kill(signal); // npm passes it on to the server
      return;
    }
    if (phase === "building" && build) build.kill(signal);
    process.exit(0);
  });
}

function startServer() {
  // Same log file as the launcher's server (start.sh), truncated per run.
  const logPath = path.join(root, ".launcher.log");
  const startedAt = Date.now();
  // Not detached: the server stays in this job's process group, so launchd cleans it up if this process ever dies.
  try {
    const out = fs.openSync(logPath, "w");
    server = spawn("npm", ["run", "start"], { cwd: root, env: { ...process.env, YTOM_SERVICE_MODE: "1" }, stdio: ["ignore", out, out] });
  } catch (error) {
    phase = "done";
    failAfterPause(`Could not start the server: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  phase = "serving";
  log(`Server starting (npm pid ${server.pid}); its output is in ${logPath}.`);
  let spawnFailed = false;
  server.on("error", (error) => {
    spawnFailed = true;
    phase = "done";
    failAfterPause(`Could not start the server: ${error.message}`);
  });
  server.on("exit", (code, signal) => {
    if (spawnFailed) return;
    phase = "done";
    log(`Server exited (${signal ?? `exit ${code}`}); launchd starts the next run.`);
    // Stopped on purpose (stop.sh sends SIGTERM to the server; npm reports 143, or 130 for SIGINT) is a restart.
    // A crash -- even one by a signal such as SIGABRT or SIGKILL -- is not.
    const stopped = stopRequested || signal === "SIGTERM" || signal === "SIGINT" || code === 143 || code === 130;
    if (!stopped && Date.now() - startedAt < EARLY_EXIT_MS) {
      failAfterPause(`The server stopped within ${EARLY_EXIT_MS / 1000} s of starting -- see ${logPath}.`);
      return;
    }
    process.exit(code ?? 1);
  });
}

function main() {
  log(`Service run starting (pid ${process.pid}, node ${process.version}, ${root}).`);
  if (!fs.existsSync(path.join(root, ".env.local"))) {
    failAfterPause(`.env.local not found in ${root} -- copy .env.example to .env.local first (docs/getting-started.md).`);
    return;
  }
  const before = branchProblem();
  if (before) {
    failAfterPause(before);
    return;
  }

  phase = "building";
  build = spawn("/bin/sh", [path.join(scriptDir, "build-if-stale.sh")], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  build.on("error", (error) => {
    phase = "done";
    failAfterPause(`Could not run the build: ${error.message}`);
  });
  build.on("exit", (code, signal) => {
    if (phase !== "building") return; // already handled (spawn error)
    phase = "checking";
    if (code !== 0) {
      failAfterPause(`Building the application failed (${signal ?? `exit ${code}`}) -- see the output above.`);
      return;
    }
    // The folder may have been switched while building: check again right before the first start migrates.
    const after = branchProblem();
    if (after) {
      failAfterPause(after);
      return;
    }
    startServer();
  });
}

main();
