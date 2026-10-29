import path from "node:path";
import type { StoredElevenlabsSpeechJob } from "@/lib/db";
import { ELEVENLABS_SPEECH_TIMEOUT_MS } from "@/lib/media-gateway";
import {
  ELEVENLABS_ACTIVE_STATUSES,
  ELEVENLABS_LIMITS,
  ELEVENLABS_MANIFEST_FILE,
  ELEVENLABS_OUTPUT_SUBDIR,
  ELEVENLABS_SPEECH_MODELS,
  isDomainError,
  ownEntry,
  type ElevenlabsCostBasis,
  type ElevenlabsJobManifest,
  type ElevenlabsJobOutput,
  type ElevenlabsSpeechParams,
} from "./contracts";
import { audioOfFormat, createElevenlabsSpeechServices, jobView, listPriceUsd, rateOfFormat, type ElevenlabsSpeechDeps } from "./services";

// BL-236 (ADR 0057): runs queued ElevenLabs takes. One `tick()` every few seconds from `src/instrumentation.ts`; every status
// change is a compare-and-set from the status the job was read in. Money rules as gemini-media's: provably never received or
// refused by ElevenLabs → not charged; sent and then lost → its characters at the list price ("unknown_outcome", never
// under-counted); done → the characters ElevenLabs reports (else the text's) at the list price.

/** Review item 7: how long a voice design's own call may still be running (its timeout plus a minute). */
const VOICE_DESIGN_CALL_WINDOW_MS = ELEVENLABS_SPEECH_TIMEOUT_MS + 60_000;

type Failure = { errorCode: string; error: string; charged: boolean };

