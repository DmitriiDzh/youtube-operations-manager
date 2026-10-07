import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, MEDIA_MODEL_FOLDERS, type MediaModelReference, type MediaTemplateParameter } from "./contracts";
import { gpuPlanSchema, templateParameterSchema, workflowGraphSchema } from "./schemas";

// ---------------------------------------------------------------------------
// BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.3) -- the factory template registry's FILE FORMAT and
// the pure checks on it. No I/O here: the folder is read by `adapters/template-registry-fs.ts`, the rows are written by
// the job services' sync. The registry is a folder (logical path `media_templates`, inside `factory_shared`) holding
//   index.json                       { schema: "ytm.media-template-index", schemaVersion: 1, templates: [{ templateId, version }] }
//   <templateId>.v<version>.json     { schema: "ytm.media-template", schemaVersion: 1, templateId, version, name,
//                                      description, workflow, parameters, models: [{ folder, file, sha256 }] }
// ---------------------------------------------------------------------------

export const TEMPLATE_INDEX_FILE = "index.json";
export const REGISTRY_TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const REGISTRY_TEMPLATE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}\.v[1-9][0-9]{0,8}\.json$/;
/** A registry file larger than this is not read (a graph of 2000 nodes is far below it). */
export const REGISTRY_FILE_MAX_BYTES = 5 * 1024 * 1024;

export function registryTemplateFileName(templateId: string, version: number): string {
  return `${templateId}.v${version}.json`;
}

const templateIdSchema = z.string().regex(REGISTRY_TEMPLATE_ID_PATTERN, "a template id is 2-63 lower-case letters, digits or '-'");
const versionSchema = z.number().int().min(1).max(999_999_999);

const indexSchema = z
  .object({
    schema: z.literal("ytm.media-template-index"),
    schemaVersion: z.literal(1),
    templates: z.array(z.object({ templateId: templateIdSchema, version: versionSchema }).strict()).max(500),
  })
  .strict()
  .refine((index) => new Set(index.templates.map((t) => t.templateId)).size === index.templates.length, "each templateId appears once");

const modelFileSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !v.startsWith("/") && !v.includes("\\") && !v.split("/").some((s) => s === "" || s === "." || s === ".."), "a path relative to the model folder");

const modelRefSchema = z
  .object({
    folder: z.enum(MEDIA_MODEL_FOLDERS),
    file: modelFileSchema,
    sha256: z.string().toLowerCase().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  })
  .strict();

const templateFileSchema = z
  .object({
    schema: z.literal("ytm.media-template"),
    schemaVersion: z.literal(1),
    templateId: templateIdSchema,
    version: versionSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    workflow: workflowGraphSchema,
    parameters: z.array(templateParameterSchema).max(100),
    models: z.array(modelRefSchema).max(100),
    /** BL-133 (optional): the GPUs this template should run on, tried in order by a factory start that names it. */
    gpu: gpuPlanSchema.optional(),
  })
  .strict();

/**
 * FO-REQ-0005 item 2: the factory takes a LOCAL template over into the registry under `newTemplateId` (version 1). The
 * local copy stays until a sync has installed `newTemplateId` from the registry, then it is removed.
 */
export const adoptTemplateInputSchema = z.object({ templateId: z.string().min(1).max(64), newTemplateId: templateIdSchema }).strict();

/** A pending adoption (`media_template_adoptions` app setting): this local template becomes registry template `templateId`. */
export type TemplateAdoption = { localTemplateId: string; templateId: string; requestedAt: string };

export function parseTemplateAdoptions(json: string | null): TemplateAdoption[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is TemplateAdoption =>
        typeof a === "object" && a !== null && typeof (a as TemplateAdoption).localTemplateId === "string" && typeof (a as TemplateAdoption).templateId === "string" && typeof (a as TemplateAdoption).requestedAt === "string"
    );
  } catch {
    return [];
  }
}

export type RegistryIndex = { templates: Array<{ templateId: string; version: number }> };
export type RegistryTemplate = z.infer<typeof templateFileSchema>;

