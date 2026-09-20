#!/usr/bin/env node
// Runs automatically before `npm run build`/`npm run dev` (npm's `pre<script>` convention) and
// writes public/build-info.json, so the Settings tab can show which commit/version is actually
// running -- captured at build time, not read live at request time, because the two can
// genuinely differ (e.g. a `git pull` succeeded but the rebuild step failed or was skipped --
// see docs/FIRST_LOCAL_TEST_BUILD.md's start.sh/start.bat auto-update). Shape mirrors
// scripts/publish-snapshot.mjs's build-info.json exactly ({ version, gitCommit, builtAt, node }).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  } catch {
    // Not a git checkout -- e.g. a standalone published/<version>/ copy (docs/decisions/0003),
    // which never contains .git by design. Fall back to the build-info.json that
    // publish-snapshot.mjs already wrote at this same directory's root for that case.
    try {
      const published = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "build-info.json"), "utf8"));
      return typeof published.gitCommit === "string" ? published.gitCommit : null;
    } catch {
      return null;
    }
  }
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const buildInfo = {
    version: packageJson.version,
    gitCommit: resolveGitCommit(),
    builtAt: new Date().toISOString(),
    node: process.version,
  };

  const outDir = path.join(REPO_ROOT, "public");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
}

main();
