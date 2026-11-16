// BL-265 (ADR 0072 §7, MEDIA_GATE_PLAN.md §3.4 "One comparison rule"): how a package's default-language texts compare with YouTube's.
// One rule for the upload's read-back, the «Упаковка отличается от YouTube» badge, the three-way check, the patch and its read-back
// (video-details' own read-back uses the same description rule, `youtubeDescriptionText`). Pure: the upload runner and client
// components use it too.
import { youtubeDescriptionText } from "@/lib/video-details/read-back";

/** Line endings the factory's Windows files may carry; YouTube keeps a description's lines, not their CR (review question). */
export const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * A description as YouTube keeps it -- LF line ends and no trailing line breaks (seen on the first real uploads, 2026-10-13, V50-V57:
 * YouTube drops a description's trailing line breaks). The patch sends this form, so YouTube's echo is the text sent.
 */
export const youtubeDescriptionOf = youtubeDescriptionText;

export type PackagingField = "title" | "description" | "tags";
export const PACKAGING_FIELDS: readonly PackagingField[] = ["title", "description", "tags"];

/** Whether two values of one field mean the same on YouTube: title exactly; description by `youtubeDescriptionOf`; tags in any order. */
export function samePackagingValue(field: PackagingField, a: string | readonly string[] | null | undefined, b: string | readonly string[] | null | undefined): boolean {
  if (field === "tags") return JSON.stringify([...((a as readonly string[] | null) ?? [])].sort()) === JSON.stringify([...((b as readonly string[] | null) ?? [])].sort());
  if (field === "description") return youtubeDescriptionOf((a as string | null) ?? "") === youtubeDescriptionOf((b as string | null) ?? "");
  return ((a as string | null) ?? null) === ((b as string | null) ?? null);
}

export type PackagingTexts = { title: string | null; description: string | null; tags: readonly string[] | null };

/** The fields whose values differ by the one rule, in the order title, description, tags. */
export function packagingDifferences(a: PackagingTexts, b: PackagingTexts): PackagingField[] {
  return PACKAGING_FIELDS.filter((field) => !samePackagingValue(field, a[field], b[field]));
}
