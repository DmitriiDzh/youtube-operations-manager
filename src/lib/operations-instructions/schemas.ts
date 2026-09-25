import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";


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
