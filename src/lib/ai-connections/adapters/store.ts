import { randomUUID } from "node:crypto";
import {
  createStoredAiConnection,
  deleteStoredAiConnection,
  deleteStoredAiConnectionCredential,
  getStoredAiConnection,
  getStoredAiConnectionCredential,
  listStoredAiConnections,
  updateStoredAiConnection,
  upsertStoredAiConnectionCredential,
} from "@/lib/db";

export function createAiConnectionStoreAdapter() {
  return {
    createConnection: createStoredAiConnection,
    listConnections: listStoredAiConnections,
    getConnection: getStoredAiConnection,
    updateConnection: updateStoredAiConnection,
    deleteConnection: deleteStoredAiConnection,
  };
}

export function createAiConnectionCredentialStoreAdapter() {
  return {
    upsertCredential: upsertStoredAiConnectionCredential,
    getCredential: getStoredAiConnectionCredential,
    deleteCredential: deleteStoredAiConnectionCredential,
  };
}

export function createIdGenerator() {
  return () => randomUUID();
}
