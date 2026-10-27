import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2 item 1, ADR 0053) -- AGENTS.md §G single gateway per API category: only this module may call
// the Telegram Bot API (it alone handles the bot token and redacts it).
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (/\.(tsx?|mjs|cjs|js)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("telegram-bot-gateway inventory: no production file outside src/lib/telegram-bot-gateway names api.telegram.org", async () => {
  const src = path.resolve(process.cwd(), "src");
  const gateway = path.join(src, "lib", "telegram-bot-gateway");
  const offenders: string[] = [];
  for (const file of await listFiles(src)) {
    if (file.startsWith(gateway + path.sep)) continue;
    if (/api\.telegram\.org/.test(await readFile(file, "utf8"))) offenders.push(path.relative(src, file));
  }
  assert.deepEqual(offenders, []);
});
