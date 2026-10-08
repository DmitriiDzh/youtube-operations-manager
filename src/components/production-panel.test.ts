import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTranslator, translate } from "@/lib/ui-text";
import { describeBalance, PRODUCTION_TABS } from "./production-panel";

// AC-P14-26 (PHASE_14_PLAN.md §5.2; owner, Telegram 2026-10-05, msg 1549): Settings keeps only the RunPod connection
// (sub-tab renamed "RunPod"); a Production section right after Content holds the work, its tabs ordered by frequency
// of use -- work on the left, setup on the right: Sessions → Jobs → Models → Workflow templates → Setup.

// Changed requirement (BL-143, ADR 0029, AC-GP-15 in GENERATION_PLANS_PLAN.md): a Plans tab after Jobs.
test("AC-P14-26 / AC-GP-15: Production's tabs are Sessions, Jobs, Plans, Models, Workflow templates (work, left) then Setup (right)", () => {
  assert.deepEqual(
    PRODUCTION_TABS.map((t) => [translate("en", t.labelKey), t.side]),
    [
      ["Sessions", "work"],
      ["Jobs", "work"],
      ["Plans", "work"],
      ["Models", "work"],
      ["Workflow templates", "work"],
      ["Setup", "setup"],
    ]
  );
});

test("AC-P14-26: the sidebar has Production right after Content; Settings has a RunPod sub-tab rendering only the connection", async () => {
  // BL-149: the sidebar lives in the (app) layout and Settings on its own page (the single dashboard page is gone; the
  // requirement this test checks is unchanged).
  const layout = await readFile(path.join(process.cwd(), "src", "app", "(app)", "layout.tsx"), "utf8");
  const page = await readFile(path.join(process.cwd(), "src", "app", "(app)", "settings", "layout.tsx"), "utf8");
  const navValues = [...layout.slice(layout.indexOf("const NAV_ITEMS"), layout.indexOf("] as const satisfies")).matchAll(/value: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(navValues[navValues.indexOf("content") + 1], "production");
  // BL-149 review: the sub-tab lists live in one plain module (section-tabs.ts) shared by the server pages and the client.
  const tabs = await readFile(path.join(process.cwd(), "src", "components", "section-tabs.ts"), "utf8");
  const subTabs = tabs.slice(tabs.indexOf("export const SETTINGS_SUB_TABS"), tabs.indexOf("export type ProductionTab"));
  // BL-152: the sub-tab name is an interface-text key; its English text is still "RunPod".
  assert.match(subTabs, /\{ value: "runpod", labelKey: "tabs\.settings\.runpod" \}/);
  assert.equal(translate("en", "tabs.settings.runpod"), "RunPod");
  assert.doesNotMatch(subTabs, /"media"/);
  const runpodBlock = page.slice(page.indexOf('settingsSubTab === "runpod"'), page.indexOf('settingsSubTab === "about"'));
  assert.match(runpodBlock, /<RunpodConnectionSettings \/>/);
  for (const card of ["SessionsCard", "JobsCard", "ModelsCard", "WorkflowTemplatesCard", "ComputeCard", "VolumeCard", "LimitsCard", "ProductionPanel"]) {
    assert.ok(!runpodBlock.includes(card), `${card} must not render under Settings → RunPod`);
  }
});

test("AC-P14-25: the balance header shows the GraphQL balance, or says the balance is unavailable and shows the v2 spend with the reason", () => {
  // BL-152: the header is translated; the requirement checked here is the English wording.
  const t = createTranslator("en");
  assert.deepEqual(describeBalance(t, { source: "graphql", balanceUsd: 12.72, spendPerHrUsd: 0.005, spendLimitUsd: 80 }), {
    headline: "$12.72",
    detail: "spending $0.005/h now · account spend limit $80.00/h",
  });
  const degraded = describeBalance(t, { source: "billing", balanceUsd: null, spentUsd: 3.75, podsUsd: 0.25, networkVolumesUsd: 3.5, from: "2026-09-05T00:00:00Z", to: "2026-10-06T00:00:00Z", balanceError: "RunPod GraphQL returned HTTP 500." });
  assert.equal(degraded.headline, "balance unavailable");
  assert.equal(degraded.detail, "RunPod spend (2026-09-05 – 2026-10-06): $3.75 (pods $0.25, network volumes $3.50). The balance read failed: RunPod GraphQL returned HTTP 500.");
});

// Owner, Telegram 2026-10-06 (msg 1793): Production → Models → "Models on the volume" refreshes by itself every time the
// Models tab is opened, without pressing the button. Every Production tab stays mounted (hidden by CSS), so "opened" is
// the tab becoming active, not the card mounting.
test("models on the volume: the Models tab tells the card it is active, and the card loads whenever it becomes active", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "production-panel.tsx"), "utf8");
  assert.match(panel, /<ModelsCard[^>]*active=\{tab === "models"\}/);
  const card = await readFile(path.join(process.cwd(), "src", "components", "media-generation-settings.tsx"), "utf8");
  const body = card.slice(card.indexOf("export function ModelsCard"), card.indexOf("const pulling = pulls.some"));
  assert.match(body, /export function ModelsCard\(\{ configured, active \}/);
  assert.match(body, /useEffect\(\(\) => \{\s*if \(!active \|\| !configured\) return;\s*void load\(\);\s*\}, \[active, configured, load\]\);/);
});

