# myfactchecker-server

Free-API fact-checking backend for YouTube video claims. Uses Wikipedia and DuckDuckGo (no keys required) plus optional Google Fact Check Tools API.

## Run

```bash
npm install
npm start
```

Server listens on `http://localhost:8787` (override with `PORT`).

## Optional API key

Copy `.env.example` and set `GOOGLE_FACTCHECK_API_KEY` to enable the Google Fact Check provider (highest weight). Without it, the server runs fully on Wikipedia + DuckDuckGo.

```bash
export GOOGLE_FACTCHECK_API_KEY=your_key_here
npm start
```

## Endpoints

- `GET /health` → `{ ok, providers, uptime }`
- `GET /api/config` → `{ googleFactCheckKeyConfigured }`
- `POST /api/analyze-claims` — body `{ transcript }` → `{ claims: [{ id, text }] }` (server-side claim extraction)
- `POST /api/fact-check` — body `{ videoId?, claims: [{ id, text, timestampMs? }], options?: { language?: 'en' } }` → `{ results: [{ id, verdict, confidence, summary, sources, provider }] }`

Verdicts: `supported | contradicted | misleading | unverified`.

## Tests

```bash
npm test
```

## Notes

- Results are cached in-memory (LRU, 500 entries, 10-minute TTL).
- Individual provider failures never fail the whole request; partial results are returned.
- Wikipedia and DuckDuckGo have no official SLA and rate-limit aggressively; treat confidence scores as heuristic signals, not ground truth.
