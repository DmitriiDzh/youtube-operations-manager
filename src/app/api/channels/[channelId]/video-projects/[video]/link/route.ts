import { createVideoProjectsRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-221 «Привязать к видео»: GET the suggestions for a number uploaded outside the app; POST `{ videoId }` links it (a local file).
const handlers = createVideoProjectsRouteHandlers();
export const GET = handlers.linkSuggestions;
export const POST = handlers.link;
