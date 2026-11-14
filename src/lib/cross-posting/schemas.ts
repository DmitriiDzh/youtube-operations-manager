import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { SOCIAL_NETWORKS } from "./contracts";

export { parseWithSchema };

// BL-252: the module's inputs. A Meta App ID is digits; an App Secret is 32 hex characters (Meta app dashboard → App settings → Basic).
export const setMetaAppInputSchema = z
  .object({
    appId: z.string().trim().regex(/^\d{5,20}$/, "an App ID is 5-20 digits"),
    appSecret: z.string().trim().regex(/^[0-9a-fA-F]{32}$/, "an App Secret is 32 hexadecimal characters"),
  })
  .strict();

const channelId = z.string().trim().min(1).max(64);

export const startConnectInputSchema = z.object({ channelId }).strict();
export const selectPageInputSchema = z.object({ pickId: z.string().min(16).max(80), pageId: z.string().regex(/^\d{1,30}$/) }).strict();
export const disconnectInputSchema = z.object({ channelId, network: z.enum(SOCIAL_NETWORKS).optional() }).strict();
