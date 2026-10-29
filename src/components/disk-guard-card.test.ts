import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { en } from "@/lib/ui-text/locales/en";
import { ru } from "@/lib/ui-text/locales/ru";
import { parseThresholdGb } from "./disk-guard-card";
import { gbLabel } from "./gb-label";

// BL-237: the «Диск» card -- the threshold is a number of GB from 1 to 10000 (the module's own range), typed in a plain text
// field (no locale-dependent number widget); sizes read as GB (10^9 bytes, one decimal); the card is its own failure domain
// on Servers → Sessions; the bell shows the low-disk notice and links to it.

const tEn = (key: string, vars: Record<string, string | number> = {}) => (en as Record<string, string>)[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));

test("the threshold field: whole or decimal GB from 1 to 10000, a comma accepted; anything else is not a value", () => {
  assert.equal(parseThresholdGb("20"), 20);
  assert.equal(parseThresholdGb(" 7,5 "), 7.5);
  assert.equal(parseThresholdGb("1"), 1);
  assert.equal(parseThresholdGb("10000"), 10_000);
  for (const bad of ["", "0", "0.5", "10001", "-5", "20GB", "1e3", "abc", "2.5.1"]) assert.equal(parseThresholdGb(bad), null, bad);
});

test("sizes are shown in GB of 10^9 bytes with one decimal", () => {
  assert.equal(gbLabel(tEn as never, 14_250_000_000), "14.3 GB");
  assert.equal(gbLabel(tEn as never, 0), "0.0 GB");
});

test("every disk text exists in English and Russian", () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("disk."));
  assert.ok(keys.length >= 20);
  for (const key of keys) assert.ok((ru as Record<string, string>)[key]?.length > 0, key);
});

test("Servers → Sessions renders the disk card inside its own FeatureErrorBoundary; the bell links low disk to it", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "production-panel.tsx"), "utf8");
  const sessions = panel.slice(panel.indexOf('tab === "sessions"'), panel.indexOf('tab === "analytics"'));
  assert.match(sessions, /<FeatureErrorBoundary[^>]*>\s*<DiskGuardCard \/>/);
  const bell = await readFile(path.join(process.cwd(), "src", "components", "device-sync-bell.tsx"), "utf8");
  assert.match(bell, /fetch\("\/api\/disk-guard\/notice"\)/);
  assert.match(bell, /DISK_HREF = "\/servers\/sessions"/);
  assert.match(bell, /diskNotice !== null/);
  assert.match(bell, /from "\.\/gb-label"/, "the bell does not import the card component");
});
