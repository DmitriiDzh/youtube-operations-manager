import path from "node:path";
import { DomainError } from "@/lib/shared-domain";
import {
  MIN_BUNDLE_VERSION,
  WEEKLY_BUILD_DAYS_MAX,
  WEEKLY_BUILD_DAYS_MIN,
  WEEKLY_PLAN_WORKFLOW,
  type WeeklyBuildBlockCode,
  type WeeklyBuildDryRun,
  type WeeklyBuildJob,
  type WeeklyBuildReadiness,
  type WeeklyBuildSettings,
  type WeeklyBuildSlot,
  type WeeklyBuildStarted,
  type WeeklyBuildStatus,
  type WeeklyBuildStep,
  type WeeklyBuildView,
} from "./contracts";
import type { RunScript, ScriptEnv, ScriptResult } from "./host";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md §1-§3): readiness, then one call of the channel's launcher per action. Every run goes
// through `runLauncher` (fixed arguments, the workspace as cwd, the filtered environment, a timeout). `check` must pass and the
// pinned bundle must be 2.5.42+ before any run; a passed check is remembered while the launcher and factory.json keep their size
// and mtime, for 5 minutes.

export type WeeklyBuildFs = {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ isFile: boolean; size: number; mtimeMs: number }>;
  readFile(p: string): Promise<string>;
};

export type WeeklyBuildDeps = {
  getWorkspace(channelId: string): Promise<{ configured: false } | { configured: true; path: string }>;
  getSettings(): Promise<WeeklyBuildSettings>;
  findPython(configured: string | null): Promise<string | null>;
  run: RunScript;
  env(): ScriptEnv;
  fs: WeeklyBuildFs;
  isPathInsideOrEqual(parent: string, child: string): boolean;
  now(): number;
};

const SHORT_TIMEOUT_MS = 60_000;
const DRY_RUN_TIMEOUT_MS = 180_000;
const CACHE_MS = 5 * 60_000;

/** Numeric dotted versions: -1 / 0 / 1. A part that is not a number makes the version unreadable (null). */
export function compareVersions(a: string, b: string): number | null {
  const pa = a.trim().split(".");
  const pb = b.trim().split(".");
  if (![...pa, ...pb].every((p) => /^\d+$/.test(p))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** stdout is one JSON object; when other lines precede it, the last non-empty line is tried. */
export function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const attempt = (text: string) => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const whole = attempt(trimmed);
  if (whole) return whole;
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  return attempt(lines[lines.length - 1] ?? "");
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** `13 status --json` to the view's shape; null when it is not that object. */
export function parseStatus(raw: Record<string, unknown>): WeeklyBuildStatus | null {
  if (!Array.isArray(raw.slots) || typeof raw.stopped !== "boolean") return null;
  const plan = obj(raw.plan);
  const job = obj(raw.job);
  const request = obj(raw.packageRequest);
  const slots: WeeklyBuildSlot[] = [];
  for (const item of raw.slots) {
    const s = obj(item);
    const slotId = str(s?.slotId);
    if (!s || !slotId) continue;
    slots.push({
      slotId,
      date: str(s.date) ?? "",
      status: str(s.status) ?? "?",
      video: str(s.video),
      folder: str(s.folder),
      hours: num(s.hours),
      problems: Array.isArray(s.problems) ? s.problems.map((p) => (typeof p === "string" ? p : JSON.stringify(p))) : [],
      retryable: s.retryable === true,
    });
  }
  const parsedJob: WeeklyBuildJob | null =
    job && str(job.jobId)
      ? { jobId: str(job.jobId)!, state: str(job.state) ?? "?", args: strings(job.args), startedAt: str(job.startedAt), finishedAt: str(job.finishedAt), exitCode: num(job.exitCode) }
      : null;
  return {
    plan: plan && str(plan.file) ? { file: str(plan.file)!, start: str(plan.start), days: num(plan.days) ?? slots.length } : null,
    stopped: raw.stopped,
    job: parsedJob,
    packageRequest: request ? { file: str(request.file), writtenAt: str(request.writtenAt), slots: strings(request.slots), pending: request.pending === true } : null,
    slots,
    line: str(raw.line),
  };
}

const isRunningState = (state: string | undefined) => state === "running" || state === "starting";

function tail(text: string, max = 800): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function validateDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isInteger(days) || days < WEEKLY_BUILD_DAYS_MIN || days > WEEKLY_BUILD_DAYS_MAX) {
    throw new DomainError({ code: "validation_failed", message: `days must be a whole number from ${WEEKLY_BUILD_DAYS_MIN} to ${WEEKLY_BUILD_DAYS_MAX}`, details: { days } });
  }
  return days;
}

type Ready = { workspace: string; launcher: string; python: string; bundle: string };

