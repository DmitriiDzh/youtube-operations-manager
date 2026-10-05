#!/usr/bin/env node
// Generates published/<version>/ -- an allowlisted, self-contained release snapshot.
// See docs/decisions/0003-published-release-snapshots.md for why this exists, what it may
// contain, and when it is allowed to be committed directly on `main` (only immediately after an
// already-approved dev -> main release merge -- this script itself grants no such approval).
//
// Usage: node scripts/publish-snapshot.mjs [version] [--out <dir>] [--force]
//   version   Must exactly match package.json's "version" if given (a mismatch is refused, so a
//             typo can never mislabel a snapshot). Defaults to package.json's version.
//   --out     Write to this directory instead of published/<version> -- for testing outside the
//             repository tree, per AGENTS.md K.4 ("do not cut a release as an incidental side
//             effect of an unrelated task").
//   --force   Overwrite an existing output directory. published/<version>/ is otherwise
//             immutable once created (docs/decisions/0003-...md).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Allowlist, not blocklist (docs/decisions/0003-published-release-snapshots.md "Alternatives" #3)
// -- a future new top-level file/directory is excluded by default until deliberately added here.
const PUBLISHED_ALLOWLIST = [
  "src",
  "scripts",
  "public",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "eslint.config.mjs",
  "postcss.config.mjs",
  ".env.example",
  "README.md",
  "LICENSE",
  "docs/getting-started.md",
  "docs/interfaces.md",
  "docs/troubleshooting.md",
  "docs/RELEASE_LAYOUT.md",
  "docs/FIRST_LOCAL_TEST_BUILD.md",
];

function parseArgs(argv) {
  let version;
  let outDir;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      outDir = argv[++i];
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("--") && version === undefined) {
      version = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { version, outDir, force };
}

function copyAllowlistedPath(relPath, outDir) {
  const src = path.join(REPO_ROOT, relPath);
  const dest = path.join(outDir, relPath);
  if (!fs.existsSync(src)) {
    throw new Error(`Allowlisted path does not exist, refusing to produce an incomplete snapshot: ${relPath}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => path.basename(srcPath) !== ".DS_Store",
  });
}

function main() {
  const { version: requestedVersion, outDir: outDirArg, force } = parseArgs(process.argv.slice(2));

  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const version = packageJson.version;
  if (requestedVersion && requestedVersion !== version) {
    throw new Error(
      `Requested version "${requestedVersion}" does not match package.json's "${version}" -- ` +
        `bump package.json first, don't label a snapshot with a version it isn't.`
    );
  }

  const outDir = outDirArg
    ? path.resolve(outDirArg)
    : path.join(REPO_ROOT, "published", version);

  if (fs.existsSync(outDir) && !force) {
    throw new Error(
      `${outDir} already exists. A published version is immutable once created ` +
        `(docs/decisions/0003-published-release-snapshots.md) -- pass --force only if you ` +
        `explicitly intend to overwrite it.`
    );
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const relPath of PUBLISHED_ALLOWLIST) {
    copyAllowlistedPath(relPath, outDir);
  }

  const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  const buildInfo = {
    version,
    gitCommit,
    builtAt: new Date().toISOString(),
    node: process.version,
  };
  fs.writeFileSync(path.join(outDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

  console.log(`Published snapshot v${version} -> ${outDir}`);
  console.log(JSON.stringify(buildInfo, null, 2));
}

main();
