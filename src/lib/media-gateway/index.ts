// ---------------------------------------------------------------------------
// Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md §2.1) -- the media gateway: a thin umbrella over
// three children, one per external API product (the same barrel + inventory-test shape as
// `src/lib/youtube-read-gateway/`, AGENTS.md §G "single gateway per API category"):
//   - `runpod-api.ts`   RunPod REST API v2 (pods, catalog, network volumes, templates)
//   - `runpod-s3.ts`    RunPod's S3-compatible access to a network volume (SigV4 in `sigv4.ts`)
//   - `comfyui-api.ts`  the ComfyUI server on a pod, through RunPod's HTTP proxy (`comfyui-progress.ts`: its
//                       websocket execution events, BL-144)
//   - `huggingface.ts`  the Hugging Face Hub metadata a model pull is checked against (BL-132)
//   - `gemini-api.ts`   Google's Gemini API: Nano Banana images, Veo video, the video download, a key check (BL-174)
// Every child checks the one "Media gateway" toggle and records a traffic event
// (`authorization.ts`); `inventory.test.ts` fails the suite if any other file reaches a
// runpod.io host. Callers import only from this barrel.
// ---------------------------------------------------------------------------

export * from "./authorization";
export * from "./runpod-api";
export * from "./runpod-s3";
export * from "./comfyui-api";
export * from "./comfyui-progress";
export * from "./huggingface";
export * from "./gemini-api";
