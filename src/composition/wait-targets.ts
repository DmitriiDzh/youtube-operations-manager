import { DomainError, isDomainError } from "@/lib/shared-domain";
import { sleep } from "@/lib/shared-async";
import {
  createOperationWait,
  shutdownSignal,
  WaitNotFoundError,
  type OperationWait,
  type WaitInput,
  type WaitObservation,
  type WaitOutcome,
  type WaitPort,
  type WaitScope,
  type WaitTarget,
} from "@/lib/operation-wait";

// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md §2/§3.1, ADR 0075): the wait's ports, one per target, each over an existing READ of
// its module -- composed here so no feature module imports another (AGENTS.md §M); a module that cannot be loaded disables only its
// own target. Every port checks the resource's own channel against the caller's scope: another channel's id answers exactly like a
// missing one (`not_found`). Nothing here writes, calls YouTube or a paid provider, or passes the device mutation gate.

type Row = Record<string, unknown>;

/** The reads the ports use (production: `productionReads`; tests inject fakes). A missing read disables that target. */
export type WaitTargetReads = {
  /** One upload row of this computer by id, or the newest row of a channel's video code (null: none). */
  upload?: { byId(uploadId: string): Promise<UploadRow | null>; latest(channelId: string, video: string): Promise<UploadRow | null> };
  /** A media session / job of this computer (the module's own not-found error when missing). */
  mediaSession?: (sessionId: string) => Promise<Row>;
  mediaJob?: (jobId: string) => Promise<Row>;
  /** `{ job }` of a Gemini job; `{ provider, job }` of a speech job; `{ job }` of an ElevenLabs job (any kind). */
  geminiJob?: (jobId: string) => Promise<Row>;
  speechJob?: (jobId: string) => Promise<Row>;
  soundJob?: (jobId: string) => Promise<Row>;
  /** The channel's translation requests (localization-review's list). */
  translationRequests?: (channelId: string) => Promise<Row[]>;
  /** `{ storyboard }` (the storyboards module's get). */
  storyboard?: (channelId: string, storyboardId: string) => Promise<Row>;
  restart?: {
    byId(id: string): Promise<Row | null>;
    active(): Promise<Row | null>;
    last(): Promise<Row | null>;
    /** When this server process started (ISO): a later one means a restart happened (plan §3.3). */
    serverStartedAt(): string;
  };
};

export type UploadRow = {
  id: string;
  channelId: string;
  video: string;
  status: string;
  resumeStatus: string | null;
  pausedReason: string | null;
  pausedUntil: Date | null;
  totalBytes: number;
  storedBytes: number;
  videoId: string | null;
  publishAt: string | null;
  errorCode: string | null;
  queuedBy?: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

function record(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

const iso = (value: Date | null | undefined) => (value instanceof Date ? value.toISOString() : null);

/** A module's own "not found" answer becomes the wait's (the same for a missing id and another channel's). */
async function orNotFound<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isDomainError(error) && (error.code === "not_found" || error.code.endsWith("_not_found"))) throw new WaitNotFoundError();
    throw error;
  }
}

/** A resource the caller may see: its channel is the scope's (a worker) and, when the input names a channel, that one. */
function visible(channelId: unknown, input: WaitInput, scope: WaitScope): boolean {
  if (scope.channelId !== null && channelId !== scope.channelId) return false;
  if (input.channelId !== undefined && channelId !== input.channelId) return false;
  return true;
}

const observation = (id: string, status: string, outcome: WaitOutcome, snapshot: Row): WaitObservation => ({
  id,
  status,
  final: outcome !== "still_running" && outcome !== "blocked" && outcome !== "not_in_review",
  outcome,
  snapshot,
});

const truncate = (text: unknown, max = 300) => (typeof text === "string" ? (text.length > max ? `${text.slice(0, max)}…` : text) : null);

// -- status tables (plan §2; the table is the expected value of the ports' tests) ---------------------------------------------

/** Upload: queued / uploading / processing / finishing / paused run; paused for auth or live_writes_off is blocked (Q2). */
export function uploadOutcome(status: string, pausedReason: string | null): WaitOutcome {
  if (status === "done") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "paused" && (pausedReason === "auth" || pausedReason === "live_writes_off")) return "blocked";
  return "still_running";
}

