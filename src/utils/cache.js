/**
 * MicroSHA - High-Performance In-Memory Cache with Single-Flight (Request Coalescing)
 *
 * Designed to eliminate redundant Supabase queries under high concurrent load.
 * Features:
 * - Ultra-fast O(1) in-memory storage with millisecond TTL.
 * - Single-flight / Coalescing: When multiple concurrent requests ask for the same
 *   uncached key simultaneously, only ONE upstream query is executed, and all
 *   callers await and receive the same result.
 * - Prefix-based invalidation for instant cache clearing on mutations.
 * - Automatic background pruning to prevent memory leaks.
 */

class MemoryCache {
  constructor() {
    this.store = new Map();
    this.inFlight = new Map();
    this.cleanupTimer = setInterval(() => this.prune(), 60000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = 10000) {
    if (value === undefined) return value;
    this.store.set(key, {
      value,
      expiry: Date.now() + Math.max(100, ttlMs),
    });
    return value;
  }

  del(key) {
    this.store.delete(key);
  }

  delPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Retrieves an item from cache, or fetches it atomically using single-flight coalescing.
   */
  async getOrSet(key, fetcher, ttlMs = 10000) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Single-Flight: Coalesce concurrent requests for the exact same key
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const promise = (async () => {
      try {
        const result = await fetcher();
        if (result !== undefined && result !== null) {
          this.set(key, result, ttlMs);
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiry) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
    this.inFlight.clear();
  }

  stats() {
    return {
      size: this.store.size,
      inFlightCount: this.inFlight.size,
    };
  }
}

const memoryCache = new MemoryCache();

module.exports = {
  memoryCache,
  MemoryCache,
};