/** The index, or `media_template_registry_unavailable`: a sync then changes NOTHING (an unreadable index never deletes). */
export function parseRegistryIndex(text: string): RegistryIndex {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // The parser's own message quotes the file; only a generic reason leaves this module (independent review).
    void error;
    throw new DomainError({ code: "media_template_registry_unavailable", message: `${TEMPLATE_INDEX_FILE} is not valid JSON` });
  }
  const parsed = indexSchema.safeParse(json);
  if (!parsed.success) {
    throw new DomainError({
      code: "media_template_registry_unavailable",
      message: `${TEMPLATE_INDEX_FILE} does not match ytm.media-template-index v1: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    });
  }
  return { templates: parsed.data.templates };
}

/** One template file against the index entry it was listed under. A problem is a reason string (the template is `invalid`). */
export function parseRegistryTemplate(text: string, expected: { templateId: string; version: number }): { ok: true; template: RegistryTemplate } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    void error;
    return { ok: false, reason: "not valid JSON" };
  }
  const parsed = templateFileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `does not match ytm.media-template v1: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  if (parsed.data.templateId !== expected.templateId || parsed.data.version !== expected.version) {
    return { ok: false, reason: `the file says ${parsed.data.templateId} v${parsed.data.version}, the index lists ${expected.templateId} v${expected.version}` };
  }
  return { ok: true, template: parsed.data };
}

/** SHA-256 of a registry file's exact text: same version + different hash = refused (the factory must bump the version). */
export function registryContentSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The ComfyUI core loader nodes and the input that names a model file, with the folder it is resolved in. Only these are
 * checked (plan §2.3): a custom loader (GGUF etc.) is not, and for such a template the declared `models` list is the
 * factory's responsibility.
 */
export const MODEL_LOADER_INPUTS: Readonly<Record<string, ReadonlyArray<{ input: string; folder: (typeof MEDIA_MODEL_FOLDERS)[number] }>>> = {
  CheckpointLoaderSimple: [{ input: "ckpt_name", folder: "checkpoints" }],
  CheckpointLoader: [{ input: "ckpt_name", folder: "checkpoints" }],
  ImageOnlyCheckpointLoader: [{ input: "ckpt_name", folder: "checkpoints" }],
  UNETLoader: [{ input: "unet_name", folder: "diffusion_models" }],
  VAELoader: [{ input: "vae_name", folder: "vae" }],
  CLIPLoader: [{ input: "clip_name", folder: "text_encoders" }],
  DualCLIPLoader: [
    { input: "clip_name1", folder: "text_encoders" },
    { input: "clip_name2", folder: "text_encoders" },
  ],
  TripleCLIPLoader: [
    { input: "clip_name1", folder: "text_encoders" },
    { input: "clip_name2", folder: "text_encoders" },
    { input: "clip_name3", folder: "text_encoders" },
  ],
  QuadrupleCLIPLoader: [
    { input: "clip_name1", folder: "text_encoders" },
    { input: "clip_name2", folder: "text_encoders" },
    { input: "clip_name3", folder: "text_encoders" },
    { input: "clip_name4", folder: "text_encoders" },
  ],
  LoraLoader: [{ input: "lora_name", folder: "loras" }],
  LoraLoaderModelOnly: [{ input: "lora_name", folder: "loras" }],
  CLIPVisionLoader: [{ input: "clip_name", folder: "clip_vision" }],
  UpscaleModelLoader: [{ input: "model_name", folder: "upscale_models" }],
  ControlNetLoader: [{ input: "control_net_name", folder: "controlnet" }],
  DiffControlNetLoader: [{ input: "control_net_name", folder: "controlnet" }],
  AudioEncoderLoader: [{ input: "audio_encoder_name", folder: "audio_encoders" }],
};

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** ComfyUI accepts `\` in model names on Windows; the volume always has `/`. */
function normalizeModelName(name: string): string {
  return name.replace(/\\/g, "/");
}

/** Every model a graph's known loader nodes name as a literal, plus every value a parameter on such an input may take. */
export function graphModelReferences(workflow: Graph, parameters: MediaTemplateParameter[] = []): Array<{ nodeId: string; input: string; folder: MediaModelReference["folder"]; file: string; via: "literal" | "parameter" }> {
  const refs: Array<{ nodeId: string; input: string; folder: MediaModelReference["folder"]; file: string; via: "literal" | "parameter" }> = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const { input, folder } of MODEL_LOADER_INPUTS[node.class_type] ?? []) {
      const parameter = parameters.find((p) => p.nodeId === nodeId && p.input === input);
      if (parameter) {
        for (const value of parameter.enum ?? []) refs.push({ nodeId, input, folder, file: normalizeModelName(value), via: "parameter" });
        continue;
      }
      const value = node.inputs?.[input];
      if (typeof value === "string" && value) refs.push({ nodeId, input, folder, file: normalizeModelName(value), via: "literal" });
    }
  }
  return refs;
}

/** A local (owner-imported) template's models: what its loader nodes name (no declared list exists for it). */
export function localTemplateModels(workflow: Graph, parameters: MediaTemplateParameter[]): MediaModelReference[] {
  const seen = new Set<string>();
  const out: MediaModelReference[] = [];
  for (const ref of graphModelReferences(workflow, parameters)) {
    const key = `${ref.folder}/${ref.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ folder: ref.folder, file: ref.file, sha256: null });
  }
  return out;
}

/**
 * Plan §2.3 model check for a registry template: every model a known loader names (literal or parameter enum) must be in
 * the declared `models`, in that loader's folder; a parameter on a loader input must be an enum (a free-text model name
 * could load anything). Returns the problems (empty = fine).
 */
export function checkDeclaredModels(template: { workflow: Graph; parameters: MediaTemplateParameter[]; models: Array<{ folder: string; file: string }> }): string[] {
  const problems: string[] = [];
  const declared = new Set(template.models.map((m) => `${m.folder}/${normalizeModelName(m.file)}`));
  for (const [nodeId, node] of Object.entries(template.workflow)) {
    for (const { input } of MODEL_LOADER_INPUTS[node.class_type] ?? []) {
      const parameter = template.parameters.find((p) => p.nodeId === nodeId && p.input === input);
      if (parameter && parameter.type !== "enum") problems.push(`parameter "${parameter.name}" sets the model of node ${nodeId} (${node.class_type}.${input}); it must be an enum of declared models`);
    }
  }
  for (const ref of graphModelReferences(template.workflow, template.parameters)) {
    if (!declared.has(`${ref.folder}/${ref.file}`)) {
      problems.push(`node ${ref.nodeId} ${ref.via === "parameter" ? "may load" : "loads"} ${ref.folder}/${ref.file}, which is not in the template's models list`);
    }
  }
  return problems;
}
