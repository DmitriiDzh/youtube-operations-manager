import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import type { WeeklyBuildSettings } from "./contracts";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md §4): this computer's Python for the factory scripts (its local database, like the
// ffmpeg folder of the live streams). Only the owner's Settings set it -- never a project file or an agent.

const settingsSchema = z
  .object({
    pythonPath: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((p) => path.isAbsolute(p) || path.win32.isAbsolute(p), "an absolute path to the Python program")
      .nullable(),
  })
  .strict();

export function weeklyBuildSettingsFromJson(json: string | null): WeeklyBuildSettings {
  try {
    const parsed = settingsSchema.safeParse(json ? JSON.parse(json) : {});
    return { pythonPath: parsed.success ? parsed.data.pythonPath : null };
  } catch {
    return { pythonPath: null };
  }
}

export function createWeeklyBuildSettings(deps: { getJson(): Promise<string | null>; setJson(json: string): Promise<void> }) {
  return {
    async get(): Promise<WeeklyBuildSettings> {
      return weeklyBuildSettingsFromJson(await deps.getJson());
    },
    async update(input: unknown): Promise<WeeklyBuildSettings> {
      const next = parseWithSchema(settingsSchema, input, "weekly build settings");
      await deps.setJson(JSON.stringify(next));
      return next;
    },
  };
}
