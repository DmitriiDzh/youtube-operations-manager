import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-248 (REVIEW_NOTIFY_PLAN.md §10, AC-RN-14; AGENTS.md §M): review-notify is a shared module -- it imports no feature module and no
// database; the feature modules know it only through the nudge their own index.ts injects, and only the composition layer wires
// its sources. No network and no Google client either.

const SRC = path.resolve(process.cwd(), "src");
const FEATURE_MODULES = ["clip-reviews", "storyboards", "storyboard-takes", "generation-plans", "publishing", "publishing-plans", "media-generation", "gemini-media", "live-streams", "batches", "changesets", "video-details", "channel-branding", "channel-localizations"];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("AC-RN-14: review-notify imports no feature module, no db.ts, no sync family, no network", async () => {
  const offenders: string[] = [];
  for (const file of await files(path.join(SRC, "lib", "review-notify"))) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(SRC, file);
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(`${rel} (feature module)`);
    if (/from\s+["']@\/lib\/(db|sync-gateway)(\/|["'])/.test(text)) offenders.push(`${rel} (database)`);
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway/.test(text)) offenders.push(`${rel} (network)`);
  }
  assert.deepEqual(offenders, []);
});

test("§10: a feature module reaches review-notify only from its own index.ts, and only the nudge", async () => {
  const offenders: string[] = [];
  for (const module of FEATURE_MODULES) {
    for (const file of await files(path.join(SRC, "lib", module))) {
      const text = await readFile(file, "utf8");
      const match = text.match(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/review-notify["']/);
      if (!match && !text.includes("@/lib/review-notify")) continue;
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (!rel.endsWith("/index.ts")) offenders.push(`${rel} (not the module's index.ts)`);
      const names = (match?.[1] ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      if (names.some((n) => n !== "nudgeReviewNotify")) offenders.push(`${rel}: ${names.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, []);
});
