import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { isDomainError } from "@/lib/shared-domain";
import { scriptEnv, type RunScript, type ScriptResult } from "./host";
import { compareVersions, createWeeklyBuildServices, parseJsonOutput, type WeeklyBuildDeps } from "./services";

// BL-231 acceptance (WEEKLY_BUILD_BUTTON_PLAN.md "Acceptance", unit items 1-9). Expected argv and codes come from the plan and
// the factory's documented commands (FO-REQ-0046, Operator's answer of 2026-10-28), not from the implementation.

const PY = "/usr/bin/python3-fake";
const WF = "13 Weekly_Plan v1";

type Call = { file: string; args: string[]; cwd: string; env: Record<string, string | undefined> };

const ok = (stdout: string): ScriptResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

const STATUS = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    plan: { file: "plan-2026-11-02.json", start: "2026-11-02", days: 7 },
    stopped: false,
    job: null,
    packageRequest: null,
    slots: [
      { slotId: "2026-11-02-1", date: "2026-11-02", status: "built", video: "V70", folder: "04 Videos/11 November/1102 V70", hours: 3, problems: [], retryable: false },
      { slotId: "2026-11-03-1", date: "2026-11-03", status: "failed", video: null, folder: null, hours: 3, problems: ["no free scene"], retryable: true },
    ],
    line: "plan-2026-11-02: собрано 1 (нужна упаковка), ошибка 1",
    ...overrides,
  });

async function channel(bundle: string | null = "2.5.42") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ytm-weekly-build-")));
  const ws = path.join(root, "01 Channel");
  await mkdir(path.join(ws, "06 Workflows"), { recursive: true });
  await writeFile(path.join(ws, "06 Workflows", "factory_launch.py"), "# launcher\n");
  if (bundle !== null) await writeFile(path.join(ws, "06 Workflows", "factory.json"), JSON.stringify({ format: 1, workflow_bundle: bundle }));
  return { root, ws, launcher: path.join(ws, "06 Workflows", "factory_launch.py"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function harness(ws: string | null, answer: (args: string[]) => ScriptResult) {
  const calls: Call[] = [];
  const run: RunScript = async (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd, env: options.env });
    return answer([...args].slice(2));
  };
  const deps: WeeklyBuildDeps = {
    getWorkspace: async () => (ws ? { configured: true, path: ws } : { configured: false }),
    getSettings: async () => ({ pythonPath: null }),
    findPython: async () => PY,
    run,
    env: () => scriptEnv({ PATH: "/usr/bin", HOME: "/Users/x", YTM_SECRET: "s3cret", AUTH_SECRET: "a" }, "darwin"),
    fs: {
      realpath: (p) => realpath(p),
      stat: async (p) => {
        const s = await stat(p);
        return { isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
      },
      readFile: (p) => readFile(p, "utf8"),
    },
    isPathInsideOrEqual,
    now: () => 1_000,
  };
  return { calls, core: createWeeklyBuildServices(deps), deps };
}

/** A factory that answers the documented commands. */
function factory(options: { stopped?: boolean; check?: ScriptResult; start?: ScriptResult; status?: string } = {}) {
  return (args: string[]): ScriptResult => {
    if (args[0] === "check") return options.check ?? ok("OK\n");
    if (args[0] === "run" && args[2] === "status") return ok(options.status ?? STATUS({ stopped: options.stopped ?? false }));
    if (args[0] === "run" && args[2] === "go") return ok("STOP removed\n");
    if (args[0] === "run" && args[2] === "stop") return ok("STOP set\n");
    if (args[0] === "run" && args[2] === "auto") return ok(JSON.stringify({ steps: [{ step: "run", text: "build 1 slot(s)", slots: ["2026-11-03-1"] }], plan: "plan-2026-11-02.json" }));
    if (args[0] === "start") return options.start ?? ok(JSON.stringify({ jobId: "20261028-140000-13-Weekly-Plan-v1", log: "/x/j.log", pid: 4242 }));
    return { exitCode: 2, stdout: "", stderr: `unexpected ${args.join(" ")}`, timedOut: false };
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string, detailsCode?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isDomainError(error), String(error));
    assert.equal(error.code, code);
    if (detailsCode) assert.equal((error.details as { code?: string }).code, detailsCode);
    return true;
  });
}

