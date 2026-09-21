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
};

export default nextConfig;
