import { z } from "zod";
import { isSupportedYoutubeLanguageCode } from "@/lib/youtube-supported-languages";
export { parseWithSchema } from "./contracts";

/** `zxx` ("no linguistic content", Studio's "Not applicable") is a legitimate Video language
 * value but is not in YouTube's UI-language list, so it is allowed explicitly. */
const NOT_APPLICABLE = "zxx";

const nullableCode = (allowNotApplicable: boolean) =>
  z
    .string()
    .trim()
    .nullable()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || isSupportedYoutubeLanguageCode(v) || (allowNotApplicable && v === NOT_APPLICABLE), {
      message: "not a supported YouTube language code",
    });

export const channelRefInputSchema = z.object({ channelId: z.string().min(1) }).strict();

export const setDefaultsInputSchema = z
  .object({
    channelId: z.string().min(1),
    // BL-178 part B (review item 3): a field left out is left unchanged -- a form sends only what the owner changed, so a
    // stale value on this screen never overwrites one that arrived from the other computer meanwhile.
    defaultLanguage: nullableCode(false).optional(),
    defaultAudioLanguage: nullableCode(true).optional(),
  })
  .strict();
