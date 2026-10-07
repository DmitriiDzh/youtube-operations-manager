import { z } from "zod";
import type { HuggingFaceFileInfo, RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { sleep } from "@/lib/shared-async";
import { DomainError, EXCHANGE_PREFIX, MEDIA_MODEL_FOLDERS, NETWORK_VOLUME_USD_PER_GB_MONTH, type MediaModelEntry, type MediaModelUsage, type MediaSettings, type MediaStorageStatus, type MediaVolumeUsage } from "./contracts";
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
/**
 * BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.1): the pull pod downloads into `ytm-staging/<pullId>/` -- outside `models/`
 * (never listed as a model) and outside `exchange/` (the janitor's domain) -- hashes the file there, moves it into
 * `models/` only on a match, and writes its verdict to `ytm-pulls/<pullId>.json`.
 */
export const PULL_STAGING_PREFIX = "ytm-staging/";
export const PULL_RESULTS_PREFIX = "ytm-pulls/";
const MODEL_FOLDERS = MEDIA_MODEL_FOLDERS;
const DEFAULT_PULL_CAP_MS = 6 * 60 * 60_000;
const TERMINATE_CONFIRM_MS = 60_000;
const TERMINATE_POLL_MS = 5_000;
/** A reserved pull (podId null) older than this with no pod of its name is void (its createPod never returned). */
const RESERVATION_GRACE_MS = 2 * 60_000;

/** Deterministic, so a pod created by a `createPod` call that failed after the fact can still be found. */
export function pullPodNameFor(pullId: string): string {
  return `ytm-models-pull-${pullId.slice(0, 8)}`;
}

/** A model's file name on the volume: one path segment, never hidden, never `..`. */
export const MODEL_TARGET_NAME_PATTERN = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,199}$/;

export const startModelPullInputSchema = z
  .object({
    /** Hugging Face repo id, e.g. "Comfy-Org/flux1-schnell". */
    repoId: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "a Hugging Face repo id looks like owner/name"),
    /** Path of the file inside the repo. */
    file: z.string().trim().min(1).max(500).refine((v) => !v.includes("..") && !v.startsWith("/"), "a repo-relative path"),
    folder: z.enum(MODEL_FOLDERS),
    /** Branch, tag or commit (default `main`); resolved to a commit before the pod starts, and that commit is downloaded. */
    revision: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, "a branch, tag or commit").refine((v) => !v.includes(".."), "a branch, tag or commit").optional(),
    /** Expected SHA-256 of the file. Optional here (the Hub's declared hash is used); the factory tool requires it. */
    sha256: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "64 hex characters").optional(),
    /**
     * FO-REQ-0005 item 3: the file's name in `models/<folder>/`. Default: the base name of `file` (a repo's
     * `split_files/<folder>/x.safetensors` lands as `models/<folder>/x.safetensors`). Give it when two repos ship files of
     * the same base name (`model.safetensors`): an existing key is never overwritten.
     */
    targetName: z.string().trim().regex(MODEL_TARGET_NAME_PATTERN, "a file name: letters, digits, '.', '_', '+' or '-', not starting with '.'").optional(),
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
  /** FO-REQ-0005: the file name under `models/<folder>/` (absent on pulls recorded before it, which kept the repo path). */
  targetName?: string;
  expectedKey: string;
  status: "running" | "done" | "failed" | "timeout";
  startedAt: string;
  finishedAt: string | null;
  bytes: number | null;
  error: string | null;
  // BL-132 -- absent on pulls recorded before it (those keep the old "file present = done" rule).
  revision?: string;
  /** The commit the revision resolved to; the pod downloads exactly this. */
  commitSha?: string | null;
  /** The hash the file must have; a pull with one is done only on the pod's matching verdict. */
  expectedSha256?: string | null;
  /** What the pod measured. */
  actualSha256?: string | null;
  /** The Hub's size, known before the pod started. */
  expectedBytes?: number | null;
  requestedBy?: PullActor;
};

export type PullActor = "owner" | "factory";

