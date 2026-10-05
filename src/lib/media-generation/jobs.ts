import path from "node:path";
import type { ComfyUiClient, RunpodS3Client } from "@/lib/media-gateway";
import {
  DomainError,
  EXCHANGE_INPUT_PREFIX,
  EXCHANGE_PREFIX,
  MEDIA_JOB_TERMINAL_STATUSES,
  MEDIA_OUTPUT_SUBDIR,
  type MediaJob,
  type MediaJobOutput,
  type MediaJobStatus,
  type MediaTemplateParameter,
  type MediaWorkflowTemplate,
} from "./contracts";
import {
  createJobInputSchema,
  importTemplateInputSchema,
  jobIdInputSchema,
  listJobsInputSchema,
  parseWithSchema,
  templateIdInputSchema,
  updateTemplateInputSchema,
  workflowGraphSchema,
} from "./schemas";

// ---------------------------------------------------------------------------
// Phase 14 slice 3 (docs/roadmap/plans/PHASE_14_PLAN.md §2.4, owner decisions D1/D4/D7): workflow
// templates are operator-imported ComfyUI graphs with declared parameters; a job fills them in,
// rewrites every Save node's `filename_prefix` to `<jobId>/…`, submits the prompt to the session's
// ComfyUI through the token proxy, polls `/history`, pulls each output over the S3 API into
// `<workspace>/99 Data Exchange/From YTM/media/<jobId>/`, verifies the bytes twice, records the
// ledger row, deletes the remote object, and registers the file in the asset catalog. The janitor
// deletes only `exchange/` leftovers of terminal jobs, by ledger, never anything else.
// ---------------------------------------------------------------------------

export type StoredTemplateRow = {
  id: string;
  name: string;
  version: number;
  description: string | null;
  workflowJson: string;
  parametersJson: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredJobRow = {
  id: string;
  sessionId: string;
  channelId: string;
  templateId: string;
  templateVersion: number;
  paramsJson: string;
  status: MediaJobStatus;
  createdBy: "operator" | "agent";
  promptId: string | null;
  outputsJson: string | null;
  assetIdsJson: string | null;
  error: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  finishedAt: Date | null;
};

export type ExchangeLedgerRow = { remoteKey: string; jobId: string; localPath: string; bytes: number; sha256: string; pulledAt: Date; remoteDeletedAt: Date | null };

export type MediaJobStore = {
  templates: {
    insert(row: { id: string; name: string; description: string | null; workflowJson: string; parametersJson: string }): Promise<StoredTemplateRow>;
    update(id: string, patch: { name?: string; description?: string | null; workflowJson?: string; parametersJson?: string }): Promise<StoredTemplateRow | null>;
    get(id: string): Promise<StoredTemplateRow | null>;
    list(): Promise<StoredTemplateRow[]>;
    delete(id: string): Promise<boolean>;
  };
  jobs: {
    insert(row: Omit<StoredJobRow, "createdAt"> & { createdAt?: Date }): Promise<StoredJobRow>;
    get(id: string): Promise<StoredJobRow | null>;
    list(filter: { sessionId?: string; channelId?: string; limit?: number }): Promise<StoredJobRow[]>;
    listNonTerminal(): Promise<StoredJobRow[]>;
    transition(id: string, from: readonly MediaJobStatus[], set: Partial<Omit<StoredJobRow, "id" | "status">> & { status: MediaJobStatus }): Promise<StoredJobRow | null>;
  };
  ledger: {
    upsert(row: Omit<ExchangeLedgerRow, "remoteDeletedAt">): Promise<void>;
    markRemoteDeleted(remoteKey: string, at: Date): Promise<void>;
    get(remoteKey: string): Promise<ExchangeLedgerRow | null>;
  };
};

export type JobServiceDependencies = {
  store: MediaJobStore;
  sessions: {
    getRunningSession(sessionId: string): Promise<{ sessionId: string; channelId: string; podId: string | null; gpuTypeId: string | null; costPerHr: number | null } | null>;
    comfyClientForSession(sessionId: string): Promise<ComfyUiClient>;
    touchActivity(sessionId: string): Promise<void>;
  };
  s3(): Promise<RunpodS3Client>;
  /** `<workspace>/99 Data Exchange/From YTM` for the channel (throws `media_workspace_unavailable`). */
  resolveOutputRoot(channelId: string): Promise<string>;
  fs: {
    mkdirp(dir: string): Promise<void>;
    sha256File(filePath: string): Promise<string>;
  };
  registerAsset(input: {
    channelId: string;
    assetType: "generated_image" | "audio_track" | "video_loop" | "other";
    referenceKind: "local_path";
    referenceValue: string;
    title: string;
    provenance: Record<string, unknown>;
  }): Promise<{ assetId: string }>;
  generateId(): string;
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
  /** How a submitted job's polling runs: production fires it in the background; tests run it inline. */
  schedule(run: () => Promise<void>): void;
  timeouts?: { pollMs?: number; maxGenerationMs?: number };
  log?: (line: string) => void;
};

const DEFAULT_POLL_MS = 4_000;
const DEFAULT_MAX_GENERATION_MS = 2 * 60 * 60_000;
/** Consecutive `/history` failures (proxy 502, 30 s timeout) tolerated while the session still runs. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
/** How long a `transferring` job keeps being retried when its outputs cannot be received yet. */
const TRANSFER_RETRY_WINDOW_MS = 24 * 60 * 60_000;

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> } & Record<string, unknown>>;

