import { z } from "zod";
import { RUNPOD_DATACENTER_ID_PATTERN } from "@/lib/media-gateway";
import { MAX_CONCURRENT_SESSIONS_RANGE } from "./contracts";
export { parseWithSchema, formatZodError } from "./contracts";

/** RunPod datacenter ids look like `EU-RO-1`, `EUR-IS-1`, `US-TX-3`. */
/** Re-exported from the gateway (single source, review round 3): `EU-RO-1`, `EUR-IS-1`, `CA-MTL-3`, ... */
export const DATACENTER_ID_PATTERN = RUNPOD_DATACENTER_ID_PATTERN;

const trimmedSecret = (max: number) => z.string().trim().min(1).max(max);

/**
 * Operator-only (Settings → RunPod). The S3 pair is optional as a pair: both or
 * neither. Secrets arrive only here and leave only as an encrypted blob.
 */
export const setCredentialsInputSchema = z
  .object({
    runpodApiKey: trimmedSecret(512).refine((v) => v.length >= 16, "runpodApiKey looks too short to be a RunPod API key"),
    s3AccessKeyId: trimmedSecret(256).nullable().optional(),
    s3SecretAccessKey: trimmedSecret(512).nullable().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.s3AccessKeyId) === Boolean(v.s3SecretAccessKey), {
    message: "s3AccessKeyId and s3SecretAccessKey must be given together",
    path: ["s3SecretAccessKey"],
  })
  // Slice 0 (2026-10-05): the access key id pasted into the secret field too (both `user_...`) passed validation and only
  // surfaced later as S3 `SignatureDoesNotMatch`. RunPod S3 secrets look like `rps_...`, the ids like `user_...`.
  .refine((v) => !v.s3SecretAccessKey || (v.s3SecretAccessKey !== v.s3AccessKeyId && !v.s3SecretAccessKey.startsWith("user_")), {
    message: "s3SecretAccessKey looks like the access key id (user_...); the S3 secret is the other value RunPod showed once (rps_...)",
    path: ["s3SecretAccessKey"],
  });

export const mediaSettingsSchema = z
  .object({
    datacenterId: z.string().regex(DATACENTER_ID_PATTERN, "not a RunPod datacenter id (e.g. EU-RO-1)").nullable(),
    gpuTypeId: z.string().trim().min(1).max(128).nullable(),
    cloudType: z.enum(["SECURE", "COMMUNITY"]),
    networkVolumeId: z.string().trim().min(1).max(64).nullable(),
    templateId: z.string().trim().min(1).max(64).nullable(),
    maxUsdPerDay: z.number().gt(0).max(10_000),
    defaultMaxMinutes: z.number().int().min(1).max(1440),
    idleMinutes: z.number().int().min(1).max(1440),
    watchIntervalSeconds: z.number().int().min(15).max(3600),
    maxConcurrentSessions: z.number().int().min(MAX_CONCURRENT_SESSIONS_RANGE.min).max(MAX_CONCURRENT_SESSIONS_RANGE.max),
    gpuOnDemandPricePerHr: z.number().min(0).max(1000).nullable(),
  })
  .strict();

/** PUT body: any subset; absent fields keep their stored value. The price is derived, never set by a caller. */
export const updateSettingsInputSchema = mediaSettingsSchema.omit({ gpuOnDemandPricePerHr: true }).partial().strict();

export const requestSessionInputSchema = z
  .object({
    channelId: z.string().min(1).max(64),
    maxMinutes: z.number().int().min(1).max(1440).optional(),
    maxUsd: z.number().gt(0).max(10_000).nullable().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
    /** BL-135: stop the pod automatically once every job of the session is finished and no new one came for a minute. */
    releaseWhenDone: z.boolean().optional(),
    requestedBy: z.enum(["operator", "agent"]),
  })
  .strict();

export const sessionIdInputSchema = z.object({ sessionId: z.string().min(1).max(64) }).strict();

// -- workflow templates and jobs (slice 3) ---------------------------------------------------------

export const parameterNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, "a parameter name is an identifier (letters, digits, _)");
const scalarSchema = z.union([z.string().max(20_000), z.number(), z.boolean()]);

export const templateParameterSchema = z
  .object({
    name: parameterNameSchema,
    type: z.enum(["string", "text", "number", "integer", "boolean", "enum", "image", "audio", "video"]),
    nodeId: z.string().min(1).max(64),
    input: z.string().min(1).max(128),
    required: z.boolean().optional(),
    default: scalarSchema.nullable().optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    enum: z.array(z.string().min(1).max(500)).min(1).max(200).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    // BL-132 input types (image/audio/video) only.
    accept: z.array(z.string().toLowerCase().regex(/^\.[a-z0-9]{1,10}$/, "an extension like .png")).min(1).max(20).nullable().optional(),
    maxBytes: z.number().int().min(1).max(500 * 1024 * 1024).nullable().optional(),
  })
  .strict();