/** BL-132 audit (FACTORY_MEDIA_CONTROL_PLAN.md §2.5): one row per model action, with who did it. */
export type MediaControlEvent = { actor: "owner" | "factory" | "sync"; action: string; subject: string; details?: Record<string, unknown> };

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
  /** The Hugging Face Hub metadata read (`src/lib/media-gateway/huggingface.ts`), done before any pod is created. */
  hub: { getFileInfo(input: { repoId: string; file: string; revision?: string }): Promise<HuggingFaceFileInfo> };
  /** Audit sink; a failure to record never fails the action itself (it is logged). */
  events: { record(event: MediaControlEvent): Promise<void> };
  /** BL-132: which templates use which model (the job services' `modelUsage`); absent = nothing known, registry unavailable. */
  modelUsage?: () => Promise<MediaModelUsage>;
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

/** FO-REQ-0005 item 3: where a pull lands -- `models/<folder>/<targetName, or the base name of the repo file>`. */
export function pullTargetKey(args: { folder: string; file: string; targetName?: string }): string {
  return `${MODELS_PREFIX}${args.folder}/${args.targetName ?? modelFileName(args.file)}`;
}

/**
 * The shell the CPU pod runs (BL-132): download one file at an exact commit into the pull's staging folder, hash it,
 * MOVE it into `models/<folder>/` only when the hash matches (else it is deleted with the staging folder), write the
 * verdict `{ ok, sha256, bytes }` to `ytm-pulls/<pullId>.json` (via a `.part` + rename), then idle until terminated.
 * The final key therefore never exists unverified (AC-FM-03). The HF CLI's cache lives inside the staging folder and
 * goes with it (review round 14's concern); `set -e` + the trap mean any failure leaves no staging litter and no verdict.
 */
