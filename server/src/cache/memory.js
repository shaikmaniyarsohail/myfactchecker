import crypto from 'node:crypto';

class LruCache {
  constructor({ max = 500, ttlMs = 10 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

export function cacheKey(claimText, lang = 'en') {
  return crypto.createHash('sha1').update(`${String(claimText).trim()}|${lang}`).digest('hex');
}

export function createCache(opts = {}) {
  return new LruCache(opts);
}

export default LruCache;
