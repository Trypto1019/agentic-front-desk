/**
 * Claim and evidence types for the evidence-gated verifier.
 *
 * Policy: no spoken or sent claim without server evidence. A reply is broken
 * into claims; each claim names the KIND of authority that can prove it, and
 * only the runtime (never the model) can add that authority to the index.
 */

export type Span = [start: number, end: number];

export type Authority = "server_receipt" | "account_read" | "scheduler_read" | "public_fact";

export type Claim =
  | { id: string; span: Span; kind: "discourse"; mode: "question" | "intention" | "mention" }
  /** A general studio fact ("open daily, first session 8:00 AM"). Every value must appear in the approved facts. */
  | { id: string; span: Span; kind: "public_fact"; values: string[] }
  /** "You're booked", "I've cancelled it", "you're all set". */
  | { id: string; span: Span; kind: "action_completed"; action: "booked" | "cancelled" | "rescheduled" | "any"; date: string | null; times: string[] }
  /** "3:00 PM is open on Friday" (positive) or "nothing is open Friday" (negative). */
  | { id: string; span: Span; kind: "slot_open"; polarity: "positive" | "negative"; date: string | null; times: string[]; room: string | null }
  /** "You have a session Friday at 3:00 PM" / "I don't see a session Friday". */
  | { id: string; span: Span; kind: "appointment_exists"; polarity: "positive" | "negative"; date: string | null; times: string[] };

export type ClaimGraph = { text: string; claims: Claim[]; uncovered: Span[] };

export type Row = { id?: string; date: string; time: string; room?: string };

/** A server read. `complete` means the rows are the WHOLE answer for the scope, so absence is provable. */
export type EvidenceRead = {
  id: string;
  authority: "account_read" | "scheduler_read";
  customerId?: string;
  scope: { date?: string; room?: string };
  rows: Row[];
  complete: boolean;
  observedAt: number;
  revision: number;
  source: { tool: string; invocationId: string };
};

export type EvidenceReceipt = {
  id: string;
  action: "booked" | "cancelled" | "rescheduled";
  customerId: string;
  date: string;
  time: string;
  at: number;
};

export type ProofStatus = "supported" | "missing" | "contradicted" | "ambiguous";

export type ProofResult = { claimId: string; status: ProofStatus; rule: string; evidenceIds: string[]; needs?: Authority };

export type GraphProof = { decision: "ALLOW" | "WITHHOLD"; status: ProofStatus; results: ProofResult[] };
