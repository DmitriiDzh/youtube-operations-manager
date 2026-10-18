import { DomainError, MEDIA_SESSION_TERMINAL_STATUSES, RUNTIME_ID_PATTERN, type MediaSession, type MediaSettings } from "./contracts";
import type { MediaControlEvent, PullActor } from "./models";
import type { RuntimeBuildJob } from "./runtime-builds";
import { missingNodeTypes, type RuntimeTestResult } from "./runtimes";

// ---------------------------------------------------------------------------
// BL-200 stage 3 (ADR 0043, POD_RUNTIMES_PLAN.md §5, AC-RT-05/09): testing a pod runtime profile. A test is asynchronous and is
// advanced by the watch loop, one step per tick:
//   building  the profile has no `.ready` yet: its CPU build runs (started by the test unless one already runs)
//   starting  a short GPU session on the runtime -- its USD cap is the owner's `runtimeTestMaxUsd`, its minutes are what that
//             cap buys at the session's price (AC-RT-09) -- is started and waited for
//   (check)   once running: `/object_info` and `/system_stats`; each template's graph against the node list; the session is
//             stopped; `test.json` is written beside the profile (AC-RT-05)
//   passed | failed
// Only node presence is checked, never a template's smoke job (plan, not in scope).
// ---------------------------------------------------------------------------

/** A test session needs this many minutes at least: ~1 min boot, the two reads, the stop. */
export const RUNTIME_TEST_MIN_MINUTES = 3;
/** And never more than this, whatever the cap would buy. */
export const RUNTIME_TEST_MAX_MINUTES = 15;
/** A test whose session has not run after this long (capacity wait, a slow start) is given up and its session stopped. */
const SESSION_WAIT_CAP_MS = 45 * 60_000;
const TERMINAL: ReadonlySet<string> = new Set(MEDIA_SESSION_TERMINAL_STATUSES);

export type RuntimeTestJob = {
  testId: string;
  runtimeId: string;
  status: "building" | "starting" | "passed" | "failed";
  /** The templates checked; null = every registry template. */
  templateIds: string[] | null;
  channelId: string;
  requestedBy: PullActor;
  startedAt: string;
  sessionRequestedAt: string | null;
  sessionId: string | null;
  maxMinutes: number | null;
  finishedAt: string | null;
  error: string | null;
  costUsd: number | null;
  bootSeconds: number | null;
  /** Per template, once checked. */
  templates: RuntimeTestResult["templates"] | null;
};

export type RuntimeTestTemplate = { templateId: string; version: number; source: "owner" | "factory"; workflowJson: string };

export type RuntimeTestDeps = {
  store: { getJson(): Promise<string | null>; updateJson(mutate: (current: string | null) => string): Promise<string> };
  getSettings(): Promise<MediaSettings>;
  runtimes: { getRuntime(runtimeId: string): Promise<{ ready: boolean }>; writeTestResult(runtimeId: string, result: RuntimeTestResult): Promise<void> };
  builds: { start(runtimeId: string, actor: PullActor): Promise<{ alreadyBuilt: boolean }>; list(): Promise<RuntimeBuildJob[]> };
  sessions: {
    /** Starts (requests and approves) a session on the runtime; `approved: false` = held (by a limit) and nothing runs. */
    start(input: { channelId: string; runtimeId: string; maxMinutes: number; maxUsd: number; actor: PullActor }): Promise<{ sessionId: string; approved: boolean; heldBy: string | null }>;
    get(sessionId: string): Promise<MediaSession>;
    readNodes(sessionId: string): Promise<{ nodes: string[]; comfyVersion: string | null }>;
    stop(sessionId: string, actor: PullActor): Promise<MediaSession>;
  };
  templates(): Promise<RuntimeTestTemplate[]>;
  events: { record(event: MediaControlEvent): Promise<void> };
  generateId(): string;
  clock: { now(): Date };
};

function parseJobs(json: string | null): RuntimeTestJob[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as RuntimeTestJob[]) : [];
  } catch {
    return [];
  }
}

const isOpen = (job: RuntimeTestJob) => job.status === "building" || job.status === "starting";

/** AC-RT-09: the minutes the owner's cap buys at `pricePerHr` (never above the cap), bounded to [3, 15]; null = too few. */
export function runtimeTestMinutes(capUsd: number, pricePerHr: number): number | null {
  const affordable = Math.floor((capUsd * 60) / pricePerHr + 1e-9);
  const minutes = Math.min(RUNTIME_TEST_MAX_MINUTES, affordable);
  return minutes >= RUNTIME_TEST_MIN_MINUTES ? minutes : null;
}

