// BL-252 (ADR 0068): the social gateway -- the single module that calls the short-video networks' APIs (one gateway per API
// category, like the YouTube read/write gateways and the media gateway). One child per network; callers import this barrel only.
// `social-gateway-inventory.test.ts` fails if any other production file reaches those hosts.
export { createMetaClient, META_GRAPH_VERSION, META_SCOPES, type MetaClient, type MetaPage } from "./meta";
