// ---------------------------------------------------------------------------
// The mechanical enforcement of the owner's own single-gateway-per-API-category rule, applied to
// the Cloud Monitoring API (owner instruction, 2026-09-22, Telegram, confirming the same "single
// funnel" principle already established for the YouTube read/write gateways applies here too:
// "Он сделан по такой же схеме модуля / шлюза? чтобы все такие запросы шли только через него и
// никак иначе?").
//
// Unlike `read-gateway-inventory.test.ts` (an import-level check on the `googleapis` npm
// package), this module deliberately never imports `googleapis` at all -- it calls the Cloud
// Monitoring REST API via plain `fetch` (`src/lib/cloud-quotas/adapters/monitoring-client.ts`'s
// own doc comment explains why). So the equivalent enforcement here is a literal-string check on
// the actual request URL (`https://monitoring.googleapis.com`), not the bare host name --
// `contracts.ts`/`services.ts` legitimately reference the bare `"monitoring.googleapis.com"`
// string as a `QuotaService` type value / parameter (identifying WHICH service's quota to ask
// about), never to construct a URL themselves. No production file outside this module's own
// `adapters/monitoring-client.ts` may contain the URL literal -- catches a future accidental
// second call site that would silently bypass this module's own traffic counter
// (`cloud_monitoring_reads`, `src/lib/db.ts`).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const MONITORING_CLIENT_FILE = path.join(THIS_DIR, "adapters", "monitoring-client.ts");

async function listTsFilesRecursively(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursively(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("cloud-quotas inventory: no file outside adapters/monitoring-client.ts constructs a monitoring.googleapis.com URL", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue; // a test may reference the URL in a fixture/comment
    if (file === MONITORING_CLIENT_FILE) continue;

    const content = await readFile(file, "utf8");
    if (content.includes("https://monitoring.googleapis.com")) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following production files construct a monitoring.googleapis.com request URL directly ` +
      `instead of going through src/lib/cloud-quotas/adapters/monitoring-client.ts: ${offenders.join(", ")}`
  );
});
