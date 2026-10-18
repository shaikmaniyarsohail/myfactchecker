# Signal Desk — User Guide

Setup, what the overlay shows, and what to do when it doesn't.

## Quick start (3 steps)

### Step 1 — Start the server (terminal A)

```bash
cd ~/Documents/myfactchecker && npm start
```

Expect:

```
myfactchecker-server listening on http://localhost:8787
```

Do not use `sudo`. Keep this terminal open — closing it stops the server.

### Step 2 — Load the extension

1. Open `chrome://extensions` in Chrome.
2. Turn **Developer mode** on (top-right toggle).
3. Click **Load unpacked** and select `~/Documents/myfactchecker/extension`.
4. If the extension is already listed (e.g. after code changes), click the reload
   icon (⟻) on its card instead.

Confirm the card shows "Signal Desk — Live Fact Check" with no red **Errors**
button.

### Step 3 — Refresh the YouTube tab

**Refresh or reopen the YouTube tab.** Extensions never inject into tabs that
were opened before the extension loaded — this is the most common reason
nothing appears.

Then open a video that has captions. Within about 6 seconds a small **Signal
Desk** dock pill appears at the bottom-right of the player. Bubbles appear
after checking finishes, which may take 5–20 seconds.

## What you'll see

### Dock states

The dock is a small pill overlaid on the player. Hover it for a tooltip.

| Dock shows | Meaning |
|---|---|
| Idle | Extension loaded, nothing to check yet (no video, disabled, or no claims found). Tooltip: `Signal Desk idle`. |
| Checking | Claims are being sent to the server in batches. Tooltip: `Checking claims`. |
| Done | Check finished. Count reads like `12 claims +3` — 12 checked, 3 hidden by your filters (or below min confidence). Tooltip: `Check complete`. |
| NO CAPTIONS | No caption track was found for this video, so there is nothing to check. |
| Server offline | The local server isn't reachable — see troubleshooting below. |
| Error | A check request failed. Tooltip: `Check failed`. |

The dock also has a **HIDE** / **SHOW** toggle that turns bubbles on and off
without changing settings.

### Bubbles

Verdict panels appear over the video at the moment the claim was made:

| Color | Verdict | Default |
|---|---|---|
| Green | Supported | Shown |
| Red | Contradicted | Shown |
| Amber | Misleading | Shown |
| Blue | Unverified | Hidden |

Each bubble carries a verdict label, a confidence score, a short summary, and
source links. **Click the timestamp inside a bubble to seek the video to that
moment.**

Hidden-by-default means exactly that: `Unverified` bubbles exist but are not
rendered unless you switch them on in the popup.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Popup says **SERVER OFFLINE** | Server not running (revisit Step 1) or wrong server URL. It must be exactly `http://localhost:8787`. Click **TEST** in the popup after fixing. |
| Nothing appears on the player | Did you refresh the tab? (Step 3.) Then check `chrome://extensions` for a red **Errors** button on the extension card. Open DevTools → Console, filter for `SDSK`, and paste what it says when asking for help. |
| **NO CAPTIONS** chip | The video has no captions. Press the player's CC button to see if any track exists, or try another video. Check the `[SDSK]` console lines to see which caption path failed. |
| `12 claims +3` (or "0 hidden") | The number after `+` is claims filtered out — either their verdict is toggled off or confidence is below **MIN CONFIDENCE**. Lower the slider or enable that verdict in the popup. |
| `0 claims` after checking | No factual claims were extracted from the transcript. Some videos simply don't contain checkable statements. |
| Extension asks for permissions | It needs `storage`, `alarms`, and access to `youtube.com` plus `http://localhost:8787`. These come from the manifest — accept them. |
| Settings where? | Popup (toolbar icon) for day-to-day controls; **Settings** link in the popup footer opens the options page, which adds about/reset. Everything persists in `chrome.storage.local`. |
| Wikipedia/DuckDuckGo rate-limiting | Results get slower or partial. Retry after a minute; a 10-minute cache already absorbs repeated checks. |

When asking for help, always include: the popup status text, the dock state,
and the `[SDSK]` console lines from the video tab.

## Settings reference

Settings live in the popup (toolbar icon); the **Settings** link at the bottom
opens the options page. Changes save automatically.

| Control (exact label) | What it does |
|---|---|
| **Enable on this browser** | Master switch for the claim overlay. Turn it off and bubbles clear immediately. |
| **SERVER URL** + **TEST** | Backend address. Default `http://localhost:8787`. **TEST** saves it and pings the server: `CONNECTION OK` or `NO RESPONSE`. |
| **SIGNAL FILTERS** → `Supported` | Show green bubbles. On by default. |
| **SIGNAL FILTERS** → `Contradicted` | Show red bubbles. On by default. |
| **SIGNAL FILTERS** → `Misleading` | Show amber bubbles. On by default. |
| **SIGNAL FILTERS** → `Unverified` | Show blue bubbles. **Off by default.** |
| **MIN CONFIDENCE** (slider) | Hides results below this score. Range 0.00–0.95, step 0.05, default **0.55**. |
| **LANGUAGE** (select) | Caption/lookup language: `en — English`, `es — Español`, `fr — Français`, `de — Deutsch`, `hi — हिन्दी`. Default `en`. |
| Header status | `SERVER ONLINE` / `SERVER OFFLINE` — live ping of the server URL above. |

## What it doesn't do

Verdicts are heuristic (text overlap, negation, numeric conflict) against
Wikipedia, DuckDuckGo, and optionally the Google Fact Check Tools API. Treat
them as signals, not truth. No accounts, no telemetry.

## Filter safety net: ALL HIDDEN + SHOW ALL
If filters ever hide every result, the status dot turns amber and the dock reads
**ALL HIDDEN · N** with a **SHOW ALL (N)** button. One click enables all verdict
toggles, zeroes the confidence floor, and restores every result. Defaults are
already permissive (unverified results shown, 0% confidence floor).

## Seeing the server work
The server prints one line per request, e.g.:

    POST /api/fact-check claims=8 → 200 5300ms

Upstream providers are rate-limited to ~1 request/1.2s each (polite UA, Wikipedia
`maxlag`, one retry on 429/5xx) so results keep flowing instead of getting you
blocked. Verdicts are cached on disk for 24h, so repeat claims answer instantly.
If some providers fail, the verdict still returns with `reason: providers-degraded`
in the payload and a note in the summary — you'll see which sources were down.
