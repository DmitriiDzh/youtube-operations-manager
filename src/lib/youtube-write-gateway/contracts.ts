import { DomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError };

export type LocaleMetadata = {
  title: string;
  description: string;
};
