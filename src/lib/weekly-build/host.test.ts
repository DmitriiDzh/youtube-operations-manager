import assert from "node:assert/strict";
import test from "node:test";
import { findPython, isSupportedPythonVersion, type RunScript } from "./host";
import { weeklyBuildSettingsFromJson, createWeeklyBuildSettings } from "./settings";
import { isDomainError } from "@/lib/shared-domain";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md §2/§4): Python 3.9+ is found -- a configured file is the only candidate when set.

const answering = (versions: Record<string, string>): RunScript => async (file) =>
  versions[file] !== undefined ? { exitCode: 0, stdout: versions[file], stderr: "", timedOut: false } : { exitCode: -1, stdout: "", stderr: "ENOENT", timedOut: false };

test("Python versions: 3.9 and newer only", () => {
  assert.equal(isSupportedPythonVersion("Python 3.12.4"), true);
  assert.equal(isSupportedPythonVersion("Python 3.9.0"), true);
  assert.equal(isSupportedPythonVersion("Python 3.8.10"), false);
  assert.equal(isSupportedPythonVersion("Python 2.7.18"), false);
  assert.equal(isSupportedPythonVersion("garbage"), false);
});

test("a configured Python is the only candidate; an unusable one is not replaced by another", async () => {
  const exists = async () => true;
  assert.equal(await findPython({ configured: "/opt/py/bin/python3", platform: "darwin", pathEnv: "", exists, run: answering({ "/opt/py/bin/python3": "Python 3.11.2", "/usr/bin/python3": "Python 3.12.0" }) }), "/opt/py/bin/python3");
  assert.equal(await findPython({ configured: "/opt/old/python3", platform: "darwin", pathEnv: "", exists, run: answering({ "/opt/old/python3": "Python 3.8.1", "/usr/bin/python3": "Python 3.12.0" }) }), null);
});

test("without a setting: the usual folders, then PATH; Windows looks for python.exe on PATH", async () => {
  const has = (files: string[]) => async (f: string) => files.includes(f);
  assert.equal(await findPython({ configured: null, platform: "darwin", pathEnv: "/x/bin", exists: has(["/usr/bin/python3", "/x/bin/python3"]), run: answering({ "/usr/bin/python3": "Python 3.9.6", "/x/bin/python3": "Python 3.13.0" }) }), "/usr/bin/python3");
  assert.equal(await findPython({ configured: null, platform: "darwin", pathEnv: "/x/bin", exists: has(["/x/bin/python3"]), run: answering({ "/x/bin/python3": "Python 3.13.0" }) }), "/x/bin/python3");
  assert.equal(await findPython({ configured: null, platform: "win32", pathEnv: 'C:\\Windows;"C:\\Py312"', exists: has(["C:\\Py312\\python.exe"]), run: answering({ "C:\\Py312\\python.exe": "Python 3.12.1" }) }), "C:\\Py312\\python.exe");
});

test("settings: absolute path or null; a bad stored value reads as null", async () => {
  assert.deepEqual(weeklyBuildSettingsFromJson(null), { pythonPath: null });
  assert.deepEqual(weeklyBuildSettingsFromJson("{bad"), { pythonPath: null });
  assert.deepEqual(weeklyBuildSettingsFromJson('{"pythonPath":"relative/python"}'), { pythonPath: null });
  let stored: string | null = null;
  const settings = createWeeklyBuildSettings({ getJson: async () => stored, setJson: async (json) => void (stored = json) });
  assert.deepEqual(await settings.update({ pythonPath: "C:\\Python312\\python.exe" }), { pythonPath: "C:\\Python312\\python.exe" });
  assert.deepEqual(await settings.get(), { pythonPath: "C:\\Python312\\python.exe" });
  await assert.rejects(settings.update({ pythonPath: "python3" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(settings.update({ pythonPath: "/x", extra: 1 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.deepEqual(await settings.update({ pythonPath: null }), { pythonPath: null });
});
