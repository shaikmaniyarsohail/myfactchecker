import express from 'express';
import cors from 'cors';
import { providers } from './providers/index.js';
import { aggregate, runProviders } from './aggregator.js';
import { extractClaims } from './claims.js';
import { createCache, cacheKey } from './cache/memory.js';
import { createDiskCache } from './cache/disk.js';
import { getTranscript } from './youtube.js';

const PORT = Number(process.env.PORT) || 8787;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{5,20}$/;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('transcript request timed out')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const memCache = createCache({ max: 1000, ttlMs: 30 * 60 * 1000 });
const diskCache = createDiskCache({ file: new URL('../.cache/verdicts.json', import.meta.url).pathname });

export function createApp() {
  const app = express();
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (origin.startsWith('chrome-extension://') || /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
  }));
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      const claims = req.method === 'POST' && Array.isArray(req.body?.claims) ? ` claims=${req.body.claims.length}` : '';
      console.log(`${req.method} ${req.path}${claims} → ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      providers: providers.map((p) => p.name),
      uptime: process.uptime(),
    });
  });

  app.get('/api/config', (req, res) => {
    res.json({ googleFactCheckKeyConfigured: Boolean(process.env.GOOGLE_FACTCHECK_API_KEY) });
  });

  app.get('/api/youtube-transcript', async (req, res) => {
    const videoId = typeof req.query.videoId === 'string' ? req.query.videoId : '';
    if (!VIDEO_ID_RE.test(videoId)) {
      return res.status(400).json({ ok: false, error: 'bad videoId' });
    }
    const lang = typeof req.query.lang === 'string' && req.query.lang.trim() ? req.query.lang.trim() : 'en';
    try {
      const { track, segments } = await withTimeout(getTranscript(videoId, lang), 15000);
      res.json({ ok: true, videoId, track, segments });
    } catch (err) {
      res.status(200).json({ ok: false, error: err?.message || 'transcript unavailable' });
    }
  });

  app.post('/api/analyze-claims', (req, res) => {
    const { transcript } = req.body || {};
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ error: 'transcript must be a non-empty string' });
    }
    const claims = extractClaims(transcript);
    res.json({ claims });
  });

  app.post('/api/fact-check', async (req, res) => {
    const { videoId, claims, options } = req.body || {};
    if (!Array.isArray(claims)) {
      return res.status(400).json({ error: 'claims must be an array' });
    }
    const lang = options?.language || 'en';
    const results = await Promise.all(
      claims.map(async (claim) => {
        const id = claim?.id || 'unknown';
        const text = typeof claim?.text === 'string' ? claim.text.trim() : '';
        if (!text) {
          return { id, verdict: 'unverified', confidence: 0.3, summary: 'Empty claim text.', sources: [], provider: 'aggregator' };
        }
        const key = cacheKey(text, lang);
        const cached = memCache.get(key) ?? diskCache.get(key);
        if (cached) {
          if (!memCache.get(key)) memCache.set(key, cached);
          return { id, ...cached };
        }
        try {
          const { results: providerResults, errors } = await runProviders(providers, text, { language: lang, videoId });
          const aggregated = aggregate(providerResults, { errors });
          memCache.set(key, aggregated);
          if (aggregated.reason !== 'providers-degraded') {
            diskCache.set(key, aggregated);
          }
          return { id, ...aggregated };
        } catch (err) {
          return { id, verdict: 'unverified', confidence: 0.3, summary: 'All providers failed for this claim.', sources: [], provider: 'aggregator', reason: 'providers-degraded' };
        }
      })
    );
    res.json({ results });
  });

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`myfactchecker-server listening on http://localhost:${PORT}`);
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} is already in use — another instance is already running.`);
      console.log('That one is fine to use (the extension only needs one server).');
      console.log(`To restart it instead: npm stop && npm start`);
      process.exit(0);
    }
    console.error('Server failed to start:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

export default createApp;
