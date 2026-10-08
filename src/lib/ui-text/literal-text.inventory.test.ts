import assert from "node:assert/strict";
import test from "node:test";
import { scanLiteralText } from "@/test-support/ui-text-literals";

// BL-152 (owner, Telegram 2026-10-07, msg 2027): "при добавлении чего-либо в инструмент — заводить ключи и переводы на все
// языки". Interface text lives in `src/lib/ui-text/locales/`, never as a literal in a component; the scan itself is in
// `src/test-support/ui-text-literals.ts`. A string that is not interface text (a technical identifier, a format sample, a
// product name) is marked on its line, or the line above, with `ui-text-ignore` and a reason.
//
// NOT_YET_MIGRATED lists the files still holding English while the interface is being moved over (BL-152 slices 2-4). It
// only shrinks: a listed file that is clean fails the test until it is removed from the list.
const NOT_YET_MIGRATED = new Set<string>([]);

test("the Web UI holds no English of its own: every text is an interface-text key (BL-152)", async () => {
  const found = await scanLiteralText();
  const stillListed = [...NOT_YET_MIGRATED].filter((file) => !found.has(file));
  const problems = [...found].filter(([file]) => !NOT_YET_MIGRATED.has(file)).flatMap(([file, lines]) => lines.map((l) => `${file}:${l}`));
  assert.deepEqual(stillListed, [], "these files are clean now -- remove them from NOT_YET_MIGRATED");
  assert.deepEqual(problems, [], "move these texts into src/lib/ui-text/locales (or mark a non-interface string with ui-text-ignore)");
});
