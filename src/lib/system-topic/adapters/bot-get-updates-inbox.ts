import type { TelegramUpdate } from "@/lib/telegram-bot-gateway";
import { SYSTEM_TOPIC_POLL_TIMEOUT_SECONDS, type SystemInbox } from "../contracts";

// BL-228 (ADR 0053; owner msg 3602): the inbound source `bot_get_updates` -- this app long-polls the bot itself through the Telegram
// gateway. Only for a bot nothing else polls: two getUpdates consumers on one bot steal each other's updates. Its cursor is the
// getUpdates offset (one past the newest update seen; Telegram forgets every update below it).

export type GetUpdatesPort = (token: string, input: { offset: number | null; timeoutSeconds: number; signal?: AbortSignal }) => Promise<TelegramUpdate[]>;

export function createBotGetUpdatesInbox(deps: { getUpdates: GetUpdatesPort; readToken: () => Promise<string | null> }): SystemInbox {
  return {
    async receive({ cursor, signal }) {
      const token = await deps.readToken();
      if (!token) return { messages: [], nextCursor: cursor };
      const updates = await deps.getUpdates(token, { offset: cursor, timeoutSeconds: SYSTEM_TOPIC_POLL_TIMEOUT_SECONDS, signal });
      let next = cursor;
      const messages = [];
      for (const update of updates) {
        // Below the offset: already confirmed to Telegram (it should not send it again; never counted twice if it does).
        if (cursor !== null && update.updateId < cursor) continue;
        next = Math.max(next ?? 0, update.updateId + 1);
        const m = update.message;
        messages.push({
          updateId: update.updateId,
          messageId: m?.messageId ?? null,
          chatId: m?.chatId ?? null,
          threadId: m?.threadId ?? null,
          fromId: m?.from?.id ?? null,
          text: m?.text ?? null,
          date: null,
        });
      }
      return { messages, nextCursor: next };
    },
  };
}
