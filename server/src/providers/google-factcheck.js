import { normalizeUrl } from '../util/text.js';

const API = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';
const TIMEOUT_MS = 5000;

const RATING_MAP = [
  { pattern: /^(true|accurate|verified|correct|correctly)/i, verdict: 'supported' },
  { pattern: /^(mostly true|mostly accurate)/i, verdict: 'supported' },
  { pattern: /^(false|incorrect|misattributed|pants on fire)/i, verdict: 'contradicted' },
  { pattern: /^(mostly false)/i, verdict: 'contradicted' },
  { pattern: /^(misleading|missing context|outdated|unrated|partly)/i, verdict: 'misleading' },
];

function mapRating(rating) {
  const text = String(rating?.textualRating || rating || '');
  for (const { pattern, verdict } of RATING_MAP) {
    if (pattern.test(text)) return verdict;
  }
  return null;
}

export default {
  name: 'google-factcheck',
  get enabled() {
    return Boolean(process.env.GOOGLE_FACTCHECK_API_KEY);
  },
  async check(claimText, opts = {}) {
    const key = process.env.GOOGLE_FACTCHECK_API_KEY;
    if (!key) {
      return { verdict: 'unverified', confidence: 0.3, summary: 'Google Fact Check API key not configured.', sources: [] };
    }
    const url = new URL(API);
    url.searchParams.set('query', claimText);
    url.searchParams.set('key', key);
    if (opts.language) url.searchParams.set('languageCode', opts.language);
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Google Fact Check HTTP ${res.status}`);
    const data = await res.json();
    const claims = data.claims || [];
    const reviews = [];
    for (const claim of claims) {
      for (const review of claim.claimReview || []) {
        reviews.push({ claim, review });
      }
    }
    if (reviews.length === 0) {
      return { verdict: 'unverified', confidence: 0.3, summary: 'No Google Fact Check reviews found.', sources: [] };
    }
    const verdictCounts = { supported: 0, contradicted: 0, misleading: 0 };
    const sources = [];
    let topVerdict = null;
    for (const { claim, review } of reviews) {
      const v = mapRating(review);
      if (v) verdictCounts[v]++;
      const url = review.url || claim.url;
      if (url) {
        sources.push({
          title: review.publisher?.name || claim.publisher?.name || 'Fact Check',
          url: normalizeUrl(url),
          snippet: `${review.textualRating || ''} — ${(claim.text || claimText).slice(0, 200)}`.trim(),
        });
      }
    }
    let finalVerdict = 'unverified';
    let confidence = 0.3;
    const total = reviews.length;
    if (verdictCounts.contradicted > 0 && verdictCounts.contradicted >= verdictCounts.supported && verdictCounts.contradicted >= verdictCounts.misleading) {
      finalVerdict = 'contradicted';
      confidence = Math.min(0.9, 0.7 + (verdictCounts.contradicted / total) * 0.2);
      topVerdict = 'contradicted';
    } else if (verdictCounts.supported > 0 && verdictCounts.supported >= verdictCounts.contradicted && verdictCounts.supported >= verdictCounts.misleading) {
      finalVerdict = 'supported';
      confidence = Math.min(0.9, 0.7 + (verdictCounts.supported / total) * 0.2);
      topVerdict = 'supported';
    } else if (verdictCounts.misleading > 0) {
      finalVerdict = 'misleading';
      confidence = Math.min(0.9, 0.6 + (verdictCounts.misleading / total) * 0.2);
      topVerdict = 'misleading';
    }
    const summary = topVerdict
      ? `Google Fact Check found ${total} review(s); weighted verdict: ${finalVerdict}.`
      : 'Google Fact Check returned reviews but ratings could not be mapped.';
    return { verdict: finalVerdict, confidence, summary, sources: sources.slice(0, 5) };
  },
};
