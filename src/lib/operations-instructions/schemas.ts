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

export const listOperationsFilesInputSchema = z.object({}).strict();

export const getOperationsFileInputSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

const operationsWorkspaceFileEntrySchema = z
  .object({
    path: z.string().min(1),
    isDirectory: z.boolean(),
    sizeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const listOperationsFilesOutputSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).strict(),
  z
    .object({
      configured: z.literal(true),
      files: z.array(operationsWorkspaceFileEntrySchema),
      truncated: z.boolean(),
    })
    .strict(),
]);

export const getOperationsFileOutputSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).strict(),
  z
    .object({
      configured: z.literal(true),
      path: z.string().min(1),
      content: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
]);

export type ListOperationsFilesInput = z.infer<typeof listOperationsFilesInputSchema>;
export type GetOperationsFileInput = z.infer<typeof getOperationsFileInputSchema>;
