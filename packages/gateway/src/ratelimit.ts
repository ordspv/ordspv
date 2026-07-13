/**
 * Per-key token bucket: `ratePerSec` sustained, `burst` peak. Injectable
 * clock for tests. Idle buckets are swept, and the tracked-key count is
 * hard-capped (oldest evicted first), so hostile key churn cannot grow the
 * map without bound between sweeps.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export const DEFAULT_MAX_TRACKED_KEYS = 50_000;

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxTrackedKeys: number = DEFAULT_MAX_TRACKED_KEYS,
  ) {
    this.lastSweep = this.now();
  }

  /** true = allowed (a token was taken); false = rate limited */
  take(key: string): boolean {
    const t = this.now();
    this.maybeSweep(t);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // hard cap: evict the oldest-tracked bucket rather than grow unbounded
      if (this.buckets.size >= this.maxTrackedKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.burst, lastRefill: t };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = (t - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.ratePerSec);
      bucket.lastRefill = t;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** seconds until one token is available (for retry-after) */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.tokens >= 1) return 0;
    return Math.ceil((1 - bucket.tokens) / this.ratePerSec);
  }

  private maybeSweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    const idleCutoff = t - 120_000;
    for (const [key, bucket] of this.buckets) {
      // effective tokens: what the bucket WOULD hold if refilled right now;
      // an idle bucket is safe to drop once it is logically full again
      const effective = bucket.tokens + ((t - bucket.lastRefill) / 1000) * this.ratePerSec;
      if (bucket.lastRefill < idleCutoff && effective >= this.burst) {
        this.buckets.delete(key);
      }
    }
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }
}
