import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// BL-266 (owner TG 4730/4732): the «Ролики и релизы» tab is removed without losing a function. Its four parts each have one new home:
// the videos board, the packages and the uploads on «План» (PlanExtras), the publishing settings and the local copy cleanup in
// Settings → Channels -- each in its own error boundary (AGENTS.md §M). Read from the source, like the other inventory tests.

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const settingsLayout = read("src/app/(app)/settings/layout.tsx");
const contentLayout = read("src/app/(app)/content/layout.tsx");
const planExtras = read("src/components/plan-extras.tsx");

/** The JSX between the opening of the settings sub-tab's own div and the next sub-tab's. */
function settingsPane(sub: string): string {
  const start = settingsLayout.indexOf(`<div className={settingsSubTab === "${sub}" ?`);
  assert.ok(start >= 0, `settings pane ${sub}`);
  const next = settingsLayout.indexOf("<div className={settingsSubTab === ", start + 10);
  return settingsLayout.slice(start, next < 0 ? undefined : next);
}

/** `<Component` appears inside a FeatureErrorBoundary of its own (the nearest opening boundary before it closes after it). */
function inOwnBoundary(source: string, component: string): boolean {
  const at = source.search(new RegExp(`<${component}\\s`));
  if (at < 0) return false;
  const open = source.lastIndexOf("<FeatureErrorBoundary", at);
  const closeBefore = source.lastIndexOf("</FeatureErrorBoundary>", at);
  const closeAfter = source.indexOf("</FeatureErrorBoundary>", at);
  return open >= 0 && open > closeBefore && closeAfter > at && source.slice(open, closeAfter).split(new RegExp(`<${component}\\s`)).length === 2;
}

test("BL-266: the publishing settings and the local copy cleanup render in Settings → Channels, each in its own boundary, for the active channel", () => {
  const pane = settingsPane("channels");
  for (const component of ["PublishingSettingsPanel", "LocalVideoCleanupCard"]) {
    assert.ok(pane.includes(`<${component} channelId={channel.id} visible={settingsSubTab === "channels"} />`), component);
    assert.ok(inOwnBoundary(pane, component), `${component} in its own FeatureErrorBoundary`);
  }
  // The cards say which channel they set, and remount for another one.
  assert.match(pane, /key=\{channel\.id\}/);
  assert.match(pane, /planExtras\.settings\.channel/);
});

test("BL-266: Content no longer mounts the former tab's panels itself; «План» carries the board, the packages and the uploads", () => {
  for (const component of ["PublishingSettingsPanel", "LocalVideoCleanupCard", "PublishingPackages", "VideoProjectsPanel"]) assert.ok(!contentLayout.includes(`<${component}`), component);
  assert.ok(contentLayout.includes("<PlanExtras "), "PlanExtras on «План»");
  assert.ok(inOwnBoundary(contentLayout, "PlanExtras"), "PlanExtras in its own boundary");
  for (const component of ["VideoProjectsPanel", "PublishingUploads", "PublishingPackages"]) assert.ok(inOwnBoundary(planExtras, component), `${component} in its own boundary`);
  // The packages on «План» do not list the uploads twice (the queue line is that list).
  assert.match(planExtras, /<PublishingPackages[\s\S]*?showUploads=\{false\}/);
});

test("BL-266: the «Ролики и релизы» badge is counted on «План»; no tab is named publishing", () => {
  assert.match(contentLayout, /item\.value === "week-plan" && badges\.releases > 0/);
  assert.ok(!contentLayout.includes('"publishing"'));
});

test("BL-266 review: both «⋯» settings links land on an anchor around their moved card in Settings → Channels", () => {
  const pane = settingsPane("channels");
  for (const [anchor, component] of [
    ["PUBLISHING_SETTINGS_ANCHOR", "PublishingSettingsPanel"],
    ["LOCAL_CLEANUP_ANCHOR", "LocalVideoCleanupCard"],
  ] as const) {
    const at = pane.indexOf(`id={${anchor}}`);
    assert.ok(at >= 0 && pane.indexOf(`<${component} `, at) > at, `${anchor} wraps ${component}`);
    assert.ok(planExtras.includes(`href={\`/settings/channels#\${${anchor}}\`}`), `link to ${anchor}`);
  }
});

test("BL-266 review (BL-270): the uploads list and the bandwidth note poll only while shown and the browser tab is visible", () => {
  const uploads = read("src/components/publishing-uploads.tsx");
  const note = read("src/components/upload-bandwidth-note.tsx");
  for (const [name, source] of [
    ["publishing-uploads", uploads],
    ["upload-bandwidth-note", note],
  ] as const) {
    assert.ok(!/setInterval\(/.test(source), `${name}: no plain setInterval`);
    assert.match(source, /startVisibleInterval\(/, name);
    assert.match(source, /if \(!visible\) return;/, name);
  }
  assert.match(uploads, /<UploadBandwidthNote visible=\{visible\} \/>/);
});
