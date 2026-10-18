const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'neither', 'nobody', 'nothing', 'nowhere', 'nor',
  "isn't", "isnt", "aren't", "arent", "wasn't", "wasnt", "weren't", "werent",
  "doesn't", "doesnt", "don't", "dont", "didn't", "didnt", "hasn't", "hasnt",
  "haven't", "havent", "hadn't", "hadnt", "won't", "wont", "wouldn't", "wouldnt",
  "can't", "cant", "couldn't", "couldnt", "shouldn't", "shouldnt", "mustn't", "mustnt",
  "cannot", "without", "disprove", "refute", "denied", "denies", "reject", "rejects",
  'false', 'incorrect', 'wrong', 'myth', 'debunk', 'debunked', 'lie', 'lies',
]);

const FACTIVE_VERBS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had',
  'will', 'shall', 'would', 'could', 'can', 'may', 'might', 'must',
  'did', 'does', 'do',
  'according', 'discovered', 'found', 'proved', 'proven', 'confirmed', 'shown', 'stated', 'said', 'announced',
]);

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'into', 'about', 'over',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'we', 'you', 'i',
  'not', 'no', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'a', 'so', 'such', 'up', 'out', 'up', 'just', 'also', 'more', 'most', 'some', 'any',
]);

export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function stem(token) {
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

export function contentTokens(text) {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t) && t.length > 1)
    .map(stem);
}

export function jaccard(a, b) {
  const setA = Array.isArray(a) ? new Set(a) : new Set(tokenize(a));
  const setB = Array.isArray(b) ? new Set(b) : new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function tokenOverlap(a, b) {
  const setA = new Set(Array.isArray(a) ? a : contentTokens(a));
  const setB = new Set(Array.isArray(b) ? b : contentTokens(b));
  if (setA.size === 0 || setB.size === 0) return { overlap: 0, coverA: 0, coverB: 0 };
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return { overlap: inter / Math.max(setA.size, setB.size), coverA: inter / setA.size, coverB: inter / setB.size };
}

export function hasNegation(text) {
  const tokens = tokenize(text);
  return tokens.some((t) => NEGATION_WORDS.has(t));
}

export function negationDiffers(claimText, evidenceText) {
  return hasNegation(claimText) !== hasNegation(evidenceText);
}

export function claimPredicateTokens(claimText) {
  const words = String(claimText).match(/\b[A-Za-z']+\b/g) || [];
  const preds = new Set();
  for (const w of words) {
    if (/^[A-Z]/.test(w)) continue;
    const t = stem(w.toLowerCase());
    if (STOPWORDS.has(t) || t.length < 3) continue;
    preds.add(t);
  }
  return preds;
}

export function negationNearPredicate(claimText, evidenceText, window = 2) {
  const preds = claimPredicateTokens(claimText);
  if (preds.size === 0) return false;
  const ev = tokenize(evidenceText);
  for (let i = 0; i < ev.length; i++) {
    if (!NEGATION_WORDS.has(ev[i])) continue;
    if (ev[i] === 'no' && ev[i + 1] === 'longer') continue;
    if (ev[i] === 'not' && ev[i + 1] === 'only') continue;
    const start = Math.max(0, i - window);
    const end = Math.min(ev.length - 1, i + window);
    for (let j = start; j <= end; j++) {
      if (j !== i && preds.has(ev[j])) return true;
    }
  }
  return false;
}

export function extractNumbers(text) {
  const matches = String(text).match(/\b\d+(?:[.,]\d+)*\b/g);
  if (!matches) return [];
  return matches.map((m) => parseFloat(m.replace(/,/g, ''))).filter((n) => !Number.isNaN(n));
}

export function splitSentences(transcript) {
  if (!transcript) return [];
  const normalized = String(transcript)
    .replace(/\r/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
  const pieces = normalized.split(/(?<=[.!?])\s+|\n+/);
  return pieces
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

export function wordCount(text) {
  const t = String(text).trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function isQuestion(text) {
  const t = String(text).trim();
  if (t.endsWith('?')) return true;
  const first = tokenize(t)[0] || '';
  const qWords = new Set(['who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose', 'whom']);
  return qWords.has(first);
}

export function hasFactualPredicate(text) {
  const tokens = tokenize(text);
  if (/\b\d/.test(text)) return true;
  if (/\b(19|20)\d{2}\b/.test(text)) return true;
  if (/\b\d+(\.\d+)?\s?(%|percent|km|kg|mi|miles|feet|meters|metres|degrees|celsius|fahrenheit|billion|million|trillion|thousand|hundred)\b/i.test(text)) return true;
  const capitalized = String(text).match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g) || [];
  if (capitalized.length > 0) return true;
  return tokens.some((t) => FACTIVE_VERBS.has(t));
}

export function extractEntities(text) {
  const entities = new Set();
  const multiWord = String(text).match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/g) || [];
  for (const m of multiWord) {
    const parts = m.split(/\s+/).filter((p) => !STOPWORDS.has(p.toLowerCase()));
    if (parts.length >= 2) entities.add(parts.join(' '));
    else if (parts.length === 1) entities.add(parts[0]);
  }
  const singleCap = String(text).match(/\b[A-Z][a-z]{2,}\b/g) || [];
  for (const m of singleCap) {
    if (!STOPWORDS.has(m.toLowerCase())) entities.add(m);
  }
  const numUnits = String(text).match(/\b\d+(?:[.,]\d+)*\s?(?:%|percent|km|kg|mi|miles|feet|meters|metres|degrees|celsius|fahrenheit|billion|million|trillion|thousand|hundred|years?|months?|days?|hours?|seconds?)\b/gi) || [];
  for (const n of numUnits) entities.add(n.trim());
  return [...entities].slice(0, 6);
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const params = [...u.searchParams.entries()].filter(([k]) => !k.startsWith('utm_'));
    u.search = new URLSearchParams(params).toString();
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).trim();
  }
}
