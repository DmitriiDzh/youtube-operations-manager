import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { mediaErrorResponse, readJsonBody } from "../../shared";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<MediaGenerationCore, "getWorkflowTemplate" | "updateWorkflowTemplate" | "deleteWorkflowTemplate">;
};

let defaultCore: MediaGenerationCore | null = null;
const defaultDeps = (): Deps => ({
  getSession: () => getServerSession(authOptions),
  get core() {
    defaultCore ??= createMediaGenerationCore();
    return defaultCore;
  },
});

export function createWorkflowTemplateHandlers(deps: Deps = defaultDeps()) {
  const withSession = async (run: (templateId: string) => Promise<NextResponse>, params: Promise<{ templateId: string }>) => {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run((await params).templateId);
    } catch (error) {
      return mediaErrorResponse(error);
    }
  };
  return {
    GET: (_request: Request, { params }: { params: Promise<{ templateId: string }> }) =>
      withSession(async (templateId) => NextResponse.json({ template: await deps.core.getWorkflowTemplate({ templateId }) }), params),
    PUT: (request: Request, { params }: { params: Promise<{ templateId: string }> }) =>
      withSession(async (templateId) => {
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const patch = body.body && typeof body.body === "object" ? (body.body as Record<string, unknown>) : {};
        return NextResponse.json({ template: await deps.core.updateWorkflowTemplate({ ...patch, templateId }) });
      }, params),
    DELETE: (_request: Request, { params }: { params: Promise<{ templateId: string }> }) =>
      withSession(async (templateId) => NextResponse.json(await deps.core.deleteWorkflowTemplate({ templateId })), params),
  };
}

const handlers = createWorkflowTemplateHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
