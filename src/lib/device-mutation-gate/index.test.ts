import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Architecture audit 2026-10-01 (M5): the app-wide mutation gate must not depend on any feature
// module (it previously lived in device-handoff and pulled in snapshot). Its only allowed
// dependencies are the operation lock and the SqlExecutor type.
test("device-mutation-gate imports only operation-lock and db-backup contracts", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/lib/device-mutation-gate/index.ts"), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["@/lib/db-backup/contracts", "@/lib/operation-lock"]);
});

test("every entry-point choke point imports the gate from device-mutation-gate, not device-handoff", async () => {
  for (const file of ["src/proxy.ts", "src/mcp/server.ts", "src/cli/video-metadata.ts"]) {
    const source = await readFile(path.resolve(process.cwd(), file), "utf8");
    assert.equal(/assertDeviceAvailableForMutation[^;]*"@\/lib\/device-handoff"/.test(source), false, file);
    assert.equal(/import\("@\/lib\/device-handoff"\)/.test(source), false, file);
  }
});
