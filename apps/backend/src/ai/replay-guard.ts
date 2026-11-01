/**
 * A short-lived guard against a duplicate chat request id.
 *
 * The browser already disables its composer while a turn is active, but two
 * tabs, a retried `fetch` or a double-click can still deliver the same
 * client-generated `requestId` twice. Rejecting the second one for a minute
 * keeps one question from spending two turns of budget; the entry holds opaque
 * ids only — never a prompt — and expires on its own.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when this key is new; false while an earlier claim is still fresh. */
  claim(key: string): boolean {
    const current = this.now();
    this.prune(current);
    const existing = this.seen.get(key);
    if (existing !== undefined && current - existing < this.ttlMs) return false;
    this.seen.set(key, current);
    return true;
  }

  private prune(current: number): void {
    for (const [key, at] of this.seen) {
      if (current - at >= this.ttlMs) this.seen.delete(key);
    }
  }
}
