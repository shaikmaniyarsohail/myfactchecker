import { schedule } from '../util/throttle.js';
import {
  contentTokens,
  tokenOverlap,
  hasNegation,
  negationNearPredicate,
  extractNumbers,
  extractEntities,
  normalizeUrl,
} from '../util/text.js';

const API = 'https://en.wikipedia.org/w/api.php';
const TIMEOUT_MS = 8000;
const UA = 'SignalDeskFactCheck/1.0 (local research tool; polite <1.2s interval, maxlag=5)';

async function wikiFetchOnce(params) {
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('maxlag', '5');
  return schedule('wikipedia', async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA } });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`Wikipedia HTTP ${res.status}`);
      err.retryable = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    return res.json();
  });
}

async function wikiFetch(params) {
  try {
    return await wikiFetchOnce(params);
  } catch (err) {
    if (!err?.retryable) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return wikiFetchOnce(params);
  }
}

function evaluateChunk(claimText, evidenceText, title) {
  const { coverA } = tokenOverlap(contentTokens(claimText), contentTokens(evidenceText));
  const claimNums = extractNumbers(claimText).map(String);
  const evidenceNums = new Set(extractNumbers(evidenceText).map(String));
  const numericMismatch = claimNums.length > 0 && claimNums.every((n) => !evidenceNums.has(n)) && coverA >= 0.5;
  const evidenceDenies = !hasNegation(claimText) && coverA >= 0.45 && negationNearPredicate(claimText, evidenceText);

  let verdict = 'unverified';
  let summary = `No clear match for the claim in the Wikipedia article "${title}".`;
  if (evidenceDenies) {
    verdict = 'contradicted';
    summary = `Wikipedia article "${title}" appears to contradict the claim near the shared subject matter.`;
  } else if (numericMismatch) {
    verdict = 'contradicted';
    summary = `Wikipedia article "${title}" covers the same subject but cites different figures than the claim.`;
  } else if (coverA >= 0.6) {
    verdict = 'supported';
    summary = `The claim aligns strongly with information in the Wikipedia article "${title}".`;
  } else if (coverA >= 0.35) {
    verdict = 'misleading';
    summary = `The claim partially overlaps with the Wikipedia article "${title}" but may lack important context.`;
  }
  const confidence = verdict === 'unverified' ? 0.3 : Math.max(0.3, Math.min(0.85, 0.3 + coverA * 0.55));
  return { verdict, confidence, summary };
}

function bestVerdict(claimText, evidenceChunks) {
  let best = { verdict: 'unverified', confidence: 0.3, summary: 'No strong evidence found on Wikipedia.' };
  const rank = { contradicted: 3, supported: 2, misleading: 1, unverified: 0 };
  for (const { text, title } of evidenceChunks) {
    const r = evaluateChunk(claimText, text, title);
    if (rank[r.verdict] > rank[best.verdict] || (r.verdict === best.verdict && r.confidence > best.confidence)) {
      best = r;
    }
  }
  return best;
}

export default {
  name: 'wikipedia',
  async check(claimText, opts = {}) {
    const entities = extractEntities(claimText);
    const parts = entities.map((e) => (e.includes(' ') ? `"${e}"` : e));
    const srsearch = parts.length ? parts.join(' ') : claimText;
    const searchRes = await wikiFetch({
      action: 'query',
      list: 'search',
      srsearch,
      format: 'json',
      srlimit: '5',
      srprop: 'snippet|title',
    });
    const hits = searchRes?.query?.search || [];
    if (hits.length === 0) {
      return { verdict: 'unverified', confidence: 0.3, summary: 'No relevant Wikipedia articles found.', sources: [] };
    }
    const topTitles = hits.slice(0, 2).map((h) => h.title);
    const extractRes = await wikiFetch({
      action: 'query',
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      titles: topTitles.join('|'),
      format: 'json',
      redirects: '1',
    });
    const pages = extractRes?.query?.pages || {};
    const evidenceChunks = Object.values(pages)
      .filter((p) => p.title && p.extract)
      .map((p) => ({ title: p.title, text: p.extract }));
    const snippetChunks = hits.map((h) => ({
      title: h.title,
      text: (h.snippet || '').replace(/<[^>]+>/g, ''),
    }));
    const { verdict, confidence, summary } = bestVerdict(claimText, evidenceChunks.length > 0 ? evidenceChunks : snippetChunks);
    const sources = topTitles.map((title) => ({
      title: `Wikipedia: ${title}`,
      url: normalizeUrl(`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`),
      snippet: (snippetChunks.find((c) => c.title === title)?.text || '').slice(0, 300),
    }));
    return { verdict, confidence, summary, sources };
  },
};
