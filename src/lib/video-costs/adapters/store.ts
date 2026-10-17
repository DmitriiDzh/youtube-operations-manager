import { listVideoCostGeminiJobs, listVideoCostRunpodJobs, listVideoCostSessionsWithoutJobs } from "@/lib/db";
import type { OwnRunRows } from "../contracts";

/** BL-194 stage 3: this computer's paid runs, read from its own tables (no prompt or parameter is selected). */
export async function readOwnRunRows(): Promise<OwnRunRows> {
  const [runpod, sessions, gemini] = await Promise.all([listVideoCostRunpodJobs(), listVideoCostSessionsWithoutJobs(), listVideoCostGeminiJobs()]);
  return { runpod, sessions, gemini };
}
