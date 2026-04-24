import { DomainError } from "@/lib/video-metadata/contracts";

export async function parseVideoMetadataJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DomainError({
        code: "validation_failed",
        message: "Malformed JSON request body",
        details: [
          {
            path: "",
            message: "Request body must be valid JSON",
            code: "invalid_json",
          },
        ],
      });
    }

    throw error;
  }
}
