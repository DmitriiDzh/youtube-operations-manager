// ---------------------------------------------------------------------------
// BL-231 (docs/roadmap/plans/WEEKLY_BUILD_BUTTON_PLAN.md, FO-REQ-0046): «Собрать неделю» -- the factory's weekly build
// (`13 Weekly_Plan v1 auto`, bundle 2.5.42+) started, followed and stopped from the Web UI. The module runs the channel's own
// launcher `<workspace>/06 Workflows/factory_launch.py` with this computer's Python and reads its JSON; it never writes a
// plan of the Manager (the channel worker still pushes it) and has no MCP tool. No imports: the Web card reads its constants.
// ---------------------------------------------------------------------------

export const WEEKLY_PLAN_WORKFLOW = "13 Weekly_Plan v1";
/** The first bundle with `auto`, `status --json` and the launcher's `start --json`. */
export const MIN_BUNDLE_VERSION = "2.5.42";
export const WEEKLY_BUILD_DAYS_MIN = 1;
export const WEEKLY_BUILD_DAYS_MAX = 14;
export const WEEKLY_BUILD_DAYS_DEFAULT = 7;

/** Why the build cannot run here now; the card explains each. */
export type WeeklyBuildBlockCode = "workspace_missing" | "launcher_missing" | "bundle_too_old" | "python_missing" | "launcher_check_failed";

export type WeeklyBuildReadiness =
  | { ready: true; bundle: string; python: string }
  | { ready: false; code: WeeklyBuildBlockCode; message: string; bundle: string | null; python: string | null };

export type WeeklySlotStatus = "planned" | "building" | "built" | "packaged" | "failed" | "skipped";

/** One slot as `13 status --json` gives it (`date` = the actual date when the slot moved). */
export type WeeklyBuildSlot = {
  slotId: string;
  date: string;
  status: WeeklySlotStatus | string;
  video: string | null;
  folder: string | null;
  hours: number | null;
  problems: string[];
  retryable: boolean;
};

export type WeeklyBuildJob = {
  jobId: string;
  /** The launcher's own job_state(): running / done / failed / stopped (…) / starting. */
  state: string;
  args: string[];
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
};

export type WeeklyBuildStatus = {
  plan: { file: string; start: string | null; days: number } | null;
  /** STOP is set: a running build ends after the current video; a new start clears it first (`go`). */
  stopped: boolean;
  job: WeeklyBuildJob | null;
  packageRequest: { file: string | null; writtenAt: string | null; slots: string[]; pending: boolean } | null;
  slots: WeeklyBuildSlot[];
  /** The factory's one-line summary (`status --line`). */
  line: string | null;
};

export type WeeklyBuildView = {
  readiness: WeeklyBuildReadiness;
  /** null when not ready, or when the status could not be read (`statusError`). */
  status: WeeklyBuildStatus | null;
  statusError: string | null;
  /** A job is running or starting: the card refreshes on its own. */
  running: boolean;
};

export type WeeklyBuildStep = { step: "draft" | "run" | "package_request" | "wait" | string; text: string; slots: string[] };

/** `wake`: the dry run of «Разбудить агента» (`auto --wake`), confirmed like a start (it builds open slots too). */
export type WeeklyBuildDryRun = { days: number; wake: boolean; steps: WeeklyBuildStep[]; plan: string | null; stopped: boolean };

export type WeeklyBuildStarted = { jobId: string; log: string; pid: number | null; clearedStop: boolean };

export type WeeklyBuildSettings = { pythonPath: string | null };
