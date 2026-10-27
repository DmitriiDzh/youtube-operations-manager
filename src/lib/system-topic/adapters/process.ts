import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunnerPort } from "../contracts";

// BL-228 (SYSTEM_TOPIC_PLAN.md §3, ADR 0053 §4): the factory's argv run directly -- never through a shell -- in its own process
// group (so a timeout ends everything it started, and never the Manager's own group). stdout and stderr are kept in the order they
// arrive, up to a cap. The child gets a small environment: the Manager's own variables (its secrets among them) never reach it.

/** The output kept (characters); the reply posts at most 3500 of it. */
const OUTPUT_CAP = 64 * 1024;
const ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL"];

export function childEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.PYTHONUNBUFFERED = "1";
  return env;
}

export const runFactoryProcess: ProcessRunnerPort = (argv, options) =>
  new Promise<ProcessResult>((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const timer: { id?: NodeJS.Timeout } = {};
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer.id);
      resolve(result);
    };
    const append = (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP) output += chunk.toString("utf8").slice(0, OUTPUT_CAP - output.length);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: childEnvironment() as NodeJS.ProcessEnv, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ output: "", exitCode: null, timedOut: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    timer.id = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => finish({ output, exitCode: null, timedOut, error: error.message }));
    child.on("close", (code) => finish({ output, exitCode: code, timedOut, error: null }));
  });
