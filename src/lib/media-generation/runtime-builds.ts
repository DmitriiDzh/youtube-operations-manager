import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { sleep } from "@/lib/shared-async";
import { DomainError, RUNTIME_ID_PATTERN, type MediaSettings } from "./contracts";
import type { MediaControlEvent, PullActor } from "./models";
import { classifyCreatePodFailure, resolveGpuCandidates } from "./gpu-plan";
import { findLivePodByName, terminateAndConfirm } from "./pod-lifecycle";
import { RUNTIMES_PREFIX, runtimeKey } from "./runtimes";

// ---------------------------------------------------------------------------
// BL-200 stage 2 (ADR 0043, POD_RUNTIMES_PLAN.md §3, AC-RT-03): a runtime profile is built on a pod with the GPU template's own
// image (the runtime's venv points to that image's Python and torch) -- on the cheapest GPU of the owner's list, because a CPU host
// never started that CUDA image (probe 2, 2026-10-18); the GPU itself is not used. The pod runs
// `ytm/runtime-build.sh <id>`, which writes `.ready` last and then `build.json`; the watch loop polls that file, like a model
// pull's verdict, and terminates the pod. A build does NOT take the network-volume lock (ADR 0043): it writes only under
// `ytm/runtimes/<id>/`, which nothing else reads until `.ready` exists, so sessions and pulls keep running during the ~9 min.
// The pod-side scripts are uploaded to `ytm/` whenever the volume's copy differs from this version's (`ensurePodScripts`).
// ---------------------------------------------------------------------------

export const POD_SCRIPTS = ["pod-start.sh", "runtime-build.sh"] as const;
export type PodScriptName = (typeof POD_SCRIPTS)[number];
/** The build itself takes ~9 min on a GPU host (probe 1); the cap bounds a stuck one at the GPU's price. */
const DEFAULT_BUILD_CAP_MS = 30 * 60_000;
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
  /** The GPU the build pod was placed on (null for a pod that was never placed). */
  gpuTypeId?: string | null;
  /** FO-REQ-0031: how many stuck-container builds of this profile came before this one in the same chain (0 = the first). */
  stuckRetries?: number;
  /** FO-REQ-0031 review: when this build's container was first seen running -- from then on it is never judged stuck. */
  containerStartedAt?: string | null;
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
  /** BL-230: the owner's GitHub read token on this computer, or null; given to a build pod whose profile names github.com. */
  githubToken?: () => Promise<string | null>;
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

