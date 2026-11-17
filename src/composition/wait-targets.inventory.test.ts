import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-271 (WAIT_TOOLS_PLAN.md AC-WT-12): the wait is read-only. No file of the wait path -- the core, its ports, the CLI -- reaches a
// YouTube gateway, a paid provider's create/send, the device mutation gate or an upload writer. A source scan (comments stripped), so a
// later edit that adds such a call fails the suite. The existing gateway and upload inventories are unchanged by BL-271.

async function waitFiles(): Promise<string[]> {
  const core = (await readdir("src/lib/operation-wait")).filter((name) => /\.ts$/.test(name) && !name.includes(".test.")).map((name) => path.join("src/lib/operation-wait", name));
  return [...core, "src/composition/wait-targets.ts", "src/cli/wait.ts"];
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

const FORBIDDEN = [
  // YouTube (AGENTS.md §G: the only funnels) and Google clients.
  "youtube-write-gateway",
  "youtube-read-gateway",
  "googleapis",
  // The device mutation gate: a wait is a read and passes none.
  "device-mutation-gate",
  "assertDeviceAvailableForMutation",
  "assertMutationAllowed",
  // Upload writers (no-agent-upload-tool.test.ts's list) and the queue control.
  "createUploadApprovalCore",
  "createUploadRunnerCore",
  "createAutoPrivateUploadCore",
  "createUploadQueueControlCore",
  "cancelUpload",
  "queueByProducer",
  // Paid or state-changing calls of the modules it reads.
  "createJob",
  "createSpeechJob",
  "createSoundJob",
  "createElevenlabsSound",
  "startSession",
  "endSession",
  "cancelJob",
  "claimTranslationRequest",
  "completeTranslationRequest",
  "failTranslationRequest",
  "attachRender",
  "submit(",
  "request(",
  "hold(",
  "releaseHold",
  "cancel(",
];

test("AC-WT-12: no file of the wait path reaches a YouTube gateway, a paid create, the mutation gate or an upload writer", async () => {
  const offenders: string[] = [];
  for (const file of await waitFiles()) {
    const code = stripComments(await readFile(file, "utf8"));
    for (const name of FORBIDDEN) if (code.includes(name)) offenders.push(`${file}: ${name}`);
  }
  assert.deepEqual(offenders, []);
});

test("AC-WT-12: the CLI never imports the database or any domain module (it is a thin HTTP client of the caller's endpoint)", async () => {
  const source = await readFile("src/cli/wait.ts", "utf8");
  const imports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.filter((spec) => !(spec.startsWith("node:") || spec === "@/lib/operation-wait/contracts" || spec === "@/lib/shared-async")), []);
});
