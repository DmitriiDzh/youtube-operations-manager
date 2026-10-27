import { z } from "zod";
import { TELEGRAM_BOT_TOKEN_PATTERN } from "@/lib/telegram-bot-gateway";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2-§3, ADR 0053): the one place the module's input shapes live -- the owner's settings, the bot
// token, and the factory-owned commands.json (DEV-RESP-0043 Part 1; the factory may still change it, so it is defined here only).

const optionalText = (pattern: RegExp, message: string) =>
  z
    .union([z.string(), z.null()])
    .transform((value) => (value === null || value.trim() === "" ? null : value.trim()))
    .refine((value) => value === null || pattern.test(value), message);

export const systemTopicSettingsInputSchema = z
  .object({
    ownerUserId: optionalText(/^[1-9]\d{0,15}$/, "the owner's Telegram user id is a positive number"),
    // A group's (supergroup's) chat id is negative: -100... for a supergroup with topics.
    chatId: optionalText(/^-[1-9]\d{0,18}$/, "the group's chat id is a negative number"),
    threadId: optionalText(/^[1-9]\d{0,15}$/, "the topic id is a positive number"),
    listening: z.boolean(),
    commandsPath: optionalText(/^\/.{1,1000}$/, "the commands.json path must be an absolute path"),
  })
  .strict();

export const systemTopicTokenInputSchema = z
  .object({ token: z.string().trim().regex(TELEGRAM_BOT_TOKEN_PATTERN, "a bot token looks like 123456789:AA... as BotFather gives it") })
  .strict();

/** A short name the owner types (`status tropico`), as the factory's config keys its channels. */
export const SYSTEM_CHANNEL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const argvSchema = z.array(z.string().min(1).max(4096)).min(1).max(64);

/**
 * `00 YT Operator/System/commands.json`, owned and written by the factory, read by the Manager on every command. Stage 1 reads
 * `channels` and `status`; `go`, `stopFile`, `jobsDir` are checked only for their type so a config written for later stages passes.
 * Unknown keys are allowed (the factory may add some before the Manager uses them).
 */
export const systemCommandsConfigSchema = z.looseObject({
  format: z.literal(1),
  channels: z.record(
    z.string().regex(SYSTEM_CHANNEL_NAME_PATTERN),
    z.looseObject({ channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/), root: z.string().regex(/^\//, "root must be an absolute path") })
  ),
  status: z.looseObject({ argv: argvSchema, channelArg: z.string().min(1).max(64).optional() }),
  go: z.looseObject({ argv: argvSchema, cwd: z.string().optional() }).optional(),
  stopFile: z.string().min(1).optional(),
  jobsDir: z.string().min(1).optional(),
});

export type SystemCommandsConfig = z.infer<typeof systemCommandsConfigSchema>;
