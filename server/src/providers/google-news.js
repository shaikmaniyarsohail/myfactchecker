import { contentTokens, tokenOverlap, extractEntities, normalizeUrl } from '../util/text.js';
import { schedule } from '../util/throttle.js';

const API = 'https://news.google.com/rss/search';
const TIMEOUT_MS = 8000;
const CONFIDENCE_CAP = 0.45;
const UA = 'SignalDeskFactCheck/1.0 (local research tool)';

function buildQuery(claimText) {
  const entities = extractEntities(claimText).filter((e) => e.length > 3);
  const content = contentTokens(claimText);
  const words = [...new Set([...entities, ...content])]
    .filter((w) => w.length > 3)
    .slice(0, 8);
  return words.length ? words.join(' ') : claimText.slice(0, 120);
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function parseRssItems(xml) {
  const out = [];
  const items = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const item of items.slice(0, 12)) {
    const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = decodeXml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const sourceName = decodeXml((item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
    const pubDate = decodeXml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    if (!title || !/^https?:\/\//.test(link)) continue;
    out.push({
      title: title.replace(/\s+-\s+[^-]+$/, '').slice(0, 200) || title,
      url: normalizeUrl(link),
      source: sourceName || '',
      pubDate,
    });
  }
  return out;
}

async function newsFetch(query) {
  const url = new URL(API);
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');
  return schedule('google-news', async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA } });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`Google News HTTP ${res.status}`);
      err.retryable = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
    return res.text();
  });
}

async function fetchNews(query) {
  try {
    return await newsFetch(query);
  } catch (err) {
    if (!err?.retryable) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return newsFetch(query);
  }
}

function evaluate(claimText, items) {
  const claimTokens = contentTokens(claimText);
  let bestCover = 0;
  let best = null;
  for (const a of items) {
    const { coverA } = tokenOverlap(claimTokens, contentTokens(a.title));
    if (coverA > bestCover) {
      bestCover = coverA;
      best = a;
    }
  }
  const summary = items.length
    ? `${items.length} recent news mention${items.length === 1 ? '' : 's'} of related terms${best ? ` (closest: "${best.title}")` : ''}. News coverage alone cannot verify this claim.`
    : 'No recent news coverage found for this claim.';
  return {
    verdict: 'unverified',
    confidence: items.length ? Math.min(CONFIDENCE_CAP, 0.3 + bestCover * 0.2) : 0.3,
    summary,
  };
}

export default {
  name: 'google-news',
  async check(claimText, opts = {}) {
    const query = buildQuery(claimText);
    const xml = await fetchNews(query);
    const items = parseRssItems(xml);
    const { verdict, confidence, summary } = evaluate(claimText, items);
    const sources = items.slice(0, 3).map((a) => ({
      title: (a.source ? `${a.source}: ` : 'News: ') + a.title,
      url: a.url,
      snippet: a.pubDate ? `Published ${a.pubDate}` : '',
    }));
    return { verdict, confidence, summary, sources };
  },
};
