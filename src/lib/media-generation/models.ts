import { z } from "zod";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { sleep } from "@/lib/shared-async";
import { DomainError, type MediaSettings } from "./contracts";
import { findLivePodByName, terminateAndConfirm } from "./pod-lifecycle";
import { parseWithSchema } from "./schemas";
import type { VolumeLock } from "./volume-lock";

// ---------------------------------------------------------------------------
// Phase 14 slice 4 (docs/roadmap/plans/PHASE_14_PLAN.md §2.6 "Models", owner decision D5): what is on
// the network volume under `models/` (S3 listing), deleting a model, and pulling one from Hugging Face
// straight onto the volume with a cheap CPU pod (no GPU, no local round trip) -- the in-app version of
// scripts/media/models-pull.sh. A pull is asynchronous: the pod is created, the server's watch loop
// polls until the expected key is on the volume, then the pod is TERMINATED (never stopped). While a
// pull is in flight the GPU session cannot start (shared volume, AC-P14-18); a pull older than the cap
// is terminated.
// ---------------------------------------------------------------------------

export const MODELS_PREFIX = "models/";
const MODEL_FOLDERS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "clip_vision", "audio_encoders", "upscale_models", "controlnet", "embeddings"] as const;
const DEFAULT_PULL_CAP_MS = 6 * 60 * 60_000;
const TERMINATE_CONFIRM_MS = 60_000;
const TERMINATE_POLL_MS = 5_000;
/** A reserved pull (podId null) older than this with no pod of its name is void (its createPod never returned). */
const RESERVATION_GRACE_MS = 2 * 60_000;

/** Deterministic, so a pod created by a `createPod` call that failed after the fact can still be found. */
export function pullPodNameFor(pullId: string): string {
  return `ytm-models-pull-${pullId.slice(0, 8)}`;
}

export const startModelPullInputSchema = z
  .object({
    /** Hugging Face repo id, e.g. "Comfy-Org/flux1-schnell". */
    repoId: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "a Hugging Face repo id looks like owner/name"),
    /** Path of the file inside the repo. */
    file: z.string().trim().min(1).max(500).refine((v) => !v.includes("..") && !v.startsWith("/"), "a repo-relative path"),
    folder: z.enum(MODEL_FOLDERS),
    cpuFlavorId: z.string().trim().min(1).max(64).optional(),
    vcpuCount: z.number().int().min(1).max(32).optional(),
  })
  .strict();

export const modelKeySchema = z
  .object({ key: z.string().min(MODELS_PREFIX.length + 1).max(1000).refine((k) => k.startsWith(MODELS_PREFIX) && !k.includes("..") && !k.endsWith("/"), "a models/ object key") })
  .strict();

export type ModelPull = {
  pullId: string;
  /** `null` while the pull is RESERVED (recorded before its createPod returned, review round 8). */
  podId: string | null;
  repoId: string;
  file: string;
  expectedKey: string;
  status: "running" | "done" | "failed" | "timeout";
  startedAt: string;
  finishedAt: string | null;
  bytes: number | null;
  error: string | null;
};

export type ModelPullStore = {
  getPullsJson(): Promise<string | null>;
  /**
   * Atomic read-modify-write (one write transaction in the real store): the web server's watch loop and
   * the operator CLI are separate processes that both mutate this list, so a whole-list overwrite from a
   * stale read would silently drop a pull -- and with it the only record of a billing pod (review round 6).
   */
  updatePullsJson(mutate: (current: string | null) => string): Promise<string>;
};

export type ModelServiceDependencies = {
  store: ModelPullStore;
  base: {
    getSettings(): Promise<MediaSettings>;
    resolveRunpodClient(): Promise<RunpodApiClient>;
    s3(): Promise<RunpodS3Client>;
  };
  generateId(): string;
  clock: { now(): Date };
  sleep?(ms: number): Promise<void>;
  pullCapMs?: number;
  /** AC-P14-18 as a constraint (review round 9): a pull holds the one "volume busy" lock from its reservation until it is terminal. */
  volumeLock: VolumeLock;
};

export function modelFileName(file: string): string {
  return file.split("/").filter(Boolean).pop() ?? file;
}

