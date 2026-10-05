import { z } from "zod";

export const selectWriteChannelInputSchema = z
  .object({
    channelId: z
      .string()
      .min(1, "channelId is required")
      .regex(/^UC[a-zA-Z0-9_-]{22}$/, "channelId must be a valid YouTube channel id"),
    credentialRef: z
      .union([
        z.object({ userId: z.string().min(1) }).strict(),
        z
          .object({
            accessToken: z.string().min(1),
            refreshToken: z.string().optional(),
            tokenExpiry: z.number().int().positive().optional(),
            scope: z.string().optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const selectUserInputSchema = z
  .object({
    userId: z.string().min(1, "userId is required"),
  })
  .strict();

export function toValidationIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}
