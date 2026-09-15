import { createLocalizationStoreAdapter } from "./adapters/store";
import { createXlsxBuilder } from "./adapters/xlsx";
import { createLocalizationServices } from "./services";

export function createLocalizationCore() {
  return createLocalizationServices({
    channelStore: createLocalizationStoreAdapter(),
    xlsxBuilder: createXlsxBuilder(),
  });
}

export type LocalizationCore = ReturnType<typeof createLocalizationCore>;