/** The shell the CPU pod runs: install the HF CLI, download one file into the right models folder, then idle until terminated. */
export function buildPullCommand(repoId: string, file: string, folder: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const dir = `/workspace/models/${folder}`;
  // The HF CLI's download cache (`.cache/huggingface/download/*.incomplete|.metadata|.lock`) would otherwise stay on
  // the paid volume forever, invisible in the Models panel (review round 14): removed after the download and on any
  // exit (a failed or cancelled pull leaves a multi-GB `.incomplete` blob).
  return `set -e; trap 'rm -rf ${dir}/.cache' EXIT; pip install -q -U 'huggingface_hub[cli]'; mkdir -p ${dir}; hf download ${q(repoId)} ${q(file)} --local-dir ${dir}; rm -rf ${dir}/.cache; echo YTM_PULL_DONE; sleep infinity`;
}

function parsePulls(json: string | null): ModelPull[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ModelPull[]) : [];
  } catch {
    return [];
  }
}

/** Keep the list small: the last 20 finished pulls plus every running one. */
function trimPulls(pulls: ModelPull[]): ModelPull[] {
  const running = pulls.filter((p) => p.status === "running");
  const finished = pulls.filter((p) => p.status !== "running").slice(-20);
  return [...running, ...finished];
}

export function createMediaModelServices(deps: ModelServiceDependencies) {
  const pullCapMs = deps.pullCapMs ?? DEFAULT_PULL_CAP_MS;
  const sleepFn = deps.sleep ?? sleep;

  // Within THIS process every mutation runs through one chain (the watch loop, startPull and cancelPull
  // share the core); across processes the store's own transaction does the same job.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  async function readPulls(): Promise<ModelPull[]> {
    return parsePulls(await deps.store.getPullsJson());
  }

  /** Replaces the pull with the same id -- or appends it -- against the CURRENT stored list, never a stale copy. */
  async function savePull(next: ModelPull): Promise<void> {
    await deps.store.updatePullsJson((current) => {
      const pulls = parsePulls(current);
      const merged = pulls.some((p) => p.pullId === next.pullId) ? pulls.map((p) => (p.pullId === next.pullId ? next : p)) : [...pulls, next];
      return JSON.stringify(trimPulls(merged));
    });
  }

  /**
   * A pull reaches a terminal status only once its pod is confirmed terminated; while termination
   * fails the pull stays `running` (with the error recorded) so the next poll retries it and
   * `hasActivePull` keeps telling the truth about the volume.
   */
  async function finishPull(pull: ModelPull, status: ModelPull["status"], extra: { bytes?: number | null; error?: string | null }): Promise<ModelPull> {
    try {
      if (pull.podId) {
        // The volume is shared: the pull is over only once RunPod confirms the pod is gone (bounded wait), the same
        // shared step the GPU sessions use (`pod-lifecycle.ts`).
        const client = await deps.base.resolveRunpodClient();
        const result = await terminateAndConfirm(client, pull.podId, { now: () => deps.clock.now(), sleep: sleepFn }, { timeoutMs: TERMINATE_CONFIRM_MS, pollMs: TERMINATE_POLL_MS });
        if (!result.confirmed) throw new Error(`pod still ${result.lastStatus} after terminate`);
      }
    } catch (cause) {
      const stillRunning: ModelPull = {
        ...pull,
        bytes: extra.bytes ?? pull.bytes,
        error: `pod ${pull.podId} could not be terminated (${cause instanceof Error ? cause.message : String(cause)}); retrying`,
      };
      await savePull(stillRunning);
      return stillRunning;
    }
    // The pod is gone (possibly killed before its own `rm -rf .cache` ran, review round 17): the HF CLI's cache keys under
    // the pull's folder are deleted over S3 so nothing invisible stays on the paid volume. Best effort.
    await cleanupPullCache(pull.expectedKey).catch(() => undefined);
    const finished: ModelPull = { ...pull, status, finishedAt: deps.clock.now().toISOString(), bytes: extra.bytes ?? null, error: extra.error ?? null };
    await savePull(finished);
    await deps.volumeLock.release(`pull:${pull.pullId}`);
    return finished;
  }

  /** Deletes `models/<folder>/.cache/**` for the folder of `expectedKey` (the HF CLI's download cache). */
  async function cleanupPullCache(expectedKey: string): Promise<void> {
    const folder = expectedKey.slice(MODELS_PREFIX.length).split("/")[0];
    if (!folder) return;
    const s3 = await deps.base.s3();
    const prefix = `${MODELS_PREFIX}${folder}/.cache/`;
    for (const object of await s3.listAllObjects(prefix)) await s3.deleteObject(object.key);
  }

  return {
    /** Everything under `models/` on the volume (size, folder), never other prefixes. */
    async listModels(): Promise<Array<{ key: string; folder: string; name: string; bytes: number; lastModified: string | null }>> {
      const s3 = await deps.base.s3();
      const objects = await s3.listAllObjects(MODELS_PREFIX);
      return objects
        // Folder markers and the Hugging Face CLI's own download cache (`.cache/huggingface/...`) are not models.
        .filter((o) => !o.key.endsWith("/.keep") && !o.key.includes("/.cache/"))
        .map((o) => {
          const rest = o.key.slice(MODELS_PREFIX.length);
          const [folder, ...parts] = rest.split("/");
          return { key: o.key, folder, name: parts.join("/") || folder, bytes: o.size, lastModified: o.lastModified };
        })
        .sort((a, b) => a.key.localeCompare(b.key));
    },

    /** Deletes one object under `models/` (explicit operator action; never a prefix, never outside models/). */
    async deleteModel(input: unknown): Promise<{ deleted: string }> {
      const { key } = parseWithSchema(modelKeySchema, input, "model key");
      const s3 = await deps.base.s3();
      await s3.deleteObject(key);
      return { deleted: key };
    },

    /** Read-only: the recorded pulls as they are (a GET never advances them -- the watch loop does). */
    async listPulls(): Promise<ModelPull[]> {
      return readPulls();
    },

    async hasActivePull(): Promise<boolean> {
      return hasActivePull();
    },

    /** For the volume lock's staleness check: is this particular pull still running? */
    async isPullActive(pullId: string): Promise<boolean> {
      return (await readPulls()).some((p) => p.pullId === pullId && p.status === "running");
    },

    /**
     * Creates a CPU pod attached to the volume that downloads one file from Hugging Face into
     * `models/<folder>/`. Returns at once; `pollPulls` watches the key and terminates the pod.
     */
    async startPull(input: unknown): Promise<ModelPull> {
      return serialized(() => startPullInner(input));
    },

    async pollPulls(): Promise<ModelPull[]> {
      return serialized(() => pollPullsInner());
    },

    /** Operator abort: terminate the pull pod now. */
    async cancelPull(input: unknown): Promise<ModelPull> {
      const { pullId } = parseWithSchema(z.object({ pullId: z.string().min(1).max(64) }).strict(), input, "pull id");
      return serialized(async () => {
        const pull = (await readPulls()).find((p) => p.pullId === pullId);
        if (!pull) throw new DomainError({ code: "media_job_not_found", message: "No model pull with this id", details: { pullId } });
        if (pull.status !== "running") throw new DomainError({ code: "media_job_invalid_state", message: `Pull is ${pull.status}`, details: { pullId } });
        let target = pull;
        if (!pull.podId) {
          // Reserved, pod not recorded: the reserving process may have died right after RunPod created it -- find it by
          // its deterministic name before finishing, so the cancel terminates it instead of orphaning it (review round 16).
          const client = await deps.base.resolveRunpodClient();
          let orphan: { id: string } | undefined;
          try {
            orphan = await findLivePodByName(client, pullPodNameFor(pullId));
          } catch (lookupError) {
            throw new DomainError({ code: "runpod_api_unavailable", message: `RunPod could not be asked whether a pod named ${pullPodNameFor(pullId)} exists; the pull stays reserved -- try again when RunPod answers.`, details: { pullId, cause: lookupError instanceof Error ? lookupError.message : String(lookupError) } });
          }
          if (orphan) target = { ...pull, podId: orphan.id };
        }
        return finishPull(target, "failed", { error: "cancelled by operator" });
      });
    },
  };

  async function hasActivePull(): Promise<boolean> {
    return (await readPulls()).some((p) => p.status === "running");
  }

  async function startPullInner(input: unknown): Promise<ModelPull> {
    const parsed = parseWithSchema(startModelPullInputSchema, input, "model pull");
    const settings = await deps.base.getSettings();
    if (!settings.datacenterId || !settings.networkVolumeId) {
      throw new DomainError({ code: "media_generation_not_configured", message: "Set the datacenter and the network volume in Production → Setup before pulling models." });
    }
    if (await hasActivePull()) {
      throw new DomainError({ code: "media_session_conflict", message: "A model pull is already running; wait for it to finish." });
    }
    const client = await deps.base.resolveRunpodClient();
    // `hf download <repo> <file> --local-dir DIR` keeps the file's repo-relative path under DIR.
    const expectedKey = `${MODELS_PREFIX}${parsed.folder}/${parsed.file}`;
    // The poll declares the pull done when the key has a size: a key that already exists would be "done" on the
    // first tick while the pod still downloads (review round 7). Re-pulling means deleting the old copy first.
    const existing = await (await deps.base.s3()).headObject(expectedKey);
    if (existing && existing.size > 0) {
      throw new DomainError({
        code: "validation_failed",
        message: `${expectedKey} already exists on the volume (${existing.size} bytes); delete it first (Production → Models, or \`media model-rm\`) to pull it again.`,
        details: { key: expectedKey, bytes: existing.size },
      });
    }
    const pullId = deps.generateId();
    const podName = pullPodNameFor(pullId);
    // AC-P14-18 as a constraint: the volume lock (held by an open session, if any) is taken BEFORE anything is written;
    // then the pull is RESERVED (recorded with no pod yet) so a crash inside createPod leaves a record the poll settles.
    await deps.volumeLock.acquire(`pull:${pullId}`);
    const reserved: ModelPull = { pullId, podId: null, repoId: parsed.repoId, file: parsed.file, expectedKey, status: "running", startedAt: deps.clock.now().toISOString(), finishedAt: null, bytes: null, error: null };
    await savePull(reserved);
    let pod: { id: string };
    try {
      pod = await client.createPod({
        name: podName,
        image: "python:3.12-slim",
        cpu: { id: parsed.cpuFlavorId ?? "cpu3c", vcpuCount: parsed.vcpuCount ?? 2 },
        cloud: "SECURE",
        dataCenterId: settings.datacenterId,
        mounts: { network: [{ volumeId: settings.networkVolumeId, path: "/workspace" }] },
        cmd: ["bash", "-lc", buildPullCommand(parsed.repoId, parsed.file, parsed.folder)],
        startSsh: false,
      });
    } catch (error) {
      // The call can fail AFTER RunPod created the pod (timeout, dropped connection): the deterministic name finds it.
      const message = error instanceof Error ? error.message : String(error);
      let orphan: { id: string } | undefined;
      try {
        orphan = await findLivePodByName(client, podName);
      } catch (lookupError) {
        // RunPod unreachable for the lookup too: the pod MAY exist and write the volume. The reservation (and the lock)
        // stay, with the error recorded; the poll repeats the name search (review round 9).
        await savePull({ ...reserved, error: `pod creation failed (${message}); RunPod could not be asked whether the pod exists (${lookupError instanceof Error ? lookupError.message : String(lookupError)}); the poll re-checks` });
        throw error;
      }
      if (!orphan) {
        await savePull({ ...reserved, status: "failed", finishedAt: deps.clock.now().toISOString(), error: `pod creation failed: ${message}` });
        await deps.volumeLock.release(`pull:${pullId}`);
        throw error;
      }
      pod = orphan;
    }
    // Record the pod ONLY if the reservation is still running: another process (the web UI's cancel while this CLI
    // process was inside createPod) may have settled it and released the lock meanwhile; then the pod we just created
    // must not be resurrected into an unlocked, billing pull (review round 10) -- it is terminated instead.
    const pull: ModelPull = { ...reserved, podId: pod.id, error: null };
    let recorded = false;
    await deps.store.updatePullsJson((current) => {
      const pulls = parsePulls(current);
      const stored = pulls.find((p) => p.pullId === pullId);
      recorded = stored?.status === "running";
      return JSON.stringify(trimPulls(recorded ? pulls.map((p) => (p.pullId === pullId ? pull : p)) : pulls));
    });
    if (!recorded) {
      const settled = (await readPulls()).find((p) => p.pullId === pullId);
      try {
        await terminateAndConfirm(client, pod.id, { now: () => deps.clock.now(), sleep: sleepFn }, { timeoutMs: TERMINATE_CONFIRM_MS, pollMs: TERMINATE_POLL_MS });
      } catch {
        // best effort; the pod carries the deterministic name for the operator's `pods` listing
      }
      throw new DomainError({ code: "media_job_invalid_state", message: `The pull was ${settled?.status ?? "removed"} before its pod was recorded; the pod ${pod.id} was terminated.`, details: { pullId, podId: pod.id } });
    }
    return pull;
  }

  /**
   * One check of every running pull: the expected key on the volume -> done (pod terminated); the
   * pod gone/EXITED before the file arrived -> failed; older than the cap -> timeout (terminated).
   */
  async function pollPullsInner(): Promise<ModelPull[]> {
    const pulls = await readPulls();
    const running = pulls.filter((p) => p.status === "running");
    if (running.length === 0) return pulls;
    // Each dependency is resolved on its own (review round 20): an unusable S3 pair must not skip the dead-pod check and
    // the cap, and an unreachable RunPod must not skip the file check.
    const s3 = await deps.base.s3().then((c) => c, () => null);
    const client = await deps.base.resolveRunpodClient().then((c) => c, () => null);
    const now = deps.clock.now().getTime();
    for (const pull of running) {
      if (!pull.podId) {
        // Reserved but never given a pod: its startPull is still inside createPod, or died there. Past a short grace the
        // deterministic name settles it -- a pod that exists is adopted, none means the reservation is void.
        if (now - Date.parse(pull.startedAt) <= RESERVATION_GRACE_MS) continue;
        let orphan: { id: string } | undefined;
        try {
          if (!client) throw new Error("RunPod credentials are not usable");
          orphan = await findLivePodByName(client, pullPodNameFor(pull.pullId));
        } catch (lookupError) {
          // Unknown is not "none": the reservation (and the lock) stay until RunPod can be asked (review round 9).
          await savePull({ ...pull, error: `could not check RunPod for a pod named ${pullPodNameFor(pull.pullId)} (${lookupError instanceof Error ? lookupError.message : String(lookupError)}); retrying` });
          continue;
        }
        if (orphan) {
          await savePull({ ...pull, podId: orphan.id, error: null });
        } else {
          await savePull({ ...pull, status: "failed", finishedAt: deps.clock.now().toISOString(), error: "reserved, but no pod was ever created" });
          await deps.volumeLock.release(`pull:${pull.pullId}`);
        }
        continue;
      }
      // Each check stands on its own (review round 18): a flaky S3 must not hide a dead pod or the cap, and a flaky RunPod
      // must not hide a finished file; a check that cannot be made is "unknown", not "fine".
      let head: { size: number } | null | undefined;
      try {
        if (!s3) throw new Error("the S3 key pair is not usable");
        head = await s3.headObject(pull.expectedKey);
      } catch (error) {
        head = undefined;
        await savePull({ ...pull, error: `S3 could not be asked for ${pull.expectedKey} (${error instanceof Error ? error.message : String(error)}); retrying` });
      }
      if (head && head.size > 0) {
        await finishPull(pull, "done", { bytes: head.size });
        continue;
      }
      let pod: { status: string } | null | undefined;
      try {
        pod = client ? await client.getPod(pull.podId) : undefined;
      } catch {
        pod = undefined;
      }
      if (pod !== undefined && (!pod || pod.status === "TERMINATED" || pod.status === "EXITED" || pod.status === "ERROR")) {
        await finishPull(pull, "failed", { error: `pod ${pod?.status ?? "gone"} before the file appeared` });
        continue;
      }
      if (now - Date.parse(pull.startedAt) > pullCapMs) {
        await finishPull(pull, "timeout", { error: `no file after ${Math.round(pullCapMs / 3_600_000)} h` });
      }
    }
    return readPulls();
  }
}

export type MediaModelServices = ReturnType<typeof createMediaModelServices>;
