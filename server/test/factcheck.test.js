import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { extractClaims } from '../src/claims.js';
import { jaccard, tokenize, splitSentences, extractNumbers, hasNegation } from '../src/util/text.js';
import { aggregate, runProviders } from '../src/aggregator.js';
import { createCache, cacheKey } from '../src/cache/memory.js';

test('splitSentences handles punctuation and caption line breaks', () => {
  const s = splitSentences('The Earth orbits the Sun.\nIt takes one year.\nMars is red? Yes it is!');
  assert.ok(s.length >= 3);
  assert.equal(s[0], 'The Earth orbits the Sun.');
});

test('extractClaims keeps factual sentences and filters questions/short lines', () => {
  const transcript = [
    'The Earth orbits the Sun in approximately 365.25 days.',
    'What is the meaning of life?',
    'Wow.',
    'Humans first walked on the Moon in 1969 during the Apollo 11 mission.',
    'The Earth orbits the Sun in about 365 days.',
  ].join('\n');
  const claims = extractClaims(transcript);
  assert.ok(claims.length >= 2, `expected >=2 claims, got ${claims.length}: ${JSON.stringify(claims)}`);
  assert.ok(claims.every((c) => typeof c.id === 'string' && c.text.length > 0));
  const texts = claims.map((c) => c.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes('orbits')), 'should keep orbit claim');
  assert.ok(texts.some((t) => t.includes('moon')), 'should keep moon claim');
  assert.ok(!texts.some((t) => t.includes('meaning of life')), 'should drop question');
});

test('extractClaims dedups near-identical claims (jaccard > 0.85)', () => {
  const transcript = 'The Great Wall of China is visible from space with the naked eye.\nThe Great Wall of China is visible from space by the naked eye.';
  const claims = extractClaims(transcript);
  assert.equal(claims.length, 1);
});

test('jaccard similarity', () => {
  assert.equal(jaccard('a b c', 'a b c'), 1);
  assert.equal(jaccard('a b', 'c d'), 0);
  const v = jaccard('the earth orbits the sun', 'earth orbits sun');
  assert.ok(v > 0.4 && v < 1, `got ${v}`);
});

test('extractNumbers and hasNegation', () => {
  assert.deepEqual(extractNumbers('There are 42 states and 3.5 million people'), [42, 3.5]);
  assert.ok(hasNegation('The moon is not made of cheese'));
  assert.ok(!hasNegation('The moon is made of rock'));
});

test('aggregate: mocked providers weighted majority', () => {
  const results = [
    { name: 'google-factcheck', verdict: 'contradicted', confidence: 0.9, summary: 'gc says false', sources: [{ title: 'A', url: 'https://a.example/x', snippet: 'a' }] },
    { name: 'wikipedia', verdict: 'contradicted', confidence: 0.7, summary: 'wiki says no', sources: [{ title: 'B', url: 'https://b.example/y', snippet: 'b' }] },
    { name: 'duckduckgo', verdict: 'supported', confidence: 0.5, summary: 'ddg mixed', sources: [{ title: 'A', url: 'https://a.example/x', snippet: 'a2' }] },
  ];
  const agg = aggregate(results);
  assert.equal(agg.verdict, 'contradicted');
  assert.ok(agg.confidence > 0.3 && agg.confidence <= 0.95);
  assert.equal(agg.sources.length, 2, 'sources deduped by URL');
});

test('aggregate: all unverified stays unverified', () => {
  const results = [
    { name: 'wikipedia', verdict: 'unverified', confidence: 0.3, summary: 'n/a', sources: [] },
    { name: 'duckduckgo', verdict: 'unverified', confidence: 0.3, summary: 'n/a', sources: [] },
  ];
  const agg = aggregate(results);
  assert.equal(agg.verdict, 'unverified');
});

test('runProviders handles provider failures gracefully', async () => {
  const good = { name: 'wikipedia', check: async () => ({ verdict: 'supported', confidence: 0.7, summary: 'ok', sources: [] }) };
  const bad = { name: 'duckduckgo', check: async () => { throw new Error('boom'); } };
  const disabled = { name: 'google-factcheck', enabled: false, check: async () => { throw new Error('should not run'); } };
  const { results, errors } = await runProviders([good, bad, disabled], 'test claim');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'wikipedia');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'duckduckgo');
});

