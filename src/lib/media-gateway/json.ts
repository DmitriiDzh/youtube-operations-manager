// Re-exported from the shared leaf module (AGENTS.md §M, review round 13) so every gateway child keeps importing
// `./json` while there is exactly one implementation.
export { asNumber, asRecord, asString } from "@/lib/shared-json";
