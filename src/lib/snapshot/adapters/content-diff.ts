import type { SqlExecutor } from "../contracts";
import { SNAPSHOT_REPLACE_ON_IMPORT_TABLES } from "../contracts";

type ExecuteResult = { rows: Array<Record<string, unknown>> };

export type TransferredTableDiff = {
  table: string;
  /** Rows (by primary key) only in the live database. */
  onlyHere: number;
  /** Rows only in the other database file. */
  onlyThere: number;
  /** Rows in both with the same primary key but different content. */
  changed: number;
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function columnsOf(client: SqlExecutor, schema: string, table: string) {
  const info = (await client.execute(`PRAGMA ${schema}.table_info(${quote(table)})`)) as ExecuteResult;
  return info.rows.map((row) => ({ name: String(row.name), pk: Number(row.pk) }));
}

async function count(client: SqlExecutor, sql: string): Promise<number> {
  const result = (await client.execute(sql)) as ExecuteResult;
  return Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
}

/**
 * Divergence preview (owner, Telegram 2026-10-06): what an import of `otherDbPath` would replace,
 * table by table -- the rows only one side has, and the rows both have under the same primary key
 * with different content. Read-only: the file is ATTACHed, compared with plain SELECTs, detached.
 * Compares the columns both sides have (pass a copy already migrated to this build's schema). A
 * table without a primary key is compared row by row (a changed row then counts on both sides).
 */
export async function diffTransferredContent(client: SqlExecutor, otherDbPath: string): Promise<TransferredTableDiff[]> {
  await client.execute({ sql: "ATTACH DATABASE ? AS diff_target", args: [otherDbPath] });
  try {
    const out: TransferredTableDiff[] = [];
    for (const table of SNAPSHOT_REPLACE_ON_IMPORT_TABLES) {
      const here = await columnsOf(client, "main", table);
      const there = new Set((await columnsOf(client, "diff_target", table)).map((c) => c.name));
      const t = quote(table);
      if (here.length === 0 && there.size === 0) continue;
      if (here.length === 0) {
        out.push({ table, onlyHere: 0, onlyThere: await count(client, `SELECT COUNT(*) FROM diff_target.${t}`), changed: 0 });
        continue;
      }
      if (there.size === 0) {
        out.push({ table, onlyHere: await count(client, `SELECT COUNT(*) FROM main.${t}`), onlyThere: 0, changed: 0 });
        continue;
      }
      const shared = here.filter((c) => there.has(c.name));
      const pk = shared.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk);
      const list = shared.map((c) => quote(c.name)).join(", ");
      if (pk.length === 0 || pk.length !== here.filter((c) => c.pk > 0).length) {
        out.push({
          table,
          onlyHere: await count(client, `SELECT COUNT(*) FROM (SELECT ${list} FROM main.${t} EXCEPT SELECT ${list} FROM diff_target.${t})`),
          onlyThere: await count(client, `SELECT COUNT(*) FROM (SELECT ${list} FROM diff_target.${t} EXCEPT SELECT ${list} FROM main.${t})`),
          changed: 0,
        });
        continue;
      }
      const join = pk.map((c) => `a.${quote(c.name)} = b.${quote(c.name)}`).join(" AND ");
      const same = shared.map((c) => `a.${quote(c.name)} IS b.${quote(c.name)}`).join(" AND ");
      out.push({
        table,
        onlyHere: await count(client, `SELECT COUNT(*) FROM main.${t} a WHERE NOT EXISTS (SELECT 1 FROM diff_target.${t} b WHERE ${join})`),
        onlyThere: await count(client, `SELECT COUNT(*) FROM diff_target.${t} a WHERE NOT EXISTS (SELECT 1 FROM main.${t} b WHERE ${join})`),
        changed: await count(client, `SELECT COUNT(*) FROM main.${t} a JOIN diff_target.${t} b ON ${join} WHERE NOT (${same})`),
      });
    }
    return out;
  } finally {
    await client.execute("DETACH DATABASE diff_target");
  }
}
