// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md §2 item 1, ADR 0053): the ONLY module that calls the Telegram Bot API
// (AGENTS.md §G, one gateway per external API; `inventory.test.ts` fails on any other production file naming its host). Two
// methods: `getUpdates` (long poll, messages only) and `sendMessage` (plain text, into one topic). The bot token is passed in for
// every call by the caller (who reads it from device-secrets) and is never kept, logged, returned or put into an error: every text
// that leaves this module goes through `redactTelegramToken` first.

const API_HOST = "https://api.telegram.org";

/** Telegram's own limit for one message's text. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** A bot token as BotFather issues it: the bot's numeric id, a colon, the secret part. Anything else is refused before any call. */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

export type TelegramUser = { id: number; isBot: boolean; username: string | null };
export type TelegramMessage = {
  messageId: number;
  chatId: number;
  /** The forum topic the message was sent in; null outside a topic. */
  threadId: number | null;
  from: TelegramUser | null;
  text: string | null;
};
export type TelegramUpdate = { updateId: number; message: TelegramMessage | null };

export type TelegramErrorCode = "telegram_token_invalid" | "telegram_unreachable" | "telegram_http_error" | "telegram_response_invalid";

/** Every failure of this gateway. Its message and details are already redacted (no token, no `bot<token>` URL part). */
export class TelegramBotError extends Error {
  readonly code: TelegramErrorCode;
  readonly status: number | null;
  constructor(code: TelegramErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "TelegramBotError";
    this.code = code;
    this.status = status;
  }
}

/** Removes the token itself, and any `bot<id>:<secret>` path part, from a text. */
export function redactTelegramToken(text: string, token?: string | null): string {
  let out = text;
  if (token && token.length > 0) out = out.split(token).join("<redacted>");
  return out.replace(/bot\d{3,15}:[A-Za-z0-9_-]{10,}/g, "bot<redacted>").replace(/\d{5,15}:[A-Za-z0-9_-]{30,64}/g, "<redacted>");
}

/** Cuts a text to Telegram's limit without splitting a character (a broken surrogate pair makes Telegram refuse the message). */
export function fitTelegramText(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit - 1).join("")}…`;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export type TelegramBotGatewayDeps = {
  /** Injected in tests; the real `fetch` otherwise. */
  fetch?: FetchLike;
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function parseUser(value: unknown): TelegramUser | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = num(raw.id);
  if (id === null) return null;
  return { id, isBot: raw.is_bot === true, username: typeof raw.username === "string" ? raw.username : null };
}

function parseMessage(value: unknown): TelegramMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const chat = raw.chat && typeof raw.chat === "object" ? (raw.chat as Record<string, unknown>) : null;
  const messageId = num(raw.message_id);
  const chatId = chat ? num(chat.id) : null;
  if (messageId === null || chatId === null) return null;
  return {
    messageId,
    chatId,
    threadId: num(raw.message_thread_id),
    from: parseUser(raw.from),
    text: typeof raw.text === "string" ? raw.text : null,
  };
}

export function createTelegramBotGateway(deps: TelegramBotGatewayDeps = {}) {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));

  async function call(token: string, method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) throw new TelegramBotError("telegram_token_invalid", "The bot token does not look like a Telegram bot token");
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${API_HOST}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      // Node's fetch can name the URL (and so the token) in its message or cause: only a redacted summary leaves.
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      const detail = error instanceof Error ? `${error.name}: ${error.message}${cause}` : String(error);
      throw new TelegramBotError("telegram_unreachable", `Telegram ${method} failed (${redactTelegramToken(detail, token)})`);
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text);
      parsed = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.ok !== true) {
      const description = parsed && typeof parsed.description === "string" ? parsed.description : `HTTP ${response.status}`;
      throw new TelegramBotError("telegram_http_error", `Telegram ${method} refused: ${redactTelegramToken(description, token).slice(0, 300)}`, response.status);
    }
    return parsed.result;
  }

  return {
    /**
     * Long poll: waits up to `timeoutSeconds` for new updates from `offset` on (Telegram forgets every update below the offset).
     * Only `message` updates are asked for.
     */
    async getUpdates(token: string, input: { offset: number | null; timeoutSeconds: number; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
      const body: Record<string, unknown> = { timeout: input.timeoutSeconds, allowed_updates: ["message"] };
      if (input.offset !== null) body.offset = input.offset;
      const result = await call(token, "getUpdates", body, (input.timeoutSeconds + 10) * 1000, input.signal);
      if (!Array.isArray(result)) throw new TelegramBotError("telegram_response_invalid", "Telegram getUpdates answered without a list");
      const updates: TelegramUpdate[] = [];
      for (const item of result) {
        const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
        const updateId = raw ? num(raw.update_id) : null;
        if (updateId === null) continue;
        updates.push({ updateId, message: parseMessage(raw?.message) });
      }
      return updates;
    },

    /** Posts plain text (no parse mode) into one topic of one chat; the text is cut to Telegram's 4096 characters. */
    async sendMessage(token: string, input: { chatId: string; threadId: number | null; text: string; signal?: AbortSignal }): Promise<{ messageId: number | null }> {
      const body: Record<string, unknown> = { chat_id: input.chatId, text: fitTelegramText(input.text), link_preview_options: { is_disabled: true } };
      if (input.threadId !== null) body.message_thread_id = input.threadId;
      const result = await call(token, "sendMessage", body, 20_000, input.signal);
      const messageId = result && typeof result === "object" ? num((result as Record<string, unknown>).message_id) : null;
      return { messageId };
    },
  };
}

export type TelegramBotGateway = ReturnType<typeof createTelegramBotGateway>;
