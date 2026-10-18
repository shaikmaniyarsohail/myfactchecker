import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

export function createDiskCache({ file, ttlMs = DEFAULT_TTL_MS } = {}) {
  const target = file || path.join(process.cwd(), '.cache', 'verdicts.json');
  let map = new Map();
  let saveTimer = null;

  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.e === 'number' && now < v.e) map.set(k, v);
    }
  } catch {
    map = new Map();
  }

  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const obj = {};
        const now = Date.now();
        for (const [k, v] of map) {
          if (now < v.e) obj[k] = { v: v.v, e: v.e };
        }
        const keys = Object.keys(obj);
        if (keys.length > MAX_ENTRIES) {
          for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete obj[k];
        }
        fs.writeFileSync(target, JSON.stringify(obj));
      } catch {
        /* cache is best-effort */
      }
    }, 200);
    saveTimer.unref?.();
  }

  function flushNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const obj = {};
      const now = Date.now();
      for (const [k, v] of map) {
        if (now < v.e) obj[k] = { v: v.v, e: v.e };
      }
      fs.writeFileSync(target, JSON.stringify(obj));
    } catch {}
  }
  process.once('exit', flushNow);

  return {
    key(claimText, lang = 'en') {
      return crypto.createHash('sha1').update(`${String(claimText).trim()}|${lang}`).digest('hex');
    },
    get(key) {
      const v = map.get(key);
      if (!v) return undefined;
      if (Date.now() > v.e) {
        map.delete(key);
        return undefined;
      }
      return v.v;
    },
    set(key, value) {
      map.set(key, { v: value, e: Date.now() + ttlMs });
      persist();
    },
    get size() {
      return map.size;
    },
  };
}

export default createDiskCache;
