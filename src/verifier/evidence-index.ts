import { isClock, isIsoDate } from "../lib/time.ts";
import type { EvidenceRead, EvidenceReceipt } from "./claims.ts";

/**
 * Trusted-input store for one conversation turn.
 *
 * - Reads come from tool adapters, never from model arguments.
 * - Account reads go stale after `accountMaxAgeMs` (capped at 60 s) and any
 *   read goes stale when a mutation bumps the revision after it was taken.
 * - Receipts can only be added through the minter, which is handed out ONCE
 *   to the runtime that executes mutations. Nothing that holds only the index
 *   (a model adapter, a prompt, a parsed tool argument) can mint a receipt.
 */
export class EvidenceIndex {
  readonly customerId: string | null;
  readonly turnStartedAt: number;
  /** Approved public facts (static configuration, not model output). */
  readonly publicFacts: readonly string[];
  private readonly clock: () => number;
  private readonly accountMaxAgeMs: number;
  private readonly readsById = new Map<string, EvidenceRead>();
  private readonly receiptList: EvidenceReceipt[] = [];
  private minterIssued = false;
  private _revision = 0;

  constructor(opts: { customerId: string | null; now?: () => number; accountMaxAgeMs?: number; publicFacts?: readonly string[] }) {
    this.customerId = opts.customerId;
    this.publicFacts = [...(opts.publicFacts ?? [])];
    this.clock = opts.now ?? Date.now;
    this.turnStartedAt = this.clock();
    this.accountMaxAgeMs = opts.accountMaxAgeMs ?? 60_000;
    if (this.accountMaxAgeMs <= 0 || this.accountMaxAgeMs > 60_000) throw new Error("ACCOUNT_FRESHNESS_CANNOT_BE_WEAKENED");
  }

  get revision(): number {
    return this._revision;
  }

  now(): number {
    return this.clock();
  }

  /** Called by the runtime after any write, so earlier reads stop proving anything. */
  bumpRevision(): void {
    this._revision += 1;
  }

  addRead(read: EvidenceRead): void {
    if (!read.id || !read.source.tool || !read.source.invocationId) throw new Error("EVIDENCE_SOURCE_REQUIRED");
    if (this.readsById.has(read.id)) throw new Error("EVIDENCE_DUPLICATE_ID");
    if (!Number.isFinite(read.observedAt) || read.observedAt > this.now()) throw new Error("EVIDENCE_OBSERVATION_INVALID");
    if (read.revision !== this._revision) throw new Error("EVIDENCE_REVISION_MISMATCH");
    if (read.authority === "account_read" && (!this.customerId || read.customerId !== this.customerId)) throw new Error("ACCOUNT_CUSTOMER_BINDING_REQUIRED");
    if (read.scope.date !== undefined && !isIsoDate(read.scope.date)) throw new Error("EVIDENCE_DATE_INVALID");
    for (const row of read.rows) {
      if (!isIsoDate(row.date) || !isClock(row.time)) throw new Error("EVIDENCE_ROW_INVALID");
    }
    this.readsById.set(read.id, structuredClone(read));
  }

  /** Fresh reads only: right revision, and account reads younger than the max age. */
  reads(): EvidenceRead[] {
    const now = this.now();
    return [...this.readsById.values()].filter(
      (r) => r.revision === this._revision && r.observedAt <= now && (r.authority !== "account_read" || now - r.observedAt < this.accountMaxAgeMs),
    );
  }

  receipts(): EvidenceReceipt[] {
    return this.receiptList.map((r) => ({ ...r }));
  }

  /** Hand the receipt-minting capability to the mutation runtime. Callable once. */
  issueReceiptMinter(): (receipt: EvidenceReceipt) => void {
    if (this.minterIssued) throw new Error("RECEIPT_MINTER_ALREADY_ISSUED");
    this.minterIssued = true;
    return (receipt) => {
      if (this.customerId && receipt.customerId !== this.customerId) throw new Error("RECEIPT_CUSTOMER_MISMATCH");
      this.receiptList.push({ ...receipt });
      this.bumpRevision();
    };
  }
}
