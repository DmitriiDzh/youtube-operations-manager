import { z } from "zod";

export const bootstrapConfigSchema = z
  .object({
    version: z.literal(1),
    deviceId: z.string().min(1),
    syncthingRootPath: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type BootstrapConfig = z.infer<typeof bootstrapConfigSchema>;

export class BootstrapConfigError extends Error {
  code: "bootstrap_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "BootstrapConfigError";
    this.code = "bootstrap_config_invalid";
  }
}
