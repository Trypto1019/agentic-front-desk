/**
 * Per-conversation turn serialization.
 *
 * The webhook acknowledges the provider immediately and runs the agent turn
 * detached ("ack-fast"). Two rapid texts from the same number would otherwise
 * process concurrently: interleaved tool calls, out-of-order replies, double
 * bookings. This queue keeps ONE live turn per conversation key; a second
 * inbound chains onto the first and runs strictly in arrival order.
 *
 * The queue is in-process. A restart empties it by definition; recovering
 * turns that died with the process is an orphan sweep's job, not the queue's.
 *
 * Hung-turn protection: a task gets `maxWaitMs` to settle, then the CHAIN
 * moves on (the hung task cannot be cancelled; it surfaces as an orphan).
 * Without this, one wedged model call would freeze a thread forever.
 */

const DEFAULT_MAX_TURN_WAIT_MS = 120_000;

export class TurnQueue {
  private queues = new Map<string, Promise<void>>();
  private readonly onError: (key: string, error: unknown) => void;
  private readonly onTimeout: (key: string, maxWaitMs: number) => void;

  constructor(opts: { onError?: (key: string, error: unknown) => void; onTimeout?: (key: string, maxWaitMs: number) => void } = {}) {
    this.onError = opts.onError ?? ((key, error) => console.error(`[turn-queue] task failed for ${key}:`, error));
    this.onTimeout = opts.onTimeout ?? ((key, ms) => console.warn(`[turn-queue] ${key} exceeded ${ms}ms; releasing the chain`));
  }

  /** Number of conversation keys with a live chain (test hook). */
  get activeCount(): number {
    return this.queues.size;
  }

  /**
   * Enqueue a task for a conversation key. Returns the chained promise so
   * tests can await completion; production callers fire and forget. A task's
   * rejection is contained and never breaks the chain.
   */
  enqueue(key: string, task: () => Promise<unknown>, opts: { maxWaitMs?: number } = {}): Promise<void> {
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_TURN_WAIT_MS;
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.then(() => this.settleWithin(key, task, maxWaitMs)).catch((error) => this.onError(key, error));
    this.queues.set(key, next);
    void next.finally(() => {
      // Only clear if no newer task chained on after this one.
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  private async settleWithin(key: string, task: () => Promise<unknown>, maxWaitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), maxWaitMs);
    });
    try {
      const outcome = await Promise.race([task().then(() => "settled" as const), timeout]);
      if (outcome === "timed_out") this.onTimeout(key, maxWaitMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
