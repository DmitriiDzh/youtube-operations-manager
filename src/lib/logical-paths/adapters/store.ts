import {
  deleteLogicalPathRow,
  getLogicalPathValue,
  insertLogicalPathRow,
  listLogicalPathRows,
  listLogicalPathValues,
  setLogicalPathValue,
} from "@/lib/db";
import type { LogicalPathStore } from "../services";

export function createLogicalPathStore(): LogicalPathStore {
  return {
    listDefinitions: () => listLogicalPathRows(),
    insertDefinition: (input) => insertLogicalPathRow(input),
    deleteDefinition: (name) => deleteLogicalPathRow(name),
    getValue: (deviceId, name) => getLogicalPathValue(deviceId, name),
    listValues: (deviceId) => listLogicalPathValues(deviceId),
    setValue: (deviceId, name, path) => setLogicalPathValue(deviceId, name, path),
  };
}
