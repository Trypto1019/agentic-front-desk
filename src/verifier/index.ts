import { parseClaims, type ParseContext } from "./claim-parser.ts";
import type { ClaimGraph, GraphProof } from "./claims.ts";
import type { EvidenceIndex } from "./evidence-index.ts";
import { ProofEngine } from "./proof-engine.ts";

export { EvidenceIndex } from "./evidence-index.ts";
export { ProofEngine } from "./proof-engine.ts";
export { parseClaims, parseDate, parseTimes } from "./claim-parser.ts";
export type * from "./claims.ts";

/** What the runtime says instead of a withheld utterance: ask, never bluff. */
export const WITHHELD_FALLBACK = "Let me double-check that before I confirm anything. One moment.";

export type Verification = { graph: ClaimGraph; proof: GraphProof };

/** No spoken or sent claim without server evidence. */
export function verifyUtterance(text: string, index: EvidenceIndex, ctx: ParseContext): Verification {
  const graph = parseClaims(text, ctx);
  return { graph, proof: new ProofEngine(index).proveGraph(graph) };
}

export function verifierRedraftInstruction(v: Verification): string {
  const missing = v.proof.results.filter((r) => r.status !== "supported").map((r) => r.rule);
  return [
    "Your draft was not sent: it states something no server result in this turn proves",
    missing.length ? `(${[...new Set(missing)].join(", ")}).` : ".",
    "Never say an action is done unless the server confirmed it; only the server sends confirmations.",
    "Offer only times from a check_availability result. Use the tools or ask one question.",
  ].join(" ");
}
