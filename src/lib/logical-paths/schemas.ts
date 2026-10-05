import { z } from "zod";
import { LOGICAL_PATH_AUDIENCES } from "./contracts";
export { parseWithSchema, formatZodError } from "./contracts";

/** Lowercase snake_case identifier; the stable key agents ask for. */
export const logicalPathNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, "name must be 2-64 characters: lowercase letters, digits, underscore; starting with a letter");

/** Agent-facing read input. `.strict()` -- an extra field (e.g. a `path`) is rejected, never
 * silently ignored, so a read tool can never be mistaken for a setter. */
export const getLogicalPathInputSchema = z.object({ name: logicalPathNameSchema }).strict();

export const createLogicalPathInputSchema = z
  .object({
    name: logicalPathNameSchema,
    audience: z.enum(LOGICAL_PATH_AUDIENCES),
    description: z.string().max(200).default(""),
  })
  .strict();

export const deleteLogicalPathInputSchema = z.object({ name: logicalPathNameSchema }).strict();

/** Operator-facing set input. `null`/`""` both clear this device's value. Length-capped so a
 * pathological body cannot store an unbounded string. */
export const setLogicalPathValueInputSchema = z
  .object({
    name: logicalPathNameSchema,
    path: z.string().max(4096).nullable(),
  })
  .strict();

export type CreateLogicalPathInput = z.infer<typeof createLogicalPathInputSchema>;