test("1: no workspace -> workspace_missing, nothing is run", async () => {
  const h = harness(null, factory());
  const view = await h.core.view("UC1");
  assert.equal(view.readiness.ready, false);
  assert.equal(!view.readiness.ready && view.readiness.code, "workspace_missing");
  assert.equal(h.calls.length, 0);
});

test("2: bundle versions -- 2.5.39, missing, malformed -> bundle_too_old; 2.5.42, 2.5.100, 2.6.0 -> ready", async () => {
  for (const [bundle, ready] of [["2.5.39", false], [null, false], ["2.5.x", false], ["2.5.42", true], ["2.5.100", true], ["2.6.0", true]] as const) {
    const c = await channel(bundle);
    try {
      const h = harness(c.ws, factory());
      const view = await h.core.view("UC1");
      assert.equal(view.readiness.ready, ready, `bundle ${bundle}`);
      if (!ready) {
        assert.equal(!view.readiness.ready && view.readiness.code, "bundle_too_old");
        assert.equal(h.calls.length, 0);
      }
    } finally {
      await c.cleanup();
    }
  }
  assert.equal(compareVersions("2.5.42", "2.5.42"), 0);
  assert.equal(compareVersions("2.5.9", "2.5.42"), -1);
});

test("3: a launcher symlinked outside the workspace -> launcher_missing", async () => {
  const c = await channel();
  try {
    const outside = path.join(c.root, "evil.py");
    await writeFile(outside, "# evil\n");
    await rm(c.launcher);
    await symlink(outside, c.launcher);
    const h = harness(c.ws, factory());
    const view = await h.core.view("UC1");
    assert.equal(!view.readiness.ready && view.readiness.code, "launcher_missing");
    assert.equal(h.calls.length, 0);
  } finally {
    await c.cleanup();
  }
});

test("4: check exit 1 -> launcher_check_failed; dry run, start and stop refused with weekly_build_unavailable", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory({ check: { exitCode: 1, stdout: "launcher differs from the bundle template", stderr: "", timedOut: false } }));
    const view = await h.core.view("UC1");
    assert.equal(!view.readiness.ready && view.readiness.code, "launcher_check_failed");
    await rejectsWith(h.core.dryRun("UC1", { days: 7 }), "weekly_build_unavailable", "launcher_check_failed");
    await rejectsWith(h.core.start("UC1", { days: 7 }), "weekly_build_unavailable", "launcher_check_failed");
    await rejectsWith(h.core.stop("UC1"), "weekly_build_unavailable", "launcher_check_failed");
    assert.ok(h.calls.every((call) => call.args[2] === "check"));
  } finally {
    await c.cleanup();
  }
});

test("5: start runs exactly the documented argv in the workspace; wake adds --wake; STOP set runs go first", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory());
    const started = await h.core.start("UC1", { days: 7 });
    assert.equal(started.jobId, "20261028-140000-13-Weekly-Plan-v1");
    assert.equal(started.clearedStop, false);
    const start = h.calls.find((call) => call.args[2] === "start")!;
    assert.equal(start.file, PY);
    assert.deepEqual(start.args, ["-B", c.launcher, "start", WF, "auto", "--days", "7", "--json"]);
    assert.equal(start.cwd, c.ws);

    const h2 = harness(c.ws, factory());
    await h2.core.start("UC1", { days: 7, wake: true });
    assert.deepEqual(h2.calls.find((call) => call.args[2] === "start")!.args, ["-B", c.launcher, "start", WF, "auto", "--days", "7", "--wake", "--json"]);

    const h3 = harness(c.ws, factory({ stopped: true }));
    const again = await h3.core.start("UC1", { days: 7 });
    assert.equal(again.clearedStop, true);
    const order = h3.calls.map((call) => call.args.slice(2, 5).join(" "));
    assert.ok(order.indexOf(`run ${WF} go`) >= 0 && order.indexOf(`run ${WF} go`) < order.findIndex((o) => o.startsWith("start")), order.join(" | "));
  } finally {
    await c.cleanup();
  }
});

