import { DomainError, type MetadataDraft, type TranscriptResult, type VideoMetadataItem } from "../contracts";
import { EDITORIAL_PROMPT_VERSION, buildEditorialPromptTemplate } from "../editorial-template";
import { metadataDraftSchema, parseWithSchema } from "../schemas";

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function buildRuleBasedDraft(args: {
  video: VideoMetadataItem;
  transcript: TranscriptResult;
  editorialPrompt: string;
}): MetadataDraft {
  const transcriptHint =
    args.transcript.status === "available"
      ? args.transcript.text.slice(0, 180)
      : `Transcript ${args.transcript.status}`;

  return {
    finalTitle: compactWhitespace(`${args.video.title} · ${args.editorialPrompt}`).slice(
      0,
      100
    ),
    description: compactWhitespace(
      `${args.editorialPrompt}\n\n${args.video.description}\n\n${transcriptHint}`
    ).slice(0, 5000),
    promptVersion: EDITORIAL_PROMPT_VERSION,
  };
}

export function createMetadataGenerator() {
  const mode = process.env.METADATA_GENERATOR_MODE ?? "rule-based";

  return {
    async generate(args: {
      video: VideoMetadataItem;
      transcript: TranscriptResult;
      editorialPrompt: string;
    }): Promise<MetadataDraft> {
      const prompt = buildEditorialPromptTemplate(args);

      let rawOutput: unknown;

      if (mode === "raw-json") {
        const configuredOutput = process.env.METADATA_GENERATOR_RAW_OUTPUT;
        if (!configuredOutput) {
          throw new DomainError({
            code: "generation_failed",
            message: "METADATA_GENERATOR_RAW_OUTPUT is required in raw-json mode",
          });
        }

        try {
          rawOutput = JSON.parse(configuredOutput) as unknown;
        } catch {
          throw new DomainError({
            code: "generation_failed",
            message: "Failed to parse METADATA_GENERATOR_RAW_OUTPUT as JSON",
          });
        }
      } else {
        rawOutput = buildRuleBasedDraft(args);
      }

      try {
        return parseWithSchema(metadataDraftSchema, rawOutput, "metadata generator output");
      } catch (error) {
        if (error instanceof DomainError && error.code === "validation_failed") {
          throw error;
        }

        throw new DomainError({
          code: "generation_failed",
          message: "Metadata generation failed",
          details: {
            promptVersion: EDITORIAL_PROMPT_VERSION,
            promptPreview: prompt.slice(0, 200),
          },
        });
      }
    },
  };
}
