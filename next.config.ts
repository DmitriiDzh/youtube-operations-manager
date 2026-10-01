import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @automerge/automerge ships a WASM binary loaded via a Node-specific relative-file path at
  // require time (src/lib/change-drafts/) -- Next.js's default Server Components bundling
  // rewrites that path and breaks it ("ENOENT ... automerge_wasm_bg.wasm"), confirmed empirically
  // while building CD2's foundation (docs/roadmap/plans/AUTOMERGE_MIGRATION_PLAN.md). Opting it
  // out of bundling and using native Node `require` instead resolves the real on-disk path
  // correctly, exactly per this option's own documented purpose for a "Node.js specific
  // features" dependency.
  serverExternalPackages: ["@automerge/automerge"],
  experimental: {
    // `src/proxy.ts` matches every `/api/*` request, and Next buffers a proxied request body up to this
    // limit (default 10 MB) and TRUNCATES anything larger, which reaches the route as invalid JSON.
    // The in-app MCP endpoint receives XLSX workbooks as base64 inside the JSON-RPC body
    // (`localizationImportPreviewInputSchema.fileBase64` allows 34,000,000 characters), so the limit
    // must cover that schema maximum plus envelope (docs/decisions/0013-in-app-http-mcp-transport.md).
    // `/api/mcp` is deliberately NOT excluded from the proxy matcher: proxy.ts's `recordActivity()` is
    // what keeps idle auto-shutdown from stopping the server under an active agent.
    proxyClientMaxBodySize: "40mb",
  },
};

export default nextConfig;