// Owner, Telegram 2026-10-06 (msgs 1804/1806): the media-generation readiness line ("Media generation is configured…" /
// "Not ready yet — missing…") shows only under Production → Setup, not above every tab.
test("readiness banner: rendered inside the Setup tab only, not above the tabs", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "production-panel.tsx"), "utf8");
  const render = panel.slice(panel.indexOf("<BalanceHeader"));
  assert.equal(render.match(/<ReadinessBanner /g)?.length, 1, "exactly one banner");
  const setup = render.slice(render.indexOf('tab === "setup"'));
  assert.ok(setup.slice(0, setup.indexOf("</div>")).includes("<ReadinessBanner "), "the banner is inside the Setup tab");
});

// Owner, Telegram 2026-10-06 (msgs 1807/1810): the "stop by itself" switch lives in Production → Setup → Limits as a saved
// setting, no longer in the Sessions request form.
test("release-when-done switch: in the Limits card (saved with the limits), not in the Sessions request form", async () => {
  const card = await readFile(path.join(process.cwd(), "src", "components", "media-generation-settings.tsx"), "utf8");
  const sessions = card.slice(card.indexOf("export function SessionsCard"), card.indexOf("export function", card.indexOf("export function SessionsCard") + 10));
  // BL-152: the switch's label is an interface-text key; the requirement checked here is the English wording.
  assert.equal(createTranslator("en")("media.limits.releaseToggle"), "Stop by itself when the jobs are done");
  assert.doesNotMatch(sessions, /Stop by itself when the jobs are done|media\.limits\.releaseToggle/);
  const limits = card.slice(card.indexOf("export function LimitsCard"), card.indexOf("export function FactoryLimitsCard"));
  assert.match(limits, /<ToggleSwitch label=\{t\("media\.limits\.releaseToggle"\)\} checked=\{ownerReleaseWhenDone\}/);
  // BL-150 review: the card sends only the fields that changed (onlyChangedSettings); the switch is still saved with the limits.
  assert.match(limits, /JSON\.stringify\(onlyChangedSettings\(\{[^}]*ownerReleaseWhenDone \}, settings\)\)/);
});

// BL-150 review: a Setup card sends only what the owner changed -- a value it merely shows (perhaps old, if the other computer
// changed it since the card loaded) is never re-sent and so never undoes the other computer's change.
test("onlyChangedSettings: only fields that differ from the settings the card shows are sent (plus any `keep`)", async () => {
  const { onlyChangedSettings } = await import("./media-generation-settings");
  const loaded = { maxUsdPerDay: 5, idleMinutes: 10, gpuFallbackIds: ["L4"], gpuTypeId: "A40" } as never;
  assert.deepEqual(onlyChangedSettings({ maxUsdPerDay: 5, idleMinutes: 15, gpuFallbackIds: ["L4"] }, loaded), { idleMinutes: 15 });
  assert.deepEqual(onlyChangedSettings({ gpuFallbackIds: ["A40", "L4"] }, loaded), { gpuFallbackIds: ["A40", "L4"] });
  assert.deepEqual(onlyChangedSettings({ gpuTypeId: "A40" }, loaded, ["gpuTypeId"]), { gpuTypeId: "A40" });
});
