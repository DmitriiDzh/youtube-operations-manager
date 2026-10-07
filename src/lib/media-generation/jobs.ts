import path from "node:path";
import type { JobProgressRegistry } from "./job-progress";
import type { ComfyUiClient, ProgressStream, RunpodS3Client } from "@/lib/media-gateway";
import {
  DomainError,
  EXCHANGE_INPUT_PREFIX,
  EXCHANGE_PREFIX,
  isInputParameterType,
  MEDIA_INPUT_DEFAULT_ACCEPT,
  MEDIA_INPUT_MAX_BYTES,
  MEDIA_JOB_MANIFEST_FILE,
  MEDIA_JOB_TERMINAL_STATUSES,
  MEDIA_OUTPUT_SUBDIR,
  type MediaJob,
  type MediaJobManifest,
  type MediaJobOutput,
  type MediaGpuPlan,
  type MediaJobInput,
  type MediaJobStatus,
  type MediaModelReference,
  type MediaModelUsage,
  type MediaTemplateParameter,
  type MediaTemplateSyncResult,
  type MediaTemplateSyncTrigger,
  type MediaWorkflowTemplate,
} from "./contracts";
import type { MediaControlEvent } from "./models";
import {
  adoptTemplateInputSchema,
  checkDeclaredModels,
  localTemplateModels,
  parseRegistryIndex,
  parseRegistryTemplate,
  parseTemplateAdoptions,
  registryContentSha256,
  registryTemplateFileName,
  type RegistryTemplate,
  type TemplateAdoption,
} from "./template-registry";
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
  /** Derived at import/update (schema v55) so a listing never re-parses the whole graph; null on rows written before v55. */
  outputNodeIdsJson: string | null;
  nodeCount: number | null;
  createdAt: Date;
  updatedAt: Date;
  /** Schema v61 (BL-132); absent = `owner`. */
  source?: "owner" | "factory";
  registrySha256?: string | null;
  modelsJson?: string | null;
  /** Schema v64 (BL-133): a registry template's GPU plan. */
  gpuJson?: string | null;
};

export type StoredJobRow = {
  id: string;
  sessionId: string;
  channelId: string;
  templateId: string;
  templateVersion: number;
  paramsJson: string;
  status: MediaJobStatus;
  createdBy: "operator" | "agent" | "factory";
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
    insert(row: { id: string; name: string; description: string | null; workflowJson: string; parametersJson: string; outputNodeIdsJson: string; nodeCount: number; modelsJson?: string }): Promise<StoredTemplateRow>;
    update(id: string, patch: { name?: string; description?: string | null; workflowJson?: string; parametersJson?: string; outputNodeIdsJson?: string; nodeCount?: number; modelsJson?: string }): Promise<StoredTemplateRow | null>;
    get(id: string): Promise<StoredTemplateRow | null>;
    list(): Promise<StoredTemplateRow[]>;
    delete(id: string): Promise<boolean>;
    /** BL-132: install/replace a registry template; `null` = the id belongs to an owner-imported (local) template. */
    upsertFactory(row: { id: string; name: string; description: string | null; version: number; workflowJson: string; parametersJson: string; outputNodeIdsJson: string; nodeCount: number; registrySha256: string; modelsJson: string; gpuJson: string | null }): Promise<StoredTemplateRow | null>;
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
  /** BL-132: job input files uploaded to `exchange/in/` (absent = this store cannot take inputs). */
  inputs?: {
    insert(row: Omit<ExchangeInputRow, "remoteDeletedAt">): Promise<void>;
    listByJob(jobId: string): Promise<ExchangeInputRow[]>;
    get(remoteKey: string): Promise<ExchangeInputRow | null>;
    markRemoteDeleted(remoteKey: string, at: Date): Promise<void>;
  };
};

export type ExchangeInputRow = { remoteKey: string; jobId: string; parameter: string; sourcePath: string; bytes: number; sha256: string; uploadedAt: Date; remoteDeletedAt: Date | null };

export type JobServiceDependencies = {
  store: MediaJobStore;
  /** BL-144: live progress from ComfyUI's websocket while a job generates; absent = not watched (tests, CLI). */
  progress?: JobProgressRegistry;
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
    /** Removes a file this module wrote itself (a download that failed verification); missing = fine. */
    remove(filePath: string): Promise<void>;
    /** Writes `<filePath>.part`, then renames it to `filePath` (the job's manifest; FO-REQ-0002). */
    writeFileAtomic(filePath: string, text: string): Promise<void>;
  };
  /** Which installation ran the job, for the manifest: the bootstrap `deviceId` and the machine's host name. */
  device(): Promise<{ deviceId: string | null; hostname: string | null }>;
  registerAsset(input: {
    channelId: string;
    assetType: "generated_image" | "audio_track" | "video_loop" | "other";
    referenceKind: "local_path";
    referenceValue: string;
    title: string;
    provenance: Record<string, unknown>;
  }): Promise<{ assetId: string }>;
  /** The asset already cataloged for this local file, if an earlier attempt registered it before dying. */
  findAssetByLocalPath(channelId: string, localPath: string): Promise<{ assetId: string } | null>;
  generateId(): string;
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
  /** How a submitted job's polling runs: production fires it in the background; tests run it inline. */
  schedule(run: () => Promise<void>): void;
  timeouts?: { pollMs?: number; maxGenerationMs?: number };
  log?: (line: string) => void;
  /**
   * BL-132 (plan §2.4): a job input file named relative to the channel workspace's `99 Data Exchange/Sent to YTM/`,
   * proven contained (`workspace-exchange`); throws `media_input_unavailable`. Absent = inputs are not available here.
   */
  resolveInputFile?(channelId: string, relativePath: string): Promise<{ path: string; bytes: number; identity?: { dev: number; ino: number } }>;
  /** BL-132: the factory template registry folder (`adapters/template-registry-fs.ts`); absent = no registry on this device. */
  registry?: { read(): Promise<{ indexText: string; readTemplateFile(name: string): Promise<string | null> }> };
  /** BL-132 audit sink. */
  events?: { record(event: MediaControlEvent): Promise<void> };
  /** BL-132: where the last sync result is kept (shown in the Web UI and the factory tool). */
  syncState?: { get(): Promise<string | null>; set(json: string): Promise<void> };
  /** FO-REQ-0005: the pending adoptions of local templates into the registry (`parseTemplateAdoptions`); absent = none kept. */
  adoptions?: { get(): Promise<string | null>; set(json: string): Promise<void> };
};

export type TemplateActor = "owner" | "factory";

/** FO-REQ-0005 item 2: what `factory_media_adopt_template` returns -- the registry file to write, ready as it is. */
export type MediaTemplateAdoption = {
  localTemplateId: string;
  templateId: string;
  /** Write this exact object as `<registry>/<fileName>` and add `indexEntry` to `index.json`. */
  fileName: string;
  indexEntry: { templateId: string; version: number };
  template: RegistryTemplate;
  /** `pending` = the local copy stays until a sync installs `templateId`; `adopted` = it was already installed, the local copy is gone. */
  status: "pending" | "adopted";
};

const DEFAULT_POLL_MS = 4_000;
const DEFAULT_MAX_GENERATION_MS = 2 * 60 * 60_000;
/** Consecutive `/history` failures (proxy 502, 30 s timeout) tolerated while the session still runs. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
/** BL-144: how long a submit waits for the progress socket to connect, and how often a dropped one is reopened. */
const PROGRESS_OPEN_WAIT_MS = 5_000;
const PROGRESS_RECONNECT_MS = 15_000;
/** How long a `transferring` job keeps being retried when its outputs cannot be received yet. */
const TRANSFER_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const TRANSFER_BACKOFF_BASE_MS = 15_000;
const TRANSFER_BACKOFF_CAP_MS = 10 * 60_000;
/** While inputs upload, the session's activity is refreshed this often (BL-135: a release-when-done grace is one minute). */
const UPLOAD_HEARTBEAT_MS = 20_000;
/** A `queued` row younger than this is a `createJob` still submitting, not a leftover. */
const SUBMIT_GRACE_MS = 5 * 60_000;
/** While `/history` has no entry, every Nth poll asks `/queue` whether ComfyUI still knows the prompt at all. */
const QUEUE_CHECK_EVERY_POLLS = 15;

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
    // BL-132: only input parameters carry these keys (the other types' JSON shape is unchanged); given on another type they
    // are kept so the template check can refuse them, never silently dropped.
    ...(isInputParameterType(p.type) || p.accept != null || p.maxBytes != null ? { accept: p.accept ?? null, maxBytes: p.maxBytes ?? null } : {}),
  };
}

/** Save-class nodes are recognised by shape, not by a class list: any node with a string `filename_prefix` input. */
export function outputNodeIds(graph: Graph): string[] {
  return Object.entries(graph)
    .filter(([, node]) => typeof node.inputs?.filename_prefix === "string")
    .map(([id]) => id);
}