/** Media session, `until: ready` (default): running (ready) succeeds; stopping / done before that fail. `until: ended`: done succeeds. */
export function mediaSessionOutcome(status: string, until: "ready" | "ended"): WaitOutcome {
  if (status === "rejected") return "rejected";
  if (status === "failed" || status === "interrupted") return "failed";
  if (until === "ready") {
    if (status === "running") return "succeeded";
    if (status === "stopping" || status === "done") return "failed";
    return "still_running";
  }
  return status === "done" ? "succeeded" : "still_running";
}

/** Media job: done; failed; cancelled; the rest run. */
export function mediaJobOutcome(status: string): WaitOutcome {
  return status === "done" ? "succeeded" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "still_running";
}

/** Gemini / speech / sound jobs: queued / submitting / running run; done; failed. */
export function providerJobOutcome(status: string): WaitOutcome {
  return status === "done" ? "succeeded" : status === "failed" ? "failed" : "still_running";
}

/** Translation request, `until: finished` (default) or `claimed` (Q3: partly_done is partly_failed). */
export function translationRequestOutcome(status: string, until: "finished" | "claimed"): WaitOutcome {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (until === "claimed") return status === "requested" ? "still_running" : "succeeded";
  if (status === "done") return "succeeded";
  if (status === "partly_done") return "partly_failed";
  return "still_running";
}

/** Storyboard review: in_review runs; approved; changes_requested; a draft never submitted returns at once (not_in_review). */
export function storyboardOutcome(state: string): WaitOutcome {
  if (state === "approved") return "succeeded";
  if (state === "changes_requested") return "changes_requested";
  if (state === "draft") return "not_in_review";
  return "still_running";
}

/** Restart: open / restarting run; done; expired; cancelled. */
export function restartOutcome(status: string): WaitOutcome {
  return status === "done" ? "succeeded" : status === "expired" ? "expired" : status === "cancelled" ? "cancelled" : "still_running";
}

// -- ports ------------------------------------------------------------------------------------------------------------------------

function jobSnapshot(job: Row): Row {
  return {
    jobId: job.jobId ?? null,
    channelId: job.channelId ?? null,
    kind: job.kind ?? null,
    model: job.model ?? null,
    status: job.status ?? null,
    outputs: job.outputs ?? [],
    costUsd: job.costUsd ?? null,
    errorCode: job.errorCode ?? null,
    error: truncate(job.error),
    video: job.video ?? null,
    createdAt: job.createdAt ?? null,
    finishedAt: job.finishedAt ?? null,
  };
}

