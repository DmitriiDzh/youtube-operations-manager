import { DomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError };

export type LocaleMetadata = {
  title: string;
  description: string;
};
