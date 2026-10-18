import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { sleep } from "@/lib/shared-async";
import { DomainError, RUNTIME_ID_PATTERN, type MediaSettings } from "./contracts";
import type { MediaControlEvent, PullActor } from "./models";
import { findLivePodByName, terminateAndConfirm } from "./pod-lifecycle";
import { RUNTIMES_PREFIX, runtimeKey } from "./runtimes";

// ---------------------------------------------------------------------------
// BL-200 stage 2 (ADR 0043, POD_RUNTIMES_PLAN.md §3, AC-RT-03): a runtime profile is built on a CPU pod with the GPU
// template's own image (the runtime's venv points to that image's Python and torch), never on a GPU. The pod runs
// `ytm/runtime-build.sh <id>`, which writes `.ready` last and then `build.json`; the watch loop polls that file, like a model
// pull's verdict, and terminates the pod. A build does NOT take the network-volume lock (ADR 0043): it writes only under
// `ytm/runtimes/<id>/`, which nothing else reads until `.ready` exists, so sessions and pulls keep running during the ~9 min.
// The pod-side scripts are uploaded to `ytm/` whenever the volume's copy differs from this version's (`ensurePodScripts`).
// ---------------------------------------------------------------------------

export const POD_SCRIPTS = ["pod-start.sh", "runtime-build.sh"] as const;
export type PodScriptName = (typeof POD_SCRIPTS)[number];
const DEFAULT_BUILD_CAP_MS = 60 * 60_000;
const TERMINATE_CONFIRM_MS = 60_000;
const TERMINATE_POLL_MS = 5_000;
/** A reserved build (podId null) older than this with no pod of its name is void (its createPod never returned). */
const RESERVATION_GRACE_MS = 2 * 60_000;
/** The image and its CUDA libraries are several GB; the template's own disk (20 GB) plus room for pip's cache. */
const BUILD_POD_DISK_GB = 40;

/** Deterministic, so a pod created by a `createPod` call that failed after the fact can still be found. */
export function buildPodNameFor(jobId: string): string {
  return `ytm-runtime-build-${jobId.slice(0, 8)}`;
}

export type RuntimeBuildJob = {
  jobId: string;
  runtimeId: string;
  podId: string | null;
  status: "running" | "built" | "failed" | "timeout";
  startedAt: string;
  finishedAt: string | null;
  seconds: number | null;
  error: string | null;
  requestedBy: PullActor;
  image: string;
};

export type RuntimeBuildStore = {
  getJobsJson(): Promise<string | null>;
  updateJobsJson(mutate: (current: string | null) => string): Promise<string>;
};

export type RuntimeBuildDeps = {
  store: RuntimeBuildStore;
  base: { getSettings(): Promise<MediaSettings>; resolveRunpodClient(): Promise<RunpodApiClient>; s3(): Promise<RunpodS3Client> };
  /** This version's copy of a pod-side script (production: `scripts/media/pod/<name>` of the installed app). */
  readPodScript(name: PodScriptName): Promise<string>;
  events: { record(event: MediaControlEvent): Promise<void> };
  generateId(): string;
  clock: { now(): Date };
  sleep?: (ms: number) => Promise<void>;
  buildCapMs?: number;
};

function parseJobs(json: string | null): RuntimeBuildJob[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as RuntimeBuildJob[]) : [];
  } catch {
    return [];
  }
}

/** The last 50 finished builds plus every running one (the full history is the audit table). */
function trimJobs(jobs: RuntimeBuildJob[]): RuntimeBuildJob[] {
  return [...jobs.filter((j) => j.status === "running"), ...jobs.filter((j) => j.status !== "running").slice(-50)];
}

/** `build.json` as the build pod writes it, or null when it is not in that shape. */
function parseBuildVerdict(text: string): { ok: boolean; seconds: number | null; error: string | null } | null {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; seconds?: unknown; error?: unknown };
    if (typeof parsed.ok !== "boolean") return null;
    return { ok: parsed.ok, seconds: typeof parsed.seconds === "number" ? parsed.seconds : null, error: typeof parsed.error === "string" ? parsed.error : null };
  } catch {
    return null;
  }
}

