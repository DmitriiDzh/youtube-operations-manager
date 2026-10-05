import { z } from "zod";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { DomainError, type MediaSettings } from "./contracts";
import { parseWithSchema } from "./schemas";

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
  podId: string;
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
  /** AC-P14-18 in the other direction: no pull may write to the volume while a GPU pod is open on it. */
  hasOpenPod?: () => Promise<boolean>;
};

export function modelFileName(file: string): string {
  return file.split("/").filter(Boolean).pop() ?? file;
}

/** The shell the CPU pod runs: install the HF CLI, download one file into the right models folder, then idle until terminated. */
export function buildPullCommand(repoId: string, file: string, folder: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `set -e; pip install -q -U 'huggingface_hub[cli]'; mkdir -p /workspace/models/${folder}; hf download ${q(repoId)} ${q(file)} --local-dir /workspace/models/${folder}; echo YTM_PULL_DONE; sleep infinity`;
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
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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
    const client = await deps.base.resolveRunpodClient();
    try {
      await client.terminatePod(pull.podId);
      // The volume is shared: the pull is over only once RunPod confirms the pod is gone (bounded wait), like sessions do.
      const deadline = deps.clock.now().getTime() + TERMINATE_CONFIRM_MS;
      for (;;) {
        const current = await client.getPod(pull.podId);
        if (!current || current.status === "TERMINATED") break;
        if (deps.clock.now().getTime() >= deadline) throw new Error(`pod still ${current.status} after terminate`);
        await sleepFn(TERMINATE_POLL_MS);
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
    const finished: ModelPull = { ...pull, status, finishedAt: deps.clock.now().toISOString(), bytes: extra.bytes ?? null, error: extra.error ?? null };
    await savePull(finished);
    return finished;
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
        return finishPull(pull, "failed", { error: "cancelled by operator" });
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
      throw new DomainError({ code: "media_generation_not_configured", message: "Set the datacenter and the network volume in Settings → Media before pulling models." });
    }
    if (await hasActivePull()) {
      throw new DomainError({ code: "media_session_conflict", message: "A model pull is already running; wait for it to finish." });
    }
    if (deps.hasOpenPod && (await deps.hasOpenPod())) {
      throw new DomainError({ code: "media_session_conflict", message: "A generation session is open on the volume; stop it before pulling models (Settings → Media → Sessions)." });
    }
    const client = await deps.base.resolveRunpodClient();
    // `hf download <repo> <file> --local-dir DIR` keeps the file's repo-relative path under DIR.
    const expectedKey = `${MODELS_PREFIX}${parsed.folder}/${parsed.file}`;
    const pullId = deps.generateId();
    const podName = pullPodNameFor(pullId);
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
      const orphan = (await client.listPods().catch(() => [])).find((p) => p.name === podName && p.status !== "TERMINATED");
      if (!orphan) throw error;
      pod = orphan;
    }
    const pull: ModelPull = {
      pullId,
      podId: pod.id,
      repoId: parsed.repoId,
      file: parsed.file,
      expectedKey,
      status: "running",
      startedAt: deps.clock.now().toISOString(),
      finishedAt: null,
      bytes: null,
      error: null,
    };
    await savePull(pull);
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
    const s3 = await deps.base.s3();
    const client = await deps.base.resolveRunpodClient();
    const now = deps.clock.now().getTime();
    for (const pull of running) {
      const head = await s3.headObject(pull.expectedKey);
      if (head && head.size > 0) {
        await finishPull(pull, "done", { bytes: head.size });
        continue;
      }
      const pod = await client.getPod(pull.podId);
      if (!pod || pod.status === "TERMINATED" || pod.status === "EXITED" || pod.status === "ERROR") {
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
