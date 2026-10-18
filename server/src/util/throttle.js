import crypto from 'node:crypto';

const queues = new Map();

function lane(key, minIntervalMs, burst) {
  let l = queues.get(key);
  if (!l) {
    l = { next: 0, tokens: burst, lastRefill: Date.now(), chain: Promise.resolve() };
    queues.set(key, l);
  }
  const now = Date.now();
  const elapsed = now - l.lastRefill;
  if (elapsed > 0) {
    l.tokens = Math.min(burst, l.tokens + elapsed / minIntervalMs);
    l.lastRefill = now;
  }
  return l;
}

export function schedule(key, fn, { minIntervalMs = 1200, burst = 2 } = {}) {
  const l = lane(key, minIntervalMs, burst);
  const run = async () => {
    const now = Date.now();
    if (l.tokens < 1) {
      const waitMs = (1 - l.tokens) * minIntervalMs;
      await new Promise((r) => setTimeout(r, waitMs));
      l.tokens = 0;
      l.lastRefill = Date.now();
    }
    l.tokens -= 1;
    return fn();
  };
  const p = l.chain.then(run, run);
  l.chain = p.then(() => {}, () => {});
  return p;
}

export function throttleKey(name, extra = '') {
  return crypto.createHash('sha1').update(`${name}|${extra}`).digest('hex').slice(0, 12);
}

export default schedule;
