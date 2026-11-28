import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";
import { VIDIQ_MAX_MONTHLY_BUDGET } from "./contracts";

// BL-278: the owner's inputs. The key is checked for shape only here (vidIQ checks it for real with the free balance read); its
// value never appears in a validation message.

export const saveKeyInputSchema = z.object({ apiKey: z.string().trim().min(8).max(512).regex(/^[\x21-\x7e]+$/) }).strict();

export const updateSettingsInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    monthlyBudgetCredits: z.number().int().min(0).max(VIDIQ_MAX_MONTHLY_BUDGET).optional(),
  })
  .strict();

export const callInputSchema = z.object({ caller: z.enum(["owner", "producer"]), tool: z.string().max(200), args: z.unknown().optional() }).strict();

export const pollInputSchema = z.object({ caller: z.enum(["owner", "producer"]), mcpJobId: z.string().min(1).max(128) }).strict();

export function parseInput<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Only the paths, never the values (a key could be one).
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(body)"))].slice(0, 5);
  throw new DomainError({ code: "validation_failed", message: `${what}: invalid ${fields.join(", ")}.`, details: { fields } });
}
