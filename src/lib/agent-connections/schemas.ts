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

// Operator-chosen slug, matched against an `AGENT_CONNECTION_ID` env var by whichever client
// config the owner writes -- kept intentionally simple (lowercase, digits, hyphen/underscore) so
// it is easy to type correctly into an MCP launch config by hand.
const agentConnectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, "must be lowercase letters, digits, hyphen, or underscore only");

export const registerAgentConnectionInputSchema = z
  .object({
    id: agentConnectionIdSchema,
    label: z.string().trim().min(1).max(200),
    enabled: z.boolean().optional().default(true),
  })
  .strict();
export type RegisterAgentConnectionInput = z.infer<typeof registerAgentConnectionInputSchema>;

export const setAgentConnectionEnabledInputSchema = z
  .object({
    id: agentConnectionIdSchema,
    enabled: z.boolean(),
  })
  .strict();
export type SetAgentConnectionEnabledInput = z.infer<typeof setAgentConnectionEnabledInputSchema>;

// A bare capability id string, e.g. "content_proposal.create_content_proposal" -- this module
// does not validate it against any capability registry (see contracts.ts's own doc comment).
const capabilityIdSchema = z.string().min(1).max(200);

export const assignAgentCapabilityZoneInputSchema = z
  .object({
    capabilityId: capabilityIdSchema,
    assignedConnectionId: agentConnectionIdSchema.nullable(),
  })
  .strict();
export type AssignAgentCapabilityZoneInput = z.infer<typeof assignAgentCapabilityZoneInputSchema>;
