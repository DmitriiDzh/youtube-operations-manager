import { createHash } from "node:crypto";
import path from "node:path";
import type { StoredGeminiMediaJob } from "@/lib/db";
import type { GeminiImageResult, GeminiInlineImage, GeminiInteractionsVideoResult } from "@/lib/media-gateway";
import {
  GEMINI_ACTIVE_STATUSES,
  GEMINI_LIMITS,
  GEMINI_MANIFEST_FILE,
  GEMINI_OUTPUT_SUBDIR,
  GEMINI_VIDEO_MODELS,
  isDomainError,
  ownEntry,
  type GeminiCostBasis,
  type GeminiImageParams,
  type GeminiJobErrorCode,
  type GeminiJobInput,
  type GeminiJobManifest,
  type GeminiJobOutput,
  type GeminiVideoParams,
} from "./contracts";
import { imageCostFromTable, imageCostFromUsage, videoCostFromUsage } from "./pricing";
import { createGeminiMediaServices, jobView, type GeminiMediaDeps } from "./services";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.4): runs queued jobs and collects running videos. One `tick()` every few seconds from
// `src/instrumentation.ts`; at most `inFlightPerProcess` jobs at a time. Every status change is a compare-and-set from the
// status the job was read in, so a second runner can never move a job twice.
//
// Money rules: a request Google provably never received, or answered with an error, costs 0 ("not_charged"); a finished
// image costs Google's own token counts ("usage") or the table price ("price_table"); a finished
// video (Omni, BL-179) Google's token counts, else its estimate; a request that was sent and then lost (timeout,
// restart mid-call, video never collected) counts its estimate ("unknown_outcome") so the spend is never under-counted.

const EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" });
const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({ "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" });

/** BL-179: an Omni video Google delivered as a Files API URI is collected by the next poll, from `remoteName`. */
const isDownloadUri = (remoteName: string) => remoteName.startsWith("https://") || remoteName.startsWith("http://");

type Failure = { errorCode: GeminiJobErrorCode; error: string; costUsd: number; costBasis: GeminiCostBasis };

