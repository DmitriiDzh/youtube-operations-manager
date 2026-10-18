import { z } from "zod";
import type { DeviceSecretSlot, DeviceSecretState } from "@/lib/device-secrets";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { parseWithSchema } from "./schemas";

/**
 * BL-134 (FO-REQ-0028, ADR 0042): this computer's Hugging Face read token, kept in the shared device-secret store (slot
 * `huggingface`). Typed and checked in Settings → Cloud APIs; read only by the model pull. No view returns the token: only
 * whether one is stored and the Hugging Face user it belongs to.
 */

export type HfTokenView = {
  /** `set`: stored and readable here. */
  state: DeviceSecretState;
  /** The Hugging Face user the token belongs to (from `whoami` when it was saved or last checked). */
  user: string | null;
  /** `ok`, or `invalid` when the last check was refused. */
  status: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

/** A read token as Hugging Face issues them (`hf_` + letters and digits); anything else is refused before any call. */
export const setHfTokenInputSchema = z
  .object({ token: z.string().trim().regex(/^hf_[A-Za-z0-9]{20,200}$/, "a Hugging Face token looks like hf_ followed by letters and digits") })
  .strict();

export type HfTokenDeps = {
  slot: DeviceSecretSlot;
  hub: { whoami(token: string): Promise<{ name: string }> };
  now?: () => number;
};

export function createHfTokenServices(deps: HfTokenDeps) {
  const now = deps.now ?? (() => Date.now());

  async function view(): Promise<HfTokenView> {
    const [state, info] = await Promise.all([deps.slot.state(), deps.slot.info()]);
    return {
      state,
      user: info?.hints.user ?? null,
      status: info?.status ?? null,
      verifiedAt: info?.verifiedAt ? new Date(info.verifiedAt).toISOString() : null,
      updatedAt: info ? new Date(info.updatedAt).toISOString() : null,
    };
  }

  type CheckedHfToken = { token: string; user: string };
  async function checkHfToken(input: unknown): Promise<CheckedHfToken> {
    const { token } = parseWithSchema(setHfTokenInputSchema, input, "Hugging Face token");
    const { name } = await deps.hub.whoami(token);
    return { token, user: name };
  }
  async function storeChecked(checked: CheckedHfToken): Promise<HfTokenView> {
    await deps.slot.write(checked.token, { hints: { user: checked.user }, status: "ok", verifiedAt: now() });
    return view();
  }

  return {
    getHfToken: view,

    /** Checks the token with Hugging Face (`whoami`) and only then stores it; a refused token stores nothing (`hf_token_invalid`). */
    async setHfToken(input: unknown): Promise<HfTokenView> {
      return storeChecked(await checkHfToken(input));
    },

    /** BL-134 (review): the cloud-keys import checks every section BEFORE storing any -- this is the HF check (stores nothing). */
    checkHfTokenForImport: checkHfToken,
    /** Stores a token `checkHfTokenForImport` accepted. */
    storeCheckedHfToken: storeChecked,

    /** One `whoami` with the stored token; the result is recorded only on the token that was checked (compare-and-set). */
    async testHfToken(): Promise<HfTokenView> {
      const read = await deps.slot.readWithVersion();
      if (!read) throw new DomainError({ code: "hf_token_missing", message: "No Hugging Face token is stored on this computer." });
      try {
        await deps.hub.whoami(read.value);
        await deps.slot.setStatus(read.version, { status: "ok", verifiedAt: now() });
      } catch (error) {
        if (isDomainError(error) && error.code === "hf_token_invalid") await deps.slot.setStatus(read.version, { status: "invalid", verifiedAt: now() });
        throw error;
      }
      return view();
    },

    async clearHfToken(): Promise<HfTokenView> {
      await deps.slot.clear();
      return view();
    },

    /** For the model pull only: the token in clear, or null when none is stored. Never returned by a route or tool. */
    readHfToken: (): Promise<string | null> => deps.slot.read(),
  };
}

export type HfTokenServices = ReturnType<typeof createHfTokenServices>;
