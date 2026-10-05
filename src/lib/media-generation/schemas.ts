import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";

/** RunPod datacenter ids look like `EU-RO-1`, `EUR-IS-1`, `US-TX-3`. */
export const DATACENTER_ID_PATTERN = /^[A-Z]{2,4}-[A-Z]{2}-\d{1,2}$/;

const trimmedSecret = (max: number) => z.string().trim().min(1).max(max);

/**
 * Operator-only (Settings → Media → Credentials). The S3 pair is optional as a pair: both or
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
  })
  .strict();

/** PUT body: any subset; absent fields keep their stored value. */
export const updateSettingsInputSchema = mediaSettingsSchema.partial().strict();

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