/** A ComfyUI API-format graph: `{ [nodeId]: { class_type, inputs } }`. */
export const workflowGraphSchema = z
  .record(
    z.string().min(1).max(64),
    z
      .object({
        class_type: z.string().min(1).max(200),
        inputs: z.record(z.string(), z.unknown()),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
  )
  .refine((graph) => Object.keys(graph).length > 0 && Object.keys(graph).length <= 2000, "a workflow has between 1 and 2000 nodes");

export const importTemplateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    workflow: workflowGraphSchema,
    parameters: z.array(templateParameterSchema).max(100),
  })
  .strict();

export const updateTemplateInputSchema = importTemplateInputSchema.partial().extend({ templateId: z.string().min(1).max(64) }).strict();
export const templateIdInputSchema = z.object({ templateId: z.string().min(1).max(64) }).strict();

export const createJobInputSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    channelId: z.string().min(1).max(64),
    templateId: z.string().min(1).max(64),
    params: z.record(parameterNameSchema, scalarSchema).default({}),
    createdBy: z.enum(["operator", "agent"]),
  })
  .strict();

export const jobIdInputSchema = z.object({ jobId: z.string().min(1).max(64) }).strict();
export const listJobsInputSchema = z.object({ sessionId: z.string().min(1).max(64).optional(), channelId: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(200).optional() }).strict();

export type ImportTemplateInput = z.infer<typeof importTemplateInputSchema>;
export type CreateJobInput = z.infer<typeof createJobInputSchema>;
export const stopSessionInputSchema = z.object({ sessionId: z.string().min(1).max(64), reason: z.string().trim().max(200).optional() }).strict();
export const rejectSessionInputSchema = z.object({ sessionId: z.string().min(1).max(64), reason: z.string().trim().min(1).max(500) }).strict();

export const createNetworkVolumeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    datacenterId: z.string().regex(DATACENTER_ID_PATTERN),
    sizeGb: z.number().int().min(10).max(4000),
  })
  .strict();

export const createPodPassthroughSchema = z
  .object({
    name: z.string().trim().min(1).max(191),
    image: z.string().trim().min(1).optional(),
    templateId: z.string().trim().min(1).optional(),
    gpu: z
      .object({
        id: z.string().min(1),
        count: z.number().int().min(1).max(8).optional(),
        vcpuCount: z.number().optional(),
        memory: z.number().optional(),
        allowedCudaVersions: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    cpu: z.object({ id: z.string().min(1), vcpuCount: z.number().int().min(1) }).strict().optional(),
    cloud: z.enum(["SECURE", "COMMUNITY"]).optional(),
    dataCenterId: z.string().regex(DATACENTER_ID_PATTERN).optional(),
    disk: z.number().int().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    ports: z.array(z.string().regex(/^\d{1,5}\/(http|tcp)$/)).optional(),
    mounts: z
      .object({
        network: z.array(z.object({ volumeId: z.string().min(1), path: z.string().min(1) }).strict()).nullable().optional(),
        persistent: z.object({ size: z.number().int().min(10), path: z.string().min(1) }).strict().nullable().optional(),
      })
      .strict()
      .optional(),
    cmd: z.array(z.string()).optional(),
    entrypoint: z.array(z.string()).optional(),
    startSsh: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.image) || Boolean(v.templateId), { message: "image or templateId is required", path: ["image"] });

/** RunPod v2 template body (docs: name + image required; mounts.persistent only; `network` is rejected by RunPod). */
export const createTemplatePassthroughSchema = z
  .object({
    name: z.string().trim().min(1).max(191),
    image: z.string().trim().min(1),
    description: z.string().max(1000).optional(),
    category: z.enum(["CPU", "NVIDIA", "AMD"]).optional(),
    args: z.string().optional(),
    cmd: z.array(z.string()).optional(),
    entrypoint: z.array(z.string()).optional(),
    disk: z.number().int().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    ports: z.array(z.string().regex(/^\d{1,5}\/(http|tcp)$/)).optional(),
    registry: z.string().nullable().optional(),
    mounts: z.object({ persistent: z.object({ size: z.number().int().min(10), path: z.string().min(1) }).strict().nullable().optional() }).strict().optional(),
    startSsh: z.boolean().optional(),
    startJupyter: z.boolean().optional(),
    allowedCudaVersions: z.array(z.string()).optional(),
    public: z.literal(false).optional(),
    serverless: z.literal(false).optional(),
  })
  .strict();

export type SetCredentialsInput = z.infer<typeof setCredentialsInputSchema>;
export type CreateTemplatePassthroughInput = z.infer<typeof createTemplatePassthroughSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;
export type CreateNetworkVolumeInput = z.infer<typeof createNetworkVolumeInputSchema>;
export type CreatePodPassthroughInput = z.infer<typeof createPodPassthroughSchema>;