export function createWaitPorts(reads: WaitTargetReads): Partial<Record<WaitTarget, WaitPort>> {
  const ports: Partial<Record<WaitTarget, WaitPort>> = {};
  const notFound = () => new WaitNotFoundError();

  if (reads.upload) {
    const upload = reads.upload;
    ports.upload = async (input, scope) => {
      let row = await upload.byId(input.id);
      const channel = input.channelId ?? scope.channelId;
      if (!row && channel) row = await upload.latest(channel, input.id);
      if (!row || !visible(row.channelId, input, scope)) throw notFound();
      const outcome = uploadOutcome(row.status, row.pausedReason);
      return observation(row.id, row.status, outcome, {
        uploadId: row.id,
        channelId: row.channelId,
        video: row.video,
        status: row.status,
        resumeStatus: row.resumeStatus,
        pausedReason: row.pausedReason,
        pausedUntil: iso(row.pausedUntil),
        progressPercent: row.totalBytes > 0 ? Math.floor((row.storedBytes / row.totalBytes) * 100) : null,
        videoId: row.videoId,
        publishAt: row.publishAt,
        errorCode: row.errorCode,
        queuedBy: row.queuedBy ?? null,
        createdAt: iso(row.createdAt),
        finishedAt: iso(row.finishedAt),
      });
    };
  }

  if (reads.mediaSession) {
    const read = reads.mediaSession;
    ports.media_session = async (input, scope) => {
      const session = record(await orNotFound(() => read(input.id)));
      if (!visible(session.channelId, input, scope)) throw notFound();
      // The Operator (no channel scope) sees only the sessions the factory started -- the same fence as its get tool; a channel worker
      // sees every session of its own channel (its agent_get_media_session does too).
      if (scope.channelId === null && session.requestedBy !== "factory") throw notFound();
      const status = String(session.status);
      const outcome = mediaSessionOutcome(status, input.until === "ended" ? "ended" : "ready");
      return observation(input.id, status, outcome, {
        sessionId: session.sessionId ?? input.id,
        channelId: session.channelId ?? null,
        status,
        requestedBy: session.requestedBy ?? null,
        approvedBy: session.approvedBy ?? null,
        startStage: session.startStage ?? null,
        readyAt: session.readyAt ?? null,
        gpuTypeId: session.gpuTypeId ?? null,
        capacity: session.capacity ?? null,
        secondsUsed: session.secondsUsed ?? null,
        usdCharged: session.usdCharged ?? null,
        reason: truncate(session.reason),
        stopReason: truncate(session.stopReason),
        error: truncate(session.error),
      });
    };
  }

  if (reads.mediaJob) {
    const read = reads.mediaJob;
    const sessionOf = reads.mediaSession;
    ports.media_job = async (input, scope) => {
      const job = record(await orNotFound(() => read(input.id)));
      if (!visible(job.channelId, input, scope)) throw notFound();
      // As for sessions: the Operator sees only the jobs of factory sessions (its get tool's rule), a worker every job of its channel.
      if (scope.channelId === null) {
        const session = sessionOf && typeof job.sessionId === "string" ? record(await orNotFound(() => sessionOf(job.sessionId as string))) : {};
        if (session.requestedBy !== "factory") throw notFound();
      }
      const status = String(job.status);
      return observation(input.id, status, mediaJobOutcome(status), { ...jobSnapshot(job), sessionId: job.sessionId ?? null, templateId: job.templateId ?? null, progress: job.progress ?? null });
    };
  }

  const providerPort =
    (read: (jobId: string) => Promise<Row>, kinds?: readonly string[]): WaitPort =>
    async (input, scope) => {
      const answer = record(await orNotFound(() => read(input.id)));
      const job = record(answer.job);
      if (kinds && !kinds.includes(String(job.kind))) throw notFound();
      if (!visible(job.channelId, input, scope)) throw notFound();
      const status = String(job.status);
      return observation(input.id, status, providerJobOutcome(status), { ...(answer.provider ? { provider: answer.provider } : {}), ...jobSnapshot(job) });
    };
  if (reads.geminiJob) ports.gemini_job = providerPort(reads.geminiJob);
  if (reads.speechJob) ports.speech_job = providerPort(reads.speechJob);
  if (reads.soundJob) ports.sound_job = providerPort(reads.soundJob, ["sfx", "music"]);

  if (reads.translationRequests) {
    const list = reads.translationRequests;
    ports.translation_request = async (input, scope) => {
      const channelId = input.channelId!;
      if (scope.channelId !== null && channelId !== scope.channelId) throw notFound();
      const request = (await list(channelId)).find((entry) => entry.requestId === input.id);
      if (!request) throw notFound();
      const status = String(request.status);
      const outcome = translationRequestOutcome(status, input.until === "claimed" ? "claimed" : "finished");
      const videoIds = Array.isArray(request.videoIds) ? request.videoIds : [];
      return observation(input.id, status, outcome, {
        requestId: input.id,
        channelId,
        status,
        videoCount: videoIds.length,
        languages: request.languages ?? [],
        claimedBy: request.claimedBy ?? null,
        claimedAt: request.claimedAt ?? null,
        results: request.results ?? [],
        failReason: truncate(request.failReason),
        overdue: request.overdue ?? false,
        updatedAt: request.updatedAt ?? null,
      });
    };
  }

  if (reads.storyboard) {
    const get = reads.storyboard;
    const storyboardOf = async (input: WaitInput, scope: WaitScope, storyboardId: string) => {
      const channelId = input.channelId!;
      if (scope.channelId !== null && channelId !== scope.channelId) throw notFound();
      return record(record(await orNotFound(() => get(channelId, storyboardId))).storyboard);
    };
    ports.storyboard_review = async (input, scope) => {
      const storyboard = await storyboardOf(input, scope, input.id);
      const state = String(storyboard.state);
      const decision = record(storyboard.lastDecision);
      return observation(input.id, state, storyboardOutcome(state), {
        storyboardId: input.id,
        channelId: input.channelId,
        title: storyboard.title ?? null,
        state,
        latestVersion: storyboard.latestVersion ?? null,
        submittedAt: storyboard.submittedAt ?? null,
        lastDecision: storyboard.lastDecision ? { kind: decision.kind ?? null, versionNumber: decision.versionNumber ?? null, at: decision.at ?? null, by: decision.by ?? null, note: truncate(decision.note, 2000) } : null,
        openComments: storyboard.openComments ?? 0,
      });
    };
    ports.storyboard_render = async (input, scope) => {
      const storyboard = await storyboardOf(input, scope, input.storyboardId!);
      const render = (Array.isArray(storyboard.renders) ? storyboard.renders : []).map(record).find((entry) => entry.renderId === input.id);
      if (!render) throw notFound();
      const state = String(render.state);
      const decisions = Array.isArray(render.decisions) ? render.decisions.map(record) : [];
      const last = decisions.at(-1);
      return observation(input.id, state, storyboardOutcome(state), {
        renderId: input.id,
        storyboardId: input.storyboardId,
        channelId: input.channelId,
        versionNumber: render.versionNumber ?? null,
        file: render.file ?? null,
        state,
        lastDecision: last ? { kind: last.kind ?? null, at: last.at ?? null, by: last.by ?? null, note: truncate(last.note, 2000) } : null,
      });
    };
  }

  if (reads.restart) {
    const restart = reads.restart;
    ports.restart = async (input) => {
      const request = input.id === "current" ? await restart.active() : await restart.byId(input.id);
      if (!request) {
        if (input.id !== "current") throw notFound();
        const last = await restart.last();
        // `current` with nothing open or restarting: the CLI decides from serverStartedAt whether a restart already happened.
        throw new DomainError({
          code: "no_restart_request",
          message: "No restart request is open or restarting on this computer.",
          details: { serverStartedAt: restart.serverStartedAt(), lastRestart: last },
        });
      }
      const status = String(request.status);
      return observation(String(request.id), status, restartOutcome(status), { ...request, serverStartedAt: restart.serverStartedAt() });
    };
  }

  return ports;
}

