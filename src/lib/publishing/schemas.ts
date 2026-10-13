import { z } from "zod";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

/** BL-182 stage 1: `agent_get_publishing_calendar` input. */
export const getAgentPublishingCalendarInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();
