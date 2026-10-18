# Signal Desk — Live Fact Check

A from-scratch YouTube fact-check overlay: MV3 Chrome extension + local Node.js fact-check server.
100% original code, free/public data sources only (Wikipedia, DuckDuckGo, optional Google Fact Check Tools API).

## Layout

```
myfactchecker/
├── extension/          MV3 Chrome extension (load this unpacked)
│   ├── manifest.json
│   ├── background/service-worker.js   message router, config, server proxy, SW keepalive
│   ├── content/                       interceptor, transcript, claims, bubble UI, styles
│   ├── popup/  options/               settings UIs
│   └── icons/
├── server/             local fact-check API on :8787
│   ├── src/providers/  wikipedia (keyless), duckduckgo (keyless), google-factcheck (optional key)
│   ├── src/aggregator.js  weighted verdict merge + source dedup
│   └── test/           13 node:test cases
└── docs/
```

## Quick start

Full instructions + troubleshooting: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

1. **Server** (terminal A, keep open, no sudo):

   ```bash
   cd ~/Documents/myfactchecker && npm start
   ```

   Expect `myfactchecker-server listening on http://localhost:8787`.

2. **Extension**: `chrome://extensions` → Developer mode ON → Load unpacked →
   select `~/Documents/myfactchecker/extension`. If already listed after code
   changes, click the ⟻ reload icon.

3. **Refresh/reopen the YouTube tab** (extensions never inject into tabs opened
   before loading) → open a video with captions → within ~6s the "Signal Desk"
   dock pill appears bottom-right of the player; bubbles follow in 5–20s.

Optional: `GOOGLE_FACTCHECK_API_KEY=... npm start` enables the Google Fact Check Tools provider.

## How it works

1. `content/interceptor.js` (page world) passively captures caption responses YouTube itself downloads (`/api/timedtext`) — no extra YouTube requests.
2. `transcript.js` parses them (json3/XML) → `claims.js` extracts factual claim sentences.
3. `background/service-worker.js` batches claims to `POST /api/fact-check` on your local server.
4. Server queries Wikipedia / DuckDuckGo / Google Fact Check in parallel, aggregates a weighted verdict (`supported | contradicted | misleading | unverified`) with confidence + sources.
5. `bubbles.js` renders "Signal Desk" panels over the video; click a timestamp to seek.

## Settings

Popup: enable switch, server URL + test, per-verdict filters, min confidence, language.
Options page: same + about/reset. Everything persists in `chrome.storage.local`.

## Notes

- Verdicts are heuristic (text overlap, negation, numeric conflict) — treat as signals, not truth.
- Wikipedia/DDG rate-limit under heavy use; 10-min in-memory LRU cache mitigates.
- All testing, no telemetry, no accounts, no external services beyond public APIs.
