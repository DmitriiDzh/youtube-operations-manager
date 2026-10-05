import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeBalance, PRODUCTION_TABS } from "./production-panel";

// AC-P14-26 (PHASE_14_PLAN.md §5.2; owner, Telegram 2026-10-05, msg 1549): Settings keeps only the RunPod connection
// (sub-tab renamed "RunPod"); a Production section right after Content holds the work, its tabs ordered by frequency
// of use -- work on the left, setup on the right: Sessions → Jobs → Models → Workflow templates → Setup.

test("AC-P14-26: Production's tabs are Sessions, Jobs, Models, Workflow templates (work, left) then Setup (right)", () => {
  assert.deepEqual(
    PRODUCTION_TABS.map((t) => [t.label, t.side]),
    [
      ["Sessions", "work"],
      ["Jobs", "work"],
      ["Models", "work"],
      ["Workflow templates", "work"],
      ["Setup", "setup"],
    ]
  );
});

test("AC-P14-26: the sidebar has Production right after Content; Settings has a RunPod sub-tab rendering only the connection", async () => {
  const page = await readFile(path.join(process.cwd(), "src", "app", "dashboard", "page.tsx"), "utf8");
  const navValues = [...page.slice(page.indexOf("const NAV_ITEMS"), page.indexOf("] as const satisfies")).matchAll(/value: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(navValues[navValues.indexOf("content") + 1], "production");
  const subTabs = page.slice(page.indexOf("const SETTINGS_SUB_TABS"), page.indexOf("type SettingsSubTab"));
  assert.match(subTabs, /\{ value: "runpod", label: "RunPod" \}/);
  assert.doesNotMatch(subTabs, /"media"/);
  const runpodBlock = page.slice(page.indexOf('settingsSubTab === "runpod"'), page.indexOf('settingsSubTab === "about"'));
  assert.match(runpodBlock, /<RunpodConnectionSettings \/>/);
  for (const card of ["SessionsCard", "JobsCard", "ModelsCard", "WorkflowTemplatesCard", "ComputeCard", "VolumeCard", "LimitsCard", "ProductionPanel"]) {
    assert.ok(!runpodBlock.includes(card), `${card} must not render under Settings → RunPod`);
  }
});

test("AC-P14-25: the balance header shows the GraphQL balance, or says the balance is unavailable and shows the v2 spend with the reason", () => {
  assert.deepEqual(describeBalance({ source: "graphql", balanceUsd: 12.72, spendPerHrUsd: 0.005, spendLimitUsd: 80 }), {
    headline: "$12.72",
    detail: "spending $0.005/h now · account spend limit $80.00/h",
  });
  const degraded = describeBalance({ source: "billing", balanceUsd: null, spentUsd: 3.75, podsUsd: 0.25, networkVolumesUsd: 3.5, from: "2026-09-05T00:00:00Z", to: "2026-10-06T00:00:00Z", balanceError: "RunPod GraphQL returned HTTP 500." });
  assert.equal(degraded.headline, "balance unavailable");
  assert.equal(degraded.detail, "RunPod spend (2026-09-05 – 2026-10-06): $3.75 (pods $0.25, network volumes $3.50). The balance read failed: RunPod GraphQL returned HTTP 500.");
});
