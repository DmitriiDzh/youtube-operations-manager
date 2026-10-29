// BL-233 (FO-REQ-0047): how fast a YouTube upload may send while live streams run on this computer -- shared logic in its own
// module (AGENTS.md §M): the app layer composes it from live-streams' encoder readings and hands it to publishing's upload runner;
// the Operator's status and the Web UI read its state. It imports no feature module and writes nothing.
export * from "./governor";
