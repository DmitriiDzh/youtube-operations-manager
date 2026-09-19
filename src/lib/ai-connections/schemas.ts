import { z } from "zod";
import { parseWithSchema } from "@/lib/changesets/schemas";

export { parseWithSchema };

const MAX_TEXT_FIELD_LENGTH = 500;

export const connectionCapabilitiesSchema = z
  .object({
    structuredOutput: z.enum(["json_schema", "json_object", "none"]),
  })
  .strict();

export const pricingMetadataSchema = z
  .object({
    inputPerMillionTokens: z.number().nonnegative(),
    outputPerMillionTokens: z.number().nonnegative(),
    currency: z.string().min(1).max(10),
  })
  .strict()
  .nullable();

export const createConnectionInputSchema = z
  .object({
    displayName: z.string().min(1).max(MAX_TEXT_FIELD_LENGTH),
    adapterType: z.enum(["mock", "openai_compatible"]),
    baseUrl: z.string().url().max(2000).nullable().optional(),
    modelId: z.string().min(1).max(MAX_TEXT_FIELD_LENGTH),
    localInferenceMode: z.boolean().optional(),
    enabled: z.boolean().optional(),
    capabilities: connectionCapabilitiesSchema,
    assignedTasks: z.array(z.enum(["ai_localization"])).max(10).optional(),
    pricing: pricingMetadataSchema.optional(),
    apiKey: z.string().min(1).max(2000).nullable().optional(),
  })
  .strict();

export const updateConnectionInputSchema = z
  .object({
    connectionId: z.string().min(1),
    displayName: z.string().min(1).max(MAX_TEXT_FIELD_LENGTH).optional(),
    baseUrl: z.string().url().max(2000).nullable().optional(),
    modelId: z.string().min(1).max(MAX_TEXT_FIELD_LENGTH).optional(),
    localInferenceMode: z.boolean().optional(),
    enabled: z.boolean().optional(),
    capabilities: connectionCapabilitiesSchema.optional(),
    assignedTasks: z.array(z.enum(["ai_localization"])).max(10).optional(),
    pricing: pricingMetadataSchema.optional(),
    apiKey: z.string().min(1).max(2000).nullable().optional(),
  })
  .strict();

export const getConnectionInputSchema = z
  .object({
    connectionId: z.string().min(1),
  })
  .strict();

export const listConnectionsInputSchema = z.object({}).strict();

export const deleteConnectionInputSchema = z
  .object({
    connectionId: z.string().min(1),
  })
  .strict();

export const testConnectionInputSchema = z
  .object({
    connectionId: z.string().min(1),
  })
  .strict();

export type CreateConnectionSchemaInput = z.infer<typeof createConnectionInputSchema>;
export type UpdateConnectionSchemaInput = z.infer<typeof updateConnectionInputSchema>;