export function createRuntimeTestServices(deps: RuntimeTestDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  const readJobs = async () => parseJobs(await deps.store.getJson());
  const nowIso = () => deps.clock.now().toISOString();

  async function save(next: RuntimeTestJob): Promise<RuntimeTestJob> {
    await deps.store.updateJson((current) => {
      const jobs = parseJobs(current);
      const merged = jobs.some((j) => j.testId === next.testId) ? jobs.map((j) => (j.testId === next.testId ? next : j)) : [...jobs, next];
      return JSON.stringify([...merged.filter(isOpen), ...merged.filter((j) => !isOpen(j)).slice(-50)]);
    });
    return next;
  }

  async function audit(event: MediaControlEvent): Promise<void> {
    try {
      await deps.events.record(event);
    } catch (error) {
      console.warn(`[media] could not record the ${event.action} event for ${event.subject}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function stopQuietly(job: RuntimeTestJob): Promise<MediaSession | null> {
    if (!job.sessionId) return null;
    try {
      return await deps.sessions.stop(job.sessionId, job.requestedBy);
    } catch (error) {
      // Its own caps (minutes, USD, idle) still end it; said in the log so the cause is findable.
      console.warn(`[media] the runtime test session ${job.sessionId} could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function fail(job: RuntimeTestJob, error: string, extra: Partial<RuntimeTestJob> = {}): Promise<RuntimeTestJob> {
    const stopped = await stopQuietly(job);
    const finished = await save({ ...job, ...extra, status: "failed", error, finishedAt: nowIso(), costUsd: extra.costUsd ?? stopped?.usdCharged ?? job.costUsd });
    await audit({ actor: job.requestedBy, action: "runtime_test_failed", subject: job.runtimeId, details: { testId: job.testId, sessionId: job.sessionId, error, costUsd: finished.costUsd } });
    return finished;
  }

  async function templatesFor(job: Pick<RuntimeTestJob, "templateIds">): Promise<RuntimeTestTemplate[]> {
    const all = await deps.templates();
    return job.templateIds === null ? all.filter((t) => t.source === "factory") : all.filter((t) => job.templateIds!.includes(t.templateId));
  }

  async function check(job: RuntimeTestJob, session: MediaSession): Promise<RuntimeTestJob> {
    let read: { nodes: string[]; comfyVersion: string | null };
    try {
      read = await deps.sessions.readNodes(session.sessionId);
    } catch (error) {
      return fail(job, `ComfyUI on the runtime did not list its nodes: ${error instanceof Error ? error.message : String(error)}`);
    }
    const nodes = new Set(read.nodes);
    const templates = (await templatesFor(job)).map((t) => {
      const missing = missingNodeTypes(t.workflowJson, nodes);
      return { templateId: t.templateId, version: t.version, ok: missing.length === 0, missing };
    });
    const bootSeconds = session.startedAt && session.readyAt ? Math.round((Date.parse(session.readyAt) - Date.parse(session.startedAt)) / 1000) : null;
    const stopped = await stopQuietly(job);
    const costUsd = stopped?.usdCharged ?? session.usdCharged ?? null;
    const ok = templates.every((t) => t.ok);
    const result: RuntimeTestResult = { ok, testedAt: nowIso(), comfyVersion: session.comfyVersion ?? read.comfyVersion, nodes: [...nodes].sort(), templates, costUsd, bootSeconds, error: ok ? null : "some templates need node types this runtime lacks", allTemplates: job.templateIds === null };
    await deps.runtimes.writeTestResult(job.runtimeId, result);
    const finished = await save({ ...job, status: ok ? "passed" : "failed", finishedAt: result.testedAt, error: result.error ?? null, costUsd, bootSeconds, templates });
    await audit({ actor: job.requestedBy, action: ok ? "runtime_tested" : "runtime_test_failed", subject: job.runtimeId, details: { testId: job.testId, sessionId: job.sessionId, comfyVersion: result.comfyVersion, nodes: nodes.size, failed: templates.filter((t) => !t.ok), costUsd, bootSeconds } });
    return finished;
  }

  /** One step of one open test. */
  async function advance(job: RuntimeTestJob): Promise<RuntimeTestJob> {
    const now = deps.clock.now().getTime();
    if (job.status === "building") {
      let ready: boolean;
      try {
        ready = (await deps.runtimes.getRuntime(job.runtimeId)).ready;
      } catch (error) {
        return fail(job, `the runtime profile could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!ready) {
        const builds = (await deps.builds.list()).filter((b) => b.runtimeId === job.runtimeId);
        if (builds.some((b) => b.status === "running")) return job;
        const last = builds[builds.length - 1];
        return fail(job, last ? `the build ended ${last.status}: ${last.error ?? "no error text"}` : "the runtime is not built and no build is running");
      }
      job = await save({ ...job, status: "starting" });
    }
    if (!job.sessionId) {
      const settings = await deps.getSettings();
      const price = settings.gpuOnDemandPricePerHr;
      if (price === null || price <= 0) return fail(job, "the GPU's price is unknown (Servers → Setup), so the test's minutes cannot be capped");
      const maxMinutes = runtimeTestMinutes(settings.runtimeTestMaxUsd, price);
      if (maxMinutes === null) return fail(job, `the test cap $${settings.runtimeTestMaxUsd} buys under ${RUNTIME_TEST_MIN_MINUTES} min at $${price}/h; raise it in Servers → Setup`);
      let started: { sessionId: string; approved: boolean; heldBy: string | null };
      try {
        started = await deps.sessions.start({ channelId: job.channelId, runtimeId: job.runtimeId, maxMinutes, maxUsd: settings.runtimeTestMaxUsd, actor: job.requestedBy });
      } catch (error) {
        return fail(job, `the test session could not start: ${error instanceof Error ? error.message : String(error)}`, { maxMinutes });
      }
      try {
        job = await save({ ...job, sessionId: started.sessionId, sessionRequestedAt: nowIso(), maxMinutes });
      } catch (error) {
        // Unrecorded, the next tick would start a second session (review): this one is stopped, the next tick starts again.
        await stopQuietly({ ...job, sessionId: started.sessionId });
        throw error;
      }
      // A held session would wait for the owner: the test withdraws it instead (nothing ran, nothing was billed).
      if (!started.approved) return fail(job, `the test session was held: ${started.heldBy ?? "a limit"}`);
      await audit({ actor: job.requestedBy, action: "runtime_test_session_started", subject: job.runtimeId, details: { testId: job.testId, sessionId: started.sessionId, maxMinutes, maxUsd: settings.runtimeTestMaxUsd } });
      return job;
    }
    let session: MediaSession;
    try {
      session = await deps.sessions.get(job.sessionId);
    } catch (error) {
      return fail(job, `the test session could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (session.status === "running") return check(job, session);
    if (TERMINAL.has(session.status)) return fail(job, `the test session ended ${session.status} before ComfyUI answered: ${session.error ?? session.stopReason ?? "no reason given"}`, { costUsd: session.usdCharged });
    if (job.sessionRequestedAt && now - Date.parse(job.sessionRequestedAt) > SESSION_WAIT_CAP_MS) return fail(job, `the test session was not running after ${SESSION_WAIT_CAP_MS / 60_000} min (${session.status})`);
    return job;
  }

  return {
    /**
     * AC-RT-05: tests `runtimeId` against `templateIds` (default: every registry template) -- building it first if needed.
     * Returns at once with the test record; the watch loop advances it (`pollRuntimeTests`).
     */
    async testRuntime(input: { runtimeId: string; templateIds?: string[]; channelId: string }, options: { actor?: PullActor } = {}): Promise<RuntimeTestJob> {
      return serialized(async () => {
        const actor = options.actor ?? "owner";
        if (!RUNTIME_ID_PATTERN.test(input.runtimeId)) throw new DomainError({ code: "validation_failed", message: "A runtime id is 3-63 lower-case letters, digits or '-'.", details: { runtimeId: input.runtimeId } });
        const { ready } = await deps.runtimes.getRuntime(input.runtimeId); // not_found for an unknown profile
        if ((await readJobs()).some((j) => j.runtimeId === input.runtimeId && isOpen(j))) {
          throw new DomainError({ code: "media_session_conflict", message: `Runtime ${input.runtimeId} is already being tested.`, details: { runtimeId: input.runtimeId } });
        }
        const templateIds = input.templateIds && input.templateIds.length > 0 ? [...new Set(input.templateIds)] : null;
        if (templateIds) {
          const known = new Set((await deps.templates()).map((t) => t.templateId));
          const unknown = templateIds.filter((id) => !known.has(id));
          if (unknown.length > 0) throw new DomainError({ code: "media_template_not_found", message: `No workflow template ${unknown.join(", ")}.`, details: { templateIds: unknown } });
        }
        if (!ready) {
          try {
            await deps.builds.start(input.runtimeId, actor);
          } catch (error) {
            // A build of this profile already running is the one the test waits for.
            if (!(error instanceof DomainError && error.code === "media_session_conflict")) throw error;
          }
        }
        const job = await save({
          testId: deps.generateId(),
          runtimeId: input.runtimeId,
          status: ready ? "starting" : "building",
          templateIds,
          channelId: input.channelId,
          requestedBy: actor,
          startedAt: nowIso(),
          sessionRequestedAt: null,
          sessionId: null,
          maxMinutes: null,
          finishedAt: null,
          error: null,
          costUsd: null,
          bootSeconds: null,
          templates: null,
        });
        await audit({ actor, action: "runtime_test_started", subject: input.runtimeId, details: { testId: job.testId, templateIds, building: !ready } });
        return ready ? advance(job) : job;
      });
    },

    /** The watch loop: one step of every open test. One test's failure never skips the others. */
    async pollRuntimeTests(): Promise<RuntimeTestJob[]> {
      return serialized(async () => {
        for (const job of (await readJobs()).filter(isOpen)) {
          try {
            await advance(job);
          } catch (error) {
            console.warn(`[media] runtime test ${job.testId} could not advance: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return readJobs();
      });
    },

    async listRuntimeTests(runtimeId?: string): Promise<RuntimeTestJob[]> {
      const jobs = await readJobs();
      return runtimeId ? jobs.filter((j) => j.runtimeId === runtimeId) : jobs;
    },
  };
}

export type RuntimeTestServices = ReturnType<typeof createRuntimeTestServices>;
