import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";


export const completeConnectInputSchema = z
  .object({
    code: z.string().min(1, "code is required"),
    state: z.string().min(1, "state is required"),
    expectedState: z.string().min(1, "expectedState is required"),
    redirectUri: z.string().min(1, "redirectUri is required"),
  })
  .strict();

export type CompleteConnectInput = z.infer<typeof completeConnectInputSchema>;