test("6: days 0, 15, 7.5, \"7\" -> validation_failed, nothing is run", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory());
    for (const days of [0, 15, 7.5, "7"]) {
      await rejectsWith(h.core.start("UC1", { days }), "validation_failed");
      await rejectsWith(h.core.dryRun("UC1", { days }), "validation_failed");
    }
    assert.equal(h.calls.length, 0);
  } finally {
    await c.cleanup();
  }
});

test("7: start answering job_running -> weekly_build_job_running with the job id", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory({ start: { exitCode: 1, stdout: JSON.stringify({ error: "job_running", jobId: "J", device: "D" }), stderr: "", timedOut: false } }));
    await assert.rejects(h.core.start("UC1", { days: 7 }), (error: unknown) => {
      assert.ok(isDomainError(error));
      assert.equal(error.code, "weekly_build_job_running");
      assert.equal((error.details as { jobId: string }).jobId, "J");
      return true;
    });
    // a job the status already shows as running: refused before any start
    const h2 = harness(c.ws, factory({ status: STATUS({ job: { jobId: "J2", state: "running", args: [], startedAt: "x", finishedAt: null, exitCode: null } }) }));
    await rejectsWith(h2.core.start("UC1", { days: 7 }), "weekly_build_job_running");
    assert.equal(h2.calls.filter((call) => call.args[2] === "start").length, 0);
  } finally {
    await c.cleanup();
  }
});

test("8: an unreadable status keeps readiness ready, with statusError", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory({ status: "Traceback (most recent call last):\n  boom" }));
    const view = await h.core.view("UC1");
    assert.equal(view.readiness.ready, true);
    assert.equal(view.status, null);
    assert.ok(view.statusError);
    const good = await harness(c.ws, factory()).core.view("UC1");
    assert.equal(good.status?.slots.length, 2);
    assert.deepEqual(good.status?.slots[1].problems, ["no free scene"]);
    assert.equal(good.running, false);
  } finally {
    await c.cleanup();
  }
});

test("9: the script's environment has none of the server's own variables", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory());
    await h.core.view("UC1");
    for (const call of h.calls) {
      assert.equal(call.env.YTM_SECRET, undefined);
      assert.equal(call.env.AUTH_SECRET, undefined);
      assert.equal(call.env.HOME, "/Users/x");
      assert.ok(String(call.env.PATH).split(":").includes("/opt/homebrew/bin"));
    }
    const win = scriptEnv({ Path: "C:\\Python312", SystemRoot: "C:\\Windows", NEXTAUTH_SECRET: "x" }, "win32");
    assert.deepEqual(Object.keys(win).sort(), ["PYTHONIOENCODING", "PYTHONUTF8", "Path", "SystemRoot"]);
  } finally {
    await c.cleanup();
  }
});

test("check is run once while the launcher is unchanged", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory());
    await h.core.view("UC1");
    await h.core.view("UC1");
    assert.equal(h.calls.filter((call) => call.args[2] === "check").length, 1);
  } finally {
    await c.cleanup();
  }
});

test("parseJsonOutput takes the last line when text precedes the JSON", () => {
  assert.deepEqual(parseJsonOutput('auto: something\n{"jobId":"A"}\n'), { jobId: "A" });
  assert.equal(parseJsonOutput("not json"), null);
  assert.equal(parseJsonOutput("[1,2]"), null);
});

test("review #1/#9: the wake dry run passes --wake; a missing Python is looked up again next time", async () => {
  const c = await channel();
  try {
    const h = harness(c.ws, factory());
    const dry = await h.core.dryRun("UC1", { days: 7, wake: true });
    assert.equal(dry.wake, true);
    assert.deepEqual(h.calls.find((call) => call.args[4] === "auto")!.args, ["-B", c.launcher, "run", WF, "auto", "--days", "7", "--dry-run", "--wake", "--json"]);
    let lookups = 0;
    const missing = createWeeklyBuildServices({ ...h.deps, findPython: async () => (lookups++, null) });
    await missing.view("UC1");
    await missing.view("UC1");
    assert.equal(lookups, 2);
  } finally {
    await c.cleanup();
  }
});
