import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md §3): how the factory's Python scripts are run from the server -- never a shell, fixed
// arguments, a minimal environment (none of the server's own variables, which may hold secrets), a timeout; and where Python is
// found on this computer (the configured file, then the usual install folders, then PATH).

/** The variables a script runs with (exactly these, see `scriptEnv`). */
export type ScriptEnv = Record<string, string | undefined>;

export type ScriptResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

/** Runs `file args` in `cwd` with exactly `env`; resolves for any exit code (a spawn failure is exit -1). */
export type RunScript = (file: string, args: readonly string[], options: { cwd: string; env: ScriptEnv; timeoutMs: number }) => Promise<ScriptResult>;

export const runScript: RunScript = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve({ exitCode: 0, stdout, stderr, timedOut: false });
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null };
        // A kill for too much output is not a timeout (review #5).
        const timedOut = Boolean(err.killed && err.signal) && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        resolve({ exitCode: typeof err.code === "number" ? err.code : -1, stdout: stdout ?? "", stderr: stderr || err.message, timedOut });
      }
    );
  });

/** Folders with tools the builds call (ffmpeg, python) that a service's PATH may lack. */
const POSIX_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The variables a script gets: what it needs to find its tools and temp folders, nothing of the server's own. */
const KEPT_POSIX = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const KEPT_WIN32 = ["SystemRoot", "SYSTEMROOT", "windir", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ComSpec", "PATHEXT", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"];

export function scriptEnv(env: ScriptEnv, platform: NodeJS.Platform): ScriptEnv {
  const out: ScriptEnv = {};
  const kept = platform === "win32" ? KEPT_WIN32 : KEPT_POSIX;
  for (const name of kept) if (env[name] !== undefined) out[name] = env[name];
  const pathKey = platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (platform !== "win32") for (const dir of POSIX_TOOL_DIRS) if (!dirs.includes(dir)) dirs.push(dir);
  out[pathKey] = dirs.join(delimiter);
  out.PYTHONIOENCODING = "utf-8";
  out.PYTHONUTF8 = "1";
  return out;
}

const POSIX_PYTHONS = ["/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** "Python 3.12.4" -> true when 3.9 or newer (the factory launcher's minimum). */
export function isSupportedPythonVersion(output: string): boolean {
  const match = /Python\s+(\d+)\.(\d+)/.exec(output);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 9);
}

/** The Python to run the factory with, or null. A configured file is the only candidate when set (never silently another). */
export async function findPython(options: {
  configured: string | null;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  run?: RunScript;
  exists?: (file: string) => Promise<boolean>;
  env?: ScriptEnv;
}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runScript;
  const exists = options.exists ?? isExecutable;
  const paths = platform === "win32" ? path.win32 : path.posix;
  let candidates: string[];
  if (options.configured) {
    candidates = [options.configured];
  } else {
    const names = platform === "win32" ? ["python.exe", "python3.exe"] : ["python3"];
    const pathDirs = (options.pathEnv ?? process.env.PATH ?? "")
      .split(paths.delimiter)
      .map((dir) => (platform === "win32" ? dir.trim().replace(/^"(.*)"$/, "$1") : dir))
      .filter(Boolean);
    candidates = [...(platform === "win32" ? [] : POSIX_PYTHONS), ...pathDirs.flatMap((dir) => names.map((name) => paths.join(dir, name)))];
  }
  const env = scriptEnv(options.env ?? process.env, platform);
  for (const file of [...new Set(candidates)]) {
    if (!paths.isAbsolute(file) || !(await exists(file))) continue;
    const result = await run(file, ["--version"], { cwd: paths.dirname(file), env, timeoutMs: 15_000 });
    if (result.exitCode === 0 && isSupportedPythonVersion(`${result.stdout} ${result.stderr}`)) return file;
  }
  return null;
}
