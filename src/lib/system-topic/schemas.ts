import { z } from "zod";

// BL-228 (SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1): the module's input shapes in one place -- the owner's settings and the hub's
// relayed message (FO-RESP-0043 H1).

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
    enabled: z.boolean(),
    requestsPath: optionalText(/^\/.{1,1000}$/, "the requests folder must be an absolute path"),
  })
  .strict();

const telegramId = z.number().int().safe();

/** `POST /api/system-topic/inbound` -- one Telegram message as the hub got it. */
export const systemInboundSchema = z
  .object({
    updateId: z.number().int().nonnegative().safe(),
    messageId: telegramId.nullable().optional().transform((v) => v ?? null),
    chatId: telegramId.nullable().optional().transform((v) => v ?? null),
    threadId: telegramId.nullable().optional().transform((v) => v ?? null),
    fromId: telegramId.nullable().optional().transform((v) => v ?? null),
    date: telegramId.nullable().optional().transform((v) => v ?? null),
    text: z.string().max(10_000).nullable().optional().transform((v) => v ?? null),
  })
  .strict();
