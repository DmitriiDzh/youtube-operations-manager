import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

export function createTemplatesGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const templates = await core.listTemplates();
    return NextResponse.json({ templates: templates.map((t) => ({ id: t.id, name: t.name })) });
  });
}

export const GET = createTemplatesGetHandler();