// -- production -------------------------------------------------------------------------------------------------------------------

/** When this process started (constant for the process; a restart starts a new one). */
function processStartedAt(): string {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
}

/** The real reads, each loaded on use: a module that cannot load fails only its own target's reads (`target_unavailable`). */
export function productionReads(): WaitTargetReads {
  const restartCore = async () => (await import("@/lib/restart-when-idle")).createRestartWhenIdleCore();
  const startedAt = processStartedAt();
  return {
    upload: {
      byId: async (uploadId) => (await import("@/lib/publishing")).getUploadRow(uploadId) as Promise<UploadRow | null>,
      latest: async (channelId, video) => (await import("@/lib/publishing")).latestUploadOfVideo(channelId, video) as Promise<UploadRow | null>,
    },
    mediaSession: async (sessionId) => ({ ...(await (await import("@/lib/media-generation")).createMediaGenerationCore().getSession({ sessionId })) }),
    mediaJob: async (jobId) => {
      const { createMediaGenerationCore, withJobErrorCode } = await import("@/lib/media-generation");
      return { ...withJobErrorCode(await createMediaGenerationCore().getJob({ jobId })) };
    },
    geminiJob: async (jobId) => ({ ...(await (await import("@/lib/gemini-media")).createGeminiMediaCore().getJobs({ jobId })) }),
    speechJob: async (jobId) => ({ ...(await (await import("@/composition/speech")).createSpeechForProduction().getJobs({ jobId })) }),
    soundJob: async (jobId) => ({ ...(await (await import("@/lib/elevenlabs-speech")).createElevenlabsSpeechCore().getJobs({ jobId })) }),
    translationRequests: async (channelId) => (await (await import("@/lib/localization-review")).listTranslationRequests({ channelId })).requests as unknown as Row[],
    storyboard: async (channelId, storyboardId) => ({ ...(await (await import("@/lib/storyboards")).createStoryboardsServiceForProduction().get({ channelId, storyboardId })) }),
    restart: {
      byId: async (id) => (await (await restartCore()).requestById(id)) as Row | null,
      active: async () => (await (await restartCore()).activeRequest()) as Row | null,
      last: async () => (await (await restartCore()).lastRestart()) as Row | null,
      serverStartedAt: () => startedAt,
    },
  };
}

/** The wait every endpoint uses (factory, channel workers, Producer); the caller passes its scope. */
export function createProductionOperationWait(): OperationWait {
  return createOperationWait({
    ports: createWaitPorts(productionReads()),
    now: () => Date.now(),
    sleep: (ms, signal) => sleep(ms, { signal }),
    shutdownSignal,
    restarting: async () => (await import("@/lib/restart-when-idle")).createRestartWhenIdleCore().isRestarting(),
  });
}
