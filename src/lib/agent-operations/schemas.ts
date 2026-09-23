import { z } from "zod";
import { parseWithSchema } from "@/lib/changesets/schemas";

export { parseWithSchema };

// No input parameters for this slice's one capability -- `.strict()` so a future accidental
// extra field is rejected loudly rather than silently ignored, matching every other input
// schema in this codebase.
export const getSystemCapabilitiesInputSchema = z.object({}).strict();

const permissionClassSchema = z.enum(["READ", "DRAFT", "APPROVE", "EXECUTE"]);

const agentCapabilityDescriptorSchema = z
  .object({
    id: z.string().min(1),
    domain: z.enum([
      "system",
      "channel_context",
      "video_context",
      "analytics",
      "asset_catalog",
      "localization_draft",
      "content_proposal",
    ]),
    permission: permissionClassSchema,
    description: z.string().min(1),
  })
  .strict();

export const systemCapabilitiesOutputSchema = z
  .object({
    productVersion: z.string().min(1),
    agentApiVersion: z.string().min(1),
    capabilities: z.array(agentCapabilityDescriptorSchema),
    dataDomains: z.array(z.enum(["channel_metadata", "video_metadata", "channel_analytics", "video_analytics"])),
    actionClasses: z.array(permissionClassSchema),
    grantedPermissions: z.array(permissionClassSchema),
    plannedFutureCapabilities: z.array(z.enum(["query_market_intelligence", "query_competitors", "create_experiment_proposal"])),
    schemaVersions: z.object({ app: z.number().int().positive() }).strict(),
  })
  .strict();

export type GetSystemCapabilitiesInput = z.infer<typeof getSystemCapabilitiesInputSchema>;
export type SystemCapabilitiesOutput = z.infer<typeof systemCapabilitiesOutputSchema>;
