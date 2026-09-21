import { z, ZodError } from "zod";
import { DomainError } from "./contracts";

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(schema: z.ZodType<T>, payload: unknown, context: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: `Invalid ${context}`,
      details: formatZodError(parsed.error),
    });
  }

  return parsed.data;
}

const changeFieldSchema = z.enum(["title", "description"]);
const changeTypeSchema = z.enum(["add", "modify", "unchanged", "delete"]);
const changeSetSourceSchema = z.enum(["xlsx_import", "ai_localization", "deletion"]);
const changeApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const createChangeSetInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    source: changeSetSourceSchema,
    importedFilename: z.string().nullable().optional(),
    schemaVersion: z.string().nullable().optional(),
    exportedAt: z.string().nullable().optional(),
  })
  .strict();

export const addChangeInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    changeSetId: z.string().min(1),
    videoId: z.string().min(1),
    language: z.string().min(1),
    field: changeFieldSchema,
    baselineValue: z.string(),
    proposedValue: z.string(),
    changeType: changeTypeSchema,
  })
  .strict();

export const updateProposedValueInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    proposedValue: z.string(),
  })
  .strict();

export const setApprovalStatusInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    approvalStatus: changeApprovalStatusSchema,
    approvedValue: z.string().nullable().optional(),
  })
  .strict();

export const channelIdInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const mergeIncomingInputSchema = z
  .object({
    channelId: z.string().min(1),
    incomingBytes: z.instanceof(Uint8Array),
  })
  .strict();
