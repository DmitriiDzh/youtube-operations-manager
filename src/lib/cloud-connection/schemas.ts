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

export const completeConnectInputSchema = z
  .object({
    code: z.string().min(1, "code is required"),
    state: z.string().min(1, "state is required"),
    expectedState: z.string().min(1, "expectedState is required"),
    redirectUri: z.string().min(1, "redirectUri is required"),
  })
  .strict();

export type CompleteConnectInput = z.infer<typeof completeConnectInputSchema>;
