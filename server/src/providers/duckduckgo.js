import { schedule } from '../util/throttle.js';
import {
  contentTokens,
  tokenOverlap,
  hasNegation,
  negationNearPredicate,
  extractNumbers,
  normalizeUrl,
} from '../util/text.js';

const API = 'https://api.duckduckgo.com/';
const TIMEOUT_MS = 5000;
const CONFIDENCE_CAP = 0.6;

async function ddgFetch(query) {
  const url = new URL(API);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  return schedule('duckduckgo', async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'SignalDeskFactCheck/1.0 (local research tool)' } });
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
    return res.json();
  });
}

function collectText(data) {
  const chunks = [];
  if (data.AbstractText) chunks.push({ text: data.AbstractText, url: data.AbstractURL, title: data.Heading || data.AbstractSource || 'DuckDuckGo' });
  if (data.Answer) chunks.push({ text: data.Answer, url: data.AnswerType, title: 'DuckDuckGo Answer' });
  const topics = data.RelatedTopics || [];
  for (const t of topics) {
    if (t.Text && t.FirstURL) chunks.push({ text: t.Text, url: t.FirstURL, title: t.Text.split(' - ')[0].slice(0, 80) });
    if (Array.isArray(t.Topics)) {
      for (const st of t.Topics) {
        if (st.Text && st.FirstURL) chunks.push({ text: st.Text, url: st.FirstURL, title: st.Text.split(' - ')[0].slice(0, 80) });
      }
    }
  }
  return chunks;
}

function evaluate(claimText, chunks) {
  let best = { verdict: 'unverified', confidence: 0.3, summary: 'No usable DuckDuckGo results for this claim.' };
  const rank = { contradicted: 3, supported: 2, misleading: 1, unverified: 0 };
  for (const chunk of chunks) {
    const { overlap, coverA } = tokenOverlap(contentTokens(claimText), contentTokens(chunk.text));
    const claimNums = extractNumbers(claimText).map(String);
    const evidenceNums = new Set(extractNumbers(chunk.text).map(String));
    const numericMismatch = claimNums.length > 0 && claimNums.every((n) => !evidenceNums.has(n)) && coverA >= 0.45;
    const evidenceDenies = !hasNegation(claimText) && coverA >= 0.4 && negationNearPredicate(claimText, chunk.text);
    const base = Math.min(CONFIDENCE_CAP, 0.3 + coverA * 0.3);
    let verdict = 'unverified';
    let summary = `DuckDuckGo result "${chunk.title}" does not clearly confirm the claim.`;
    if (evidenceDenies) {
      verdict = 'contradicted';
      summary = `DuckDuckGo result "${chunk.title}" appears to contradict the claim.`;
    } else if (numericMismatch) {
      verdict = 'contradicted';
      summary = `DuckDuckGo result "${chunk.title}" mentions the same subject but different figures.`;
    } else if (coverA >= 0.55 && overlap > 0.4) {
      verdict = 'supported';
      summary = `DuckDuckGo result "${chunk.title}" is consistent with the claim.`;
    } else if (coverA >= 0.35) {
      verdict = 'misleading';
      summary = `DuckDuckGo result "${chunk.title}" partially supports the claim but may lack context.`;
    }
    const confidence = verdict === 'unverified' ? 0.3 : Math.max(0.3, Math.min(CONFIDENCE_CAP, base));
    if (rank[verdict] > rank[best.verdict] || (verdict === best.verdict && confidence > best.confidence)) {
      best = { verdict, confidence, summary };
    }
  }
  return best;
}

export default {
  name: 'duckduckgo',
  async check(claimText, opts = {}) {
    const data = await ddgFetch(claimText);
    const chunks = collectText(data);
    if (chunks.length === 0) {
      return { verdict: 'unverified', confidence: 0.3, summary: 'No DuckDuckGo evidence available.', sources: [] };
    }
    const { verdict, confidence, summary } = evaluate(claimText, chunks);
    const sources = chunks
      .filter((c) => c.url && /^https?:\/\//.test(c.url))
      .slice(0, 5)
      .map((c) => ({
        title: c.title || 'DuckDuckGo result',
        url: normalizeUrl(c.url),
        snippet: c.text.slice(0, 300),
      }));
    return { verdict, confidence, summary, sources };
  },
};
