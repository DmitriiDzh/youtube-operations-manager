import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { getRestartQuietMinutesSetting, rawSqlClient, SCHEMA_CURRENT_VERSION, setRestartQuietMinutesSetting } from "@/lib/db";
import { getOperationLock } from "@/lib/operation-lock";
import { getOperationRegistry } from "@/lib/operation-progress";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createDefaultLogger } from "@/lib/shared-logger";
import { RESTART_REQUEST_FILE_NAME, type RestartBusyReaders } from "./contracts";
import { createRestartStore, createTableReaders } from "./adapters/store";
import { createRestartWhenIdle, type RestartWhenIdle } from "./services";

// BL-220 (docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md, ADR 0049): the restart-when-idle module wired to this computer -- the
// database, the other modules' busy state (read only), the developer's request file in the app-data folder, and SIGTERM to this
// process (the same graceful stop as stop.sh; launchd starts the next run, rebuilding first if `dev` moved).

/** The running build: package.json's version and the commit public/build-info.json names (the commit is what changes on a rebuild). */
function readBuild(): { version: string; schema: number } {
  let version = "unknown";
  try {
    const parsed = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) version = parsed.version;
  } catch {
    // keep "unknown"
  }
  try {
    const info = JSON.parse(readFileSync(path.join(process.cwd(), "public", "build-info.json"), "utf8")) as { gitCommit?: unknown };
    if (typeof info.gitCommit === "string" && /^[0-9a-f]{7,40}$/.test(info.gitCommit)) version = `${version} (${info.gitCommit.slice(0, 12)})`;
  } catch {
    // no build info (next dev before the first build): the version alone
  }
  return { version, schema: SCHEMA_CURRENT_VERSION };
}

/** Where the developer script writes its request: the app-data folder this server uses (~/Library/Application Support/... on a Mac). */
/** Review (BL-220): how long after its own stop signal a still-running process exits by itself. */
export const RESTART_FORCE_EXIT_MS = 90_000;

export function restartRequestFilePath(): string {
  return path.join(getProductionAppPaths().appDataDir, RESTART_REQUEST_FILE_NAME);
}

/** The file's text, removed before it is answered (taken once); null when there is none. The script's `.tmp` is never read. */
async function takeRequestFile(): Promise<string | null> {
  const file = restartRequestFilePath();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await unlink(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  return text;
}

function productionReaders(): RestartBusyReaders {
  const tables = createTableReaders(rawSqlClient);
  return {
    ...tables,
    async liveStreams() {
      // Loaded on use: a computer that runs no stream has no rows, and the module's own state (its locks) lives in this process.
      const { listLiveStreamTransitions } = await import("@/lib/live-streams");
      return (await listLiveStreamTransitions()).map((entry) => `${entry.channelId}:${entry.kind}`);
    },
    async operationLock() {
      return (await getOperationLock(rawSqlClient))?.operationType ?? null;
    },
    async operations() {
      return getOperationRegistry().hasActive() ? ["running"] : [];
    },
  };
}

// One instance per process, on globalThis: Next builds the instrumentation and the routes as separate bundles, and they must share the
// stop-once guard and the check's single-flight (the database state `restarting` is the guard across processes).
const CORE_KEY = Symbol.for("youtube-operations-manager.restart-when-idle");

/** The process's restart-when-idle core (the routes, the MCP tools and the server's check). */
export function createRestartWhenIdleCore(): RestartWhenIdle {
  const holder = globalThis as unknown as Record<symbol, RestartWhenIdle | undefined>;
  const existing = holder[CORE_KEY];
  if (existing) return existing;
  const logger = createDefaultLogger();
  const core = createRestartWhenIdle({
    store: createRestartStore(rawSqlClient, { get: () => getRestartQuietMinutesSetting(), set: (minutes) => setRestartQuietMinutesSetting(minutes) }),
    readers: productionReaders(),
    clock: () => Date.now(),
    newId: () => randomUUID(),
    serviceMode: () => process.env.YTOM_SERVICE_MODE === "1",
    build: readBuild,
    // Review (BL-220): the graceful stop can hang on a connection a browser keeps open (2026-10-13: the listener closed, the process
    // stayed, launchd waited -- the app was down for minutes). The shutdown hooks run at the signal; 90 s later a process that is still
    // here exits by itself so launchd starts the next run. The timer is unref'd: it never keeps a process alive that is ending anyway.
    stop: () => {
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {
        console.warn("[restart-when-idle] still running 90 s after its own stop signal; exiting so the service starts the next run");
        process.exit(0);
      }, RESTART_FORCE_EXIT_MS).unref();
    },
    takeRequestFile,
    log: (event, context) => logger.info({ event, context }),
  });
  holder[CORE_KEY] = core;
  return core;
}

export * from "./contracts";
export { isRestartHoldOwner, parseRequestFile } from "./services";
export type { RestartWhenIdle } from "./services";
