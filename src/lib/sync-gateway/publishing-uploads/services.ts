import { PUBLISHING_UPLOADS_REPORT_VERSION, publishingUploadsReportSchema, type PublishingUploadsReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type PublishingUploadsReportStore = PerDeviceReportStore;

/** BL-182 stage 2: the uploads report -- the shared per-device report mechanics with this family's strict schema. */
export function createPublishingUploadsShareCore(deps: { store: PublishingUploadsReportStore; ownDeviceId(): Promise<string>; clock?: { now(): Date } }) {
  return createPerDeviceReportCore<PublishingUploadsReport>({ schema: publishingUploadsReportSchema, label: "publishing uploads report", currentVersion: PUBLISHING_UPLOADS_REPORT_VERSION, ...deps });
}

export type PublishingUploadsShareCore = ReturnType<typeof createPublishingUploadsShareCore>;
