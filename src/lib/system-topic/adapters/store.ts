import type { Client } from "@libsql/client";
import type { SystemCommandRow, SystemCommandStatus, SystemTopicState, SystemTopicStore } from "../contracts";

// BL-228: the System topic's tables (SCHEMA_MIGRATIONS v111) -- one settings row (id = 1), the audit trail keyed by the Telegram
// update id (a message is never recorded, and run, twice), and the outbox the hub posts from. Plain SQL on the shared client,
// like restart-when-idle.

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const EMPTY: SystemTopicState = {
  ownerUserId: null,
  chatId: null,
  threadId: null,
  enabled: false,
  requestsPath: null,
  relaySecretHash: null,
  relaySecretCreatedAt: null,
  droppedCount: 0,
  lastInboundAt: null,
  lastOutboxAt: null,
  lastScanAt: null,
  lastScanError: null,
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
    receivedAt: Number(row.received_at),
    finishedAt: num(row.finished_at),
  };
}

export function createSystemTopicStore(client: Client): SystemTopicStore {
  const ensureRow = () => client.execute("INSERT OR IGNORE INTO system_topic_state (id, enabled, dropped_count) VALUES (1, 0, 0)");
  return {
    async read() {
      const [row] = (await client.execute("SELECT * FROM system_topic_state WHERE id = 1")).rows as unknown as Row[];
      if (!row) return { ...EMPTY };
      return {
        ownerUserId: str(row.owner_user_id),
        chatId: str(row.chat_id),
        threadId: str(row.thread_id),
        enabled: Number(row.enabled) === 1,
        requestsPath: str(row.requests_path),
        relaySecretHash: str(row.relay_secret_hash),
        relaySecretCreatedAt: num(row.relay_secret_created_at),
        droppedCount: Number(row.dropped_count ?? 0),
        lastInboundAt: num(row.last_inbound_at),
        lastOutboxAt: num(row.last_outbox_at),
        lastScanAt: num(row.last_scan_at),
        lastScanError: str(row.last_scan_error),
        updatedAt: num(row.updated_at),
      };
    },
    async saveSettings(settings, at) {
      await ensureRow();
      await client.execute({
        sql: "UPDATE system_topic_state SET owner_user_id = ?, chat_id = ?, thread_id = ?, enabled = ?, requests_path = ?, updated_at = ? WHERE id = 1",
        args: [settings.ownerUserId, settings.chatId, settings.threadId, settings.enabled ? 1 : 0, settings.requestsPath, at],
      });
    },
    async setRelaySecretHash(hash, at) {
      await ensureRow();
      await client.execute({ sql: "UPDATE system_topic_state SET relay_secret_hash = ?, relay_secret_created_at = ? WHERE id = 1", args: [hash, at] });
    },
    async recordInbound({ dropped, at }) {
      await ensureRow();
      await client.execute({ sql: "UPDATE system_topic_state SET dropped_count = dropped_count + ?, last_inbound_at = ? WHERE id = 1", args: [dropped, at] });
    },
    async recordScan({ at, error }) {
      await ensureRow();
      await client.execute({ sql: "UPDATE system_topic_state SET last_scan_at = ?, last_scan_error = ? WHERE id = 1", args: [at, error] });
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
        sql: "UPDATE system_topic_commands SET status = ?, result_text = ?, finished_at = ? WHERE update_id = ?",
        args: [patch.status, patch.resultText, patch.finishedAt, updateId],
      });
    },
    async recentCommands(limit) {
      const rows = (await client.execute({ sql: "SELECT * FROM system_topic_commands ORDER BY received_at DESC, update_id DESC LIMIT ?", args: [limit] })).rows as unknown as Row[];
      return rows.map(commandFromRow);
    },
    async enqueueOutbox(row) {
      await client.execute({ sql: "INSERT INTO system_topic_outbox (id, text, created_at) VALUES (?, ?, ?)", args: [row.id, row.text, row.createdAt] });
    },
    async takeOutbox(at, limit) {
      // One statement: two polls at once can never hand out the same message.
      const result = await client.execute({
        sql:
          "UPDATE system_topic_outbox SET delivered_at = ? WHERE delivered_at IS NULL AND id IN " +
          "(SELECT id FROM system_topic_outbox WHERE delivered_at IS NULL ORDER BY created_at, id LIMIT ?) RETURNING id, text, created_at",
        args: [at, limit],
      });
      await ensureRow();
      await client.execute({ sql: "UPDATE system_topic_state SET last_outbox_at = ? WHERE id = 1", args: [at] });
      return (result.rows as unknown as Row[])
        .map((row) => ({ id: String(row.id), text: String(row.text), createdAt: Number(row.created_at) }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(({ id, text }) => ({ id, text }));
    },
  };
}