/** BL-230: whether a stored profile (`runtime.json` text) names an `https://github.com/` repository (ComfyUI or a node pack). */
export function profileNamesGithub(text: string | null): boolean {
  if (!text) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const p = record(parsed);
  const repos = [record(p.comfy).repo, ...(Array.isArray(p.customNodes) ? p.customNodes.map((n) => record(n).repo) : [])];
  return repos.some((repo) => typeof repo === "string" && /^https:\/\/github\.com\//i.test(repo));
}

/** BL-230: the token replaced in a text that may echo the pod request (a RunPod 400), before it is stored, audited or thrown. */
export function scrubSecret(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

/** BL-230: an error whose message or details carry the token, rebuilt without it (same code); any other error as it is. */
export function scrubError(error: unknown, secret: string | null): unknown {
  if (!secret) return error;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof DomainError ? error.details : undefined;
  const detailsText = details === undefined ? "" : JSON.stringify(details);
  if (!message.includes(secret) && !detailsText.includes(secret)) return error;
  const code = error instanceof DomainError ? error.code : "media_session_start_failed";
  return new DomainError({ code, message: scrubSecret(message, secret), ...(details === undefined ? {} : { details: JSON.parse(scrubSecret(detailsText, secret)) }) });
}

/** `build.json` as the build pod writes it, or null when it is not in that shape. */
function parseBuildVerdict(text: string): { ok: boolean; seconds: number | null; error: string | null; finishedAt: string | null } | null {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; seconds?: unknown; error?: unknown; finishedAt?: unknown };
    if (typeof parsed.ok !== "boolean") return null;
    return { ok: parsed.ok, seconds: typeof parsed.seconds === "number" ? parsed.seconds : null, error: typeof parsed.error === "string" ? parsed.error : null, finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null };
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
    // A build that did not finish by itself leaves its lock file behind; the next build of this profile must not wait 2 h. Only
    // THIS build's lock (it holds the pod id): another computer's build of the same profile may still be running (review).
    if (status !== "built" && job.podId) {
      const lockKey = `${RUNTIMES_PREFIX}${job.runtimeId}/.lock`;
      await deps.base
        .s3()
        .then(async (s3) => {
          if ((await s3.getObjectText(lockKey))?.trim() === job.podId) await s3.deleteObject(lockKey);
        })
        .catch(() => undefined);
    }
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

  async function startInner(runtimeId: string, actor: PullActor, stuckRetries = 0): Promise<{ job: RuntimeBuildJob | null; alreadyBuilt: boolean }> {
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
    // BL-230 (AC-PR-11): the owner's GitHub token goes to the pod's env only when it is stored here AND the profile names github.com.
    const gitToken = deps.githubToken && profileNamesGithub(await s3.getObjectText(runtimeKey(runtimeId, "runtime.json"))) ? await deps.githubToken() : null;
    try {
      const placed = { ...settings, datacenterId: settings.datacenterId, networkVolumeId: settings.networkVolumeId, templateId: settings.templateId };
      return await placeBuild(runtimeId, actor, stuckRetries, placed, s3, gitToken);
    } catch (error) {
      throw scrubError(error, gitToken);
    }
  }

  async function placeBuild(
    runtimeId: string,
    actor: PullActor,
    stuckRetries: number,
    settings: MediaSettings & { datacenterId: string; networkVolumeId: string; templateId: string },
    s3: RunpodS3Client,
    gitToken: string | null
  ): Promise<{ job: RuntimeBuildJob | null; alreadyBuilt: boolean }> {
    const scrub = (text: string) => scrubSecret(text, gitToken);
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
    // The previous build's verdict goes first (review): the poll would otherwise read an old ok:false before the new pod has even
    // booted and fail this build with the old error, every time.
    await s3.deleteObject(runtimeKey(runtimeId, "build.json"));
    await s3.deleteObject(`${runtimeKey(runtimeId, "build.json")}.part`);

    const jobId = deps.generateId();
    const podName = buildPodNameFor(jobId);
    const reserved: RuntimeBuildJob = { jobId, runtimeId, podId: null, status: "running", startedAt: deps.clock.now().toISOString(), finishedAt: null, seconds: null, error: null, requestedBy: actor, image, stuckRetries };
    await saveJob(reserved);
    // Probe 2 (2026-10-18, owner msg 3035): on a CPU host the multi-GB CUDA image never started (45 min pulling); GPU hosts have it
    // cached and start in seconds. The build therefore runs on the CHEAPEST GPU of the owner's list offered in the volume's
    // datacenter (the GPU itself is not used), the next one on "no capacity".
    const catalog = await client.listGpuTypes({ cloud: "SECURE" }).catch(() => null);
    const candidates = resolveGpuCandidates({ plan: null, settings, catalog }).candidates.sort((a, b) => (a.pricePerHr ?? Infinity) - (b.pricePerHr ?? Infinity));
    if (candidates.length === 0) {
      await saveJob({ ...reserved, status: "failed", finishedAt: deps.clock.now().toISOString(), error: "no GPU of the owner's list is offered in the volume's datacenter" });
      throw new DomainError({ code: "media_no_capacity", message: "No GPU of your list (Servers → Setup) is offered in the network volume's datacenter, so the runtime cannot be built.", details: { runtimeId } });
    }
    let podId: string | null = null;
    let gpuTypeId: string | null = null;
    const failures: string[] = [];
    try {
      for (const candidate of candidates) {
        try {
          const pod = await client.createPod({
            name: podName,
            image,
            gpu: { id: candidate.gpuTypeId, count: 1 },
            cloud: "SECURE",
            dataCenterId: settings.datacenterId,
            disk: BUILD_POD_DISK_GB,
            mounts: { network: [{ volumeId: settings.networkVolumeId, path: "/workspace" }] },
            // Replaces the image's own start: the pod runs the build script and nothing else (no ports). BL-230: the GitHub read token,
            // when needed, is in the env only (masked in every pod read), never in the entrypoint RunPod shows.
            entrypoint: ["bash", "/workspace/ytm/runtime-build.sh", runtimeId],
            ...(gitToken ? { env: { YTM_GIT_TOKEN: gitToken } } : {}),
            startSsh: false,
          });
          podId = pod.id;
          gpuTypeId = candidate.gpuTypeId;
          break;
        } catch (error) {
          if (classifyCreatePodFailure(error) === "fatal") throw error;
          // The call may have failed after RunPod created the pod: the deterministic name settles it before the next GPU.
          const orphan = await findLivePodByName(client, podName);
          if (orphan) {
            podId = orphan.id;
            gpuTypeId = candidate.gpuTypeId;
            break;
          }
          failures.push(scrub(`${candidate.gpuTypeId}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (!podId) throw new DomainError({ code: "media_no_capacity", message: `No GPU could be placed for the build: ${failures.join("; ")}`, details: { runtimeId } });
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : String(error));
      let orphan: { id: string } | undefined;
      try {
        orphan = await findLivePodByName(client, podName);
      } catch (lookupError) {
        // The pod MAY exist and bill: the reservation stays (with the error) and the poll repeats the name search.
        await saveJob({ ...reserved, error: `pod creation failed (${message}); RunPod could not be asked whether the pod exists (${scrub(lookupError instanceof Error ? lookupError.message : String(lookupError))}); the poll re-checks` });
        throw error;
      }
      if (!orphan) {
        await saveJob({ ...reserved, status: "failed", finishedAt: deps.clock.now().toISOString(), error: `pod creation failed: ${message}` });
        if (error instanceof DomainError && error.code === "media_no_capacity") throw error;
        throw new DomainError({ code: "media_session_start_failed", message: `The build pod could not be created: ${message}`, details: { runtimeId } });
      }
      podId = orphan.id;
    }
    const job: RuntimeBuildJob = { ...reserved, podId, gpuTypeId };
    await saveJob(job);
    await audit({ actor, action: "runtime_build_started", subject: runtimeId, details: { jobId, podId, image, gpuTypeId } });
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
        // A verdict that predates this build is a leftover (S3 lagging behind the delete), never this build's answer.
        if (verdict?.finishedAt && Date.parse(verdict.finishedAt) < Date.parse(job.startedAt)) continue;
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
      let pod: { status: string; containerUptimeSec?: number | null } | null | undefined;
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
      // FO-REQ-0031: a container that has not started within the owner's limit (a host without the image) is given up at once and
      // the build is started again on another pod, up to containerStuckRetries times -- not left to bill until the cap.
      if (pod && pod.containerUptimeSec != null && !job.containerStartedAt) await saveJob({ ...job, containerStartedAt: deps.clock.now().toISOString() });
      const settings = await deps.base.getSettings().catch(() => null);
      if (settings && pod && !job.containerStartedAt && pod.containerUptimeSec == null && now - Date.parse(job.startedAt) >= settings.containerStartMinutes * 60_000) {
        const ended = await finishJob(job, "failed", { error: `container_stuck: the build pod's container did not start within ${settings.containerStartMinutes} min` });
        const used = job.stuckRetries ?? 0;
        if (ended.status === "failed" && used < settings.containerStuckRetries) {
          await startInner(job.runtimeId, job.requestedBy, used + 1).catch((error: unknown) => {
            console.warn(`[media] the build of ${job.runtimeId} could not be started again after a stuck container: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
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

    /** Oldest first by start (the stored list keeps running builds first). */
    async listRuntimeBuilds(): Promise<RuntimeBuildJob[]> {
      return [...(await readJobs())].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
  };
}

export type RuntimeBuildServices = ReturnType<typeof createRuntimeBuildServices>;
