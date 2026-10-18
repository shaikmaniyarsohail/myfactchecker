import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCaptionTracks,
  parseJson3,
  parseXmlCaptions,
  orderCaptionTracks,
  fetchCaptionTracks,
  getTranscript,
} from '../src/youtube.js';
import { createApp } from '../src/server.js';

const WATCH_HTML = `<html><head><title>Test Video - YouTube</title></head><body>
<script>var ytInitialData = {"responseContext":{"junk":true}};</script>
<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&expire=123&sig=abc","languageCode":"en","kind":"","name":{"simpleText":"English"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&expire=123&sig=def","languageCode":"en","kind":"asr","name":{"runs":[{"text":"English (auto-generated)"}]}}]}}};</script>
<div class="junk">watch page footer</div>
</body></html>`;

test('extractCaptionTracks pulls tracks from watch-page HTML', () => {
  const tracks = extractCaptionTracks(WATCH_HTML);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].languageCode, 'en');
  assert.equal(tracks[0].kind, '');
  assert.equal(tracks[0].name, 'English');
  assert.ok(tracks[0].baseUrl.startsWith('https://www.youtube.com/api/timedtext?'));
  assert.equal(tracks[1].kind, 'asr');
  assert.equal(tracks[1].name, 'English (auto-generated)');
});

test('extractCaptionTracks falls back to bracket scan when regex capture is unparseable', () => {
  const html = 'junk "captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=x&x]=1","languageCode":"en","name":{"simpleText":"English"}}] trailing';
  const tracks = extractCaptionTracks(html);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'English');
  assert.ok(tracks[0].baseUrl.includes(']'));
});

test('extractCaptionTracks returns [] when no captionTracks present', () => {
  assert.deepEqual(extractCaptionTracks('<html><body>no captions here</body></html>'), []);
});

test('parseJson3 merges event segs and maps tStartMs', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 1000, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
      { tStartMs: 3500, segs: [{ tStartMs: 50, utf8: 'foo' }, { utf8: ' bar' }] },
      { tStartMs: 4000, segs: [{ utf8: '   ' }] },
    ],
  });
  assert.deepEqual(parseJson3(body), [
    { t: 1000, text: 'hello world' },
    { t: 3550, text: 'foo bar' },
  ]);
});

test('parseXmlCaptions decodes entities and converts start seconds to ms', () => {
  const xml = '<transcript><text start="1.5">hello &amp; hi</text><text start="2">it&#39;s &quot;fine&quot; &lt;ok&gt;</text></transcript>';
  assert.deepEqual(parseXmlCaptions(xml), [
    { t: 1500, text: 'hello & hi' },
    { t: 2000, text: "it's \"fine\" <ok>" },
  ]);
});

test('orderCaptionTracks: preferred lang first, manual before asr, cap 6', () => {
  const tracks = [
    { languageCode: 'en', kind: 'asr', name: 'English (auto)' },
    { languageCode: 'hi', kind: '', name: 'Hindi' },
    { languageCode: 'es', kind: '', name: 'Spanish' },
    { languageCode: 'en', kind: '', name: 'English' },
  ];
  const enOrder = orderCaptionTracks(tracks, 'en');
  assert.deepEqual(enOrder.map((t) => t.name), ['English', 'English (auto)', 'Hindi', 'Spanish']);
  const hiOrder = orderCaptionTracks(tracks, 'hi');
  assert.equal(hiOrder[0].name, 'Hindi');
  assert.equal(hiOrder[1].name, 'English');
  const many = Array.from({ length: 10 }, (_, i) => ({ languageCode: `l${i}`, kind: '', name: `n${i}` }));
  assert.equal(orderCaptionTracks(many, 'en').length, 6);
});

test('fetchCaptionTracks requests the watch page with injected fetch', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(WATCH_HTML, { status: 200 });
  };
  const tracks = await fetchCaptionTracks('dQw4w9WgXcQ', { fetchImpl });
  assert.equal(tracks.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.ok(calls[0].init.headers['User-Agent'].includes('Chrome/126'));
  assert.equal(calls[0].init.headers['Accept-Language'], 'en-US,en;q=0.9');
});

test('getTranscript returns first non-empty track end-to-end via injected fetch', async () => {
  const json3 = JSON.stringify({
    events: [
      { tStartMs: 0, segs: [{ utf8: 'Never gonna give you up.' }] },
      { tStartMs: 2500, segs: [{ utf8: 'Never gonna let you down.' }] },
    ],
  });
  const fetchImpl = async (url) => {
    if (url.includes('/watch?')) return new Response(WATCH_HTML, { status: 200 });
    if (url.includes('sig=abc')) return new Response(json3, { status: 200 });
    return new Response('', { status: 200 });
  };
  const result = await getTranscript('dQw4w9WgXcQ', 'en', { fetchImpl });
  assert.equal(result.track.languageCode, 'en');
  assert.equal(result.track.kind, null);
  assert.equal(result.track.name, 'English');
  assert.deepEqual(result.segments, [
    { t: 0, text: 'Never gonna give you up.' },
    { t: 2500, text: 'Never gonna let you down.' },
  ]);
});

test('getTranscript throws readable error when watch page has no tracks', async () => {
  const fetchImpl = async () => new Response('<html>nope</html>', { status: 200 });
  await assert.rejects(() => getTranscript('dQw4w9WgXcQ', 'en', { fetchImpl }), /no caption tracks/);
});

test('GET /api/youtube-transcript rejects bad videoId with 400', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/youtube-transcript?videoId=bad!id`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'bad videoId');
    const missing = await fetch(`http://127.0.0.1:${port}/api/youtube-transcript`);
    assert.equal(missing.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/youtube-transcript returns 200 ok:false when upstream fails', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await realFetch(`http://127.0.0.1:${port}/api/youtube-transcript?videoId=dQw4w9WgXcQ`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');
    const health = await realFetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