function normalizeParameter(p: ReturnType<typeof importTemplateInputSchema.parse>["parameters"][number]): MediaTemplateParameter {
  return {
    name: p.name,
    type: p.type,
    nodeId: p.nodeId,
    input: p.input,
    required: p.required ?? (p.default === undefined || p.default === null),
    default: p.default ?? null,
    min: p.min ?? null,
    max: p.max ?? null,
    enum: p.enum ?? null,
    description: p.description ?? null,
  };
}

/** Save-class nodes are recognised by shape, not by a class list: any node with a string `filename_prefix` input. */
export function outputNodeIds(graph: Graph): string[] {
  return Object.entries(graph)
    .filter(([, node]) => typeof node.inputs?.filename_prefix === "string")
    .map(([id]) => id);
}

export function toPublicTemplate(row: StoredTemplateRow): MediaWorkflowTemplate {
  const graph = JSON.parse(row.workflowJson) as Graph;
  return {
    templateId: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    parameters: JSON.parse(row.parametersJson) as MediaTemplateParameter[],
    outputNodeIds: outputNodeIds(graph),
    nodeCount: Object.keys(graph).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPublicJob(row: StoredJobRow): MediaJob {
  return {
    jobId: row.id,
    sessionId: row.sessionId,
    channelId: row.channelId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    params: JSON.parse(row.paramsJson) as Record<string, string | number | boolean>,
    status: row.status,
    createdBy: row.createdBy,
    promptId: row.promptId,
    outputs: row.outputsJson ? (JSON.parse(row.outputsJson) as MediaJobOutput[]) : [],
    assetIds: row.assetIdsJson ? (JSON.parse(row.assetIdsJson) as string[]) : [],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/**
 * Validates the caller's values against the declared parameters (AC-P14-10): unknown names, missing
 * required ones, wrong types, out-of-bounds numbers and non-enum values are all rejected before any
 * ComfyUI call. Returns the complete value map (defaults filled in).
 */
export function resolveParams(parameters: MediaTemplateParameter[], given: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const declared = new Map(parameters.map((p) => [p.name, p]));
  const problems: string[] = [];
  for (const name of Object.keys(given)) if (!declared.has(name)) problems.push(`unknown parameter "${name}"`);
  const resolved: Record<string, string | number | boolean> = {};
  for (const p of parameters) {
    const value = given[p.name] ?? p.default ?? undefined;
    if (value === undefined || value === null) {
      if (p.required) problems.push(`"${p.name}" is required`);
      continue;
    }
    switch (p.type) {
      case "string":
      case "text":
        if (typeof value !== "string") problems.push(`"${p.name}" must be a string`);
        else if (p.max !== null && value.length > p.max) problems.push(`"${p.name}" is longer than ${p.max} characters`);
        break;
      case "number":
      case "integer":
        if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`"${p.name}" must be a number`);
        else if (p.type === "integer" && !Number.isInteger(value)) problems.push(`"${p.name}" must be an integer`);
        else if (p.min !== null && value < p.min) problems.push(`"${p.name}" is below ${p.min}`);
        else if (p.max !== null && value > p.max) problems.push(`"${p.name}" is above ${p.max}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") problems.push(`"${p.name}" must be true or false`);
        break;
      case "enum":
        if (typeof value !== "string" || !(p.enum ?? []).includes(value)) problems.push(`"${p.name}" must be one of ${(p.enum ?? []).join(", ")}`);
        break;
    }
    resolved[p.name] = value;
  }
  if (problems.length > 0) {
    throw new DomainError({ code: "media_job_params_invalid", message: `Invalid job parameters: ${problems.join("; ")}`, details: { problems } });
  }
  return resolved;
}

/** The prompt ComfyUI receives: the graph with the parameters applied and every output prefixed `<jobId>/…`. */
export function buildPrompt(graph: Graph, parameters: MediaTemplateParameter[], values: Record<string, string | number | boolean>, jobId: string): Graph {
  const prompt = JSON.parse(JSON.stringify(graph)) as Graph;
  for (const p of parameters) {
    if (!(p.name in values)) continue;
    const node = prompt[p.nodeId];
    if (!node) throw new DomainError({ code: "media_template_invalid", message: `Parameter "${p.name}" targets node ${p.nodeId}, which is not in the workflow.` });
    node.inputs[p.input] = values[p.name];
  }
  for (const id of outputNodeIds(prompt)) {
    const original = String(prompt[id].inputs.filename_prefix);
    const base = original.split("/").filter(Boolean).pop() || "output";
    prompt[id].inputs.filename_prefix = `${jobId}/${base}`;
  }
  return prompt;
}

function assetTypeFor(kind: string): "generated_image" | "audio_track" | "video_loop" | "other" {
  if (kind === "images") return "generated_image";
  if (kind === "audio") return "audio_track";
  if (kind === "gifs" || kind === "video" || kind === "videos") return "video_loop";
  return "other";
}

function safeFileName(name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
  return name;
}

export function createMediaJobServices(deps: JobServiceDependencies) {
  const pollMs = deps.timeouts?.pollMs ?? DEFAULT_POLL_MS;
  const maxGenerationMs = deps.timeouts?.maxGenerationMs ?? DEFAULT_MAX_GENERATION_MS;
  const log = deps.log ?? (() => undefined);

  function validateTemplateShape(graph: Graph, parameters: MediaTemplateParameter[]): void {
    const problems: string[] = [];
    for (const p of parameters) {
      const node = graph[p.nodeId];
      if (!node) problems.push(`parameter "${p.name}": node ${p.nodeId} is not in the workflow`);
      else if (!(p.input in node.inputs)) problems.push(`parameter "${p.name}": node ${p.nodeId} has no input "${p.input}"`);
      if (p.type === "enum" && (!p.enum || p.enum.length === 0)) problems.push(`parameter "${p.name}": an enum needs values`);
    }
    const names = parameters.map((p) => p.name);
    if (new Set(names).size !== names.length) problems.push("parameter names must be unique");
    if (outputNodeIds(graph).length === 0) problems.push("the workflow has no Save node (no input named filename_prefix), so it would produce nothing to pull");
    if (problems.length > 0) throw new DomainError({ code: "media_template_invalid", message: `Invalid workflow template: ${problems.join("; ")}`, details: { problems } });
  }

  async function requireTemplate(templateId: string): Promise<StoredTemplateRow> {
    const row = await deps.store.templates.get(templateId);
    if (!row) throw new DomainError({ code: "media_template_not_found", message: "No workflow template with this id", details: { templateId } });
    return row;
  }

  async function requireJob(jobId: string): Promise<StoredJobRow> {
    const row = await deps.store.jobs.get(jobId);
    if (!row) throw new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId } });
    return row;
  }

  async function failJob(row: StoredJobRow, error: string, outputs?: MediaJobOutput[]): Promise<void> {
    await deps.store.jobs.transition(row.id, ["queued", "submitted", "generating", "transferring"], {
      status: "failed",
      error,
      finishedAt: deps.clock.now(),
      ...(outputs ? { outputsJson: JSON.stringify(outputs) } : {}),
    });
  }

  /**
   * Pulls one output: HEAD -> GET to a temp name + rename (inside the gateway) -> SHA-256 of the
   * stream compared with a second read-back of the file (AC-P14-12) -> ledger row -> DELETE remote
   * (AC-P14-13; a failed delete leaves `remoteDeletedAt` null for the janitor) -> asset entry.
   */
  async function pullOutput(job: StoredJobRow, output: MediaJobOutput, outputDir: string, s3: RunpodS3Client, provenance: Record<string, unknown>): Promise<MediaJobOutput> {
    const fileName = safeFileName(output.filename);
    if (!fileName) return { ...output, note: "unsafe file name; not pulled" };
    if (!output.remoteKey.startsWith(`${EXCHANGE_PREFIX}${job.id}/`)) return { ...output, note: "output outside the job's folder; not pulled" };
    const head = await s3.headObject(output.remoteKey);
    if (!head) return { ...output, note: "output missing on the volume" };
    const localPath = path.join(outputDir, fileName);
    const pulled = await s3.getObjectToFile(output.remoteKey, localPath);
    const readBack = await deps.fs.sha256File(localPath);
    if (readBack !== pulled.sha256 || (head.size > 0 && pulled.bytes !== head.size)) {
      return { ...output, note: `verification failed (stream ${pulled.sha256.slice(0, 8)}, file ${readBack.slice(0, 8)}, ${pulled.bytes}/${head.size} bytes)` };
    }
    await deps.store.ledger.upsert({ remoteKey: output.remoteKey, jobId: job.id, localPath, bytes: pulled.bytes, sha256: pulled.sha256, pulledAt: deps.clock.now() });
    let remoteDeleted = false;
    try {
      await s3.deleteObject(output.remoteKey);
      await deps.store.ledger.markRemoteDeleted(output.remoteKey, deps.clock.now());
      remoteDeleted = true;
    } catch (error) {
      log(`[media] remote delete of ${output.remoteKey} failed: ${error instanceof Error ? error.message : String(error)}; the janitor retries`);
    }
    // The file is now the only copy (pulled, remote deleted): a catalog failure must not make it look "not pulled".
    try {
      const asset = await deps.registerAsset({
        channelId: job.channelId,
        assetType: assetTypeFor(output.kind),
        referenceKind: "local_path",
        referenceValue: localPath,
        title: fileName,
        provenance: { ...provenance, comfyNodeId: output.nodeId, outputKind: output.kind, sha256: pulled.sha256, bytes: pulled.bytes },
      });
      return { ...output, localPath, bytes: pulled.bytes, sha256: pulled.sha256, remoteDeleted, assetId: asset.assetId, note: null };
    } catch (error) {
      return {
        ...output,
        localPath,
        bytes: pulled.bytes,
        sha256: pulled.sha256,
        remoteDeleted,
        assetId: null,
        note: `pulled, but asset registration failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Jobs this process is polling right now (so a resume never starts a second loop for the same job). */
  const inFlight = new Set<string>();

  /** The poll/transfer loop for one submitted job (background in production, inline in tests). */
  async function processJob(jobId: string): Promise<void> {
    if (inFlight.has(jobId)) return;
    inFlight.add(jobId);
    try {
      await processJobInner(jobId);
    } finally {
      inFlight.delete(jobId);
    }
  }

  async function processJobInner(jobId: string): Promise<void> {
    const job = await deps.store.jobs.get(jobId);
    if (!job || !job.promptId) return;
    if (job.status === "transferring" && job.outputsJson) {
      // A transfer another process (or an earlier life of this one) never finished: redo it from the recorded outputs.
      await transferOutputs(job, JSON.parse(job.outputsJson) as MediaJobOutput[]);
      return;
    }
    if (job.status !== "submitted" && job.status !== "generating") return;
    let pollFailures = 0;
    const session = await deps.sessions.getRunningSession(job.sessionId);
    if (!session) {
      await failJob(job, "the session is no longer running");
      return;
    }
    let comfy: ComfyUiClient;
    try {
      comfy = await deps.sessions.comfyClientForSession(job.sessionId);
    } catch (error) {
      await failJob(job, `no ComfyUI client: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const deadline = deps.clock.now().getTime() + maxGenerationMs;
    let outputs: MediaJobOutput[] = [];
    for (;;) {
      const current = await deps.store.jobs.get(jobId);
      if (!current || (current.status !== "submitted" && current.status !== "generating")) return; // cancelled or swept meanwhile
      let history;
      try {
        history = await comfy.getHistory(job.promptId);
        pollFailures = 0;
      } catch (error) {
        // One 502/timeout through RunPod's proxy is routine during a heavy generation: fail only after a run of them,
        // or once the session itself is gone.
        pollFailures++;
        const stillRunning = await deps.sessions.getRunningSession(job.sessionId);
        if (!stillRunning || pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          await failJob(job, `ComfyUI unreachable (${pollFailures} consecutive polls): ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        await deps.sleep(pollMs);
        continue;
      }
      await deps.sessions.touchActivity(job.sessionId);
      if (history) {
        if (history.status === "error") {
          await failJob(job, `ComfyUI execution error: ${history.statusMessages.filter((m) => m.includes("error")).join(", ") || "unknown"}`);
          return;
        }
        if (history.status === "completed") {
          outputs = history.outputs.map((o) => ({
            nodeId: o.nodeId,
            kind: o.kind,
            filename: o.filename,
            subfolder: o.subfolder,
            remoteKey: `${EXCHANGE_PREFIX}${o.subfolder ? `${o.subfolder}/` : ""}${o.filename}`,
            localPath: null,
            bytes: null,
            sha256: null,
            remoteDeleted: false,
            assetId: null,
            note: null,
          }));
          break;
        }
      } else if (current.status === "submitted") {
        await deps.store.jobs.transition(jobId, ["submitted"], { status: "generating" });
      }
      if (deps.clock.now().getTime() >= deadline) {
        await failJob(job, `no result after ${Math.round(maxGenerationMs / 60_000)} min`);
        return;
      }
      await deps.sleep(pollMs);
    }

    const transferring = await deps.store.jobs.transition(jobId, ["submitted", "generating"], { status: "transferring", outputsJson: JSON.stringify(outputs) });
    if (!transferring) return;
    await transferOutputs(job, outputs);
  }

  /**
   * Pulls every recorded output (re-entrant: an output already pulled by an earlier attempt is
   * recognised by its ledger row and never re-downloaded or re-registered).
   */
  async function transferOutputs(job: StoredJobRow, outputs: MediaJobOutput[]): Promise<void> {
    const jobId = job.id;
    const session = await deps.sessions.getRunningSession(job.sessionId);
    let outputDir: string;
    let s3: RunpodS3Client;
    try {
      outputDir = path.join(await deps.resolveOutputRoot(job.channelId), MEDIA_OUTPUT_SUBDIR, job.id);
      await deps.fs.mkdirp(outputDir);
      s3 = await deps.s3();
    } catch (error) {
      // A transient cause (workspace drive unmounted, gateway toggle off, S3 unreachable): keep `transferring` so the
      // watch loop retries, up to the retry window; the recorded outputs stay on the volume meanwhile.
      const message = `cannot receive outputs: ${error instanceof Error ? error.message : String(error)}`;
      const since = (job.submittedAt ?? job.createdAt).getTime();
      if (deps.clock.now().getTime() - since > TRANSFER_RETRY_WINDOW_MS) {
        await failJob(job, `${message} (gave up after ${Math.round(TRANSFER_RETRY_WINDOW_MS / 3_600_000)} h)`, outputs);
      } else {
        await deps.store.jobs.transition(jobId, ["transferring"], { status: "transferring", error: `${message}; retrying` });
      }
      return;
    }
    const template = await deps.store.templates.get(job.templateId);
    const provenance = {
      source: "media_generation",
      jobId: job.id,
      sessionId: job.sessionId,
      templateId: job.templateId,
      templateVersion: job.templateVersion,
      templateName: template?.name ?? null,
      params: JSON.parse(job.paramsJson),
      promptId: job.promptId,
      podId: session?.podId ?? null,
      gpuTypeId: session?.gpuTypeId ?? null,
      costPerHr: session?.costPerHr ?? null,
    };
    const results: MediaJobOutput[] = [];
    for (const output of outputs) {
      if (output.localPath) {
        results.push(output); // already pulled by an earlier attempt
        continue;
      }
      const ledger = await deps.store.ledger.get(output.remoteKey);
      if (ledger) {
        results.push({ ...output, localPath: ledger.localPath, bytes: ledger.bytes, sha256: ledger.sha256, remoteDeleted: ledger.remoteDeletedAt !== null, note: output.note ?? "pulled by an earlier attempt" });
        continue;
      }
      try {
        results.push(await pullOutput(job, output, outputDir, s3, provenance));
      } catch (error) {
        results.push({ ...output, note: `pull failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const pulled = results.filter((r) => r.localPath);
    const notes = results.filter((r) => r.note).map((r) => `${r.filename}: ${r.note}`);
    if (pulled.length === 0 && results.length > 0) {
      await failJob(job, `no output could be pulled (${notes.join("; ")})`, results);
      return;
    }
    await deps.store.jobs.transition(jobId, ["transferring"], {
      status: "done",
      outputsJson: JSON.stringify(results),
      assetIdsJson: JSON.stringify(pulled.map((r) => r.assetId).filter(Boolean)),
      error: notes.length > 0 ? notes.join("; ") : null,
      finishedAt: deps.clock.now(),
    });
  }

  return {
    // -- templates (operator only; D7) ---------------------------------------------------------

    async importWorkflowTemplate(input: unknown): Promise<MediaWorkflowTemplate> {
      const parsed = parseWithSchema(importTemplateInputSchema, input, "workflow template");
      const parameters = parsed.parameters.map(normalizeParameter);
      validateTemplateShape(parsed.workflow as Graph, parameters);
      const row = await deps.store.templates.insert({
        id: deps.generateId(),
        name: parsed.name,
        description: parsed.description ?? null,
        workflowJson: JSON.stringify(parsed.workflow),
        parametersJson: JSON.stringify(parameters),
      });
      return toPublicTemplate(row);
    },

    async updateWorkflowTemplate(input: unknown): Promise<MediaWorkflowTemplate> {
      const parsed = parseWithSchema(updateTemplateInputSchema, input, "workflow template update");
      const existing = await requireTemplate(parsed.templateId);
      const graph = (parsed.workflow ?? JSON.parse(existing.workflowJson)) as Graph;
      const parameters = parsed.parameters ? parsed.parameters.map(normalizeParameter) : (JSON.parse(existing.parametersJson) as MediaTemplateParameter[]);
      validateTemplateShape(parseWithSchema(workflowGraphSchema, graph, "workflow") as Graph, parameters);
      const row = await deps.store.templates.update(parsed.templateId, {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description ?? null } : {}),
        workflowJson: JSON.stringify(graph),
        parametersJson: JSON.stringify(parameters),
      });
      if (!row) throw new DomainError({ code: "media_template_not_found", message: "No workflow template with this id", details: { templateId: parsed.templateId } });
      return toPublicTemplate(row);
    },

    async listWorkflowTemplates(): Promise<MediaWorkflowTemplate[]> {
      return (await deps.store.templates.list()).map(toPublicTemplate);
    },

    async getWorkflowTemplate(input: unknown): Promise<MediaWorkflowTemplate & { workflow: Graph }> {
      const { templateId } = parseWithSchema(templateIdInputSchema, input, "template id");
      const row = await requireTemplate(templateId);
      return { ...toPublicTemplate(row), workflow: JSON.parse(row.workflowJson) as Graph };
    },

    async deleteWorkflowTemplate(input: unknown): Promise<{ deleted: boolean }> {
      const { templateId } = parseWithSchema(templateIdInputSchema, input, "template id");
      return { deleted: await deps.store.templates.delete(templateId) };
    },

    // -- jobs ---------------------------------------------------------------------------------

    /**
     * Validates the parameters, builds the prompt, submits it to the session's ComfyUI and starts
     * the background poll. The session must be running and belong to the caller's channel (AC-P14-16).
     */
    async createJob(input: unknown): Promise<MediaJob> {
      const parsed = parseWithSchema(createJobInputSchema, input, "create job");
      const session = await deps.sessions.getRunningSession(parsed.sessionId);
      if (!session) throw new DomainError({ code: "media_session_invalid_state", message: "The session is not running", details: { sessionId: parsed.sessionId } });
      if (session.channelId !== parsed.channelId) {
        throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "The session belongs to another channel", details: { sessionId: parsed.sessionId } });
      }
      const template = await requireTemplate(parsed.templateId);
      const parameters = JSON.parse(template.parametersJson) as MediaTemplateParameter[];
      const values = resolveParams(parameters, parsed.params);
      const jobId = deps.generateId();
      const prompt = buildPrompt(JSON.parse(template.workflowJson) as Graph, parameters, values, jobId);
      const now = deps.clock.now();
      const row = await deps.store.jobs.insert({
        id: jobId,
        sessionId: parsed.sessionId,
        channelId: parsed.channelId,
        templateId: template.id,
        templateVersion: template.version,
        paramsJson: JSON.stringify(values),
        status: "queued",
        createdBy: parsed.createdBy,
        promptId: null,
        outputsJson: null,
        assetIdsJson: null,
        error: null,
        createdAt: now,
        submittedAt: null,
        finishedAt: null,
      });
      let comfy: ComfyUiClient;
      try {
        comfy = await deps.sessions.comfyClientForSession(parsed.sessionId);
      } catch (error) {
        await failJob(row, `no ComfyUI client: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      let submitted;
      try {
        submitted = await comfy.submitPrompt({ prompt, clientId: `ytm-${jobId}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failJob(row, `ComfyUI rejected the prompt: ${message}`);
        throw error;
      }
      await deps.sessions.touchActivity(parsed.sessionId);
      const updated = await deps.store.jobs.transition(jobId, ["queued"], { status: "submitted", promptId: submitted.promptId, submittedAt: deps.clock.now() });
      deps.schedule(() => processJob(jobId));
      return toPublicJob(updated ?? row);
    },

    processJob,

    async getJob(input: unknown): Promise<MediaJob> {
      const { jobId } = parseWithSchema(jobIdInputSchema, input, "job id");
      return toPublicJob(await requireJob(jobId));
    },

    async listJobs(input: unknown = {}): Promise<MediaJob[]> {
      const filter = parseWithSchema(listJobsInputSchema, input, "list jobs");
      return (await deps.store.jobs.list(filter)).map(toPublicJob);
    },

    /** queued/submitted/generating -> cancelled; ComfyUI's current execution is interrupted (best effort). */
    async cancelJob(input: unknown): Promise<MediaJob> {
      const { jobId } = parseWithSchema(jobIdInputSchema, input, "job id");
      const row = await requireJob(jobId);
      const cancelled = await deps.store.jobs.transition(jobId, ["queued", "submitted", "generating"], { status: "cancelled", finishedAt: deps.clock.now(), error: null });
      if (!cancelled) throw new DomainError({ code: "media_job_invalid_state", message: `Job is ${row.status}; only a queued or generating job can be cancelled`, details: { jobId, status: row.status } });
      if (row.promptId) {
        try {
          // /interrupt aborts whatever ComfyUI is executing -- only this job's prompt may be interrupted; a queued one is removed from the queue.
          const comfy = await deps.sessions.comfyClientForSession(row.sessionId);
          const queue = await comfy.getQueue();
          if (queue.runningPromptIds.includes(row.promptId)) await comfy.interrupt();
          else if (queue.pendingPromptIds.includes(row.promptId)) await comfy.deleteQueued([row.promptId]);
        } catch {
          // the session may be gone already; the job is cancelled either way
        }
      }
      return toPublicJob(cancelled);
    },

    /**
     * Picks up submitted/generating jobs nobody in this process is polling (created by the operator CLI,
     * or left by a restart whose session survived) -- as long as their session is still running.
     */
    async resumeInFlightJobs(): Promise<{ resumed: string[] }> {
      const resumed: string[] = [];
      for (const row of await deps.store.jobs.listNonTerminal()) {
        if (inFlight.has(row.id)) continue;
        if (row.status === "queued" || !row.promptId) {
          // Never submitted (a crash between insert and the `submitted` write): nothing to resume.
          await failJob(row, "never submitted to ComfyUI");
          continue;
        }
        // A transfer needs only S3 (the pod may be gone already); a poll needs the session's ComfyUI -- without it
        // the job can never finish, so it fails now instead of lingering as "in flight" forever.
        if (row.status !== "transferring" && !(await deps.sessions.getRunningSession(row.sessionId))) {
          await failJob(row, "the session is no longer running");
          continue;
        }
        resumed.push(row.id);
        deps.schedule(() => processJob(row.id));
      }
      return { resumed };
    },

    /** For the idle auto-shutdown: a job in flight is work even when no HTTP request is (an MCP-driven session). */
    async hasInFlightJobs(): Promise<boolean> {
      return (await deps.store.jobs.listNonTerminal()).length > 0;
    },

    /** Boot: a job left non-terminal by a dead process fails as interrupted (its pod is gone by then too). */
    async sweepInterruptedJobs(): Promise<{ failed: string[] }> {
      const failed: string[] = [];
      for (const row of await deps.store.jobs.listNonTerminal()) {
        // A `transferring` row keeps its recorded outputs and is resumed by the watch loop (it needs only S3).
        if (row.status === "transferring" && row.outputsJson) continue;
        await failJob(row, "interrupted by a server restart");
        failed.push(row.id);
      }
      return { failed };
    },

    /**
     * The janitor (AC-P14-14): lists ONLY `exchange/`, skips `exchange/in/`, and deletes a key only
     * when its job is terminal AND (its ledger row says the file is local, or the job failed/was
     * cancelled, so nothing was ever pulled). Keys of unknown jobs (another device's) are left alone.
     */
    async cleanupExchange(options: { dryRun?: boolean } = {}): Promise<{ scanned: number; deleted: string[]; kept: Array<{ key: string; reason: string }> }> {
      const dryRun = options.dryRun ?? true;
      const s3 = await deps.s3();
      const objects = await s3.listAllObjects(EXCHANGE_PREFIX);
      const deleted: string[] = [];
      const kept: Array<{ key: string; reason: string }> = [];
      const jobCache = new Map<string, StoredJobRow | null>();
      for (const object of objects) {
        const key = object.key;
        if (!key.startsWith(EXCHANGE_PREFIX)) {
          kept.push({ key, reason: "outside exchange/" });
          continue;
        }
        if (key.startsWith(EXCHANGE_INPUT_PREFIX)) {
          kept.push({ key, reason: "reference input" });
          continue;
        }
        const jobId = key.slice(EXCHANGE_PREFIX.length).split("/")[0];
        if (!jobCache.has(jobId)) jobCache.set(jobId, await deps.store.jobs.get(jobId));
        const job = jobCache.get(jobId) ?? null;
        if (!job) {
          kept.push({ key, reason: "unknown job" });
          continue;
        }
        if (!MEDIA_JOB_TERMINAL_STATUSES.includes(job.status)) {
          kept.push({ key, reason: `job ${job.status}` });
          continue;
        }
        const ledger = await deps.store.ledger.get(key);
        // A failed/cancelled job may still own completed outputs that were never pulled (transfer failure, restart):
        // those are the only copy and stay until pulled by hand or recorded in the ledger.
        const unpulledOutputs = job.outputsJson ? (JSON.parse(job.outputsJson) as MediaJobOutput[]).some((o) => o.remoteKey === key && !o.localPath) : false;
        const safeToDelete = Boolean(ledger && ledger.localPath) || ((job.status === "failed" || job.status === "cancelled") && !unpulledOutputs);
        if (!safeToDelete) {
          kept.push({ key, reason: job.status === "done" ? "done job without a ledger row" : `${job.status} job with an unpulled output` });
          continue;
        }
        if (!dryRun) {
          await s3.deleteObject(key);
          if (ledger) await deps.store.ledger.markRemoteDeleted(key, deps.clock.now());
        }
        deleted.push(key);
      }
      return { scanned: objects.length, deleted, kept };
    },
  };
}

export type MediaJobServices = ReturnType<typeof createMediaJobServices>;
