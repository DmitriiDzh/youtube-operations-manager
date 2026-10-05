// The loopback guard is shared by every in-app MCP endpoint (channel agents and the Factory Operator),
// so it lives in its own module (`AGENTS.md` §M); this re-export keeps the original import path.
export { isLoopbackRequest } from "@/lib/loopback-guard";
