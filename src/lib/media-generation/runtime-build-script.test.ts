import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// BL-230 (PRIVATE_RUNTIME_REPOS_PLAN.md AC-PR-14/15): the build script's own functions, sourced, against a local bare repository.
// A `git` shim records every argument list and maps the https URLs to that repository (insteadOf), so no network is touched. The
// expected header is computed here from the rule (base64 of "x-access-token:<token>"), not read from the script.

const SCRIPT = path.join(process.cwd(), "scripts", "media", "pod", "runtime-build.sh");
const TOKEN = "github_pat_" + "A1b2C3d4E5".repeat(8) + "_xy";
const HEADER = `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const REAL_GIT = (() => {
  try {
    return execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ytm-bl230-"));
  const work = path.join(dir, "work");
  const bare = path.join(dir, "bare.git");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync(REAL_GIT, ["init", "-q", work], { env });
  writeFileSync(path.join(work, "nodes.py"), "NODE_CLASS_MAPPINGS = {}\n");
  execFileSync(REAL_GIT, ["-C", work, "add", "."], { env });
  execFileSync(REAL_GIT, ["-C", work, "commit", "-q", "-m", "one"], { env });
  const sha = execFileSync(REAL_GIT, ["-C", work, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
  execFileSync(REAL_GIT, ["clone", "-q", "--bare", work, bare], { env });
  const shim = path.join(dir, "bin");
  mkdirSync(shim);
  const log = path.join(dir, "git.log");
  writeFileSync(
    path.join(shim, "git"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> '${log}'`,
      `exec '${REAL_GIT}' -c 'url.file://${bare}.insteadOf=https://github.com/owner/private-nodes' -c 'url.file://${bare}.insteadOf=https://example.com/owner/nodes' -c protocol.file.allow=always "$@"`,
      "",
    ].join("\n")
  );
  chmodSync(path.join(shim, "git"), 0o755);
  return { dir, sha, log, env: { ...env, PATH: `${shim}:${process.env.PATH ?? ""}` } };
}

/** Sources the script (it stops before touching /workspace) and runs one command line with its functions. */
function run(env: NodeJS.ProcessEnv, command: string) {
  return spawnSync("bash", ["-c", `source '${SCRIPT}'; ${command}`], { env, encoding: "utf8" });
}

const skip = !REAL_GIT ? "git is not installed" : false;

test("AC-PR-14: with YTM_GIT_TOKEN a github.com fetch gets the one-shot header; the checkout is at the commit; .git/config holds no credential", { skip }, () => {
  const f = fixture();
  try {
    const dest = path.join(f.dir, "dest");
    const result = run({ ...f.env, YTM_GIT_TOKEN: TOKEN }, `clone_at https://github.com/owner/private-nodes ${f.sha} '${dest}'`);
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(f.log, "utf8").split("\n").filter(Boolean);
    const network = calls.filter((c) => / (fetch|clone) /.test(` ${c} `));
    assert.ok(network.length >= 1, calls.join("\n"));
    for (const call of network) assert.ok(call.startsWith(`-c ${HEADER} `), call);
    // Only the network commands carry it (init, remote add, checkout do not).
    assert.equal(calls.filter((c) => c.includes(TOKEN)).length, 0, "the raw token never reaches git's arguments");
    assert.equal(calls.filter((c) => c.includes("extraheader")).length, network.length);
    assert.equal(execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { env: f.env, encoding: "utf8" }).trim(), f.sha);
    const config = readFileSync(path.join(dest, ".git", "config"), "utf8");
    assert.ok(!config.includes(TOKEN) && !config.includes("extraheader") && !config.includes(HEADER.split("basic ")[1]), config);
    assert.match(config, /url = https:\/\/github\.com\/owner\/private-nodes\n/);
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("AC-PR-14: another host, or no YTM_GIT_TOKEN, gets no header", { skip }, () => {
  const f = fixture();
  try {
    const other = run({ ...f.env, YTM_GIT_TOKEN: TOKEN }, `clone_at https://example.com/owner/nodes ${f.sha} '${path.join(f.dir, "a")}'`);
    assert.equal(other.status, 0, other.stderr);
    const none = run({ ...f.env, YTM_GIT_TOKEN: "" }, `clone_at https://github.com/owner/private-nodes ${f.sha} '${path.join(f.dir, "b")}'`);
    assert.equal(none.status, 0, none.stderr);
    const log = readFileSync(f.log, "utf8");
    assert.ok(!log.includes("extraheader") && !log.includes(TOKEN), log);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("AC-PR-15: the leak check fails on the token or its header form anywhere in the folder, passes on a clean one, prints nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ytm-bl230-leak-"));
  try {
    const clean = path.join(dir, "clean");
    mkdirSync(path.join(clean, "ComfyUI", "custom_nodes", "x"), { recursive: true });
    writeFileSync(path.join(clean, "build.log"), "[3s] node x@abc\n");
    writeFileSync(path.join(clean, "ComfyUI", "custom_nodes", "x", "nodes.py"), "pass\n");
    const raw = path.join(dir, "raw");
    mkdirSync(path.join(raw, "ComfyUI", "custom_nodes", "x", ".git"), { recursive: true });
    writeFileSync(path.join(raw, "ComfyUI", "custom_nodes", "x", ".git", "config"), `[remote "origin"]\n\turl = https://x-access-token:${TOKEN}@github.com/o/r\n`);
    const header = path.join(dir, "header");
    mkdirSync(header);
    writeFileSync(path.join(header, "build.log"), `trace: AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}\n`);

    const env = { ...process.env, YTM_GIT_TOKEN: TOKEN };
    for (const [folder, expected] of [[clean, 0], [raw, 1], [header, 1]] as const) {
      const result = run(env, `leak_free '${folder}'`);
      assert.equal(result.status, expected, folder);
      assert.equal(result.stdout + result.stderr, "", "the check prints nothing");
    }
    assert.equal(run({ ...process.env, YTM_GIT_TOKEN: "" }, `leak_free '${raw}'`).status, 0, "no token given: nothing to look for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-PR-14: the script unsets YTM_GIT_TOKEN after the clones, checks the folder before .ready, and never puts the token in a URL", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const unset = text.indexOf("unset YTM_GIT_TOKEN");
  assert.ok(unset > text.indexOf("done < <(spec nodes)") && unset < text.indexOf('"$R/venv/bin/python" -m pip install'), "unset between the clones and pip");
  assert.ok(text.indexOf('leak_free "$R" || finish false') < text.indexOf('touch "$R/.ready"'), "leak check before .ready");
  assert.ok(!/@github\.com/.test(text), "no credential in a URL");
  assert.ok(!/\bexport\s+GUARD_TOKEN/.test(text), "the leak-check copy is never exported");
});
