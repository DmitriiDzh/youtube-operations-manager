// BL-238 (ADR 0058 §2): the ONE path pattern the cleanup may delete -- the owner's hard rule (FO-REQ-0051, TG 3251): the release's
// own final video and nothing else. Pure: the file-system checks (real path, symlinks, regular file) are the adapter's.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** The channel's name as the release file carries it: the channel folder's name without its number prefix ("01 Tropico Jazz"). */
export function channelNameOfFolder(folderName: string): string {
  return folderName.replace(/^\d+\s+/, "").trim();
}

/**
 * Whether `relativePath` (relative to the channel workspace, `/` between folders) is exactly
 * `04 Videos/<MM> <EnglishMonth>/<MMDD> V<n>/V<n> <channel>.mp4` for this upload's `video` and the channel's name: the month number
 * and name agree, the release folder's MMDD lies in that month, and V<n> is the same in both places.
 */
export function isAllowedReleaseVideo(relativePath: string, video: string, channelName: string): boolean {
  if (!/^V\d+$/.test(video) || channelName === "" || channelName.includes("/")) return false;
  const segments = relativePath.split("/");
  if (segments.length !== 4) return false;
  const [root, month, release, file] = segments;
  if (root !== "04 Videos") return false;
  const monthMatch = /^(\d{2}) ([A-Za-z]+)$/.exec(month);
  if (!monthMatch) return false;
  const mm = Number(monthMatch[1]);
  if (mm < 1 || mm > 12 || MONTHS[mm - 1] !== monthMatch[2]) return false;
  const releaseMatch = /^(\d{2})(\d{2}) (V\d+)$/.exec(release);
  if (!releaseMatch) return false;
  const day = Number(releaseMatch[2]);
  if (releaseMatch[1] !== monthMatch[1] || day < 1 || day > 31 || releaseMatch[3] !== video) return false;
  return file === `${video} ${channelName}.mp4`;
}
