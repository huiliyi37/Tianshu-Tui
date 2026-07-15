/**
 * W2-B1: appendixDelta-aligned block charge tracker.
 *
 * Under appendixDelta, a byte-stable appendix block pays its bytes once on
 * entry and nothing at steady state; only changed bytes are re-sent. The
 * charge decision therefore is: full block length when the rendered content
 * differs from the last charged snapshot, zero when byte-identical.
 *
 * A compact boundary resets the appendix baseline (all blocks re-enter), so
 * the caller must call `reset()` when the compact generation changes —
 * otherwise the re-sent bytes go unmetered.
 *
 * This mirrors the projection/toolContext charging in turn-step-producer
 * (W6, incident 20b9714e); it exists as a standalone class so the
 * "second render with no change charges 0" invariant is directly testable.
 */
export class BlockChargeTracker {
  private lastCharged = ''

  /** Returns the chars to charge for this render (0 when byte-stable). */
  charge(content: string): number {
    if (content === this.lastCharged) return 0
    this.lastCharged = content
    return content.length
  }

  /** Compact boundary: baseline invalidated, next render pays full entry cost. */
  reset(): void {
    this.lastCharged = ''
  }
}