test('aggregate marks providers-degraded when failures caused unverified', () => {
  const agg = aggregate([], { errors: [{ name: 'wikipedia', error: 'HTTP 429' }] });
  assert.equal(agg.verdict, 'unverified');
  assert.equal(agg.reason, 'providers-degraded');
  assert.ok(agg.summary.includes('rate-limited'));
  const ok = aggregate([{ name: 'wikipedia', verdict: 'supported', confidence: 0.7, summary: 's', sources: [] }], { errors: [{ name: 'gdelt', error: 'x' }] });
  assert.equal(ok.reason, null);
});

test('throttle serializes calls below min interval', async () => {
  const { schedule } = await import('../src/util/throttle.js');
  const stamps = [];
  const job = () => { stamps.push(Date.now()); };
  const t0 = Date.now();
  await Promise.all([
    schedule('t-test', job, { minIntervalMs: 80, burst: 1 }),
    schedule('t-test', job, { minIntervalMs: 80, burst: 1 }),
    schedule('t-test', job, { minIntervalMs: 80, burst: 1 }),
  ]);
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 70, `gap1=${stamps[1] - stamps[0]}`);
  assert.ok(stamps[2] - stamps[1] >= 70, `gap2=${stamps[2] - stamps[1]}`);
  assert.ok(Date.now() - t0 >= 100);
});

test('google-news parseRssItems keeps valid items only', async () => {
  const { parseRssItems } = await import('../src/providers/google-news.js');
  const xml = `<rss><channel>
    <item><title><![CDATA[Apollo 11 anniversary - Space.com]]></title><link>https://space.com/a</link><source url="https://space.com">Space.com</source><pubDate>Fri, 18 Oct 2026</pubDate></item>
    <item><title>Bad link</title><link>ftp://bad</link></item>
    <item><title>No link</title></item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://space.com/a');
  assert.equal(items[0].source, 'Space.com');
  assert.ok(!items[0].title.includes(' - Space.com'));
  assert.deepEqual(parseRssItems(''), []);
});

test('disk cache persists and honors ttl', async () => {
  const { createDiskCache } = await import('../src/cache/disk.js');
  const file = `/tmp/opencode/disk-cache-${Date.now()}.json`;
  const c1 = createDiskCache({ file, ttlMs: 10000 });
  c1.set('k1', { verdict: 'supported' });
  await new Promise((r) => setTimeout(r, 350));
  const c2 = createDiskCache({ file, ttlMs: 10000 });
  assert.deepEqual(c2.get('k1'), { verdict: 'supported' });
  const c3 = createDiskCache({ file, ttlMs: 1 });
  c3.set('k2', 1);
  await new Promise((r) => setTimeout(r, 20));
  const c4 = createDiskCache({ file, ttlMs: 1 });
  assert.equal(c4.get('k2'), undefined);
});

test('cache LRU evicts and TTL expires entries', async () => {
  const c = createCache({ max: 2, ttlMs: 50 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.size, 2);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('c'), 3);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get('c'), undefined);
  assert.equal(cacheKey('hello', 'en').length, 40);
});

test('GET /health returns ok and provider names', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.includes('wikipedia'));
    assert.ok(body.providers.includes('duckduckgo'));
    assert.ok(body.providers.includes('google-factcheck'));
    assert.equal(typeof body.uptime, 'number');
  } finally {
    server.close();
  }
});

test('POST /api/analyze-claims returns extracted claims', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/analyze-claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'The Earth orbits the Sun in 365 days.\nHumans landed on the Moon in 1969.' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.claims));
    assert.ok(body.claims.length >= 1);
    assert.ok(body.claims[0].text.length > 0);
  } finally {
    server.close();
  }
});

test('POST /api/fact-check validates claims array', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/fact-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/config reflects key presence', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.googleFactCheckKeyConfigured, 'boolean');
  } finally {
    server.close();
  }
});
