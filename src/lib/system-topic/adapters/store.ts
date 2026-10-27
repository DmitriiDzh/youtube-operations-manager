import type { Client } from "@libsql/client";
import type { SystemCommandRow, SystemCommandStatus, SystemTopicState, SystemTopicStore } from "../contracts";

// BL-228: the System topic's tables (SCHEMA_MIGRATIONS v111) -- one settings/poll-state row (id = 1) and the audit trail, keyed by
// the Telegram update id so the same message is never recorded (and run) twice. Plain SQL on the shared client, like restart-when-idle.

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const EMPTY: SystemTopicState = {
  ownerUserId: null,
  chatId: null,
  threadId: null,
  listening: false,
  commandsPath: null,
  pollOffset: null,
  droppedCount: 0,
  lastPollAt: null,
  lastPollError: null,
  updatedAt: null,
};

function commandFromRow(row: Row): SystemCommandRow {
  return {
    updateId: Number(row.update_id),
    fromUserId: String(row.from_user_id),
    text: String(row.text),
    command: str(row.command),
    status: String(row.status) as SystemCommandStatus,
    resultText: str(row.result_text),
    replyError: str(row.reply_error),
    receivedAt: Number(row.received_at),
    finishedAt: num(row.finished_at),
  };
}

export function createSystemTopicStore(client: Client): SystemTopicStore {
  const ensureRow = () => client.execute("INSERT OR IGNORE INTO system_topic_state (id, listening, dropped_count) VALUES (1, 0, 0)");
  return {
    async read() {
      const [row] = (await client.execute("SELECT * FROM system_topic_state WHERE id = 1")).rows as unknown as Row[];
      if (!row) return { ...EMPTY };
      return {
        ownerUserId: str(row.owner_user_id),
        chatId: str(row.chat_id),
        threadId: str(row.thread_id),
        listening: Number(row.listening) === 1,
        commandsPath: str(row.commands_path),
        pollOffset: num(row.poll_offset),
        droppedCount: Number(row.dropped_count ?? 0),
        lastPollAt: num(row.last_poll_at),
        lastPollError: str(row.last_poll_error),
        updatedAt: num(row.updated_at),
      };
    },
    async saveSettings(settings, at) {
      await ensureRow();
      await client.execute({
        sql: "UPDATE system_topic_state SET owner_user_id = ?, chat_id = ?, thread_id = ?, listening = ?, commands_path = ?, updated_at = ? WHERE id = 1",
        args: [settings.ownerUserId, settings.chatId, settings.threadId, settings.listening ? 1 : 0, settings.commandsPath, at],
      });
    },
    async recordPoll(input) {
      await ensureRow();
      await client.execute({
        sql: "UPDATE system_topic_state SET poll_offset = ?, dropped_count = dropped_count + ?, last_poll_at = ?, last_poll_error = ? WHERE id = 1",
        args: [input.offset, input.dropped, input.at, input.error],
      });
    },
    async claimCommand(row) {
      const result = await client.execute({
        sql: "INSERT OR IGNORE INTO system_topic_commands (update_id, from_user_id, text, command, status, received_at) VALUES (?, ?, ?, ?, 'received', ?)",
        args: [row.updateId, row.fromUserId, row.text, row.command, row.receivedAt],
      });
      return result.rowsAffected > 0;
    },
    async finishCommand(updateId, patch) {
      await client.execute({
        sql: "UPDATE system_topic_commands SET status = ?, result_text = ?, reply_error = ?, finished_at = ? WHERE update_id = ?",
        args: [patch.status, patch.resultText, patch.replyError, patch.finishedAt, updateId],
      });
    },
    async recentCommands(limit) {
      const rows = (await client.execute({ sql: "SELECT * FROM system_topic_commands ORDER BY received_at DESC, update_id DESC LIMIT ?", args: [limit] })).rows as unknown as Row[];
      return rows.map(commandFromRow);
    },
  };
}