export function buildPullCommand(args: { pullId: string; repoId: string; file: string; folder: string; targetName?: string; commitSha: string; expectedSha256: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const stage = `/workspace/${PULL_STAGING_PREFIX}${args.pullId}`;
  const result = `/workspace/${PULL_RESULTS_PREFIX}${args.pullId}.json`;
  const staged = `${stage}/${q(args.file)}`;
  // `hf download --local-dir` keeps the repo-relative path in the staging folder; the final name drops it (FO-REQ-0005).
  const final = `/workspace/${q(pullTargetKey(args))}`;
  return [
    "set -e",
    `trap 'rm -rf ${stage}' EXIT`,
    "pip install -q -U 'huggingface_hub[cli]'",
    `mkdir -p ${stage} /workspace/${PULL_RESULTS_PREFIX}`,
    `hf download ${q(args.repoId)} ${q(args.file)} --revision ${q(args.commitSha)} --local-dir ${stage}`,
    `ACTUAL=$(sha256sum ${staged} | cut -d' ' -f1)`,
    `BYTES=$(stat -c %s ${staged})`,
    // Never over an existing file (the start refuses an existing key; this covers one that appeared meanwhile).
    `if [ "$ACTUAL" = ${q(args.expectedSha256)} ] && [ ! -e ${final} ]; then mkdir -p "$(dirname ${final})"; mv ${staged} ${final}; OK=true; else OK=false; fi`,
    `rm -rf ${stage}`,
    `printf '{"ok":%s,"sha256":"%s","bytes":%s}\\n' "$OK" "$ACTUAL" "$BYTES" > ${result}.part`,
    `mv ${result}.part ${result}`,
    "echo YTM_PULL_DONE",
    "sleep infinity",
  ].join("\n");
}

export function pullResultKey(pullId: string): string {
  return `${PULL_RESULTS_PREFIX}${pullId}.json`;
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

/** Keep the list bounded: the last 100 finished pulls plus every running one (the full history is the audit table). */
function trimPulls(pulls: ModelPull[]): ModelPull[] {
  const running = pulls.filter((p) => p.status === "running");
  const finished = pulls.filter((p) => p.status !== "running").slice(-100);
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
  async function finishPull(pull: ModelPull, status: ModelPull["status"], extra: { bytes?: number | null; error?: string | null; actualSha256?: string | null; actor?: PullActor }): Promise<ModelPull> {
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
    // BL-132: the pod's staging folder (a killed pod never ran its own `rm`) and its verdict file go too. Best effort.
    await cleanupPullStaging(pull.pullId).catch(() => undefined);
    const finished: ModelPull = {
      ...pull,
      status,
      finishedAt: deps.clock.now().toISOString(),
      bytes: extra.bytes ?? null,
      error: extra.error ?? null,
      ...(extra.actualSha256 !== undefined ? { actualSha256: extra.actualSha256 } : {}),
    };
    await savePull(finished);
    await deps.volumeLock.release(`pull:${pull.pullId}`);
    await audit({
      actor: extra.actor ?? pull.requestedBy ?? "owner",
      action: status === "done" ? "model_pull_done" : extra.error === "cancelled by operator" || extra.error === "cancelled by the Factory Operator" ? "model_pull_cancelled" : `model_pull_${status}`,
      subject: pull.expectedKey,
      details: { pullId: pull.pullId, repoId: pull.repoId, file: pull.file, revision: pull.revision ?? null, commitSha: pull.commitSha ?? null, expectedSha256: pull.expectedSha256 ?? null, actualSha256: finished.actualSha256 ?? null, bytes: finished.bytes, error: finished.error },
    });
    return finished;
  }

  async function listModelFiles(): Promise<Array<{ key: string; folder: string; name: string; bytes: number; lastModified: string | null }>> {
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
  }

  /** Never throws (independent review): a usage that cannot be computed is "unknown" -- the factory is then refused, the owner is not. */
  async function usageOrUnknown(): Promise<MediaModelUsage> {
    if (!deps.modelUsage) return { registry: "unavailable", registryError: "model usage is not wired", users: [] };
    try {
      return await deps.modelUsage();
    } catch (error) {
      return { registry: "unavailable", registryError: `template usage could not be read: ${error instanceof Error ? error.message : String(error)}`, users: [] };
    }
  }

  /** Records an audit row; a failure to record never fails or undoes the action it describes (logged instead). */
  async function audit(event: MediaControlEvent): Promise<void> {
    try {
      await deps.events.record(event);
    } catch (error) {
      console.warn(`[media] could not record the ${event.action} event for ${event.subject}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Deletes `ytm-staging/<pullId>/**` and `ytm-pulls/<pullId>.json` -- this pull's own keys only. */
  async function cleanupPullStaging(pullId: string): Promise<void> {
    const s3 = await deps.base.s3();
    for (const object of await s3.listAllObjects(`${PULL_STAGING_PREFIX}${pullId}/`)) await s3.deleteObject(object.key);
    await s3.deleteObject(pullResultKey(pullId));
    await s3.deleteObject(`${pullResultKey(pullId)}.part`); // a pod killed between its printf and its mv
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
      return listModelFiles();
    },

    /**
     * Deletes one object under `models/` (explicit action; never a prefix, never outside models/). BL-132 (plan §2.2): the
     * FACTORY is refused while any template uses the file (`media_model_in_use`) or while the registry cannot be read to
     * tell (fail closed); the OWNER is shown the same check in the Web UI before confirming and is never locked out of
     * their own storage. Both are refused while sessions or a pull hold the volume (a running job may be reading it).
     */
    async deleteModel(input: unknown, options: { actor?: PullActor } = {}): Promise<{ deleted: string }> {
      const { key } = parseWithSchema(modelKeySchema, input, "model key");
      const actor = options.actor ?? "owner";
      // The lock first, then the check, then the delete (independent review): nothing that takes the volume can slip in
      // between the "unused" verdict and the delete.
      const owner = `delete:${deps.generateId()}` as const;
      await deps.volumeLock.acquire(owner);
      let usage: MediaModelUsage;
      let users: MediaModelUsage["users"];
      try {
        usage = await usageOrUnknown();
        users = usage.users.filter((u) => u.key === key);
        if (actor === "factory") {
          if (usage.registry === "unavailable") {
            throw new DomainError({ code: "media_template_registry_unavailable", message: `The template registry cannot be read completely on this device, so it cannot be shown that no template uses ${key}; nothing was deleted. (${usage.registryError ?? "not configured"})`, details: { key } });
          }
          if (users.length > 0) {
            throw new DomainError({ code: "media_model_in_use", message: `${key} is used by ${users.map((u) => `${u.templateId} v${u.version}${u.source === "owner" ? " (local)" : ""}`).join(", ")}; nothing was deleted.`, details: { key, usedBy: users } });
          }
        }
        const s3 = await deps.base.s3();
        await s3.deleteObject(key);
      } finally {
        // A failed release must not replace the answer being thrown (FO-REQ-0005: `media_model_in_use` must reach the
        // caller); the row is then left to the lock's staleness rule (an inactive `delete:` holder ages out).
        await deps.volumeLock.release(owner).catch((error: unknown) => {
          console.warn(`[media] could not release the volume lock ${owner}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await audit({ actor, action: "model_deleted", subject: key, details: users.length > 0 || usage.registry === "unavailable" ? { usedBy: users, registry: usage.registry } : undefined });
      return { deleted: key };
    },

    /** BL-132 (plan §2.2): the network volume's rented size, use, free space and monthly cost, as RunPod reports it. */
    async storageStatus(): Promise<MediaStorageStatus> {
      const settings = await deps.base.getSettings();
      if (!settings.networkVolumeId) throw new DomainError({ code: "media_generation_not_configured", message: "No network volume is chosen (Production → Setup)." });
      const volume = await (await deps.base.resolveRunpodClient()).getNetworkVolume(settings.networkVolumeId);
      if (!volume) throw new DomainError({ code: "media_settings_invalid", message: `RunPod has no network volume ${settings.networkVolumeId} on this account.`, details: { volumeId: settings.networkVolumeId } });
      const usedGb = volume.usedSizeGb;
      return {
        volumeId: volume.id,
        dataCenterId: volume.dataCenterId ?? settings.datacenterId ?? null,
        sizeGb: volume.sizeGb,
        usedGb,
        freeGb: usedGb === null ? null : Math.max(0, volume.sizeGb - usedGb),
        monthlyUsd: Math.round(volume.sizeGb * NETWORK_VOLUME_USD_PER_GB_MONTH * 100) / 100,
      };
    },

    /** BL-136: the bytes on the whole volume by area, from one S3 listing (RunPod does not report a volume's used space). */
    async volumeUsage(): Promise<MediaVolumeUsage> {
      const objects = await (await deps.base.s3()).listAllObjects("");
      const usage: MediaVolumeUsage = { totalBytes: 0, modelsBytes: 0, exchangeBytes: 0, otherBytes: 0, objectCount: objects.length };
      for (const o of objects) {
        usage.totalBytes += o.size;
        if (o.key.startsWith(MODELS_PREFIX)) usage.modelsBytes += o.size;
        else if (o.key.startsWith(EXCHANGE_PREFIX)) usage.exchangeBytes += o.size;
        else usage.otherBytes += o.size;
      }
      return usage;
    },

    /** BL-132: the model list with each file's verified SHA-256 (from this device's pulls) and the templates using it. */
    async listModelsWithUsage(): Promise<{ models: MediaModelEntry[]; registry: MediaModelUsage["registry"]; registryError: string | null }> {
      const [files, usage, pulls] = await Promise.all([listModelFiles(), usageOrUnknown(), readPulls()]);
      const hashes = new Map<string, string>();
      for (const pull of pulls) if (pull.status === "done" && pull.actualSha256) hashes.set(pull.expectedKey, pull.actualSha256);
      return {
        registry: usage.registry,
        registryError: usage.registryError,
        models: files.map((f) => ({
          ...f,
          sha256: hashes.get(f.key) ?? null,
          usedBy: usage.users.filter((u) => u.key === f.key).map(({ templateId, version, source }) => ({ templateId, version, source })),
        })),
      };
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
    async startPull(input: unknown, options: { requestedBy?: PullActor } = {}): Promise<ModelPull> {
      return serialized(() => startPullInner(input, options.requestedBy ?? "owner"));
    },

    async pollPulls(): Promise<ModelPull[]> {
      return serialized(() => pollPullsInner());
    },

    /** Operator abort: terminate the pull pod now. */
    async cancelPull(input: unknown, options: { actor?: PullActor } = {}): Promise<ModelPull> {
      const actor = options.actor ?? "owner";
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
        // The pod may already have verified and moved the file (independent review): then the pull is done, not cancelled --
        // the record must not say "nothing was kept" while a verified file sits at its final key.
        if (target.expectedSha256) {
          const verdict = await deps.base
            .s3()
            .then((s3) => s3.getObjectText(pullResultKey(pullId)))
            .then((text) => (text === null ? null : parseVerdict(text)), () => null);
          if (verdict && verdict.ok && verdict.sha256 === target.expectedSha256) {
            return finishPull(target, "done", { bytes: verdict.bytes, actualSha256: verdict.sha256, actor });
          }
        }
        return finishPull(target, "failed", { error: actor === "factory" ? "cancelled by the Factory Operator" : "cancelled by operator", actor });
      });
    },
  };

  async function hasActivePull(): Promise<boolean> {
    return (await readPulls()).some((p) => p.status === "running");
  }

  async function startPullInner(input: unknown, requestedBy: PullActor): Promise<ModelPull> {
    const parsed = parseWithSchema(startModelPullInputSchema, input, "model pull");
    const settings = await deps.base.getSettings();
    if (!settings.datacenterId || !settings.networkVolumeId) {
      throw new DomainError({ code: "media_generation_not_configured", message: "Set the datacenter and the network volume in Production → Setup before pulling models." });
    }
    if (await hasActivePull()) {
      throw new DomainError({ code: "media_session_conflict", message: "A model pull is already running; wait for it to finish." });
    }
    // BL-132 pre-check (AC-FM-01): everything that can refuse the pull is asked BEFORE any pod exists -- no cost.
    const hub = await deps.hub.getFileInfo({ repoId: parsed.repoId, file: parsed.file, revision: parsed.revision });
    if (hub.sha256 && parsed.sha256 && hub.sha256 !== parsed.sha256) {
      throw new DomainError({
        code: "media_model_hash_mismatch",
        message: `Hugging Face declares SHA-256 ${hub.sha256} for ${parsed.repoId}/${parsed.file}@${hub.revision}, not the requested ${parsed.sha256}.`,
        details: { repoId: parsed.repoId, file: parsed.file, revision: hub.revision, declared: hub.sha256, requested: parsed.sha256 },
      });
    }
    const expectedSha256 = parsed.sha256 ?? hub.sha256;
    if (!expectedSha256) {
      throw new DomainError({
        code: "validation_failed",
        message: `${parsed.file} has no SHA-256 on Hugging Face (not an LFS file); pass the expected sha256 explicitly.`,
        details: { repoId: parsed.repoId, file: parsed.file },
      });
    }
    const client = await deps.base.resolveRunpodClient();
    const volume = await client.getNetworkVolume(settings.networkVolumeId);
    if (volume && volume.usedSizeGb !== null) {
      // RunPod sizes are decimal GB; the file must fit in what is left (a staged file is moved, never copied).
      const freeBytes = Math.max(0, (volume.sizeGb - volume.usedSizeGb) * 1e9);
      if (hub.bytes > freeBytes) {
        throw new DomainError({
          code: "media_volume_full",
          message: `${parsed.file} is ${(hub.bytes / 1e9).toFixed(2)} GB, but the network volume has only ${(freeBytes / 1e9).toFixed(2)} GB free (${volume.usedSizeGb} of ${volume.sizeGb} GB used).`,
          details: { bytes: hub.bytes, freeBytes, sizeGb: volume.sizeGb, usedGb: volume.usedSizeGb },
        });
      }
    }
    // The default name follows the same rule as a given one (independent review): never hidden (`.cache` is the HF CLI's).
    if (parsed.targetName === undefined && !MODEL_TARGET_NAME_PATTERN.test(modelFileName(parsed.file))) {
      throw new DomainError({ code: "validation_failed", message: `${modelFileName(parsed.file)} cannot be a model file name on the volume; give targetName.`, details: { file: parsed.file } });
    }
    const expectedKey = pullTargetKey(parsed);
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
    const reserved: ModelPull = {
      pullId,
      podId: null,
      repoId: parsed.repoId,
      file: parsed.file,
      ...(parsed.targetName !== undefined ? { targetName: parsed.targetName } : {}),
      expectedKey,
      status: "running",
      startedAt: deps.clock.now().toISOString(),
      finishedAt: null,
      bytes: null,
      error: null,
      revision: hub.revision,
      commitSha: hub.commitSha,
      expectedSha256,
      actualSha256: null,
      expectedBytes: hub.bytes,
      requestedBy,
    };
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
        cmd: ["bash", "-lc", buildPullCommand({ pullId, repoId: parsed.repoId, file: parsed.file, folder: parsed.folder, targetName: parsed.targetName, commitSha: hub.commitSha, expectedSha256 })],
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
    await audit({
      actor: requestedBy,
      action: "model_pull_started",
      subject: expectedKey,
      details: { pullId, repoId: parsed.repoId, file: parsed.file, targetName: parsed.targetName ?? null, revision: hub.revision, commitSha: hub.commitSha, expectedSha256, bytes: hub.bytes, podId: pod.id },
    });
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
      if (pull.expectedSha256) {
        // BL-132: a verified pull is settled ONLY by the pod's verdict (AC-FM-02/03). A file at the final key with no
        // verdict yet is not "done" (the verdict follows the move within seconds); a mismatch verdict means the pod deleted
        // the file. The verdict's bytes must also be what S3 sees at the final key (its view can lag -- then wait).
        let verdictText: string | null | undefined;
        try {
          if (!s3) throw new Error("the S3 key pair is not usable");
          verdictText = await s3.getObjectText(pullResultKey(pull.pullId));
        } catch (error) {
          verdictText = undefined;
          await savePull({ ...pull, error: `S3 could not be asked for the pull's verdict (${error instanceof Error ? error.message : String(error)}); retrying` });
        }
        const verdict = typeof verdictText === "string" ? parseVerdict(verdictText) : null;
        if (typeof verdictText === "string" && !verdict) {
          await finishPull(pull, "failed", { error: "the pod's verdict file could not be read" });
          continue;
        }
        if (verdict) {
          if (!verdict.ok || verdict.sha256 !== pull.expectedSha256) {
            // A matching hash with ok=false means the pod found the target key taken and did not overwrite it (FO-REQ-0005).
            const error =
              verdict.sha256 === pull.expectedSha256
                ? `${pull.expectedKey} already existed when the download finished; nothing was overwritten and the downloaded copy was deleted`
                : `hash mismatch: expected ${pull.expectedSha256}, the downloaded file has ${verdict.sha256}; the file was deleted`;
            await finishPull(pull, "failed", { error, actualSha256: verdict.sha256, bytes: verdict.bytes });
            continue;
          }
          const head = await s3!.headObject(pull.expectedKey).catch(() => undefined);
          if (head && head.size === verdict.bytes) {
            await finishPull(pull, "done", { bytes: verdict.bytes, actualSha256: verdict.sha256 });
            continue;
          }
          // The move is a rename on the volume: once S3 shows the key at all, a different size is a contradiction, not lag
          // (independent review) -- fail now instead of letting the pod idle to the 6 h cap. Absent (null) = lag: wait.
          if (head && head.size !== verdict.bytes) {
            await finishPull(pull, "failed", { error: `the pod reported ${verdict.bytes} bytes, the volume shows ${head.size} at ${pull.expectedKey}`, actualSha256: verdict.sha256, bytes: head.size });
            continue;
          }
        }
      } else {
        // A pull recorded before BL-132 (no expected hash): the old rule -- the key on the volume means done.
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

/** The pod's `{ ok, sha256, bytes }`, or `null` when the file is not in that shape. */
function parseVerdict(text: string): { ok: boolean; sha256: string; bytes: number } | null {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof parsed.ok === "boolean" && typeof parsed.sha256 === "string" && typeof parsed.bytes === "number") return { ok: parsed.ok, sha256: parsed.sha256.toLowerCase(), bytes: parsed.bytes };
  } catch {
    // fall through
  }
  return null;
}

export type MediaModelServices = ReturnType<typeof createMediaModelServices>;
