import { createMusicLibraryRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-229 part A: the active channel's music library per genre (read-only, from the factory's snapshot).
export const GET = createMusicLibraryRouteHandlers().get;
