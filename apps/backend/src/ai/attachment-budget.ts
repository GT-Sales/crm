/**
 * A process-wide bound on the attachment bytes stored turns hold in memory.
 *
 * One turn may hand the model up to `maxAttachmentBytesPerTurn` (15 MiB) of
 * images and PDFs, re-read from storage every turn, and the SDK holds a
 * base64 copy of each while it builds the request (about 4/3 more), so an
 * unbounded number of concurrent turns could take the process down. The
 * backend runs on a small Railway instance (512 MiB to 1 GiB); 48 MiB of raw
 * bytes is about 112 MiB at the peak with the base64 copies, three full
 * turns at once (or many light ones), and leaves the rest of the CRM its
 * memory. A turn that cannot take its share at once does not queue behind the
 * others: its files are sent as "not available in this turn".
 */
export const AI_ATTACHMENT_MEMORY_BUDGET_BYTES = 48 * 1024 * 1024;

/** A held share of the budget; `release` is idempotent. */
export interface AttachmentBudgetLease {
  readonly bytes: number;
  release(): void;
}

export class AttachmentByteBudget {
  private used = 0;

  constructor(readonly total: number = AI_ATTACHMENT_MEMORY_BUDGET_BYTES) {}

  /** Bytes not held by any turn now. */
  get available(): number {
    return this.total - this.used;
  }

  /** The share, at once, or undefined when it does not fit right now. Never waits. */
  tryAcquire(bytes: number): AttachmentBudgetLease | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.available) return undefined;
    this.used += bytes;
    let held = true;
    return {
      bytes,
      release: () => {
        if (!held) return;
        held = false;
        this.used -= bytes;
      },
    };
  }
}

/** The one budget every stored turn of this process shares. */
export const sharedAttachmentByteBudget = new AttachmentByteBudget();
