import { NextResponse } from "next/server";
import { z } from "zod";
import { imageFileNames } from "@/lib/spend-analytics";

// BL-219 (SERVERS_ANALYTICS_PLAN.md AC-SA-09): a small JPEG of one image output of THIS computer's RunPod or Gemini job, for the
// history's previews. The file is found only inside the job's own `99 Data Exchange/From YTM/<media|gemini>/<job>/` folder of its
// channel's workspace (the shared resolver); anything else is 404. Read-only.

export type PreviewDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  jobOutputs: (source: "runpod" | "gemini", jobId: string) => Promise<{ channelId: string; outputsJson: string | null } | null>;
  workspaceOf: (channelId: string) => Promise<string | null>;
  /** Resolves `fileName` (relative to the job folder, "/"-separated) inside the job's From YTM folder; throws when it is not there. */
  resolveJobFile: (workspace: string, subdir: "media" | "gemini", jobFolder: string, fileName: string) => Promise<{ path: string }>;
  preview: (path: string) => Promise<Uint8Array | null>;
  readFile: (path: string) => Promise<Uint8Array>;
};

const querySchema = z
  .object({ source: z.enum(["runpod", "gemini"]), jobId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), index: z.string().regex(/^\d{1,2}$/).default("0") })
  .strict();

/** The same rule as the history's preview count (one rule, two places would drift). */
export { imageFileNames as imageFiles } from "@/lib/spend-analytics";

export function createPreviewHandler(deps: PreviewDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    if (!parsed.success) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
    const { source, jobId } = parsed.data;
    const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      const job = await deps.jobOutputs(source, jobId);
      const file = job ? imageFileNames(job.outputsJson)[Number(parsed.data.index)] : undefined;
      if (!job || !file) return notFound();
      const workspace = await deps.workspaceOf(job.channelId);
      if (!workspace) return notFound();
      const resolved = await deps.resolveJobFile(workspace, source === "runpod" ? "media" : "gemini", jobId, file).catch(() => null);
      if (!resolved) return notFound();
      const small = await deps.preview(resolved.path);
      const body = small ?? (await deps.readFile(resolved.path));
      const type = small ? "image/jpeg" : file.toLowerCase().endsWith(".png") ? "image/png" : file.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
      return new Response(body as BodyInit, { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
    } catch {
      return notFound();
    }
  };
}
