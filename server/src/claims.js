import {
  splitSentences,
  wordCount,
  isQuestion,
  hasFactualPredicate,
  contentTokens,
  jaccard,
} from './util/text.js';

const MIN_WORDS = 6;
const MAX_WORDS = 40;
const JACCARD_THRESHOLD = 0.85;

function isNearDuplicate(a, existing) {
  const ta = contentTokens(a);
  for (const b of existing) {
    const tb = contentTokens(b);
    if (jaccard(ta, tb) > JACCARD_THRESHOLD) return true;
  }
  return false;
}

export function extractClaims(transcript) {
  const sentences = splitSentences(transcript);
  const kept = [];
  for (const sentence of sentences) {
    const wc = wordCount(sentence);
    if (wc < MIN_WORDS || wc > MAX_WORDS) continue;
    if (isQuestion(sentence)) continue;
    if (!hasFactualPredicate(sentence)) continue;
    if (isNearDuplicate(sentence, kept)) continue;
    kept.push(sentence);
  }
  return kept.map((text, index) => ({ id: `c${index + 1}`, text }));
}

export default extractClaims;