export function createGeminiWorker(deps: GeminiMediaDeps) {
  const services = createGeminiMediaServices(deps);
  const inFlight = new Set<string>();
  const now = () => deps.clock.now();

  async function fail(job: StoredGeminiMediaJob, from: StoredGeminiMediaJob["status"], failure: Failure): Promise<void> {
    await deps.store.updateJob(job.jobId, from, {
      status: "failed",
      errorCode: failure.errorCode,
      error: failure.error.slice(0, 2000),
      costUsd: failure.costUsd,
      costBasis: failure.costBasis,
      nextAttemptAt: null,
      finishedAt: now(),
      updatedAt: now(),
    });
  }

  const notCharged = (errorCode: GeminiJobErrorCode, error: string): Failure => ({ errorCode, error, costUsd: 0, costBasis: "not_charged" });
  const maybeCharged = (job: StoredGeminiMediaJob, errorCode: GeminiJobErrorCode, error: string): Failure => ({ errorCode, error, costUsd: job.estimateUsd, costBasis: "unknown_outcome" });

  /** How a call that threw ends the job: retried (the request never reached Google, or Google said "later"), or a failure. */
  function classify(job: StoredGeminiMediaJob, error: unknown): { retry: true; errorCode: GeminiJobErrorCode; message: string } | { retry: false; failure: Failure } {
    const message = error instanceof Error ? error.message : String(error);
    if (!isDomainError(error)) return { retry: false, failure: maybeCharged(job, "gemini_unavailable", message) };
    const details = (error.details ?? {}) as Record<string, unknown>;
    switch (error.code) {
      case "gemini_rate_limited":
        return { retry: true, errorCode: "gemini_rate_limited", message };
      case "gemini_unavailable":
        if (details.outcome === "unknown") return { retry: false, failure: maybeCharged(job, details.timedOut ? "gemini_timeout" : "gemini_unavailable", message) };
        return { retry: true, errorCode: "gemini_unavailable", message };
      case "gemini_request_rejected":
        return { retry: false, failure: notCharged(details.blocked ? "gemini_blocked" : "gemini_invalid_request", message) };
      case "gemini_key_invalid":
        return { retry: false, failure: notCharged("gemini_key_invalid", message) };
      case "gemini_payment_required":
        return { retry: false, failure: notCharged("gemini_payment_required", message) };
      case "media_gateway_disabled":
        return { retry: false, failure: notCharged("media_gateway_disabled", message) };
      default:
        return { retry: false, failure: maybeCharged(job, "gemini_unavailable", message) };
    }
  }

  /** Back to `queued` with backoff while attempts remain; otherwise failed at no cost (every attempt was refused or never arrived). */
  async function retryOrFail(job: StoredGeminiMediaJob, attempts: number, errorCode: GeminiJobErrorCode, message: string): Promise<void> {
    if (attempts < GEMINI_LIMITS.maxAttempts) {
      const backoff = GEMINI_LIMITS.retryBackoffMs[Math.min(attempts - 1, GEMINI_LIMITS.retryBackoffMs.length - 1)];
      await deps.store.updateJob(job.jobId, "submitting", { status: "queued", errorCode, error: message.slice(0, 2000), nextAttemptAt: new Date(now().getTime() + backoff), updatedAt: now() });
      return;
    }
    await fail(job, "submitting", notCharged(errorCode, `${message} (after ${attempts} attempts)`));
  }

  /** Re-reads the job's inputs with the same proofs as at creation; a file that changed fails the job before anything is sent. */
  async function loadInputs(job: StoredGeminiMediaJob, inputs: GeminiJobInput[]): Promise<Map<string, GeminiInlineImage> | Failure> {
    const loaded = new Map<string, GeminiInlineImage>();
    for (const input of inputs) {
      try {
        const resolved = await deps.workspace.resolveInput(job.channelId, input.path);
        const data = await deps.files.readInput(resolved, GEMINI_LIMITS.inputBytes);
        if (createHash("sha256").update(data).digest("hex") !== input.sha256) {
          return notCharged("gemini_input_changed", `Input ${input.path} changed after the job was created.`);
        }
        loaded.set(`${input.role}:${input.path}`, { mimeType: input.mimeType, dataBase64: data.toString("base64") });
      } catch (error) {
        return notCharged("gemini_input_changed", `Input ${input.path} is no longer readable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return loaded;
  }

  async function registerAsset(job: StoredGeminiMediaJob, output: Omit<GeminiJobOutput, "assetId" | "note">): Promise<{ assetId: string | null; note: string | null }> {
    try {
      const existing = await deps.assets.findByLocalPath(job.channelId, output.localPath);
      if (existing) return { assetId: existing.assetId, note: null };
      const asset = await deps.assets.register({
        channelId: job.channelId,
        assetType: output.kind === "video" ? "generated_video" : "generated_image",
        referenceKind: "local_path",
        referenceValue: output.localPath,
        title: `${job.model} ${output.kind} ${job.jobId}`,
        provenance: { source: "gemini_media", jobId: job.jobId, model: job.model, kind: job.kind, params: JSON.parse(job.paramsJson), prompt: job.prompt.slice(0, 2000), sha256: output.sha256, bytes: output.bytes, mimeType: output.mimeType },
      });
      return { assetId: asset.assetId, note: null };
    } catch (error) {
      // The file is the result; a catalog failure never costs it (the same rule as media jobs).
      return { assetId: null, note: `not registered in the asset catalog: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
    }
  }

  async function writeManifest(job: StoredGeminiMediaJob, dir: string, outputs: GeminiJobOutput[], costUsd: number, costBasis: GeminiCostBasis, finishedAt: Date): Promise<void> {
    const params = JSON.parse(job.paramsJson) as GeminiImageParams | GeminiVideoParams;
    const inputs = JSON.parse(job.inputsJson) as GeminiJobInput[];
    const manifest: GeminiJobManifest = {
      schema: "ytm.gemini-job-manifest",
      schemaVersion: 1,
      jobId: job.jobId,
      channelId: job.channelId,
      kind: job.kind,
      model: job.model,
      prompt: job.prompt,
      params,
      inputs: inputs.map((i) => ({ role: i.role, path: i.path, bytes: i.bytes, sha256: i.sha256 })),
      status: "done",
      estimateUsd: job.estimateUsd,
      costUsd,
      costBasis,
      createdBy: job.createdBy,
      createdAt: job.createdAt.toISOString(),
      submittedAt: job.submittedAt ? job.submittedAt.toISOString() : null,
      finishedAt: finishedAt.toISOString(),
      device: await deps.device(),
      video: job.video ?? null,
      outputs: outputs.map((o) => ({ path: o.path, kind: o.kind, mimeType: o.mimeType, bytes: o.bytes, sha256: o.sha256, assetId: o.assetId, note: o.note })),
    };
    await deps.files.writeManifest(path.join(dir, GEMINI_MANIFEST_FILE), manifest);
  }

  async function finish(job: StoredGeminiMediaJob, from: "submitting" | "running", dir: string, outputs: GeminiJobOutput[], costUsd: number, costBasis: GeminiCostBasis): Promise<void> {
    const finishedAt = now();
    try {
      await writeManifest(job, dir, outputs, costUsd, costBasis, finishedAt);
    } catch (error) {
      await deps.store.updateJob(job.jobId, from, {
        status: "failed",
        errorCode: "gemini_output_failed",
        error: `The files were written but manifest.json was not: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
        outputsJson: JSON.stringify(outputs),
        costUsd,
        costBasis,
        nextAttemptAt: null,
        finishedAt,
        updatedAt: finishedAt,
      });
      return;
    }
    await deps.store.updateJob(job.jobId, from, { status: "done", outputsJson: JSON.stringify(outputs), costUsd, costBasis, error: null, errorCode: null, nextAttemptAt: null, finishedAt, updatedAt: finishedAt });
  }

  /** Claims a queued job (CAS) and resolves what every kind needs before calling Google: key, inputs, output folder. */
  async function claim(job: StoredGeminiMediaJob) {
    const attempts = job.attempts + 1;
    const submittedAt = job.submittedAt ?? now();
    const claimed = await deps.store.updateJob(job.jobId, "queued", { status: "submitting", attempts, submittedAt, nextAttemptAt: null, updatedAt: now() });
    if (!claimed) return null;
    // The job carries on with what was stored: an answer that comes back in this same call writes the manifest from this object,
    // which otherwise kept the submission time it was read with -- null (FO-MSG-0016).
    job.submittedAt = submittedAt;
    let apiKey: string | null;
    try {
      apiKey = await services.readApiKey();
    } catch (error) {
      await fail(job, "submitting", notCharged("gemini_key_missing", error instanceof Error ? error.message : String(error)));
      return null;
    }
    if (!apiKey) {
      await fail(job, "submitting", notCharged("gemini_key_missing", "The Gemini API key was removed from this computer."));
      return null;
    }
    const inputs = JSON.parse(job.inputsJson) as GeminiJobInput[];
    const loaded = await loadInputs(job, inputs);
    if (!(loaded instanceof Map)) {
      await fail(job, "submitting", loaded);
      return null;
    }
    let dir: string;
    try {
      dir = path.join(await deps.workspace.resolveOutputRoot(job.channelId), GEMINI_OUTPUT_SUBDIR, job.jobId);
    } catch (error) {
      await fail(job, "submitting", notCharged("gemini_output_failed", `The output folder is not available: ${error instanceof Error ? error.message : String(error)}`));
      return null;
    }
    return { apiKey, attempts, inputs, loaded, dir };
  }

  function relativeOutput(job: StoredGeminiMediaJob, file: string): string {
    return `${GEMINI_OUTPUT_SUBDIR}/${job.jobId}/${file}`;
  }

  async function runImage(job: StoredGeminiMediaJob): Promise<void> {
    const claimed = await claim(job);
    if (!claimed) return;
    const params = JSON.parse(job.paramsJson) as GeminiImageParams;
    let result: GeminiImageResult;
    try {
      result = await deps.api.generateImage(claimed.apiKey, {
        model: job.model,
        prompt: job.prompt,
        images: claimed.inputs.map((i) => claimed.loaded.get(`${i.role}:${i.path}`)!),
        aspectRatio: params.aspectRatio,
        imageSize: params.size,
      });
    } catch (error) {
      const verdict = classify(job, error);
      if (verdict.retry) await retryOrFail(job, claimed.attempts, verdict.errorCode, verdict.message);
      else await fail(job, "submitting", verdict.failure);
      return;
    }
    const charged = result.usage ? imageCostFromUsage(job.model, result.usage, result.images.length) : null;
    if (result.images.length === 0) {
      // No image. Only a terminal refusal (a block code; a failed / cancelled / incomplete status) or a completed answer with
      // Google's own counts may decide what it cost: the image itself is not charged, the counted input and thinking are.
      // Anything else -- an unreadable body, a non-terminal status (in_progress, queued, …) whatever its counts -- may still be
      // generating and charged: its estimate (review rounds 1 and 2).
      const refused = result.blockReason !== null || (result.status !== null && ["failed", "cancelled", "incomplete"].includes(result.status));
      const completedWithCounts = result.status === "completed" && charged !== null;
      if (!refused && !completedWithCounts) {
        await fail(job, "submitting", maybeCharged(job, "gemini_unavailable", `Google answered without an image, a final status or token counts (status ${result.status ?? "none"}); it may have been charged.`));
        return;
      }
      const reason = result.blockReason ?? (result.status && result.status !== "completed" ? `status ${result.status}` : "no image in the answer");
      await fail(job, "submitting", { errorCode: "gemini_blocked", error: `Google returned no image (${reason}).`, costUsd: charged ?? 0, costBasis: charged !== null ? "usage" : "not_charged" });
      return;
    }
    // Google's counts, but never below the table price of the images saved (a count without its modality split, review round 1).
    const tableCost = imageCostFromTable(job.model, params.size, result.images.length);
    const costUsd = charged !== null ? Math.max(charged, tableCost) : tableCost;
    const costBasis: GeminiCostBasis = charged !== null ? "usage" : "price_table";
    const outputs: GeminiJobOutput[] = [];
    try {
      for (const [index, image] of result.images.entries()) {
        const file = `image-${index + 1}.${ownEntry(EXTENSIONS, image.mimeType) ?? "bin"}`;
        const localPath = path.join(claimed.dir, file);
        const written = await deps.files.writeOutput(localPath, image.data);
        const base = { path: relativeOutput(job, file), localPath, kind: "image" as const, mimeType: image.mimeType, bytes: written.bytes, sha256: written.sha256 };
        outputs.push({ ...base, ...(await registerAsset(job, base)) });
      }
    } catch (error) {
      // Paid: the cost stays, and the files already written (and registered) stay listed.
      await deps.store.updateJob(job.jobId, "submitting", {
        status: "failed",
        errorCode: "gemini_output_failed",
        error: `The image was generated (and charged) but could not be written: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
        outputsJson: outputs.length > 0 ? JSON.stringify(outputs) : null,
        costUsd,
        costBasis,
        nextAttemptAt: null,
        finishedAt: now(),
        updatedAt: now(),
      });
      return;
    }
    await finish(job, "submitting", claimed.dir, outputs, costUsd, costBasis);
  }

  /**
   * BL-179 (FO-REQ-0021): one Omni video, synchronous like an image. Its answer is the video: written here, priced by Google's
   * token counts. Delivered as a URI instead, it is collected by the running-video poll (already paid for, so never dropped).
   */
  async function runInteractionsVideo(job: StoredGeminiMediaJob): Promise<void> {
    const claimed = await claim(job);
    if (!claimed) return;
    const params = JSON.parse(job.paramsJson) as GeminiVideoParams;
    const pick = (role: GeminiJobInput["role"]) => claimed.inputs.filter((i) => i.role === role).map((i) => claimed.loaded.get(`${i.role}:${i.path}`)!);
    let result: GeminiInteractionsVideoResult;
    try {
      result = await deps.api.generateVideo(claimed.apiKey, {
        model: job.model,
        prompt: job.prompt,
        frames: [...pick("first_frame"), ...pick("last_frame")],
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        durationSeconds: params.durationSeconds,
      });
    } catch (error) {
      const verdict = classify(job, error);
      if (verdict.retry) await retryOrFail(job, claimed.attempts, verdict.errorCode, verdict.message);
      else await fail(job, "submitting", verdict.failure);
      return;
    }
    const charged = result.usage ? videoCostFromUsage(job.model, result.usage, result.video ? { resolution: params.resolution, durationSeconds: params.durationSeconds } : null) : null;
    if (!result.video) {
      // The image rule (review rounds 1 and 2 of BL-174): only a terminal refusal or a completed answer with Google's counts
      // decides the cost; anything else may still be generating and charged -- its estimate.
      const refused = result.blockReason !== null || (result.status !== null && ["failed", "cancelled", "incomplete"].includes(result.status));
      const completedWithCounts = result.status === "completed" && charged !== null;
      if (!refused && !completedWithCounts) {
        await fail(job, "submitting", maybeCharged(job, "gemini_unavailable", `Google answered without a video, a final status or token counts (status ${result.status ?? "none"}); it may have been charged.`));
        return;
      }
      const reason = result.blockReason ?? (result.status && result.status !== "completed" ? `status ${result.status}` : "no video in the answer");
      await fail(job, "submitting", { errorCode: "gemini_blocked", error: `Google returned no video (${reason}).`, costUsd: charged ?? 0, costBasis: charged !== null ? "usage" : "not_charged" });
      return;
    }
    const costUsd = charged ?? job.estimateUsd;
    const costBasis: GeminiCostBasis = charged !== null ? "usage" : "price_table";
    if ("uri" in result.video && !isDownloadUri(result.video.uri)) {
      // A reference no download can follow (review item 4): paid, but not collectable -- counted, never polled for 47 h.
      await fail(job, "submitting", { errorCode: "gemini_output_failed", error: `The video was generated (and charged) but Google gave no downloadable link (${result.video.uri.slice(0, 120)}).`, costUsd, costBasis });
      return;
    }
    if ("uri" in result.video) {
      await deps.store.updateJob(job.jobId, "submitting", {
        status: "running",
        remoteName: result.video.uri,
        costUsd,
        costBasis,
        error: null,
        errorCode: null,
        nextAttemptAt: now(),
        updatedAt: now(),
      });
      return;
    }
    const file = `video-1.${ownEntry(VIDEO_EXTENSIONS, result.video.mimeType) ?? "mp4"}`;
    const localPath = path.join(claimed.dir, file);
    let output: GeminiJobOutput;
    try {
      const written = await deps.files.writeOutput(localPath, result.video.data);
      const base = { path: relativeOutput(job, file), localPath, kind: "video" as const, mimeType: result.video.mimeType, bytes: written.bytes, sha256: written.sha256 };
      output = { ...base, ...(await registerAsset(job, base)) };
    } catch (error) {
      // Paid: the cost stays.
      await deps.store.updateJob(job.jobId, "submitting", {
        status: "failed",
        errorCode: "gemini_output_failed",
        error: `The video was generated (and charged) but could not be written: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
        costUsd,
        costBasis,
        nextAttemptAt: null,
        finishedAt: now(),
        updatedAt: now(),
      });
      return;
    }
    await finish(job, "submitting", claimed.dir, [output], costUsd, costBasis);
  }

  async function pollVideo(job: StoredGeminiMediaJob): Promise<void> {
    const later = (ms: number, note?: string) =>
      deps.store.updateJob(job.jobId, "running", { nextAttemptAt: new Date(now().getTime() + ms), ...(note ? { error: note.slice(0, 2000) } : {}), updatedAt: now() });
    const startedAt = (job.submittedAt ?? job.createdAt).getTime();
    // An Omni video's cost is already known from Google's counts: kept, never replaced by the estimate (review item 4).
    const knownCost = (errorCode: GeminiJobErrorCode, error: string): Failure =>
      job.costUsd !== null && job.costBasis ? { errorCode, error, costUsd: job.costUsd, costBasis: job.costBasis as GeminiCostBasis } : maybeCharged(job, errorCode, error);
    if (now().getTime() - startedAt > GEMINI_LIMITS.videoGiveUpMs) {
      await fail(job, "running", knownCost("gemini_expired", "The video was not collected within 47 hours; Google keeps it for 2 days."));
      return;
    }
    if (!job.remoteName) {
      await fail(job, "running", maybeCharged(job, "gemini_interrupted", "The video job has no download link."));
      return;
    }
    // BL-180: a Veo job started before its models were removed has an operation name, which is no longer polled.
    if (!isDownloadUri(job.remoteName)) {
      await fail(job, "running", maybeCharged(job, "gemini_expired", "A Veo video is no longer collected here: the Veo 3.1 previews were removed (Google shuts them down on 2026-10-22)."));
      return;
    }
    let apiKey: string | null;
    try {
      apiKey = await services.readApiKey();
    } catch (error) {
      await later(GEMINI_LIMITS.videoRetryMs, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!apiKey) {
      await later(GEMINI_LIMITS.videoRetryMs, "No Gemini API key on this computer: the started video cannot be collected until one is entered.");
      return;
    }
    const videoUri = job.remoteName;
    let dir: string;
    try {
      dir = path.join(await deps.workspace.resolveOutputRoot(job.channelId), GEMINI_OUTPUT_SUBDIR, job.jobId);
    } catch (error) {
      await later(GEMINI_LIMITS.videoRetryMs, `The output folder is not available: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const file = "video-1.mp4";
    const localPath = path.join(dir, file);
    let written: { bytes: number; sha256: string };
    try {
      written = await deps.api.downloadVideo(apiKey, videoUri, localPath);
    } catch (error) {
      // Google answered that the file is gone (review item 4), or with something that is not a video (re-check): nothing left to
      // collect -- not retried for 47 h.
      const details = isDomainError(error) ? (error.details as { status?: number; notAVideo?: boolean } | undefined) : undefined;
      if (details?.status === 404) {
        await fail(job, "running", knownCost("gemini_expired", `Google no longer has the video file: ${(error as Error).message}`));
        return;
      }
      if (details?.notAVideo) {
        await fail(job, "running", knownCost("gemini_output_failed", `The video link did not give a video file: ${(error as Error).message}`));
        return;
      }
      await later(GEMINI_LIMITS.videoRetryMs, `Download failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const base = { path: relativeOutput(job, file), localPath, kind: "video" as const, mimeType: "video/mp4", bytes: written.bytes, sha256: written.sha256 };
    const output: GeminiJobOutput = { ...base, ...(await registerAsset(job, base)) };
    // The cost was recorded from Google's counts when the link was delivered; without it, the table price.
    if (job.costUsd !== null && job.costBasis) await finish(job, "running", dir, [output], job.costUsd, job.costBasis as GeminiCostBasis);
    else await finish(job, "running", dir, [output], job.estimateUsd, "price_table");
  }

  function track(jobId: string, run: () => Promise<void>): Promise<void> {
    inFlight.add(jobId);
    return run()
      .catch((error) => console.error(`[gemini-media] job ${jobId}:`, error instanceof Error ? error.message : error))
      .finally(() => inFlight.delete(jobId));
  }

  return {
    /**
     * One pass: fail queued jobs when the owner's switch is off (never sent, cost 0 -- AC-GM-12), start due queued jobs and
     * poll due running videos, up to the in-flight cap. Returns the work it started (tests await it; the loop does not).
     */
    async tick(): Promise<Promise<void>[]> {
      const started: Promise<void>[] = [];
      const settings = await services.getSettings();
      const at = now().getTime();
      // A job left `submitting` by a write that failed after its call (nothing here still runs it) would otherwise wait for the
      // next restart and block `stop.sh` meanwhile: failed at its estimate once it is clearly abandoned (review round 1).
      for (const job of await deps.store.listJobs({ statuses: ["submitting"], limit: 200 })) {
        if (inFlight.has(job.jobId) || at - job.updatedAt.getTime() < GEMINI_LIMITS.staleSubmittingMs) continue;
        await fail(job, "submitting", maybeCharged(job, "gemini_interrupted", "The job was left half-sent (its result could not be recorded); it may have been charged."));
      }
      const queued = (await deps.store.listJobs({ statuses: ["queued"], limit: 200 })).reverse();
      for (const job of queued) {
        if (inFlight.has(job.jobId)) continue;
        if (!settings.enabled) {
          await fail(job, "queued", notCharged("gemini_disabled", "Generation through Gemini was turned off before the job was sent."));
          continue;
        }
        if (inFlight.size >= GEMINI_LIMITS.inFlightPerProcess) break;
        if (job.nextAttemptAt && job.nextAttemptAt.getTime() > at) continue;
        // BL-180: a video job queued for a model that has since been removed (a Veo preview) is never sent.
        if (job.kind === "video" && !ownEntry(GEMINI_VIDEO_MODELS, job.model)) {
          await fail(job, "queued", notCharged("gemini_invalid_request", `${job.model} is no longer offered here (removed with BL-180); the job was not sent.`));
          continue;
        }
        started.push(track(job.jobId, () => (job.kind === "image" ? runImage(job) : runInteractionsVideo(job))));
      }
      const running = (await deps.store.listJobs({ statuses: ["running"], limit: 200 })).reverse();
      for (const job of running) {
        if (inFlight.has(job.jobId) || inFlight.size >= GEMINI_LIMITS.inFlightPerProcess) continue;
        if (job.nextAttemptAt && job.nextAttemptAt.getTime() > at) continue;
        started.push(track(job.jobId, () => pollVideo(job)));
      }
      return started;
    },

    /**
     * At startup: a job left `submitting` was cut mid-call by a stop, so Google may have finished and charged it with no
     * file here -- failed at its estimate (AC-GM-10). Running videos are simply polled again by the next tick.
     */
    async bootSweep(): Promise<number> {
      const stuck = await deps.store.listJobs({ statuses: ["submitting"], limit: 1000 });
      for (const job of stuck) {
        if (inFlight.has(job.jobId)) continue;
        await fail(job, "submitting", maybeCharged(job, "gemini_interrupted", "The app stopped while the request was with Google; it may have been charged."));
      }
      return stuck.length;
    },

    /** Idle shutdown must wait while any job is queued, being sent or a video is running. */
    async hasActiveJobs(): Promise<boolean> {
      return (await deps.store.listJobs({ statuses: GEMINI_ACTIVE_STATUSES, limit: 1 })).length > 0;
    },

    view: jobView,
  };
}

export type GeminiWorker = ReturnType<typeof createGeminiWorker>;
