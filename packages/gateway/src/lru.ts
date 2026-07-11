/**
 * Byte-budgeted LRU for immutable responses. Everything a gateway serves with
 * `immutable` cache semantics is safe to cache forever; the only pressure is
 * memory, so the budget is BYTES, not entries. Map iteration order gives us
 * recency for free (delete + re-set on hit).
 */

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export class ByteLru {
  private readonly entries = new Map<string, CachedResponse>();
  private bytes = 0;
  hits = 0;
  misses = 0;

  constructor(
    /** total budget across all bodies */
    private readonly maxBytes: number,
    /** refuse to cache any single body larger than this */
    private readonly maxEntryBytes: number,
  ) {}

  get(key: string): CachedResponse | undefined {
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    // refresh recency
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hits++;
    return hit;
  }

  set(key: string, value: CachedResponse): void {
    if (value.body.length > this.maxEntryBytes) return;
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.body.length;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.body.length;
    // evict least-recently-used until inside budget
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (oldest === key && this.entries.size === 1) break;
      this.entries.delete(oldest);
      this.bytes -= entry.body.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }
}
