import type { Claim, ClaimGraph, EvidenceRead, GraphProof, ProofResult, ProofStatus, Row } from "./claims.ts";
import type { EvidenceIndex } from "./evidence-index.ts";

/**
 * Proves each claim against the evidence index.
 *
 * - discourse (questions, intentions, plain mentions) needs no evidence.
 * - action_completed needs a server receipt from THIS turn, or, for a
 *   "you're booked for <date/time>" state statement, a fresh account read
 *   showing that exact session.
 * - slot_open needs a fresh scheduler read; "nothing open" needs a COMPLETE
 *   read for that date (absence is only provable from a complete answer).
 * - appointment_exists needs a fresh account read for the bound customer.
 *
 * One uncovered span, or any claim that is not `supported`, withholds the
 * whole reply. Policy: finish or ask, never silently partial.
 */
export class ProofEngine {
  constructor(private readonly index: EvidenceIndex) {}

  private result(claim: Claim, status: ProofStatus, rule: string, evidenceIds: string[] = [], needs?: ProofResult["needs"]): ProofResult {
    return { claimId: claim.id, status, rule, evidenceIds: [...new Set(evidenceIds)], ...(status === "supported" ? {} : needs ? { needs } : {}) };
  }

  private rowMatches(row: Row, date: string | null, times: string[], room?: string | null): boolean {
    if (date && row.date !== date) return false;
    if (times.length && !times.includes(row.time)) return false;
    if (room && row.room && row.room !== room) return false;
    return true;
  }

  private accountReads(): EvidenceRead[] {
    return this.index.reads().filter((r) => r.authority === "account_read" && r.customerId === this.index.customerId);
  }

  prove(claim: Claim): ProofResult {
    switch (claim.kind) {
      case "discourse":
        return this.result(claim, "supported", "nonasserting_discourse");

      case "public_fact": {
        const factText = this.index.publicFacts.join(" ").toLowerCase().replace(/\./g, "");
        const unsupported = claim.values.filter((v) => !factText.includes(v));
        if (claim.values.length && !unsupported.length) return this.result(claim, "supported", "value_in_approved_facts");
        return this.result(claim, "missing", "fact_value_not_approved", [], "public_fact");
      }

      case "action_completed": {
        const receipts = this.index
          .receipts()
          .filter((r) => r.at >= this.index.turnStartedAt && (claim.action === "any" || r.action === claim.action))
          .filter((r) => (!claim.date || r.date === claim.date) && (!claim.times.length || claim.times.includes(r.time)));
        if (receipts.length) return this.result(claim, "supported", "server_receipt_this_turn", receipts.map((r) => r.id));
        if (claim.action !== "cancelled" && (claim.date || claim.times.length)) {
          const reads = this.accountReads().filter((r) => r.rows.some((row) => this.rowMatches(row, claim.date, claim.times)));
          if (reads.length) return this.result(claim, "supported", "fresh_account_read_shows_session", reads.map((r) => r.id));
        }
        return this.result(claim, "missing", "completion_requires_server_receipt", [], "server_receipt");
      }

      case "appointment_exists": {
        if (!this.index.customerId) return this.result(claim, "ambiguous", "owned_customer_scope_required", [], "account_read");
        const reads = this.accountReads();
        const matching = reads.filter((r) => r.rows.some((row) => this.rowMatches(row, claim.date, claim.times)));
        const complete = reads.filter((r) => r.complete);
        if (claim.polarity === "positive") {
          if (matching.length) return this.result(claim, "supported", "matching_owned_record", matching.map((r) => r.id));
          if (complete.length) return this.result(claim, "contradicted", "complete_read_has_no_matching_record", complete.map((r) => r.id));
          return this.result(claim, "missing", "matching_record_required", [], "account_read");
        }
        if (matching.length) return this.result(claim, "contradicted", "matching_record_exists", matching.map((r) => r.id));
        if (complete.length) return this.result(claim, "supported", "complete_read_proves_absence", complete.map((r) => r.id));
        return this.result(claim, "missing", "complete_read_required", [], "account_read");
      }

      case "slot_open": {
        const reads = this.index
          .reads()
          .filter((r) => r.authority === "scheduler_read")
          .filter((r) => (!claim.date || r.scope.date === claim.date) && (!claim.room || !r.scope.room || r.scope.room === claim.room));
        if (claim.polarity === "negative") {
          if (!claim.date) return this.result(claim, "ambiguous", "date_scope_required", [], "scheduler_read");
          const complete = reads.filter((r) => r.complete);
          if (complete.some((r) => r.rows.length > 0)) return this.result(claim, "contradicted", "open_rows_exist", complete.map((r) => r.id));
          if (complete.length) return this.result(claim, "supported", "complete_read_proves_absence", complete.map((r) => r.id));
          return this.result(claim, "missing", "complete_read_required", [], "scheduler_read");
        }
        // Each offered clock must be open. With no date bound, the times must match exactly one read date.
        const supportingIds: string[] = [];
        for (const time of claim.times) {
          const hits = reads.filter((r) => r.rows.some((row) => row.time === time));
          if (!hits.length) {
            const complete = reads.filter((r) => r.complete);
            return complete.length
              ? this.result(claim, "contradicted", "complete_read_lacks_time", complete.map((r) => r.id))
              : this.result(claim, "missing", "matching_slot_required", [], "scheduler_read");
          }
          if (!claim.date && new Set(hits.map((r) => r.scope.date)).size > 1) return this.result(claim, "ambiguous", "multiple_date_bindings", hits.map((r) => r.id));
          supportingIds.push(...hits.map((r) => r.id));
        }
        return this.result(claim, "supported", "matching_open_slot", supportingIds);
      }
    }
  }

  proveGraph(graph: ClaimGraph): GraphProof {
    if (graph.uncovered.length) {
      return { decision: "WITHHOLD", status: "ambiguous", results: [{ claimId: "graph", status: "ambiguous", rule: "uncovered_substantive_span", evidenceIds: [] }] };
    }
    const results = graph.claims.map((c) => this.prove(c));
    const status = (["contradicted", "ambiguous", "missing"] as const).find((s) => results.some((r) => r.status === s)) ?? "supported";
    return { decision: status === "supported" ? "ALLOW" : "WITHHOLD", status, results };
  }
}