/** The image of the owner's GPU template, as RunPod lists it (`imageName`), or null. */
export function templateImageOf(raw: Record<string, unknown>): string | null {
  for (const field of ["imageName", "image"]) {
    const value = raw[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function createRuntimeBuildServices(deps: RuntimeBuildDeps) {
  const capMs = deps.buildCapMs ?? DEFAULT_BUILD_CAP_MS;
  const sleepFn = deps.sleep ?? sleep;

  // Within THIS process every mutation runs through one chain (the watch loop and a start share the core); across
  // processes the store's compare-and-swap does the same job.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  const readJobs = async () => parseJobs(await deps.store.getJobsJson());

  async function saveJob(next: RuntimeBuildJob): Promise<void> {
    await deps.store.updateJobsJson((current) => {
      const jobs = parseJobs(current);
      const merged = jobs.some((j) => j.jobId === next.jobId) ? jobs.map((j) => (j.jobId === next.jobId ? next : j)) : [...jobs, next];
      return JSON.stringify(trimJobs(merged));
    });
  }

  /** Records an audit row; a failure to record never fails or undoes the action it describes (logged instead). */
  async function audit(event: MediaControlEvent): Promise<void> {
    try {
      await deps.events.record(event);
    } catch (error) {
      console.warn(`[media] could not record the ${event.action} event for ${event.subject}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function ensurePodScripts(actor: PullActor): Promise<{ uploaded: PodScriptName[] }> {
    const s3 = await deps.base.s3();
    const uploaded: PodScriptName[] = [];
    for (const name of POD_SCRIPTS) {
      const local = await deps.readPodScript(name);
      if ((await s3.getObjectText(`ytm/${name}`)) === local) continue;
      await s3.putObject(`ytm/${name}`, local, "text/x-shellscript");
      uploaded.push(name);
    }
    if (uploaded.length > 0) await audit({ actor, action: "pod_scripts_uploaded", subject: "ytm/", details: { uploaded } });
    return { uploaded };
  }

  /**
   * A build is over only once its pod is confirmed terminated; while termination fails the build stays `running` (with the
   * error recorded) so the next poll retries it -- the same rule as a model pull.
   */
  async function finishJob(job: RuntimeBuildJob, status: RuntimeBuildJob["status"], extra: { seconds?: number | null; error?: string | null }): Promise<RuntimeBuildJob> {
    try {
      if (job.podId) {
        const client = await deps.base.resolveRunpodClient();
        const result = await terminateAndConfirm(client, job.podId, { now: () => deps.clock.now(), sleep: sleepFn }, { timeoutMs: TERMINATE_CONFIRM_MS, pollMs: TERMINATE_POLL_MS });
        if (!result.confirmed) throw new Error(`pod still ${result.lastStatus} after terminate`);
      }
    } catch (cause) {
      const stillRunning: RuntimeBuildJob = { ...job, error: `pod ${job.podId} could not be terminated (${cause instanceof Error ? cause.message : String(cause)}); retrying` };
      await saveJob(stillRunning);
      return stillRunning;
    }
    // A build that did not finish by itself leaves its lock file behind; the next build of this profile must not wait 2 h.
    if (status !== "built") await deps.base.s3().then((s3) => s3.deleteObject(`${RUNTIMES_PREFIX}${job.runtimeId}/.lock`)).catch(() => undefined);
    const finished: RuntimeBuildJob = { ...job, status, finishedAt: deps.clock.now().toISOString(), seconds: extra.seconds ?? null, error: extra.error ?? null };
    await saveJob(finished);
    await audit({
      actor: job.requestedBy,
      action: status === "built" ? "runtime_built" : "runtime_build_failed",
      subject: job.runtimeId,
      details: { jobId: job.jobId, podId: job.podId, status, seconds: finished.seconds, error: finished.error },
    });
    return finished;
  }

  async function startInner(runtimeId: string, actor: PullActor): Promise<{ job: RuntimeBuildJob | null; alreadyBuilt: boolean }> {
    if (!RUNTIME_ID_PATTERN.test(runtimeId)) throw new DomainError({ code: "validation_failed", message: "A runtime id is 3-63 lower-case letters, digits or '-'.", details: { runtimeId } });
    const settings = await deps.base.getSettings();
    if (!settings.datacenterId || !settings.networkVolumeId || !settings.templateId) {
      throw new DomainError({ code: "media_generation_not_configured", message: "Set the datacenter, the network volume and the pod template in Servers → Setup before building a runtime." });
    }
    const s3 = await deps.base.s3();
    if (!(await s3.headObject(runtimeKey(runtimeId, "runtime.json")))) {
      throw new DomainError({ code: "not_found", message: `No runtime profile ${runtimeId} on the network volume.`, details: { runtimeId } });
    }
    if (await s3.headObject(`${RUNTIMES_PREFIX}${runtimeId}/.ready`)) return { job: null, alreadyBuilt: true };
    const running = (await readJobs()).find((j) => j.runtimeId === runtimeId && j.status === "running");
    if (running) throw new DomainError({ code: "media_session_conflict", message: `Runtime ${runtimeId} is already being built (since ${running.startedAt}).`, details: { runtimeId, jobId: running.jobId } });

    // The build runs the GPU template's image on a CPU pod: the venv it creates is tied to that image's Python (probe 1).
    const client = await deps.base.resolveRunpodClient();
    const template = (await client.listTemplates()).find((t) => t.id === settings.templateId);
    const image = template ? templateImageOf(template.raw) : null;
    if (!image) {
      throw new DomainError({ code: "media_generation_not_configured", message: `The pod template ${settings.templateId} is not in this RunPod account or names no image; a runtime is built with that image.`, details: { templateId: settings.templateId } });
    }
    await ensurePodScripts(actor);

    const jobId = deps.generateId();
    const podName = buildPodNameFor(jobId);
    const reserved: RuntimeBuildJob = { jobId, runtimeId, podId: null, status: "running", startedAt: deps.clock.now().toISOString(), finishedAt: null, seconds: null, error: null, requestedBy: actor, image };
    await saveJob(reserved);
    let podId: string;
    try {
      const pod = await client.createPod({
        name: podName,
        image,
        cpu: { id: "cpu3c", vcpuCount: 4 },
        cloud: "SECURE",
        dataCenterId: settings.datacenterId,
        disk: BUILD_POD_DISK_GB,
        mounts: { network: [{ volumeId: settings.networkVolumeId, path: "/workspace" }] },
        // Replaces the image's own start: the pod runs the build script and nothing else (no ports, no token, no secret).
        entrypoint: ["bash", "/workspace/ytm/runtime-build.sh", runtimeId],
        startSsh: false,
      });
      podId = pod.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let orphan: { id: string } | undefined;
      try {
        orphan = await findLivePodByName(client, podName);
      } catch (lookupError) {
        // The pod MAY exist and bill: the reservation stays (with the error) and the poll repeats the name search.
        await saveJob({ ...reserved, error: `pod creation failed (${message}); RunPod could not be asked whether the pod exists (${lookupError instanceof Error ? lookupError.message : String(lookupError)}); the poll re-checks` });
        throw error;
      }
      if (!orphan) {
        await saveJob({ ...reserved, status: "failed", finishedAt: deps.clock.now().toISOString(), error: `pod creation failed: ${message}` });
        throw new DomainError({ code: "media_session_start_failed", message: `The build pod could not be created: ${message}`, details: { runtimeId } });
      }
      podId = orphan.id;
    }
    const job: RuntimeBuildJob = { ...reserved, podId };
    await saveJob(job);
    await audit({ actor, action: "runtime_build_started", subject: runtimeId, details: { jobId, podId, image } });
    return { job, alreadyBuilt: false };
  }

  async function pollInner(): Promise<RuntimeBuildJob[]> {
    const jobs = await readJobs();
    const running = jobs.filter((j) => j.status === "running");
    if (running.length === 0) return jobs;
    // Each dependency on its own: an unusable S3 pair must not skip the dead-pod check and the cap, and the reverse.
    const s3 = await deps.base.s3().then((c) => c, () => null);
    const client = await deps.base.resolveRunpodClient().then((c) => c, () => null);
    const now = deps.clock.now().getTime();
    for (const job of running) {
      if (!job.podId) {
        if (now - Date.parse(job.startedAt) <= RESERVATION_GRACE_MS) continue;
        try {
          if (!client) throw new Error("RunPod credentials are not usable");
          const orphan = await findLivePodByName(client, buildPodNameFor(job.jobId));
          if (orphan) await saveJob({ ...job, podId: orphan.id, error: null });
          else await saveJob({ ...job, status: "failed", finishedAt: deps.clock.now().toISOString(), error: "reserved, but no pod was ever created" });
        } catch (lookupError) {
          await saveJob({ ...job, error: `could not check RunPod for a pod named ${buildPodNameFor(job.jobId)} (${lookupError instanceof Error ? lookupError.message : String(lookupError)}); retrying` });
        }
        continue;
      }
      let verdictText: string | null | undefined;
      try {
        if (!s3) throw new Error("the S3 key pair is not usable");
        verdictText = await s3.getObjectText(runtimeKey(job.runtimeId, "build.json"));
      } catch (error) {
        verdictText = undefined;
        await saveJob({ ...job, error: `S3 could not be asked for the build's verdict (${error instanceof Error ? error.message : String(error)}); retrying` });
      }
      if (typeof verdictText === "string") {
        const verdict = parseBuildVerdict(verdictText);
        if (!verdict) await finishJob(job, "failed", { error: "the build pod's build.json could not be read" });
        else if (!verdict.ok) await finishJob(job, "failed", { seconds: verdict.seconds, error: verdict.error ?? "the build failed (see ytm/runtimes/<id>/build.log)" });
        else {
          // AC-RT-03: `.ready` is the build's own invariant -- an ok verdict without it is not a built runtime.
          const ready = await s3!.headObject(`${RUNTIMES_PREFIX}${job.runtimeId}/.ready`).catch(() => undefined);
          if (ready === undefined) continue; // S3 unreachable for this check: ask again next tick
          await finishJob(job, ready ? "built" : "failed", { seconds: verdict.seconds, error: ready ? null : "build.json says ok but .ready is missing" });
        }
        continue;
      }
      let pod: { status: string } | null | undefined;
      try {
        pod = client ? await client.getPod(job.podId) : undefined;
      } catch {
        pod = undefined;
      }
      if (pod !== undefined && (!pod || pod.status === "TERMINATED" || pod.status === "EXITED" || pod.status === "ERROR")) {
        // Most likely the image could not start on a CPU host (too large for its disk, wrong architecture): see the pod's logs.
        await finishJob(job, "failed", { error: `the build pod was ${pod?.status ?? "gone"} before it wrote build.json` });
        continue;
      }
      if (now - Date.parse(job.startedAt) > capMs) await finishJob(job, "timeout", { error: `no build.json after ${Math.round(capMs / 60_000)} min` });
    }
    return readJobs();
  }

  return {
    /** Uploads the pod-side scripts to `ytm/` when the volume's copy differs from this version's. */
    ensurePodScripts: (options: { actor?: PullActor } = {}) => ensurePodScripts(options.actor ?? "owner"),

    /** AC-RT-03: starts the CPU build of a profile (returns at once); `alreadyBuilt` when `.ready` is already there. */
    async startRuntimeBuild(input: { runtimeId: string }, options: { actor?: PullActor } = {}) {
      return serialized(() => startInner(input.runtimeId, options.actor ?? "owner"));
    },

    /** One check of every running build (the watch loop): verdict -> built/failed (pod terminated); pod gone -> failed; cap -> timeout. */
    async pollRuntimeBuilds(): Promise<RuntimeBuildJob[]> {
      return serialized(() => pollInner());
    },

    async listRuntimeBuilds(): Promise<RuntimeBuildJob[]> {
      return readJobs();
    },
  };
}

export type RuntimeBuildServices = ReturnType<typeof createRuntimeBuildServices>;