/** The structural checks every template passes, imported by hand or installed from the registry. */
export function validateTemplateShape(graph: Graph, parameters: MediaTemplateParameter[]): void {
  const problems: string[] = [];
  for (const p of parameters) {
    const node = graph[p.nodeId];
    if (!node) problems.push(`parameter "${p.name}": node ${p.nodeId} is not in the workflow`);
    else if (!(p.input in node.inputs)) problems.push(`parameter "${p.name}": node ${p.nodeId} has no input "${p.input}"`);
    // The `<jobId>/` output-folder rewrite is what keeps every output inside the job's own folder (and pullable): a
    // parameter on `filename_prefix` could undo it (review round 10).
    if (p.input === "filename_prefix") problems.push(`parameter "${p.name}": filename_prefix is managed by the job (its <jobId>/ prefix) and cannot be a parameter`);
    if (p.type === "enum" && (!p.enum || p.enum.length === 0)) problems.push(`parameter "${p.name}": an enum needs values`);
    // BL-132: an input file is always the job's own (a default path would be the same file for every job).
    if (isInputParameterType(p.type) && p.default !== null && p.default !== undefined) problems.push(`parameter "${p.name}": an ${p.type} input cannot have a default`);
    if (!isInputParameterType(p.type) && (p.accept != null || p.maxBytes != null)) problems.push(`parameter "${p.name}": accept/maxBytes apply only to image, audio and video inputs`);
    // A default that cannot pass the parameter's own type/bounds/enum would fail every job that omits the parameter
    // (blaming the caller's params); refuse it at import instead (review round 8).
    if (p.default !== null && p.default !== undefined) {
      const problem = checkParameterValue(p, p.default);
      if (problem) problems.push(`parameter "${p.name}": its default is invalid -- ${problem}`);
    }
  }
  const names = parameters.map((p) => p.name);
  if (new Set(names).size !== names.length) problems.push("parameter names must be unique");
  if (outputNodeIds(graph).length === 0) problems.push("the workflow has no Save node (no input named filename_prefix), so it would produce nothing to pull");
  // A Save node whose filename_prefix is a link (not a string) could not be rewritten to <jobId>/: its files would land
  // outside the job's folder, never pulled and never cleaned (review round 11).
  for (const [id, node] of Object.entries(graph)) {
    if (node.inputs && "filename_prefix" in node.inputs && typeof node.inputs.filename_prefix !== "string") {
      problems.push(`node ${id} (${node.class_type}): filename_prefix must be a literal string, not a link, so the job can prefix it with <jobId>/`);
    }
  }
  if (problems.length > 0) throw new DomainError({ code: "media_template_invalid", message: `Invalid workflow template: ${problems.join("; ")}`, details: { problems } });
}

/**
 * A factory row's declared models, or a local row's loader-node models -- both recorded when the row is written (schema
 * v61), so a listing never parses graphs (review round 8). A local row written before v61 is parsed once per call as a
 * fallback, like the v55 shape fields; one that cannot be parsed reports no models.
 */
function templateModels(row: StoredTemplateRow): MediaModelReference[] {
  if (row.modelsJson) {
    return (JSON.parse(row.modelsJson) as Array<{ folder: MediaModelReference["folder"]; file: string; sha256?: string | null }>).map((m) => ({ folder: m.folder, file: m.file, sha256: m.sha256 ?? null }));
  }
  try {
    return localTemplateModels(JSON.parse(row.workflowJson) as Graph, JSON.parse(row.parametersJson) as MediaTemplateParameter[]);
  } catch {
    return [];
  }
}

export function toPublicTemplate(row: StoredTemplateRow): MediaWorkflowTemplate {
  // The graph is parsed only for a row written before schema v55 recorded these two facts.
  const shape =
    row.outputNodeIdsJson !== null && row.nodeCount !== null
      ? { outputNodeIds: JSON.parse(row.outputNodeIdsJson) as string[], nodeCount: row.nodeCount }
      : (() => {
          const graph = JSON.parse(row.workflowJson) as Graph;
          return { outputNodeIds: outputNodeIds(graph), nodeCount: Object.keys(graph).length };
        })();
  return {
    templateId: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    source: row.source ?? "owner",
    models: templateModels(row),
    gpu: row.gpuJson ? (JSON.parse(row.gpuJson) as MediaGpuPlan) : null,
    parameters: JSON.parse(row.parametersJson) as MediaTemplateParameter[],
    outputNodeIds: shape.outputNodeIds,
    nodeCount: shape.nodeCount,
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
/** One value against one declared parameter: the problem, or null. Shared by job params and template defaults. */
export function checkParameterValue(p: MediaTemplateParameter, value: string | number | boolean): string | null {
  switch (p.type) {
    case "string":
    case "text":
      if (typeof value !== "string") return `"${p.name}" must be a string`;
      if (p.min !== null && value.length < p.min) return `"${p.name}" is shorter than ${p.min} characters`;
      if (p.max !== null && value.length > p.max) return `"${p.name}" is longer than ${p.max} characters`;
      return null;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `"${p.name}" must be a number`;
      if (p.type === "integer" && !Number.isInteger(value)) return `"${p.name}" must be an integer`;
      if (p.min !== null && value < p.min) return `"${p.name}" is below ${p.min}`;
      if (p.max !== null && value > p.max) return `"${p.name}" is above ${p.max}`;
      return null;
    case "boolean":
      return typeof value !== "boolean" ? `"${p.name}" must be true or false` : null;
    case "enum":
      return typeof value !== "string" || !(p.enum ?? []).includes(value) ? `"${p.name}" must be one of ${(p.enum ?? []).join(", ")}` : null;
    case "image":
    case "audio":
    case "video": {
      // BL-132: a path relative to the channel's `99 Data Exchange/Sent to YTM/` (where it lies is proven at upload).
      if (typeof value !== "string" || !value) return `"${p.name}" must be a file path relative to 99 Data Exchange/Sent to YTM`;
      if (value.length > 500 || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.split("/").some((s) => s === "" || s === "." || s === "..")) {
        return `"${p.name}" must be a path relative to 99 Data Exchange/Sent to YTM (use / between folders, no .. or absolute paths)`;
      }
      const accept = p.accept ?? MEDIA_INPUT_DEFAULT_ACCEPT[p.type];
      const extension = path.extname(value).toLowerCase();
      return accept.includes(extension) ? null : `"${p.name}" must be one of ${accept.join(", ")} (got "${extension || "no extension"}")`;
    }
  }
}

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
    const problem = checkParameterValue(p, value);
    if (problem) problems.push(problem);
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

function isInside(relative: string): boolean {
  return relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

const MANIFEST_KIND: Record<ReturnType<typeof assetTypeFor>, MediaJobManifest["outputs"][number]["kind"]> = {
  generated_image: "image",
  audio_track: "audio",
  video_loop: "video",
  other: "other",
};

/**
 * The manifest of a final job (FO-REQ-0002): built from the job row and its outputs only, field by field -- never by
 * spreading a record that could later grow a credential, a pod id or an account identity.
 */
export function buildJobManifest(input: {
  job: StoredJobRow;
  status: "done" | "failed";
  error: string | null;
  finishedAt: Date;
  outputs: MediaJobOutput[];
  outputDir: string;
  templateName: string | null;
  device: { deviceId: string | null; hostname: string | null };
}): MediaJobManifest {
  const { job } = input;
  const relativePath = (localPath: string) => path.relative(input.outputDir, localPath);
  // Only files inside THIS folder are listed as delivered: an output pulled before the channel's workspace was moved
  // lives elsewhere and could never be found next to the manifest -- it is reported under `missing` instead.
  const delivered = input.outputs.filter(
    (o): o is MediaJobOutput & { localPath: string; bytes: number; sha256: string } =>
      Boolean(o.localPath) && o.bytes !== null && o.sha256 !== null && isInside(relativePath(o.localPath!)),
  );
  return {
    schema: "ytm.media-job-manifest",
    schemaVersion: 1,
    jobId: job.id,
    sessionId: job.sessionId,
    channelId: job.channelId,
    status: input.status,
    error: input.error,
    template: { templateId: job.templateId, templateVersion: job.templateVersion, name: input.templateName },
    params: JSON.parse(job.paramsJson) as Record<string, string | number | boolean>,
    createdBy: job.createdBy,
    createdAt: job.createdAt.toISOString(),
    submittedAt: job.submittedAt ? job.submittedAt.toISOString() : null,
    finishedAt: input.finishedAt.toISOString(),
    device: { deviceId: input.device.deviceId, hostname: input.device.hostname },
    // `/` on every platform: the folder is read on the other OS too (Syncthing between the Mac and Windows).
    outputs: delivered.map((o) => ({
      path: relativePath(o.localPath).split(path.sep).join("/"),
      kind: MANIFEST_KIND[assetTypeFor(o.kind)],
      comfyKind: o.kind,
      nodeId: o.nodeId,
      bytes: o.bytes,
      sha256: o.sha256,
      assetId: o.assetId,
      note: o.note,
    })),
    missing: input.outputs.filter((o) => !delivered.includes(o as (typeof delivered)[number])).map((o) => ({
      nodeId: o.nodeId,
      comfyKind: o.kind,
      filename: o.filename,
      subfolder: o.subfolder,
      note: o.localPath && o.bytes !== null && o.sha256 !== null ? `delivered outside this folder: ${o.localPath}` : o.note,
    })),
  };
}

/**
 * The text an agent can act on when ComfyUI refuses a prompt (AC-P14-11): the gateway's HTTP message
 * plus ComfyUI's own `error.message`/`details` and every node's `errors[].message` from the 400 body
 * (`{ error, node_errors: { <nodeId>: { class_type, errors: [{ message, details }] } } }`), bounded.
 */
export function describeComfyRejection(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof DomainError)) return message;
  const details = (error.details ?? {}) as Record<string, unknown>;
  const body = (details.body ?? details) as Record<string, unknown>;
  const parts: string[] = [];
  const top = body.error;
  if (top && typeof top === "object") {
    const t = top as Record<string, unknown>;
    const text = [t.message, t.details].filter((v): v is string => typeof v === "string" && v.length > 0).join(": ");
    if (text) parts.push(text);
  } else if (typeof top === "string") parts.push(top);
  const nodeErrors = (body.node_errors ?? body.nodeErrors) as Record<string, unknown> | undefined;
  if (nodeErrors && typeof nodeErrors === "object") {
    for (const [nodeId, value] of Object.entries(nodeErrors)) {
      const node = (value ?? {}) as Record<string, unknown>;
      const errors = Array.isArray(node.errors) ? (node.errors as Array<Record<string, unknown>>) : [];
      const texts = errors.map((e) => [e.message, e.details].filter((v): v is string => typeof v === "string" && v.length > 0).join(": ")).filter(Boolean);
      parts.push(`node ${nodeId}${typeof node.class_type === "string" ? ` (${node.class_type})` : ""}: ${texts.join("; ") || "invalid"}`);
    }
  }
  const full = parts.length > 0 ? `${message} -- ${parts.join(" | ")}` : message;
  return full.length > 2000 ? `${full.slice(0, 1997)}...` : full;
}

/** BL-132: an input's flat name on the volume -- letters, digits, `.`, `-`, `_` only (the extension is kept). */
function safeInputName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(-120) || "input";
}

