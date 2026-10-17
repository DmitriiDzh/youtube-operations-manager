"use client";

import type { InputHTMLAttributes } from "react";

/**
 * A field for a secret (an API key, an S3 secret, a key-file password) whose characters are hidden. Not `type="password"`: Chrome
 * ignores `autocomplete="off"` there and filled a saved login password into the Gemini key field (seen live 2026-10-11, BL-174),
 * which "Check and save" would have sent to the provider. A text field with hidden characters is never offered saved passwords,
 * and the password-manager extensions are told to skip it too.
 */
export function MaskedSecretInput({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete">) {
  return (
    <input
      {...props}
      type="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className={`${className ?? ""} [-webkit-text-security:disc]`.trim()}
    />
  );
}
