import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 3 (owner decision D7): workflow templates are imported by the OPERATOR here; agents
// only list and use them (slice 5). A template is a technical ComfyUI graph plus declared
// parameters -- prompts arrive as job parameters, never live in a template.

export function createWorkflowTemplatesGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ templates: await core.listWorkflowTemplates() }));
}

export function createWorkflowTemplatesPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json({ template: await core.importWorkflowTemplate(body.body) }, { status: 201 });
  });
}

export const GET = createWorkflowTemplatesGetHandler();
export const POST = createWorkflowTemplatesPostHandler();
