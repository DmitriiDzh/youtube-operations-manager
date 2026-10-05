import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { listSnapshots, readManifestFromDir } from "@/lib/snapshot";
import path from "node:path";
import { resolveSnapshotsDir, deviceHandoffErrorResponse } from "../shared";

/** Lists every snapshot visible in the configured Syncthing folder (or the local fallback) --
 * read-only, used by the import UI to let the operator pick which one to import. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const snapshotsDir = await resolveSnapshotsDir();
    const ids = await listSnapshots(snapshotsDir);

    const manifests = await Promise.all(
      ids.map(async (id) => {
        try {
          return await readManifestFromDir(path.join(snapshotsDir, id));
        } catch {
          // A directory that isn't a valid/complete snapshot (e.g. a stray file, or another
          // device's in-flight `.staging-*` dir that Syncthing hasn't finished syncing yet --
          // those are already excluded by listSnapshots, but a corrupt/partial one that made
          // it through Syncthing under its final name is possible) -- omit it rather than fail
          // the whole listing.
          return null;
        }
      })
    );

    return NextResponse.json({
      snapshotsDir,
      snapshots: manifests.filter((m) => m !== null),
    });
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
