const DEFAULT_CONFIG = {
  serverUrl: 'http://localhost:8787',
  enabled: true,
  minConfidence: 0.3,
  showSupported: true,
  showContradicted: true,
  showMisleading: true,
  showUnverified: true,
  language: 'en'
};

const KEEPALIVE_ALARM = 'sdsdk-keepalive';
const KEEPALIVE_PERIOD_S = 25;
const CHECK_TIMEOUT_MS = 60000;
const PING_TIMEOUT_MS = 2500;
const TRANSCRIPT_TIMEOUT_MS = 15000;

const checkingTabs = new Set();

function errText(err) {
  return String((err && err.message) || err || 'unknown error');
}

function baseServerUrl(config) {
  return String((config && config.serverUrl) || DEFAULT_CONFIG.serverUrl).replace(/\/+$/, '');
}

async function readConfig() {
  const stored = await chrome.storage.local.get({ config: null });
  if (!stored.config || typeof stored.config !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...stored.config };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local
    .get({ config: null })
    .then(({ config }) => {
      if (!config || typeof config !== 'object') {
        return chrome.storage.local.set({ config: { ...DEFAULT_CONFIG, v: 2 } });
      }
      let next = { ...DEFAULT_CONFIG, ...config };
      if (!config.v || config.v < 2) {
        next = {
          ...next,
          showUnverified: true,
          minConfidence: 0.3,
          v: 2
        };
      }
      return chrome.storage.local.set({ config: next });
    })
    .catch(() => {});
});

function keepaliveOn() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_S / 60 });
  } catch (e) {}
}

function keepaliveOff() {
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch (e) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (checkingTabs.size > 0) keepaliveOn();
  else keepaliveOff();
});

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (checkingTabs.delete(tabId) && checkingTabs.size === 0) keepaliveOff();
  });
} catch (e) {}

function trackSender(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return;
  checkingTabs.add(tabId);
  keepaliveOn();
}

async function postJson(path, payload, timeoutMs) {
  const config = await readConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseServerUrl(config) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(path, timeoutMs) {
  const config = await readConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseServerUrl(config) + path, {
      method: 'GET',
      signal: controller.signal
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function timeoutMessage(err) {
  const text = errText(err);
  if ((err && err.name === 'AbortError') || /abort|timed?\s?out/i.test(text)) {
    return 'server timeout';
  }
  return text;
}

function normalizeTranscript(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'bad server response' };
  }
  if (data.ok === false) {
    return { ok: false, error: data.error || 'transcript unavailable' };
  }
  const segments = Array.isArray(data.segments) ? data.segments : [];
  return { ok: true, segments };
}

async function probeServer() {
  const config = await readConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(baseServerUrl(config) + '/', { signal: controller.signal });
    return res.status < 500;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function pickResults(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.claims)) return data.claims;
  return [];
}

async function route(msg, sender) {
  const type = msg && msg.type;
  switch (type) {
    case 'GET_CONFIG':
      return readConfig();
    case 'SET_CONFIG': {
      const current = await readConfig();
      const patch =
        msg.patch && typeof msg.patch === 'object'
          ? msg.patch
          : msg.config && typeof msg.config === 'object'
            ? msg.config
            : {};
      const next = { ...current, ...patch };
      await chrome.storage.local.set({ config: next });
      return next;
    }
    case 'FACT_CHECK': {
      trackSender(sender);
      const claims = Array.isArray(msg.claims) ? msg.claims : [];
      if (!claims.length) return { ok: true, results: [] };
      try {
        const data = await postJson(
          '/api/fact-check',
          { videoId: msg.videoId || null, claims },
          CHECK_TIMEOUT_MS
        );
        return { ok: true, results: pickResults(data) };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    }
    case 'ANALYZE_TRANSCRIPT': {
      trackSender(sender);
      try {
        const data = await postJson(
          '/api/analyze-claims',
          { transcript: typeof msg.transcript === 'string' ? msg.transcript : '' },
          CHECK_TIMEOUT_MS
        );
        const claims =
          data && Array.isArray(data.claims) ? data.claims : Array.isArray(data) ? data : [];
        return { ok: true, claims };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    }
    case 'GET_REMOTE_TRANSCRIPT': {
      const videoId = typeof msg.videoId === 'string' ? msg.videoId.trim() : '';
      if (!/^[A-Za-z0-9_-]{5,}$/.test(videoId)) {
        return { ok: false, error: 'invalid videoId' };
      }
      const lang =
        typeof msg.lang === 'string' && msg.lang.trim() ? msg.lang.trim() : 'en';
      const path =
        '/api/youtube-transcript?videoId=' +
        encodeURIComponent(videoId) +
        '&lang=' +
        encodeURIComponent(lang);
      const attempts = [
        () => postJson(path, { videoId, lang }, TRANSCRIPT_TIMEOUT_MS),
        () => getJson(path, TRANSCRIPT_TIMEOUT_MS)
      ];
      let lastErr = null;
      for (const attempt of attempts) {
        try {
          const data = await attempt();
          return normalizeTranscript(data);
        } catch (e) {
          lastErr = e;
        }
      }
      return { ok: false, error: timeoutMessage(lastErr) };
    }
    case 'PING': {
      const server = await probeServer();
      return { ok: true, server };
    }
    case 'CHECKING_STARTED':
      trackSender(sender);
      return { ok: true };
    case 'CHECKING_ENDED': {
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId === 'number') {
        checkingTabs.delete(tabId);
        if (checkingTabs.size === 0) keepaliveOff();
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown message type' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  Promise.resolve()
    .then(() => route(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: errText(err) }));
  return true;
});
