export class TtlCache {
  constructor({ ttlMs = 60000, staleMs = 300000, maxEntries = 100, clock = () => Date.now() } = {}) {
    this.ttlMs = Math.max(0, ttlMs);
    this.staleMs = Math.max(this.ttlMs, staleMs);
    this.maxEntries = Math.max(1, maxEntries);
    this.clock = clock;
    this.entries = new Map();
    this.inflight = new Map();
  }

  peek(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    const now = this.clock();
    if (entry.staleUntil <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return {
      value: entry.value,
      cachedAt: entry.cachedAt,
      state: entry.expiresAt > now ? 'fresh' : 'stale',
      ageMs: Math.max(0, now - entry.cachedAt),
    };
  }

  set(key, value) {
    this.prune();
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    const now = this.clock();
    this.entries.set(key, {
      value,
      cachedAt: now,
      expiresAt: now + this.ttlMs,
      staleUntil: now + this.staleMs,
    });
    return value;
  }

  invalidate(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  async getOrLoad(key, loader, { force = false, allowStale = true } = {}) {
    const cached = this.peek(key);
    if (!force && cached?.state === 'fresh') {
      return { value: cached.value, cached, fromCache: true };
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return { value: await existing, cached: this.peek(key), fromCache: false, shared: true };
    }

    const pending = Promise.resolve()
      .then(loader)
      .then(value => this.set(key, value))
      .catch(error => {
        const stale = this.peek(key);
        if (allowStale && stale?.state === 'stale') {
          return stale.value;
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return { value: await pending, cached: this.peek(key), fromCache: false };
  }

  stats() {
    this.prune();
    let fresh = 0;
    let stale = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt > this.clock()) {
        fresh += 1;
      } else {
        stale += 1;
      }
    }
    return { entries: this.entries.size, fresh, stale, inflight: this.inflight.size };
  }

  prune() {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (entry.staleUntil <= now) {
        this.entries.delete(key);
      }
    }
  }
}
