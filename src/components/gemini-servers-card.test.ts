import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { geminiSpendSplit } from "./gemini-servers-card";

// BL-193 (owner msgs 2864/2867): Servers shows Gemini's spend for every computer on the key, with this computer's part, and the
// card is its own failure domain (AGENTS.md §M): wrapped in a FeatureErrorBoundary, next to RunPod's cards in Sessions.

test("the key's spend splits into this computer's part and the other computers' part (hand-computed)", () => {
  const split = geminiSpendSplit({ todayUsd: 0.4, monthUsd: 3.2, activeUsd: 0, activeJobs: 0, account: { todayUsd: 1.15, monthUsd: 10.7, keyKnown: true, otherComputers: [] } });
  assert.deepEqual(split, { today: 1.15, month: 10.7, ownToday: 0.4, ownMonth: 3.2, othersToday: 0.75, othersMonth: 7.5 });
  // An older answer without `account`: this computer's figures only.
  assert.deepEqual(geminiSpendSplit({ todayUsd: 2, monthUsd: 5, activeUsd: 0, activeJobs: 0 }), { today: 2, month: 5, ownToday: 2, ownMonth: 5, othersToday: 0, othersMonth: 0 });
});

test("Servers → Sessions renders the Gemini card inside its own FeatureErrorBoundary, after RunPod's cards", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "production-panel.tsx"), "utf8");
  const sessions = panel.slice(panel.indexOf('tab === "sessions"'), panel.indexOf('tab === "models"'));
  assert.match(sessions, /<FeatureErrorBoundary[^>]*>\s*<GeminiServersCard /);
  assert.ok(sessions.indexOf("<SessionsCard") < sessions.indexOf("<GeminiServersCard"));
});