export function createElevenlabsWorker(deps: ElevenlabsSpeechDeps) {
  const services = createElevenlabsSpeechServices(deps);
  const inFlight = new Set<string>();
  const now = () => deps.clock.now();

  async function fail(job: StoredElevenlabsSpeechJob, from: StoredElevenlabsSpeechJob["status"], failure: Failure): Promise<void> {
    await deps.store.updateJob(job.jobId, from, {
      status: "failed",
      errorCode: failure.errorCode,
      error: failure.error.slice(0, 2000),
      costUsd: failure.charged ? job.estimateUsd : 0,
      costBasis: failure.charged ? "unknown_outcome" : "not_charged",
      chargedChars: failure.charged ? job.chars : 0,
      nextAttemptAt: null,
      finishedAt: now(),
      updatedAt: now(),
    });
  }

  function classify(error: unknown): { retry: true; errorCode: string; message: string } | { retry: false; failure: Failure } {
    const message = error instanceof Error ? error.message : String(error);
    if (!isDomainError(error)) return { retry: false, failure: { errorCode: "elevenlabs_unavailable", error: message, charged: true } };
    const details = (error.details ?? {}) as Record<string, unknown>;
    switch (error.code) {
      case "elevenlabs_rate_limited":
        return { retry: true, errorCode: error.code, message };
      case "elevenlabs_unavailable":
        if (details.outcome === "unknown") return { retry: false, failure: { errorCode: "elevenlabs_unavailable", error: message, charged: true } };
        return { retry: true, errorCode: error.code, message };
      case "elevenlabs_request_rejected":
        return { retry: false, failure: { errorCode: details.blocked ? "elevenlabs_blocked" : "elevenlabs_invalid_request", error: message, charged: false } };
      case "elevenlabs_key_invalid":
      case "elevenlabs_payment_required":
      case "media_gateway_disabled":
        return { retry: false, failure: { errorCode: error.code, error: message, charged: false } };
      default:
        return { retry: false, failure: { errorCode: "elevenlabs_unavailable", error: message, charged: true } };
    }
  }

  async function run(job: StoredElevenlabsSpeechJob): Promise<void> {
    const attempts = job.attempts + 1;
    const submittedAt = job.submittedAt ?? now();
    if (!(await deps.store.updateJob(job.jobId, "queued", { status: "submitting", attempts, submittedAt, nextAttemptAt: null, updatedAt: now() }))) return;
    job.submittedAt = submittedAt;
    let apiKey: string | null;
    try {
      apiKey = await services.readApiKey();
    } catch (error) {
      await fail(job, "submitting", { errorCode: "elevenlabs_key_missing", error: error instanceof Error ? error.message : String(error), charged: false });
      return;
    }
    if (!apiKey) {
      await fail(job, "submitting", { errorCode: "elevenlabs_key_missing", error: "The ElevenLabs API key was removed from this computer.", charged: false });
      return;
    }
    let dir: string;
    try {
      dir = path.join(await deps.workspace.resolveOutputRoot(job.channelId), ELEVENLABS_OUTPUT_SUBDIR, job.jobId);
    } catch (error) {
      await fail(job, "submitting", { errorCode: "elevenlabs_output_failed", error: `The output folder is not available: ${error instanceof Error ? error.message : String(error)}`, charged: false });
      return;
    }
    const params = JSON.parse(job.paramsJson) as ElevenlabsSpeechParams;
    let result: Awaited<ReturnType<ElevenlabsSpeechDeps["api"]["textToSpeech"]>>;
    try {
      result = await deps.api.textToSpeech(apiKey, { voiceId: params.voice.providerVoiceId, text: job.text, modelId: job.model, outputFormat: params.outputFormat });
    } catch (error) {
      const verdict = classify(error);
      if (!verdict.retry) {
        await fail(job, "submitting", verdict.failure);
        return;
      }
      if (attempts < ELEVENLABS_LIMITS.maxAttempts) {
        const backoff = ELEVENLABS_LIMITS.retryBackoffMs[Math.min(attempts - 1, ELEVENLABS_LIMITS.retryBackoffMs.length - 1)];
        await deps.store.updateJob(job.jobId, "submitting", { status: "queued", errorCode: verdict.errorCode, error: verdict.message.slice(0, 2000), nextAttemptAt: new Date(now().getTime() + backoff), updatedAt: now() });
      } else {
        await fail(job, "submitting", { errorCode: verdict.errorCode, error: `${verdict.message} (after ${attempts} attempts)`, charged: false });
      }
      return;
    }
    const chargedChars = result.chargedChars ?? job.chars;
    const costUsd = listPriceUsd(job.model, chargedChars);
    const costBasis: ElevenlabsCostBasis = "list_price";
    const file = audioOfFormat(params.outputFormat, result.audio);
    const name = `take-1.${file.extension}`;
    const localPath = path.join(dir, name);
    let output: ElevenlabsJobOutput;
    try {
      const written = await deps.files.writeOutput(localPath, file.data);
      let assetId: string | null = null;
      let note: string | null = null;
      try {
        assetId =
          (await deps.assets.findByLocalPath(job.channelId, localPath))?.assetId ??
          (
            await deps.assets.register({
              channelId: job.channelId,
              assetType: "generated_audio",
              referenceKind: "local_path",
              referenceValue: localPath,
              title: `${job.model} speech ${job.jobId}`,
              provenance: { source: "elevenlabs_speech", jobId: job.jobId, model: job.model, voice: params.voice, outputFormat: params.outputFormat, text: job.text.slice(0, 2000), sha256: written.sha256, bytes: written.bytes },
            })
          ).assetId;
      } catch (error) {
        note = `not registered in the asset catalog: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      }
      output = {
        path: `${ELEVENLABS_OUTPUT_SUBDIR}/${job.jobId}/${name}`,
        localPath,
        kind: "audio",
        mimeType: file.mimeType,
        bytes: written.bytes,
        sha256: written.sha256,
        // An mp3's rate is the format's (ElevenLabs encodes at it); a WAV's is read from its header.
        sampleRateHz: file.sampleRateHz ?? rateOfFormat(params.outputFormat),
        durationSeconds: file.durationSeconds,
        assetId,
        note,
      };
    } catch (error) {
      await deps.store.updateJob(job.jobId, "submitting", {
        status: "failed",
        errorCode: "elevenlabs_output_failed",
        error: `The speech was generated (and charged) but could not be written: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
        costUsd,
        costBasis,
        chargedChars,
        finishedAt: now(),
        updatedAt: now(),
      });
      return;
    }
    const finishedAt = now();
    const manifest: ElevenlabsJobManifest = {
      schema: "ytm.elevenlabs-job-manifest",
      schemaVersion: 1,
      jobId: job.jobId,
      channelId: job.channelId,
      kind: "speech",
      model: job.model,
      text: job.text,
      voice: params.voice,
      outputFormat: params.outputFormat,
      status: "done",
      chars: job.chars,
      chargedChars,
      estimateUsd: job.estimateUsd,
      costUsd,
      costBasis,
      createdBy: job.createdBy,
      createdAt: job.createdAt.toISOString(),
      submittedAt: job.submittedAt ? job.submittedAt.toISOString() : null,
      finishedAt: finishedAt.toISOString(),
      device: await deps.device(),
      video: job.video ?? null,
      outputs: [{ path: output.path, kind: "audio", mimeType: output.mimeType, bytes: output.bytes, sha256: output.sha256, sampleRateHz: output.sampleRateHz, durationSeconds: output.durationSeconds, assetId: output.assetId, note: output.note }],
    };
    try {
      // The manifest last: a folder with a manifest is complete.
      await deps.files.writeManifest(path.join(dir, ELEVENLABS_MANIFEST_FILE), manifest);
    } catch (error) {
      await deps.store.updateJob(job.jobId, "submitting", { status: "failed", errorCode: "elevenlabs_output_failed", error: `The file was written but manifest.json was not: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), outputsJson: JSON.stringify([output]), costUsd, costBasis, chargedChars, finishedAt, updatedAt: finishedAt });
      return;
    }
    await deps.store.updateJob(job.jobId, "submitting", { status: "done", outputsJson: JSON.stringify([output]), costUsd, costBasis, chargedChars, error: null, errorCode: null, finishedAt, updatedAt: finishedAt });
  }

  function track(jobId: string, work: () => Promise<void>): Promise<void> {
    inFlight.add(jobId);
    return work()
      .catch((error) => console.error(`[elevenlabs-speech] job ${jobId}:`, error instanceof Error ? error.message : error))
      .finally(() => inFlight.delete(jobId));
  }

  return {
    /** One pass: fail queued takes when the switch is off (never sent, 0), fail abandoned half-sent ones, start due queued ones. */
    async tick(): Promise<Promise<void>[]> {
      const started: Promise<void>[] = [];
      const settings = await services.getSettings();
      const at = now().getTime();
      for (const job of await deps.store.listJobs({ statuses: ["submitting"], limit: 200 })) {
        if (inFlight.has(job.jobId) || at - job.updatedAt.getTime() < ELEVENLABS_LIMITS.staleSubmittingMs) continue;
        await fail(job, "submitting", { errorCode: "elevenlabs_interrupted", error: "The job was left half-sent; it may have been charged.", charged: true });
      }
      for (const job of (await deps.store.listJobs({ statuses: ["queued"], limit: 200 })).reverse()) {
        if (inFlight.has(job.jobId)) continue;
        if (!settings.enabled) {
          await fail(job, "queued", { errorCode: "elevenlabs_disabled", error: "Speech through ElevenLabs was turned off before the job was sent.", charged: false });
          continue;
        }
        if (job.kind !== "speech" || !ownEntry(ELEVENLABS_SPEECH_MODELS, job.model)) {
          await fail(job, "queued", { errorCode: "elevenlabs_invalid_request", error: `${job.model} is not offered here; the job was not sent.`, charged: false });
          continue;
        }
        if (inFlight.size >= ELEVENLABS_LIMITS.inFlightPerProcess) break;
        if (job.nextAttemptAt && job.nextAttemptAt.getTime() > at) continue;
        started.push(track(job.jobId, () => run(job)));
      }
      return started;
    },

    /** At startup: a job left `submitting` was cut mid-call -- failed at its characters (it may have been charged). */
    async bootSweep(): Promise<number> {
      const stuck = await deps.store.listJobs({ statuses: ["submitting"], limit: 1000 });
      const at = now().getTime();
      for (const job of stuck) {
        if (inFlight.has(job.jobId)) continue;
        // Review item 7: a voice design is sent by its own call, not by this worker -- left alone while that call may still run.
        if (job.kind === "voice_design" && at - job.updatedAt.getTime() < VOICE_DESIGN_CALL_WINDOW_MS) continue;
        await fail(job, "submitting", { errorCode: "elevenlabs_interrupted", error: "The app stopped while the request was with ElevenLabs; it may have been charged.", charged: true });
      }
      return stuck.length;
    },

    async hasActiveJobs(): Promise<boolean> {
      return (await deps.store.listJobs({ statuses: ELEVENLABS_ACTIVE_STATUSES, limit: 1 })).length > 0;
    },

    view: jobView,
  };
}

export type ElevenlabsWorker = ReturnType<typeof createElevenlabsWorker>;
