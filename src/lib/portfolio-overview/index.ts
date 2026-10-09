/** BL-161 -- the Producer's portfolio overview; see `./contracts.ts`. The caller wires how each channel's stored data is read. */
export { createPortfolioOverviewServices, buildPortfolioRow } from "./services";
export type { PortfolioOverviewServices, PortfolioOverviewDeps } from "./services";
export type { PortfolioChannelRow, PortfolioChannelSource, PortfolioOverview, PortfolioRange } from "./contracts";
