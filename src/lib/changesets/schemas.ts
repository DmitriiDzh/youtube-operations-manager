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

export const importWorkbookInputSchema = z
  .object({
    channelId: z.string().min(1),
    filename: z.string().min(1),
    buffer: z.instanceof(Buffer),
  })
  .strict();

export const listChangeSetsInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const getChangeSetInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    status: z.enum(["pending", "approved", "rejected", "conflict", "invalid", "all"]).optional(),
    language: z.string().min(1).optional(),
    videoId: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const changeActionInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    changeId: z.string().min(1),
  })
  .strict();

export const changeSetBulkActionInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
  })
  .strict();

export type ImportWorkbookInput = z.infer<typeof importWorkbookInputSchema>;
export type ListChangeSetsInput = z.infer<typeof listChangeSetsInputSchema>;
export type GetChangeSetInput = z.infer<typeof getChangeSetInputSchema>;
export type ChangeActionInput = z.infer<typeof changeActionInputSchema>;
export type ChangeSetBulkActionInput = z.infer<typeof changeSetBulkActionInputSchema>;