export function createWeeklyBuildServices(deps: WeeklyBuildDeps) {
  const checkPassed = new Map<string, { key: string; at: number }>();
  const pythonCache = new Map<string, { python: string | null; at: number }>();
  const busy = new Set<string>();

  const blocked = (code: WeeklyBuildBlockCode, message: string, bundle: string | null = null, python: string | null = null): { readiness: WeeklyBuildReadiness; ctx: null } => ({
    readiness: { ready: false, code, message, bundle, python },
    ctx: null,
  });

  async function python(): Promise<string | null> {
    const configured = (await deps.getSettings()).pythonPath;
    const key = configured ?? "";
    const cached = pythonCache.get(key);
    if (cached && deps.now() - cached.at < CACHE_MS) return cached.python;
    const found = await deps.findPython(configured);
    pythonCache.set(key, { python: found, at: deps.now() });
    return found;
  }

  function runLauncher(ctx: { workspace: string; launcher: string; python: string }, args: string[], timeoutMs = SHORT_TIMEOUT_MS): Promise<ScriptResult> {
    return deps.run(ctx.python, ["-B", ctx.launcher, ...args], { cwd: ctx.workspace, env: deps.env(), timeoutMs });
  }

  async function readiness(channelId: string): Promise<{ readiness: WeeklyBuildReadiness; ctx: Ready | null }> {
    const ws = await deps.getWorkspace(channelId);
    if (!ws.configured) return blocked("workspace_missing", "This channel has no workspace folder on this computer (Settings → Channels).");
    let workspace: string;
    let launcher: string;
    let launcherStat: { isFile: boolean; size: number; mtimeMs: number };
    try {
      workspace = await deps.fs.realpath(ws.path);
      launcher = await deps.fs.realpath(path.join(workspace, "06 Workflows", "factory_launch.py"));
      launcherStat = await deps.fs.stat(launcher);
    } catch {
      return blocked("launcher_missing", "The channel folder has no 06 Workflows/factory_launch.py.");
    }
    if (!deps.isPathInsideOrEqual(workspace, launcher) || !launcherStat.isFile) {
      return blocked("launcher_missing", "06 Workflows/factory_launch.py is not a file inside the channel folder.");
    }
    const factoryJson = path.join(path.dirname(launcher), "factory.json");
    let bundle: string | null = null;
    let factoryStat: { size: number; mtimeMs: number } | null = null;
    try {
      factoryStat = await deps.fs.stat(factoryJson);
      bundle = str(obj(JSON.parse(await deps.fs.readFile(factoryJson)))?.workflow_bundle);
    } catch {
      bundle = null;
    }
    const cmp = bundle ? compareVersions(bundle, MIN_BUNDLE_VERSION) : null;
    if (cmp === null || cmp < 0) {
      return blocked("bundle_too_old", `The channel is pinned to factory bundle ${bundle ?? "?"}; the weekly build needs ${MIN_BUNDLE_VERSION} or newer (the Factory Operator pins it).`, bundle);
    }
    const py = await python();
    if (!py) return blocked("python_missing", "No Python 3.9+ found on this computer; set its path below.", bundle);
    const ctx: Ready = { workspace, launcher, python: py, bundle: bundle! };
    const key = [launcherStat.size, launcherStat.mtimeMs, factoryStat?.size, factoryStat?.mtimeMs, py].join(":");
    const passed = checkPassed.get(channelId);
    if (!passed || passed.key !== key || deps.now() - passed.at >= CACHE_MS) {
      const result = await runLauncher(ctx, ["check"]);
      if (result.exitCode !== 0) {
        checkPassed.delete(channelId);
        return blocked("launcher_check_failed", tail(`${result.stdout}\n${result.stderr}`) || "factory_launch.py check failed.", bundle, py);
      }
      checkPassed.set(channelId, { key, at: deps.now() });
    }
    return { readiness: { ready: true, bundle: ctx.bundle, python: py }, ctx };
  }

  async function requireReady(channelId: string): Promise<Ready> {
    const { readiness: r, ctx } = await readiness(channelId);
    if (!r.ready || !ctx) {
      throw new DomainError({ code: "weekly_build_unavailable", message: r.ready ? "Not ready" : r.message, details: { channelId, code: r.ready ? null : r.code } });
    }
    return ctx;
  }

  function failed(what: string, result: ScriptResult): DomainError {
    const reason = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
    return new DomainError({ code: "weekly_build_failed", message: `${what} failed (${reason}): ${tail(`${result.stdout}\n${result.stderr}`)}`, details: { exitCode: result.exitCode, timedOut: result.timedOut } });
  }

  async function readStatus(ctx: Ready): Promise<WeeklyBuildStatus> {
    const result = await runLauncher(ctx, ["run", WEEKLY_PLAN_WORKFLOW, "status", "--json"]);
    if (result.exitCode !== 0) throw failed("status", result);
    const parsed = parseJsonOutput(result.stdout);
    const status = parsed ? parseStatus(parsed) : null;
    if (!status) throw failed("status (unreadable answer)", { ...result, exitCode: 0 });
    return status;
  }

  async function exclusive<T>(channelId: string, run: () => Promise<T>): Promise<T> {
    if (busy.has(channelId)) {
      throw new DomainError({ code: "weekly_build_job_running", message: "A start or stop of this channel's weekly build is already in progress.", details: { channelId } });
    }
    busy.add(channelId);
    try {
      return await run();
    } finally {
      busy.delete(channelId);
    }
  }

  return {
    async view(channelId: string): Promise<WeeklyBuildView> {
      const { readiness: r, ctx } = await readiness(channelId);
      if (!ctx) return { readiness: r, status: null, statusError: null, running: false };
      try {
        const status = await readStatus(ctx);
        return { readiness: r, status, statusError: null, running: isRunningState(status.job?.state) };
      } catch (error) {
        return { readiness: r, status: null, statusError: error instanceof Error ? error.message : String(error), running: false };
      }
    },

    async dryRun(channelId: string, input: { days: unknown; wake?: unknown }): Promise<WeeklyBuildDryRun> {
      const days = validateDays(input.days);
      const ctx = await requireReady(channelId);
      const args = ["run", WEEKLY_PLAN_WORKFLOW, "auto", "--days", String(days), "--dry-run", ...(input.wake === true ? ["--wake"] : []), "--json"];
      const result = await runLauncher(ctx, args, DRY_RUN_TIMEOUT_MS);
      if (result.exitCode !== 0) throw failed("dry run", result);
      const parsed = parseJsonOutput(result.stdout);
      if (!parsed || !Array.isArray(parsed.steps)) throw failed("dry run (unreadable answer)", { ...result, exitCode: 0 });
      const steps: WeeklyBuildStep[] = parsed.steps.flatMap((item) => {
        const s = obj(item);
        return s && str(s.step) ? [{ step: str(s.step)!, text: str(s.text) ?? "", slots: strings(s.slots) }] : [];
      });
      const status = await readStatus(ctx).catch(() => null);
      return { days, steps, plan: str(parsed.plan), stopped: status?.stopped ?? false };
    },

    async start(channelId: string, input: { days: unknown; wake?: unknown }): Promise<WeeklyBuildStarted> {
      const days = validateDays(input.days);
      const wake = input.wake === true;
      return exclusive(channelId, async () => {
        const ctx = await requireReady(channelId);
        const status = await readStatus(ctx);
        if (isRunningState(status.job?.state)) {
          throw new DomainError({ code: "weekly_build_job_running", message: `The weekly build already runs (job ${status.job!.jobId}).`, details: { jobId: status.job!.jobId } });
        }
        let clearedStop = false;
        if (status.stopped) {
          const go = await runLauncher(ctx, ["run", WEEKLY_PLAN_WORKFLOW, "go"]);
          if (go.exitCode !== 0) throw failed("clearing STOP (go)", go);
          clearedStop = true;
        }
        const result = await runLauncher(ctx, ["start", WEEKLY_PLAN_WORKFLOW, "auto", "--days", String(days), ...(wake ? ["--wake"] : []), "--json"]);
        const parsed = parseJsonOutput(result.stdout);
        if (result.exitCode !== 0) {
          if (parsed?.error === "job_running") {
            throw new DomainError({ code: "weekly_build_job_running", message: `The weekly build already runs (job ${str(parsed.jobId) ?? "?"} on ${str(parsed.device) ?? "?"}).`, details: { jobId: str(parsed.jobId), device: str(parsed.device) } });
          }
          if (parsed && str(parsed.message)) throw new DomainError({ code: "weekly_build_failed", message: `start failed: ${str(parsed.message)}`, details: { exitCode: result.exitCode } });
          throw failed("start", result);
        }
        if (!parsed || !str(parsed.jobId)) throw failed("start (unreadable answer)", { ...result, exitCode: 0 });
        return { jobId: str(parsed.jobId)!, log: str(parsed.log) ?? "", pid: num(parsed.pid), clearedStop };
      });
    },

    async stop(channelId: string): Promise<{ stopped: true }> {
      return exclusive(channelId, async () => {
        const ctx = await requireReady(channelId);
        const result = await runLauncher(ctx, ["run", WEEKLY_PLAN_WORKFLOW, "stop"]);
        if (result.exitCode !== 0) throw failed("stop", result);
        return { stopped: true as const };
      });
    },
  };
}

export type WeeklyBuildService = ReturnType<typeof createWeeklyBuildServices>;
