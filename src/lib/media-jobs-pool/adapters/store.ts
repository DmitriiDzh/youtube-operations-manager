import {
  claimMediaJobPeerCommand,
  finishMediaJobPeerCommand,
  insertMediaJobCommandOut,
  knownMediaJobPeerCommandIds,
  listMediaJobCommandsOut,
  listMediaJobPeerCommands,
} from "@/lib/db";
import type { CommandStore } from "../commands";

/** BL-188 stage 2: the commands sent and received, in this computer's database (schema v93). */
export function createCommandStore(): CommandStore {
  return {
    insertOutgoing: (row) => insertMediaJobCommandOut(row),
    listOutgoing: (sinceIso, limit) => listMediaJobCommandsOut(sinceIso, limit),
    claim: (row) => claimMediaJobPeerCommand(row),
    finish: (commandId, set) => finishMediaJobPeerCommand(commandId, set),
    known: (ids) => knownMediaJobPeerCommandIds(ids),
    listReceived: (sinceIso, limit) => listMediaJobPeerCommands(sinceIso, limit),
  };
}
