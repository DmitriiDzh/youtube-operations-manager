import { NextResponse } from "next/server";
import { bodyRecord, defaultMediaRouteDeps, mediaParamsHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

type Params = { templateId: string };

export function createWorkflowTemplateHandlers(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return {
    GET: mediaParamsHandler<Params>(deps, async ({ core, params }) => NextResponse.json({ template: await core.getWorkflowTemplate({ templateId: params.templateId }) })),
    PUT: mediaParamsHandler<Params>(deps, async ({ core, request, params }) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      return NextResponse.json({ template: await core.updateWorkflowTemplate({ ...bodyRecord(body.body), templateId: params.templateId }) });
    }),
    DELETE: mediaParamsHandler<Params>(deps, async ({ core, params }) => NextResponse.json(await core.deleteWorkflowTemplate({ templateId: params.templateId }))),
  };
}

const handlers = createWorkflowTemplateHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