function inputContentType(name: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
  };
  return types[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

function safeFileName(name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
  return name;
}

/** Every segment of the key must be a plain name: no empty, `.` or `..` segment (a Save node's subfolder is untrusted). */
function safeRemoteKey(key: string): boolean {
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

export function createMediaJobServices(deps: JobServiceDependencies) {
  const pollMs = deps.timeouts?.pollMs ?? DEFAULT_POLL_MS;
  const maxGenerationMs = deps.timeouts?.maxGenerationMs ?? DEFAULT_MAX_GENERATION_MS;
  const log = deps.log ?? (() => undefined);

  /** BL-132: a job's uploaded inputs from the ledger (`[]` when it has none). */
  async function withInputs(job: MediaJob): Promise<MediaJob> {
    const rows = deps.store.inputs ? await deps.store.inputs.listByJob(job.jobId) : [];
    const inputs: MediaJobInput[] = rows.map((r) => ({ parameter: r.parameter, sourcePath: r.sourcePath, remoteKey: r.remoteKey, bytes: r.bytes, sha256: r.sha256, uploadedAt: r.uploadedAt.toISOString(), remoteDeleted: r.remoteDeletedAt !== null }));
    // BL-144: live ComfyUI progress while this device watches the job's generation (absent otherwise).
    const progress = deps.progress?.get(job.jobId) ?? null;
    return { ...job, inputs, ...(progress ? { progress } : {}) };
  }

  function factoryManaged(templateId: string): DomainError {
    return new DomainError({
      code: "media_template_invalid",
      message: "This template is installed from the factory template registry; change or remove it there (it would be overwritten by the next sync).",
      details: { templateId, source: "factory" },
    });
  }

  async function recordEvent(event: MediaControlEvent): Promise<void> {
    try {
      await deps.events?.record(event);
    } catch (error) {
      log(`[media] could not record the ${event.action} event for ${event.subject}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let registrySyncChain: Promise<unknown> = Promise.resolve();

  async function readAdoptions(): Promise<TemplateAdoption[]> {
    return parseTemplateAdoptions(deps.adoptions ? await deps.adoptions.get() : null);
  }

  async function writeAdoptions(adoptions: TemplateAdoption[]): Promise<void> {
    await deps.adoptions?.set(JSON.stringify(adoptions));
  }

  async function forgetAdoption(localTemplateId: string): Promise<void> {
    const adoptions = await readAdoptions();
    if (adoptions.some((a) => a.localTemplateId === localTemplateId)) await writeAdoptions(adoptions.filter((a) => a.localTemplateId !== localTemplateId));
  }

  /** The local copy goes once the registry template is installed here (the factory's adoption, so recorded as the factory's). */
  async function completeAdoption(local: StoredTemplateRow, templateId: string): Promise<void> {
    await deps.store.templates.delete(local.id);
    await forgetAdoption(local.id);
    await recordEvent({ actor: "factory", action: "template_adopted", subject: local.id, details: { name: local.name, templateId } });
  }

  async function adoptTemplate(input: unknown): Promise<MediaTemplateAdoption> {
    if (!deps.adoptions) throw new DomainError({ code: "media_template_registry_unavailable", message: "Template adoption is not available on this device." });
    const parsed = parseWithSchema(adoptTemplateInputSchema, input, "template adoption");
    const local = await requireTemplate(parsed.templateId);
    if (local.source === "factory") throw factoryManaged(local.id);
    const workflow = JSON.parse(local.workflowJson) as Graph;
    const parameters = JSON.parse(local.parametersJson) as MediaTemplateParameter[];
    const models = localTemplateModels(workflow, parameters).flatMap((m) => (m.folder ? [{ folder: m.folder, file: m.file }] : []));
    const body = {
      schema: "ytm.media-template",
      schemaVersion: 1,
      templateId: parsed.newTemplateId,
      version: 1,
      name: local.name,
      ...(local.description ? { description: local.description } : {}),
      workflow,
      parameters,
      models,
    };
    // The file must be one a sync accepts as it is: the factory never gets a body it cannot write.
    const checked = parseRegistryTemplate(JSON.stringify(body), { templateId: parsed.newTemplateId, version: 1 });
    const problems = checked.ok ? checkDeclaredModels({ workflow, parameters, models }) : [checked.reason];
    if (!checked.ok || problems.length > 0) {
      throw new DomainError({
        code: "media_template_invalid",
        message: `This template cannot become a registry template as it is: ${problems.join("; ")}`,
        details: { templateId: local.id, problems, template: body },
      });
    }
    const existing = await deps.store.templates.get(parsed.newTemplateId);
    if (existing && (existing.source ?? "owner") !== "factory") {
      throw new DomainError({ code: "media_template_invalid", message: `${parsed.newTemplateId} is the id of another local template on this device; choose another id.`, details: { newTemplateId: parsed.newTemplateId } });
    }
    const adoptions = await readAdoptions();
    const clash = adoptions.find((a) => a.templateId === parsed.newTemplateId && a.localTemplateId !== local.id);
    if (clash) {
      throw new DomainError({ code: "media_template_invalid", message: `${parsed.newTemplateId} is already the adoption target of local template ${clash.localTemplateId}; choose another id.`, details: { newTemplateId: parsed.newTemplateId, localTemplateId: clash.localTemplateId } });
    }
    const result = { localTemplateId: local.id, templateId: parsed.newTemplateId, fileName: registryTemplateFileName(parsed.newTemplateId, 1), indexEntry: { templateId: parsed.newTemplateId, version: 1 }, template: checked.template };
    if (existing) {
      // Already in the registry and installed here: the local copy is no longer needed.
      await completeAdoption(local, parsed.newTemplateId);
      return { ...result, status: "adopted" };
    }
    await writeAdoptions([...adoptions.filter((a) => a.localTemplateId !== local.id), { localTemplateId: local.id, templateId: parsed.newTemplateId, requestedAt: deps.clock.now().toISOString() }]);
    await recordEvent({ actor: "factory", action: "template_adoption_requested", subject: local.id, details: { name: local.name, templateId: parsed.newTemplateId } });
    return { ...result, status: "pending" };
  }
  /** What the registry read like at the last sync (the 60 s check compares against it). Per process. */
  let lastRegistryFingerprint: string | null = null;

  async function runRegistrySync(input: { trigger: MediaTemplateSyncTrigger; dryRun?: boolean; onlyIfChanged?: boolean }): Promise<MediaTemplateSyncResult | null> {
    const dryRun = input.dryRun ?? false;
    const result: MediaTemplateSyncResult = { at: deps.clock.now().toISOString(), trigger: input.trigger, dryRun, outcome: "ok", error: null, installed: [], updated: [], removed: [], unchanged: [], pending: [], invalid: [] };
    const actor = input.trigger === "auto" ? "sync" : input.trigger;
    const finish = async (fingerprint: string): Promise<MediaTemplateSyncResult> => {
      if (!dryRun) {
        lastRegistryFingerprint = fingerprint;
        await deps.syncState?.set(JSON.stringify(result));
      }
      return result;
    };

    // 1. Read the registry. Anything that keeps the index from being read means: change nothing.
    let snapshot: { indexText: string; readTemplateFile(name: string): Promise<string | null> };
    let index: ReturnType<typeof parseRegistryIndex>;
    try {
      if (!deps.registry) throw new DomainError({ code: "media_template_registry_unavailable", message: "No template registry is wired on this device." });
      snapshot = await deps.registry.read();
      index = parseRegistryIndex(snapshot.indexText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fingerprint = `unavailable:${message}`;
      if (input.onlyIfChanged && fingerprint === lastRegistryFingerprint) return null;
      result.outcome = "unavailable";
      result.error = message;
      return finish(fingerprint);
    }
    const files = new Map<string, string | null>();
    for (const entry of index.templates) {
      const name = registryTemplateFileName(entry.templateId, entry.version);
      files.set(name, await snapshot.readTemplateFile(name).catch(() => null));
    }
    // 2. Each listed template. The fingerprint covers this device's template rows too (independent review): a change there
    // (e.g. the owner deleted a local template whose id blocked a registry one) is picked up by the 60 s check as well.
    const rows = await deps.store.templates.list();
    const fingerprintOf = (current: StoredTemplateRow[]) =>
      registryContentSha256(
        JSON.stringify([
          snapshot.indexText,
          ...[...files.entries()].map(([name, text]) => [name, text === null ? null : registryContentSha256(text)]),
          ...current.map((r) => [r.id, r.version, r.source ?? "owner", r.registrySha256 ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ])
      );
    if (input.onlyIfChanged && fingerprintOf(rows) === lastRegistryFingerprint) return null;
    for (const entry of index.templates) {
      const { templateId, version } = entry;
      const text = files.get(registryTemplateFileName(templateId, version)) ?? null;
      if (text === null) {
        result.pending.push({ templateId, version });
        continue;
      }
      const invalid = (reason: string) => result.invalid.push({ templateId, version, reason });
      const parsed = parseRegistryTemplate(text, entry);
      if (!parsed.ok) {
        invalid(parsed.reason);
        continue;
      }
      const parameters = parsed.template.parameters.map(normalizeParameter);
      try {
        validateTemplateShape(parsed.template.workflow as Graph, parameters);
      } catch (error) {
        invalid(error instanceof Error ? error.message : String(error));
        continue;
      }
      const modelProblems = checkDeclaredModels({ workflow: parsed.template.workflow as Graph, parameters, models: parsed.template.models });
      if (modelProblems.length > 0) {
        invalid(`models: ${modelProblems.join("; ")}`);
        continue;
      }
      const sha = registryContentSha256(text);
      const existing = rows.find((r) => r.id === templateId);
      if (existing && (existing.source ?? "owner") !== "factory") {
        invalid("this id belongs to a template imported by hand on this device");
        continue;
      }
      if (existing && existing.version > version) {
        invalid(`version ${version} is lower than the installed ${existing.version}; a registry never rolls back`);
        continue;
      }
      if (existing && existing.version === version) {
        if (existing.registrySha256 === sha) result.unchanged.push({ templateId, version });
        else invalid(`version ${version} is installed with different content; bump the version for a change`);
        continue;
      }
      if (!dryRun) {
        const written = await deps.store.templates.upsertFactory({
          id: templateId,
          name: parsed.template.name,
          description: parsed.template.description ?? null,
          version,
          workflowJson: JSON.stringify(parsed.template.workflow),
          parametersJson: JSON.stringify(parameters),
          outputNodeIdsJson: JSON.stringify(outputNodeIds(parsed.template.workflow as Graph)),
          nodeCount: Object.keys(parsed.template.workflow).length,
          registrySha256: sha,
          modelsJson: JSON.stringify(parsed.template.models.map((m) => ({ folder: m.folder, file: m.file, sha256: m.sha256 ?? null }))),
          gpuJson: parsed.template.gpu ? JSON.stringify({ candidates: parsed.template.gpu.candidates, minVramGb: parsed.template.gpu.minVramGb ?? null, maxPricePerHr: parsed.template.gpu.maxPricePerHr ?? null }) : null,
        });
        if (!written) {
          invalid("this id belongs to a template imported by hand on this device");
          continue;
        }
        await recordEvent({ actor, action: existing ? "template_updated" : "template_installed", subject: templateId, details: { version, from: existing?.version ?? null, registrySha256: sha } });
      }
      if (existing) result.updated.push({ templateId, from: existing.version, to: version });
      else result.installed.push({ templateId, version });
    }

    // 3. Factory templates the (readable) index no longer lists.
    const listed = new Set(index.templates.map((t) => t.templateId));
    for (const row of rows) {
      if (row.source !== "factory" || listed.has(row.id)) continue;
      if (!dryRun) {
        await deps.store.templates.delete(row.id);
        await recordEvent({ actor, action: "template_removed", subject: row.id, details: { version: row.version } });
      }
      result.removed.push({ templateId: row.id, version: row.version });
    }
    // 4. FO-REQ-0005: a local template whose adoption target is now installed from the registry is removed.
    if (!dryRun) {
      const installed = await deps.store.templates.list();
      for (const adoption of await readAdoptions()) {
        const local = installed.find((r) => r.id === adoption.localTemplateId && (r.source ?? "owner") !== "factory");
        if (!local) await forgetAdoption(adoption.localTemplateId);
        else if (installed.some((r) => r.id === adoption.templateId && r.source === "factory")) await completeAdoption(local, adoption.templateId);
      }
    }
    // Remembered as the state AFTER this sync's own writes, so the next unchanged tick is skipped.
    return finish(dryRun ? "" : fingerprintOf(await deps.store.templates.list()));
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

  /**
   * `delivery` = the job's folder exists (a transfer created it): a failed job's manifest is then written AFTER the
   * transition, best effort -- the job is failed either way, and a missing manifest only means "not final" to a reader.
   */
  async function failJob(row: StoredJobRow, error: string, outputs?: MediaJobOutput[], delivery?: { outputDir: string; templateName: string | null }): Promise<void> {
    const finishedAt = deps.clock.now();
    const failed = await deps.store.jobs.transition(row.id, ["queued", "submitted", "generating", "transferring"], {
      status: "failed",
      error,
      finishedAt,
      ...(outputs ? { outputsJson: JSON.stringify(outputs) } : {}),
    });
    if (!failed || !delivery) return;
    try {
      await writeManifest(delivery.outputDir, buildJobManifest({ job: row, status: "failed", error, finishedAt, outputs: outputs ?? [], outputDir: delivery.outputDir, templateName: delivery.templateName, device: await deps.device() }));
    } catch (manifestError) {
      log(`[media] could not write the manifest of failed job ${row.id}: ${manifestError instanceof Error ? manifestError.message : String(manifestError)}`);
    }
  }

  async function writeManifest(outputDir: string, manifest: MediaJobManifest): Promise<void> {
    await deps.fs.writeFileAtomic(path.join(outputDir, MEDIA_JOB_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * Pulls one output: HEAD -> GET to a temp name + rename (inside the gateway) -> SHA-256 of the
   * stream compared with a second read-back of the file (AC-P14-12) -> ledger row -> DELETE remote
   * (AC-P14-13; a failed delete leaves `remoteDeletedAt` null for the janitor) -> asset entry.
   */
  async function pullOutput(job: StoredJobRow, output: MediaJobOutput, outputDir: string, s3: RunpodS3Client, provenance: Record<string, unknown>): Promise<MediaJobOutput> {
    const fileName = safeFileName(output.filename);
    if (!fileName) return { ...output, note: "unsafe file name; not pulled" };
    if (!safeRemoteKey(output.remoteKey) || !output.remoteKey.startsWith(`${EXCHANGE_PREFIX}${job.id}/`)) return { ...output, note: "output outside the job's folder; not pulled" };
    // The manifest's own name (and its `.part`) as the FIRST segment below the job's folder is reserved, as a file or as
    // a subfolder (case-insensitive: the macOS and Windows file systems are): a file would be overwritten by the
    // manifest (the remote copy is deleted after a pull), a directory would make every manifest write fail.
    const firstSegment = output.remoteKey.slice(`${EXCHANGE_PREFIX}${job.id}/`.length).split("/")[0].toLowerCase();
    if (firstSegment === MEDIA_JOB_MANIFEST_FILE || firstSegment === `${MEDIA_JOB_MANIFEST_FILE}.part`) {
      return { ...output, note: `reserved file name (${MEDIA_JOB_MANIFEST_FILE}); not pulled` };
    }
    const head = await s3.headObject(output.remoteKey);
    // The S3 view of the volume can lag behind ComfyUI's just-closed file (review round 10): "not there yet" and "not
    // all there yet" are THROWN so the transfer stays `transferring` and is retried within the window, never a verdict.
    // A 0-byte object is the same lag (the file is open, nothing flushed yet): never "complete" -- the empty stream would
    // hash equal to its empty read-back, be recorded, and the only copy DELETED (review round 12).
    if (!head || head.size === 0) throw new Error("output not visible on the volume yet");
    // The key's path BELOW exchange/<jobId>/ is kept locally (a Save node may nest its own subfolder): two outputs with
    // the same file name in different subfolders never overwrite each other (review round 16); `safeRemoteKey` already
    // refused `.`/`..` segments.
    const below = output.remoteKey.slice(`${EXCHANGE_PREFIX}${job.id}/`.length).split("/").slice(0, -1);
    const localPath = path.join(outputDir, ...below, fileName);
    if (below.length > 0) await deps.fs.mkdirp(path.dirname(localPath));
    const pulled = await s3.getObjectToFile(output.remoteKey, localPath);
    const readBack = await deps.fs.sha256File(localPath);
    if (readBack !== pulled.sha256 || pulled.bytes !== head.size || pulled.bytes === 0) {
      // Never leave a file that failed verification in the operator's folder looking like a result; the remote copy stays.
      await deps.fs.remove(localPath).catch((error) => log(`[media] could not remove unverified ${localPath}: ${error instanceof Error ? error.message : String(error)}`));
      throw new Error(`verification failed (stream ${pulled.sha256.slice(0, 8)}, file ${readBack.slice(0, 8)}, ${pulled.bytes}/${head.size} bytes); the file was removed`);
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
    const pulledOutput = { ...output, localPath, bytes: pulled.bytes, sha256: pulled.sha256, remoteDeleted };
    return catalogOutput(job, pulledOutput, fileName, provenance);
  }

  /**
   * The asset entry for a pulled file (AC-P14-15). The file is the only copy by now (pulled, remote
   * deleted): a catalog failure must not make it look "not pulled". Idempotent: an entry an earlier
   * attempt registered before dying is reused, never duplicated.
   */
  async function catalogOutput(job: StoredJobRow, output: MediaJobOutput & { localPath: string; bytes: number; sha256: string }, fileName: string, provenance: Record<string, unknown>): Promise<MediaJobOutput> {
    try {
      const existing = await deps.findAssetByLocalPath(job.channelId, output.localPath);
      const asset =
        existing ??
        (await deps.registerAsset({
          channelId: job.channelId,
          assetType: assetTypeFor(output.kind),
          referenceKind: "local_path",
          referenceValue: output.localPath,
          title: fileName,
          provenance: { ...provenance, comfyNodeId: output.nodeId, outputKind: output.kind, sha256: output.sha256, bytes: output.bytes },
        }));
      // A note from an earlier failed registration is resolved by this success; any other note stays.
      return { ...output, assetId: asset.assetId, note: output.note?.startsWith("pulled, but asset registration failed") ? null : output.note };
    } catch (error) {
      return { ...output, assetId: null, note: `pulled, but asset registration failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Takes a prompt off ComfyUI (best effort): interrupted if it is the one executing, removed if it is queued. The ONE
   * sequence a cancel, a withdrawn submit and every failure exit of the poll loop use (review round 17: a job failed by
   * its deadline or by a run of poll failures must not leave a zombie prompt on the GPU).
   */
  async function withdrawPrompt(comfy: ComfyUiClient, promptId: string): Promise<void> {
    try {
      const queue = await comfy.getQueue();
      if (queue.runningPromptIds.includes(promptId)) await comfy.interrupt();
      else if (queue.pendingPromptIds.includes(promptId)) await comfy.deleteQueued([promptId]);
    } catch (error) {
      log(`[media] could not withdraw prompt ${promptId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Jobs this process is polling right now (so a resume never starts a second loop for the same job). */
  const inFlight = new Set<string>();
  /**
   * A `transferring` job that could not be received is retried with exponential backoff (15 s → 10 min cap), not on
   * every watch tick for 24 h (review round 12). Per process: the web server is the only resumer.
   */
  const transferBackoff = new Map<string, { attempt: number; notBefore: number }>();
  function scheduleTransferRetry(jobId: string): void {
    const attempt = (transferBackoff.get(jobId)?.attempt ?? 0) + 1;
    const delay = Math.min(TRANSFER_BACKOFF_BASE_MS * 2 ** (attempt - 1), TRANSFER_BACKOFF_CAP_MS);
    transferBackoff.set(jobId, { attempt, notBefore: deps.clock.now().getTime() + delay });
  }

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

  /**
   * BL-144: ComfyUI's own execution events for a job, read from its websocket into the in-memory progress registry.
   * ComfyUI sends them only to sockets already connected with the prompt's client id, so the socket is opened BEFORE the
   * prompt is submitted (createJob) and kept for the whole generation; a job picked up later (restart, CLI) connects
   * late and relies on ComfyUI re-sending its current node. A dropped stream is reopened at most every
   * PROGRESS_RECONNECT_MS. All of it is independent of the /history polling, which alone decides the job's status: a
   * stream that cannot open or drops only makes the progress "unavailable" (§M).
   */
  const progressStreams = new Map<string, { stream: ProgressStream | null; lastAttemptAt: number }>();

  /** The job's graph, only when the template is still at the version the job was built from (else no node count). */
  async function graphFor(templateId: string, templateVersion: number): Promise<string | null> {
    try {
      const template = await deps.store.templates.get(templateId);
      return template && template.version === templateVersion ? template.workflowJson : null;
    } catch {
      return null;
    }
  }

  async function openProgress(jobId: string, comfy: ComfyUiClient, input: { promptId: string | null; workflowJson: string | null; waitForOpenMs?: number }): Promise<void> {
    const registry = deps.progress;
    if (!registry) return;
    const now = deps.clock.now();
    if (registry.has(jobId)) registry.reconnecting(jobId, now);
    else registry.begin(jobId, { promptId: input.promptId, workflowJson: input.workflowJson }, now);
    const entry: { stream: ProgressStream | null; lastAttemptAt: number } = { stream: null, lastAttemptAt: now.getTime() };
    progressStreams.set(jobId, entry);
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    try {
      entry.stream = await comfy.openProgressStream({
        clientId: `ytm-${jobId}`,
        onOpened: () => {
          registry.connected(jobId, deps.clock.now());
          settle();
        },
        onEvent: (event) => registry.apply(jobId, event, deps.clock.now()),
        onClosed: (reason) => {
          entry.stream = null;
          registry.unavailable(jobId, reason, deps.clock.now());
          settle();
        },
      });
    } catch (error) {
      registry.unavailable(jobId, error instanceof Error ? error.message : String(error), deps.clock.now());
      return;
    }
    if (input.waitForOpenMs) {
      // Before a submit: give the socket a moment to connect so ComfyUI's first events are not lost. Never blocks the
      // submit for longer than this.
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, input.waitForOpenMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    }
  }

  /** Called on every poll: opens the stream of a job picked up without one, or reopens a dropped one (throttled). */
  async function keepProgress(job: { id: string; promptId: string | null; templateId: string; templateVersion: number }, comfy: ComfyUiClient): Promise<void> {
    if (!deps.progress) return;
    const entry = progressStreams.get(job.id);
    if (entry && (entry.stream || deps.clock.now().getTime() - entry.lastAttemptAt < PROGRESS_RECONNECT_MS)) return;
    await openProgress(job.id, comfy, { promptId: job.promptId, workflowJson: entry ? null : await graphFor(job.templateId, job.templateVersion) });
  }

  function closeProgress(jobId: string): void {
    const entry = progressStreams.get(jobId);
    progressStreams.delete(jobId);
    entry?.stream?.close();
    deps.progress?.end(jobId);
  }

  async function processJobInner(jobId: string): Promise<void> {
    try {
      await pollJob(jobId);
    } finally {
      closeProgress(jobId);
    }
  }

  async function pollJob(jobId: string): Promise<void> {
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
    // Per job, from its submit -- not from this process's pickup, or every resume would grant a fresh 2 h (review round 16).
    const deadline = (job.submittedAt ?? deps.clock.now()).getTime() + maxGenerationMs;
    let outputs: MediaJobOutput[] = [];
    let emptyPolls = 0;
    // Just submitted = ComfyUI knows the prompt; re-confirmed through /queue on every Nth empty poll (review round 8).
    // While it is known, EVERY poll credits activity: with idleMinutes at its 1-minute minimum, a once-a-minute touch
    // would race the watcher mid-generation (review round 11).
    let promptKnown = true;
    for (;;) {
      const current = await deps.store.jobs.get(jobId);
      if (!current || (current.status !== "submitted" && current.status !== "generating")) return; // cancelled or swept meanwhile
      await keepProgress(current, comfy);
      let history;
      try {
        history = await comfy.getHistory(job.promptId);
        pollFailures = 0;
      } catch (error) {
        // One 502/timeout through RunPod's proxy is routine during a heavy generation: fail only after a run of them,
        // or once the session itself is gone. A JSON 4xx on /history can only come from an intermediary (ComfyUI itself
        // never answers 4xx there), so `comfyui_rejected` is definitive for POST /prompt only and is counted like any
        // other poll failure here (review round 15).
        pollFailures++;
        const stillRunning = await deps.sessions.getRunningSession(job.sessionId);
        if (!stillRunning || pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          await failJob(job, `ComfyUI unreachable (${pollFailures} consecutive polls): ${error instanceof Error ? error.message : String(error)}`);
          if (stillRunning) await withdrawPrompt(comfy, job.promptId);
          return;
        }
        await deps.sleep(pollMs);
        continue;
      }
      // "In progress" = no history entry yet, OR an entry without a verdict (a build that writes the entry at execution
      // start, no `status`, no outputs): both are polled the same way (review round 13) -- progressed to `generating`
      // and liveness-checked, never left to bill until the deadline.
      const inProgress = !history || history.status === "unknown";
      if (inProgress) {
        // Unless ComfyUI no longer knows the prompt at all (restarted, queue cleared): then nothing will ever arrive, and
        // touching the session's activity every poll would keep a dead job billing the GPU until the generation deadline
        // (review round 8). Activity is credited only while the prompt is confirmed queued/running (re-checked on every
        // Nth poll); a transient /queue failure is left to the /history counter.
        if (emptyPolls++ % QUEUE_CHECK_EVERY_POLLS === 0) {
          try {
            const queue = await comfy.getQueue();
            promptKnown = queue.runningPromptIds.includes(job.promptId) || queue.pendingPromptIds.includes(job.promptId);
          } catch {
            promptKnown = true;
          }
          if (!promptKnown) {
            // It may have finished between the two reads: one more look at history before giving up.
            const finished = await comfy.getHistory(job.promptId).catch(() => null);
            if (finished && finished.status !== "unknown") continue;
            await failJob(
              job,
              finished
                ? "ComfyUI finished the prompt without a status or outputs (not queued, not running, nothing saved)"
                : "ComfyUI no longer lists the prompt as queued or running and it is not in history (ComfyUI restarted or its queue was cleared)"
            );
            return;
          }
        }
        if (promptKnown) await deps.sessions.touchActivity(job.sessionId);
        if (current.status === "submitted") await deps.store.jobs.transition(jobId, ["submitted"], { status: "generating" });
      } else {
        await deps.sessions.touchActivity(job.sessionId);
      }
      if (history && !inProgress) {
        if (history.status === "error") {
          await failJob(job, `ComfyUI execution error: ${history.statusMessages.filter((m) => m.includes("error")).join(", ") || "unknown"}`);
          return;
        }
        if (history.status === "completed") {
          // Only saved files (`type: "output"`) are results; a PreviewImage's `temp` files live in ComfyUI's temp dir,
          // not under exchange/<jobId>/, so they are neither pullable nor a reason to call the job partial.
          const saved = history.outputs.filter((o) => o.type === "output");
          if (saved.length === 0) {
            await failJob(job, `the prompt completed without any saved output (${history.outputs.length} preview/temp file(s) only; the workflow needs a Save node)`);
            return;
          }
          outputs = saved.map((o) => ({
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
      }
      if (deps.clock.now().getTime() >= deadline) {
        await failJob(job, `no result after ${Math.round(maxGenerationMs / 60_000)} min`);
        await withdrawPrompt(comfy, job.promptId); // never a zombie prompt billing the GPU behind the next job
        return;
      }
      await deps.sleep(pollMs);
    }

    const transferring = await deps.store.jobs.transition(jobId, ["submitted", "generating"], { status: "transferring", outputsJson: JSON.stringify(outputs) });
    if (!transferring) return;
    await transferOutputs(job, outputs);
  }

  /**
   * The ONE retry-window rule for a transfer that could not complete this time (review round 16): within the window
   * the job stays `transferring` (outputs recorded as `forRetry`, next attempt after the backoff); past it the job
   * FAILS with what was received recorded -- never a `done` quietly missing an output.
   */
  async function retryOrFail(job: StoredJobRow, message: string, forRetry: MediaJobOutput[], results: MediaJobOutput[], delivery?: { outputDir: string; templateName: string | null }): Promise<void> {
    const since = (job.submittedAt ?? job.createdAt).getTime();
    if (deps.clock.now().getTime() - since <= TRANSFER_RETRY_WINDOW_MS) {
      scheduleTransferRetry(job.id);
      await deps.store.jobs.transition(job.id, ["transferring"], { status: "transferring", outputsJson: JSON.stringify(forRetry), error: `${message}; retrying` });
      return;
    }
    transferBackoff.delete(job.id);
    const notes = results.filter((r) => r.note).map((r) => `${r.filename}: ${r.note}`);
    await failJob(job, `not every output could be received within ${Math.round(TRANSFER_RETRY_WINDOW_MS / 3_600_000)} h (${message}${notes.length ? `; ${notes.join("; ")}` : ""})`, results, delivery);
  }

  /**
   * Pulls every recorded output (re-entrant: an output already pulled by an earlier attempt is
   * recognised by its ledger row and never re-downloaded or re-registered).
   */
  async function transferOutputs(job: StoredJobRow, outputs: MediaJobOutput[]): Promise<void> {
    const jobId = job.id;
    const session = await deps.sessions.getRunningSession(job.sessionId);
    let outputDir: string | null = null;
    let s3: RunpodS3Client;
    const template = await deps.store.templates.get(job.templateId);
    try {
      const dir = path.join(await deps.resolveOutputRoot(job.channelId), MEDIA_OUTPUT_SUBDIR, job.id);
      await deps.fs.mkdirp(dir);
      outputDir = dir;
      s3 = await deps.s3();
    } catch (error) {
      // A transient cause (workspace drive unmounted, gateway toggle off, S3 unreachable): keep `transferring` so the
      // watch loop retries, up to the retry window; the recorded outputs stay on the volume meanwhile. Once the folder
      // exists (an earlier attempt may have delivered into it), a failure past the window still gets its manifest.
      await retryOrFail(job, `cannot receive outputs: ${error instanceof Error ? error.message : String(error)}`, outputs, outputs, outputDir ? { outputDir, templateName: template?.name ?? null } : undefined);
      return;
    }
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
    /** What the row keeps for a retry: pulled outputs as pulled, a transiently failed one with its note cleared. */
    const forRetry: MediaJobOutput[] = [];
    let transientFailure: string | null = null;
    for (const output of outputs) {
      if (output.localPath) {
        // Already pulled by an earlier attempt; its catalog entry may still be missing (registration failed then) --
        // catalogOutput is idempotent, so that step alone is redone (review round 9).
        const settled =
          output.assetId || output.bytes === null || output.sha256 === null
            ? output
            : await catalogOutput(job, { ...output, localPath: output.localPath, bytes: output.bytes, sha256: output.sha256 }, path.basename(output.localPath), provenance);
        results.push(settled);
        forRetry.push(settled);
        continue;
      }
      const ledger = await deps.store.ledger.get(output.remoteKey);
      if (ledger) {
        // Pulled by an earlier attempt that died before the job row recorded it: the file is local (ledger), so only
        // the catalog step is (re)done -- reusing the entry if that attempt got that far (review round 6).
        const earlier = { ...output, localPath: ledger.localPath, bytes: ledger.bytes, sha256: ledger.sha256, remoteDeleted: ledger.remoteDeletedAt !== null, note: output.note ?? "pulled by an earlier attempt" };
        const cataloged = await catalogOutput(job, earlier, path.basename(ledger.localPath), provenance);
        results.push(cataloged);
        forRetry.push(cataloged);
        continue;
      }
      try {
        const pulled = await pullOutput(job, output, outputDir, s3, provenance);
        results.push(pulled);
        forRetry.push(pulled);
      } catch (error) {
        // A THROW here is "could not receive it THIS time" (S3 503, a read error, an object not yet visible or not yet
        // fully flushed, bytes that failed verification -- the S3 view can lag, review round 10): the job keeps
        // `transferring` and the watch loop retries with backoff within the window, after which it FAILS with these notes.
        // A verdict about the output itself ("outside the job's folder", "unsafe file name") is a note, never a throw.
        transientFailure = error instanceof Error ? error.message : String(error);
        results.push({ ...output, note: `pull failed: ${transientFailure}` });
        forRetry.push({ ...output, note: null });
      }
    }
    const delivery = { outputDir, templateName: template?.name ?? null };
    if (transientFailure) {
      await retryOrFail(job, `pull failed: ${transientFailure}`, forRetry, results, delivery);
      return;
    }
    transferBackoff.delete(jobId);
    const pulled = results.filter((r) => r.localPath);
    // `error` on a done job = notes of outputs that were NOT received; an informational note on a received output
    // ("pulled by an earlier attempt") stays on the output only (review round 19).
    const notes = results.filter((r) => r.note && !r.localPath).map((r) => `${r.filename}: ${r.note}`);
    if (pulled.length === 0) {
      await failJob(job, results.length === 0 ? "nothing was produced" : `no output could be pulled (${notes.join("; ")})`, results, delivery);
      return;
    }
    const error = notes.length > 0 ? notes.join("; ") : null;
    const finishedAt = deps.clock.now();
    // FO-REQ-0002: the manifest is written after every output has its final name and BEFORE `done`, so `done` always
    // means "manifest on disk". A write that fails (the drive went away) is a transient cause like any other here.
    try {
      await writeManifest(outputDir, buildJobManifest({ job, status: "done", error, finishedAt, outputs: results, outputDir, templateName: delivery.templateName, device: await deps.device() }));
    } catch (manifestError) {
      await retryOrFail(job, `cannot write ${MEDIA_JOB_MANIFEST_FILE}: ${manifestError instanceof Error ? manifestError.message : String(manifestError)}`, forRetry, results, delivery);
      return;
    }
    const done = await deps.store.jobs.transition(jobId, ["transferring"], {
      status: "done",
      outputsJson: JSON.stringify(results),
      assetIdsJson: JSON.stringify(pulled.map((r) => r.assetId).filter(Boolean)),
      error,
      finishedAt,
    });
    // Within this process `inFlight` makes this unreachable (nothing else moves a `transferring` row); only another
    // process could, and the manifest would then say `done` for a row that is not. Logged, never silent.
    if (!done) log(`[media] job ${jobId} left \`transferring\` before it could be marked done; its manifest says done`);
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
        outputNodeIdsJson: JSON.stringify(outputNodeIds(parsed.workflow as Graph)),
        nodeCount: Object.keys(parsed.workflow).length,
        modelsJson: JSON.stringify(localTemplateModels(parsed.workflow as Graph, parameters)),
      });
      return toPublicTemplate(row);
    },

    async updateWorkflowTemplate(input: unknown): Promise<MediaWorkflowTemplate> {
      const parsed = parseWithSchema(updateTemplateInputSchema, input, "workflow template update");
      const existing = await requireTemplate(parsed.templateId);
      if (existing.source === "factory") throw factoryManaged(parsed.templateId);
      const graph = (parsed.workflow ?? JSON.parse(existing.workflowJson)) as Graph;
      const parameters = parsed.parameters ? parsed.parameters.map(normalizeParameter) : (JSON.parse(existing.parametersJson) as MediaTemplateParameter[]);
      validateTemplateShape(parseWithSchema(workflowGraphSchema, graph, "workflow") as Graph, parameters);
      // Only a changed graph/parameters is a new version (what job provenance records); a rename keeps the version.
      const contentChanged = parsed.workflow !== undefined || parsed.parameters !== undefined;
      const row = await deps.store.templates.update(parsed.templateId, {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description ?? null } : {}),
        ...(contentChanged
          ? {
              workflowJson: JSON.stringify(graph),
              parametersJson: JSON.stringify(parameters),
              outputNodeIdsJson: JSON.stringify(outputNodeIds(graph)),
              nodeCount: Object.keys(graph).length,
              modelsJson: JSON.stringify(localTemplateModels(graph, parameters)),
            }
          : {}),
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

    /**
     * A local template only (registry ones are removed via the index). FO-REQ-0005 item 2: the factory may delete one
     * too (agreed with the owner beforehand, no second approval); either way it is recorded with who did it.
     */
    async deleteWorkflowTemplate(input: unknown, options: { actor?: TemplateActor } = {}): Promise<{ deleted: boolean }> {
      const { templateId } = parseWithSchema(templateIdInputSchema, input, "template id");
      const actor = options.actor ?? "owner";
      const existing = await deps.store.templates.get(templateId);
      if (existing?.source === "factory") throw factoryManaged(templateId);
      if (!existing && actor === "factory") throw new DomainError({ code: "media_template_not_found", message: "No workflow template with this id", details: { templateId } });
      const deleted = await deps.store.templates.delete(templateId);
      if (deleted && existing) {
        await recordEvent({ actor, action: "template_deleted", subject: templateId, details: { name: existing.name, version: existing.version, source: "owner" } });
        await forgetAdoption(templateId);
      }
      return { deleted };
    },

    /**
     * FO-REQ-0005 item 2: the factory takes a local template over into the registry. Nothing is written to the registry
     * here: the complete registry file (version 1, models declared from the graph) is returned for the factory to write.
     * The local copy is removed only once a sync has installed `newTemplateId` -- or at once when it already is.
     */
    async adoptWorkflowTemplate(input: unknown): Promise<MediaTemplateAdoption> {
      const run = registrySyncChain.then(() => adoptTemplate(input));
      registrySyncChain = run.catch(() => undefined);
      return run;
    },

    /**
     * BL-132 (plan §2.3): brings this device's `factory` templates in line with the registry folder. Every rule that can
     * lose a template fails safe: an unreadable index changes nothing; a file not arrived yet, an invalid file, a LOWER
     * version or the same version with other content keeps what is installed; only an id no longer in a readable index is
     * removed. Owner-imported (local) templates are never touched. `onlyIfChanged` is the 60 s check: it skips the sync
     * when the registry's files read exactly as at the last sync.
     */
    async syncTemplatesFromRegistry(input: { trigger: MediaTemplateSyncTrigger; dryRun?: boolean; onlyIfChanged?: boolean }): Promise<MediaTemplateSyncResult | null> {
      const run = registrySyncChain.then(() => runRegistrySync(input));
      registrySyncChain = run.catch(() => undefined);
      return run;
    },

    /**
     * BL-132 (plan §2.2, owner addition A1): every template that uses a model file -- this device's installed templates
     * (factory and local) plus every template the registry currently lists (identical on every device, so a model a
     * template on ANOTHER device needs is protected too). Read-only: no sync, no write.
     */
    async modelUsage(): Promise<MediaModelUsage> {
      const users: MediaModelUsage["users"] = [];
      const add = (templateId: string, version: number, source: MediaModelUsage["users"][number]["source"], models: Array<{ folder: string | null; file: string }>) => {
        for (const m of models) {
          if (!m.folder) continue;
          const key = `models/${m.folder}/${m.file}`;
          if (!users.some((u) => u.key === key && u.templateId === templateId && u.version === version)) users.push({ key, templateId, version, source });
        }
      };
      for (const row of await deps.store.templates.list()) add(row.id, row.version, row.source ?? "owner", templateModels(row));
      let registry: MediaModelUsage["registry"] = "ok";
      let registryError: string | null = null;
      try {
        if (!deps.registry) throw new DomainError({ code: "media_template_registry_unavailable", message: "No template registry is wired on this device." });
        const snapshot = await deps.registry.read();
        // Every listed template must be readable: one that is not there yet (a file sync still copying), unreadable or
        // invalid declares models nobody can know, so the registry counts as unavailable -- the factory deletion is then
        // refused (fail closed, independent review).
        const unknown: string[] = [];
        for (const entry of parseRegistryIndex(snapshot.indexText).templates) {
          const text = await snapshot.readTemplateFile(registryTemplateFileName(entry.templateId, entry.version)).catch(() => null);
          const parsed = text === null ? null : parseRegistryTemplate(text, entry);
          if (parsed?.ok) add(entry.templateId, entry.version, "registry", parsed.template.models);
          else unknown.push(`${entry.templateId} v${entry.version}`);
        }
        if (unknown.length > 0) throw new Error(`listed templates that cannot be read: ${unknown.join(", ")}`);
      } catch (error) {
        registry = "unavailable";
        registryError = error instanceof Error ? error.message : String(error);
      }
      return { registry, registryError, users };
    },

    /** The last (non-dry-run) sync result, or null if none ran on this device. */
    async getLastTemplateSync(): Promise<MediaTemplateSyncResult | null> {
      const json = deps.syncState ? await deps.syncState.get() : null;
      return json ? (JSON.parse(json) as MediaTemplateSyncResult) : null;
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
      // The outputs can only land in the channel's workspace folder, and only travel over the S3 API: without either,
      // nothing is submitted (and no GPU minute spent) -- `media_workspace_unavailable` / `media_generation_not_configured`
      // at submit time, as the agent contract promises.
      await deps.resolveOutputRoot(parsed.channelId);
      const s3 = await deps.s3();
      // BL-132 (plan §2.4, AC-FM-11): every input file is found and checked BEFORE anything is written or uploaded.
      const inputs: Array<{ parameter: MediaTemplateParameter; relativePath: string; maxBytes: number; file: { path: string; bytes: number; identity?: { dev: number; ino: number } } }> = [];
      for (const p of parameters.filter((q) => isInputParameterType(q.type) && typeof values[q.name] === "string")) {
        const relativePath = values[p.name] as string;
        if (!deps.resolveInputFile || !deps.store.inputs) throw new DomainError({ code: "media_input_unavailable", message: "Job input files are not available on this server.", details: { parameter: p.name } });
        const file = await deps.resolveInputFile(parsed.channelId, relativePath);
        const limit = Math.min(p.maxBytes ?? MEDIA_INPUT_MAX_BYTES, MEDIA_INPUT_MAX_BYTES);
        if (file.bytes === 0 || file.bytes > limit) {
          throw new DomainError({ code: "media_input_unavailable", message: `"${p.name}": ${relativePath} is ${file.bytes} bytes; an input must be 1 byte to ${limit} bytes.`, details: { parameter: p.name, bytes: file.bytes, maxBytes: limit } });
        }
        inputs.push({ parameter: p, relativePath, maxBytes: limit, file });
      }
      const jobId = deps.generateId();
      // Each input goes to the ROOT of ComfyUI's input folder under a job-unique flat name (`<jobId>-<param>-<name>`), and
      // the targeted loader input is given that name; the job's params keep the path the caller gave.
      const uploads = inputs.map((input) => {
        const name = `${jobId}-${input.parameter.name}-${safeInputName(path.basename(input.relativePath))}`;
        return { ...input, name, remoteKey: `${EXCHANGE_INPUT_PREFIX}${name}` };
      });
      const promptValues = { ...values, ...Object.fromEntries(uploads.map((u) => [u.parameter.name, u.name])) };
      const prompt = buildPrompt(JSON.parse(template.workflowJson) as Graph, parameters, promptValues, jobId);
      // BL-132: the inputs are uploaded BEFORE the job row exists (independent review): a long upload (up to 500 MB each)
      // can then never be failed as "never submitted" by the resume pass's queued-row grace period, and nothing reaches
      // ComfyUI unless every input is on the volume. Each upload counts as session activity (the idle timeout must not stop
      // the pod mid-upload). On any failure the inputs already uploaded are deleted again and no job exists.
      const uploaded: string[] = [];
      // A heartbeat while uploading (BL-135 review): one 500 MB upload can outlast both the idle timeout and a
      // release-when-done session's one-minute grace; the session must not be stopped under a job being created.
      const heartbeat = uploads.length > 0 ? setInterval(() => void deps.sessions.touchActivity(parsed.sessionId).catch(() => undefined), UPLOAD_HEARTBEAT_MS) : null;
      try {
        for (const upload of uploads) {
          try {
            await deps.sessions.touchActivity(parsed.sessionId);
            const sent = await s3.putObjectFromFile(upload.remoteKey, upload.file.path, inputContentType(upload.name), { maxBytes: upload.maxBytes, expectedIdentity: upload.file.identity });
            uploaded.push(upload.remoteKey);
            await deps.store.inputs!.insert({ remoteKey: upload.remoteKey, jobId, parameter: upload.parameter.name, sourcePath: upload.relativePath, bytes: sent.bytes, sha256: sent.sha256, uploadedAt: deps.clock.now() });
          } catch (error) {
            for (const key of uploaded) {
              await s3.deleteObject(key).catch((cleanupError) => log(`[media] could not delete the uploaded input ${key}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
              await deps.store.inputs?.markRemoteDeleted(key, deps.clock.now()).catch(() => undefined);
            }
            const message = `input "${upload.parameter.name}" (${upload.relativePath}) could not be uploaded: ${error instanceof Error ? error.message : String(error)}`;
            throw new DomainError({ code: "media_input_unavailable", message, details: { parameter: upload.parameter.name } });
          }
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      if (uploads.length > 0) await deps.sessions.touchActivity(parsed.sessionId);
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
      // BL-144: the progress socket is connected first, so ComfyUI's first execution events reach it.
      await openProgress(jobId, comfy, { promptId: null, workflowJson: template.workflowJson, waitForOpenMs: PROGRESS_OPEN_WAIT_MS });
      let submitted: { promptId: string };
      try {
        submitted = await comfy.submitPrompt({ prompt, clientId: `ytm-${jobId}` });
      } catch (error) {
        if (error instanceof DomainError && error.code === "comfyui_rejected") {
          closeProgress(jobId);
          await failJob(row, `ComfyUI rejected the prompt: ${describeComfyRejection(error)}`);
          throw error;
        }
        // A lost RESPONSE is not a rejection: ComfyUI may have accepted the prompt (proxy 502, 30 s timeout) and be
        // executing it. The queue says -- every submit carries client_id `ytm-<jobId>` (review round 17).
        const adopted = await comfy
          .getQueue()
          .then((queue) => queue.entries.find((e) => e.clientId === `ytm-${jobId}`) ?? null)
          .catch(() => null);
        if (!adopted) {
          closeProgress(jobId);
          await failJob(row, `the prompt could not be submitted (ComfyUI unreachable: ${error instanceof Error ? error.message : String(error)}); it is not in ComfyUI's queue`);
          throw error;
        }
        log(`[media] submit response lost for job ${jobId}, but ComfyUI queued it as ${adopted.promptId}; adopting`);
        submitted = { promptId: adopted.promptId };
      }
      deps.progress?.setPrompt(jobId, submitted.promptId);
      await deps.sessions.touchActivity(parsed.sessionId);
      const updated = await deps.store.jobs.transition(jobId, ["queued"], { status: "submitted", promptId: submitted.promptId, submittedAt: deps.clock.now() });
      if (!updated) {
        closeProgress(jobId);
        // Cancelled or swept while the submit was in flight: the prompt must not run unowned.
        await withdrawPrompt(comfy, submitted.promptId);
        const current = await requireJob(jobId);
        throw new DomainError({ code: "media_job_invalid_state", message: `Job was ${current.status} before the submit completed; the prompt was withdrawn`, details: { jobId, status: current.status } });
      }
      deps.schedule(() => processJob(jobId));
      return withInputs(toPublicJob(updated));
    },

    processJob,

    async getJob(input: unknown): Promise<MediaJob> {
      const { jobId } = parseWithSchema(jobIdInputSchema, input, "job id");
      return withInputs(toPublicJob(await requireJob(jobId)));
    },

    async listJobs(input: unknown = {}): Promise<MediaJob[]> {
      const filter = parseWithSchema(listJobsInputSchema, input, "list jobs");
      return Promise.all((await deps.store.jobs.list(filter)).map((row) => withInputs(toPublicJob(row))));
    },

    /** queued/submitted/generating -> cancelled; ComfyUI's current execution is interrupted (best effort). */
    async cancelJob(input: unknown): Promise<MediaJob> {
      const { jobId } = parseWithSchema(jobIdInputSchema, input, "job id");
      const row = await requireJob(jobId);
      const cancelled = await deps.store.jobs.transition(jobId, ["queued", "submitted", "generating"], { status: "cancelled", finishedAt: deps.clock.now(), error: null });
      if (!cancelled) throw new DomainError({ code: "media_job_invalid_state", message: `Job is ${row.status}; only a queued or generating job can be cancelled`, details: { jobId, status: row.status } });
      if (row.promptId) {
        try {
          const comfy = await deps.sessions.comfyClientForSession(row.sessionId);
          await withdrawPrompt(comfy, row.promptId);
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
          // Never submitted. `createJob` is between its insert and its `submitted` write for a few seconds at most
          // (a submit through the proxy), so only a row older than the grace period is a real leftover.
          if (deps.clock.now().getTime() - row.createdAt.getTime() > SUBMIT_GRACE_MS) await failJob(row, "never submitted to ComfyUI");
          continue;
        }
        // A transfer needs only S3 (the pod may be gone already); a poll needs the session's ComfyUI -- without it
        // the job can never finish, so it fails now instead of lingering as "in flight" forever.
        if (row.status !== "transferring" && !(await deps.sessions.getRunningSession(row.sessionId))) {
          await failJob(row, "the session is no longer running");
          continue;
        }
        const backoff = transferBackoff.get(row.id);
        if (row.status === "transferring" && backoff && backoff.notBefore > deps.clock.now().getTime()) continue; // not yet
        // The scheduled poll's first activity touch lands asynchronously; the watcher's idle check runs right after this
        // pass in the same tick (review round 15) -- so a job being picked up counts as activity NOW.
        if (row.status !== "transferring") await deps.sessions.touchActivity(row.sessionId);
        resumed.push(row.id);
        deps.schedule(() => processJob(row.id));
      }
      return { resumed };
    },

    /** For the idle auto-shutdown: a job in flight is work even when no HTTP request is (an MCP-driven session). */
    async hasInFlightJobs(): Promise<boolean> {
      // A `transferring` job sleeping in its backoff is not work the idle shutdown should wait for (review round 17): only
      // a job being polled, or one whose next transfer attempt is due, counts.
      const now = deps.clock.now().getTime();
      return (await deps.store.jobs.listNonTerminal()).some((row) => {
        if (row.status !== "transferring") return true;
        const backoff = transferBackoff.get(row.id);
        return !backoff || backoff.notBefore <= now;
      });
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
     * when its job is terminal AND its ledger row says the file is local (BY LEDGER ONLY, review round
     * 5). A failed/cancelled job's leftovers are kept -- they may be a finished generation nobody
     * received, the only copy -- for the operator (`scripts/media/s3.sh rm`). Keys of unknown jobs
     * (another device's) are left alone.
     */
    async cleanupExchange(options: { dryRun?: boolean } = {}): Promise<{ dryRun: boolean; scanned: number; deleted: string[]; wouldDelete: string[]; kept: Array<{ key: string; reason: string }> }> {
      const dryRun = options.dryRun ?? true;
      const s3 = await deps.s3();
      const objects = await s3.listAllObjects(EXCHANGE_PREFIX);
      // `deleted` lists only what was REALLY deleted; a dry run reports its candidates as `wouldDelete` (review round 20).
      const deleted: string[] = [];
      const wouldDelete: string[] = [];
      const kept: Array<{ key: string; reason: string }> = [];
      const jobCache = new Map<string, StoredJobRow | null>();
      for (const object of objects) {
        const key = object.key;
        if (!key.startsWith(EXCHANGE_PREFIX)) {
          kept.push({ key, reason: "outside exchange/" });
          continue;
        }
        if (key.startsWith(EXCHANGE_INPUT_PREFIX)) {
          // BL-132: a job's uploaded input is deleted once its job is terminal -- BY LEDGER ONLY; anything else under
          // exchange/in/ (the operator's own reference files) is never touched.
          const input = deps.store.inputs ? await deps.store.inputs.get(key) : null;
          if (!input) {
            kept.push({ key, reason: "reference input" });
            continue;
          }
          if (!jobCache.has(input.jobId)) jobCache.set(input.jobId, await deps.store.jobs.get(input.jobId));
          const owner = jobCache.get(input.jobId) ?? null;
          if (owner && !MEDIA_JOB_TERMINAL_STATUSES.includes(owner.status)) {
            kept.push({ key, reason: `input of a ${owner.status} job` });
            continue;
          }
          // No job row: a createJob still uploading (the row is written after the uploads) -- or one that died. Only an
          // hour-old one is a leftover.
          if (!owner && deps.clock.now().getTime() - input.uploadedAt.getTime() < 60 * 60_000) {
            kept.push({ key, reason: "input of a job still being created" });
            continue;
          }
          if (dryRun) {
            wouldDelete.push(key);
            continue;
          }
          await s3.deleteObject(key);
          await deps.store.inputs!.markRemoteDeleted(key, deps.clock.now());
          deleted.push(key);
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
        // BY LEDGER ONLY (ADR 0019's rule): a key is deleted only when its row says the file is local. A failed or
        // cancelled job's leftovers may be a finished generation nobody recorded (restart mid-generation) -- the only
        // copy -- so they stay until pulled by hand (`scripts/media/s3.sh`), never auto-deleted.
        if (!ledger) {
          kept.push({ key, reason: `${job.status} job, not in the ledger` });
          continue;
        }
        if (dryRun) {
          wouldDelete.push(key);
          continue;
        }
        await s3.deleteObject(key);
        await deps.store.ledger.markRemoteDeleted(key, deps.clock.now());
        deleted.push(key);
      }
      return { dryRun, scanned: objects.length, deleted, wouldDelete, kept };
    },
  };
}

export type MediaJobServices = ReturnType<typeof createMediaJobServices>;
