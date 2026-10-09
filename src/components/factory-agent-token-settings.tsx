"use client";

import { RoleAgentTokenSettings } from "./role-agent-token-settings";

/**
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` F2) -- the Factory Operator role's token card: the
 * shared role-token card (`./role-agent-token-settings`) on `/api/factory-agent-token` with the factory's own texts.
 */
export function FactoryAgentTokenSettings() {
  return (
    <RoleAgentTokenSettings
      endpoint="/api/factory-agent-token"
      placeholder="ytom_fo_..."
      texts={{
        title: "settingsCard.factoryToken",
        info: "settingsCards.factoryToken.info",
        loadFailed: "settingsCards.factoryToken.loadFailed",
        statusUnknown: "settingsCards.factoryToken.statusUnknown",
        rotateTitle: "settingsCards.factoryToken.rotateTitle",
        revokeTitle: "settingsCards.factoryToken.revokeTitle",
        rotateBody: "settingsCards.factoryToken.rotateBody",
        revokeBody: "settingsCards.factoryToken.revokeBody",
      }}
    />
  );
}
