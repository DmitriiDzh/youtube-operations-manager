import { NextResponse } from "next/server";

// BL-116 -- the open page's heartbeat (src/components/server-presence.tsx). Its only job is to be an `/api/*`
// request: src/proxy.ts records every one as activity, which is what keeps the server from shutting itself down
// while a window is open. No session and no database on purpose: it must work on the login page, while the
// database is still starting, and never cost anything. GET: never gated by the mutation check.
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
