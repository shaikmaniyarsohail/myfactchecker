const WEIGHTS = {
  'google-factcheck': 0.9,
  wikipedia: 0.6,
  duckduckgo: 0.35,
  'google-news': 0.3,
};

function mergeSources(providerResults) {
  const byUrl = new Map();
  for (const result of providerResults) {
    for (const source of result.sources || []) {
      if (!source.url) continue;
      if (!byUrl.has(source.url)) {
        byUrl.set(source.url, { title: source.title || source.url, url: source.url, snippet: source.snippet || '' });
      } else {
        const existing = byUrl.get(source.url);
        if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
        if (!existing.title && source.title) existing.title = source.title;
      }
    }
  }
  return [...byUrl.values()].slice(0, 10);
}

function weightedVerdict(providerResults) {
  const totals = { supported: 0, contradicted: 0, misleading: 0, unverified: 0 };
  let allWeight = 0;
  for (const { name, verdict, confidence } of providerResults) {
    const base = WEIGHTS[name] || 0.3;
    const w = base * Math.max(0.3, Math.min(1, confidence || 0.3));
    const key = totals[verdict] !== undefined ? verdict : 'unverified';
    totals[key] += w;
    allWeight += w;
  }
  const candidates = ['contradicted', 'supported', 'misleading']
    .filter((v) => totals[v] > 0)
    .sort((a, b) => totals[b] - totals[a]);
  if (candidates.length === 0 || totals.unverified >= totals[candidates[0]]) {
    return { verdict: 'unverified', confidence: 0.3 };
  }
  const verdict = candidates[0];
  const share = allWeight > 0 ? totals[verdict] / allWeight : 0;
  const confidence = Math.min(0.95, 0.3 + share * 0.5 + Math.min(0.15, totals[verdict] * 0.1));
  return { verdict, confidence: Number(confidence.toFixed(3)) };
}

export function aggregate(providerResults, { errors = [] } = {}) {
  const fulfilled = providerResults.filter(Boolean);
  if (fulfilled.length === 0) {
    return {
      verdict: 'unverified',
      confidence: 0.3,
      summary: errors.length
        ? 'All providers failed or were rate-limited. Try again shortly.'
        : 'No providers returned a result.',
      sources: [],
      provider: 'aggregator',
      reason: errors.length ? 'providers-degraded' : null,
      providerErrors: errors.map((e) => e.name),
    };
  }
  const { verdict, confidence } = weightedVerdict(fulfilled);
  const bestSummary = fulfilled
    .filter((r) => r.verdict === verdict && r.summary)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0]?.summary
    || fulfilled.find((r) => r.summary)?.summary
    || 'Aggregated result from available providers.';
  const degraded = verdict === 'unverified' && errors.length > 0;
  return {
    verdict,
    confidence,
    summary: degraded
      ? `Some sources were unavailable (${errors.map((e) => e.name).join(', ')}). ${bestSummary}`
      : bestSummary,
    sources: mergeSources(fulfilled),
    provider: 'aggregator',
    reason: degraded ? 'providers-degraded' : null,
    providerErrors: errors.map((e) => e.name),
  };
}

export async function runProviders(providers, claimText, opts = {}) {
  const enabled = providers.filter((p) => (typeof p.enabled === 'boolean' ? p.enabled : true));
  const settled = await Promise.allSettled(
    enabled.map(async (p) => {
      const result = await p.check(claimText, opts);
      return { name: p.name, ...result };
    })
  );
  const results = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      errors.push({ name: enabled[i]?.name || 'unknown', error: String(s.reason?.message || s.reason || 'failed') });
    }
  });
  return { results, errors };
}

export { WEIGHTS };
