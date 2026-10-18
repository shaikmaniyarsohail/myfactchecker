const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;

function trackName(name) {
  if (typeof name === 'string') return name;
  if (name?.simpleText) return name.simpleText;
  if (Array.isArray(name?.runs) && name.runs[0]?.text) return name.runs[0].text;
  return '';
}

function normalizeTracks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.baseUrl === 'string' && t.baseUrl)
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode || '',
      kind: t.kind || '',
      name: trackName(t.name),
    }));
}

function bracketParseTracks(html, startIdx) {
  const arrStart = html.indexOf('[', startIdx);
  if (arrStart === -1) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = arrStart; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return normalizeTracks(JSON.parse(html.slice(arrStart, i + 1)));
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

export function extractCaptionTracks(html) {
  const match = /"captionTracks":(\[.*?\])/.exec(html);
  if (match) {
    try {
      const tracks = normalizeTracks(JSON.parse(match[1]));
      if (tracks.length) return tracks;
    } catch {}
  }
  const marker = html.indexOf('"captionTracks":[');
  if (marker === -1) return [];
  return bracketParseTracks(html, marker);
}

export function parseJson3(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('caption response was not valid json3');
  }
  const segments = [];
  for (const ev of data?.events || []) {
    if (!Array.isArray(ev?.segs)) continue;
    const text = ev.segs.map((s) => s?.utf8 || '').join('').trim();
    if (!text) continue;
    segments.push({ t: (ev.tStartMs || 0) + (ev.segs[0]?.tStartMs || 0), text });
  }
  return segments;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export function parseXmlCaptions(body) {
  const segments = [];
  const re = /<text\b[^>]*\bstart="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const start = Number.parseFloat(m[1]);
    const text = decodeXmlEntities(m[2]).trim();
    if (!text || Number.isNaN(start)) continue;
    segments.push({ t: Math.round(start * 1000), text });
  }
  return segments;
}

export function orderCaptionTracks(tracks, lang = 'en') {
  const wanted = String(lang || 'en').toLowerCase();
  const langScore = (t) => {
    const code = String(t.languageCode || '').toLowerCase();
    if (code === wanted || code.startsWith(`${wanted}-`)) return 0;
    if (code === 'en' || code.startsWith('en-')) return 1;
    return 2;
  };
  const kindScore = (t) => (t.kind ? 1 : 0);
  return tracks
    .slice()
    .sort((a, b) => langScore(a) - langScore(b) || kindScore(a) - kindScore(b))
    .slice(0, 6);
}

export async function fetchCaptionTracks(videoId, { fetchImpl = fetch, userAgent } = {}) {
  const res = await fetchImpl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: {
      'User-Agent': userAgent || DEFAULT_UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
  const html = await res.text();
  return extractCaptionTracks(html);
}

export async function fetchTrackSegments(baseUrl, { fetchImpl = fetch, userAgent, lang } = {}) {
  const url = baseUrl + (baseUrl.includes('fmt=') ? '' : '&fmt=json3');
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': userAgent || DEFAULT_UA,
      Referer: 'https://www.youtube.com/',
      ...(lang ? { 'Accept-Language': String(lang) } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`caption fetch HTTP ${res.status}`);
  const body = await res.text();
  if (body.length < 50) return [];
  if (body.trimStart().startsWith('<')) return parseXmlCaptions(body);
  return parseJson3(body);
}

export async function getTranscript(videoId, lang = 'en', opts = {}) {
  let tracks = [];
  try {
    tracks = await fetchCaptionTracks(videoId, opts);
  } catch {
    tracks = [];
  }
  if (!tracks.length) throw new Error('no caption tracks found for this video');
  for (const track of orderCaptionTracks(tracks, lang)) {
    try {
      const segments = await fetchTrackSegments(track.baseUrl, { ...opts, lang });
      if (segments.length) {
        return {
          track: { languageCode: track.languageCode, kind: track.kind || null, name: track.name },
          segments,
        };
      }
    } catch {}
  }
  throw new Error('all caption tracks empty');
}
