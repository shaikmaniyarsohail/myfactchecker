(function () {
  'use strict';

  var DEFAULTS = {
    windowMs: 16000,
    minWords: 6,
    maxWords: 40,
    maxClaims: 0
  };

  var INTERROGATIVES = [
    'who', 'what', 'when', 'where', 'why', 'how',
    'is', 'are', 'was', 'were', 'am',
    'do', 'does', 'did',
    'can', 'could', 'will', 'would', 'shall', 'should',
    'has', 'have', 'had'
  ];

  function cleanSpace(s) {
    return String(s == null ? '' : s)
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function sortedSegments(segments) {
    if (!Array.isArray(segments)) return [];
    return segments
      .filter(function (s) {
        return s && typeof s.text === 'string' && isFinite(Number(s.t));
      })
      .slice()
      .sort(function (a, b) {
        return Number(a.t) - Number(b.t);
      });
  }

  function splitSentences(text) {
    var prepared = String(text == null ? '' : text)
      .replace(/\r/g, '')
      .replace(/\.{3,}/g, ' … ')
      .replace(/…/g, ' … ');
    var out = [];
    prepared.split(/\n+/).forEach(function (line) {
      line.split(/(?<=[.!?…])\s+/).forEach(function (piece) {
        var p = cleanSpace(piece);
        if (p) out.push(p);
      });
    });
    return out;
  }

  function wordCount(s) {
    var matches = String(s).match(/[\p{L}\p{N}'’-]+/gu);
    return matches ? matches.length : 0;
  }

  function isQuestion(s) {
    if (/\?\s*$/.test(s)) return true;
    if (/[.!?…]\s*$/.test(s)) return false;
    var first = (s.match(/[A-Za-z]+/) || [''])[0].toLowerCase();
    return INTERROGATIVES.indexOf(first) !== -1;
  }

  function looksLikeLyrics(s) {
    if (/\d/.test(s)) return false;
    var body = String(s).replace(/^[^A-Za-z]+/, '');
    var firstWord = (body.match(/^[A-Za-z]+/) || [''])[0];
    var rest = body.slice(firstWord.length);
    return !/\b[A-Z][A-Za-z]{2,}/.test(rest);
  }

  function tokenSet(s) {
    var set = Object.create(null);
    (String(s).toLowerCase().match(/[a-z0-9']+/g) || []).forEach(function (w) {
      set[w] = 1;
    });
    return set;
  }

  function jaccard(a, b) {
    var aKeys = Object.keys(a);
    var inter = 0;
    aKeys.forEach(function (k) {
      if (b[k]) inter++;
    });
    var union = aKeys.length + Object.keys(b).length - inter;
    return union ? inter / union : 0;
  }

  function buildClaims(segments, opts) {
    var o = Object.assign({}, DEFAULTS, opts && typeof opts === 'object' ? opts : {});
    var segs = sortedSegments(segments);
    var windows = [];
    var cur = null;
    segs.forEach(function (seg) {
      if (!cur || Number(seg.t) - cur.start >= o.windowMs) {
        cur = { start: Number(seg.t), list: [] };
        windows.push(cur);
      }
      cur.list.push(seg);
    });

    var claims = [];
    var seen = [];
    var n = 0;
    for (var w = 0; w < windows.length; w++) {
      var windowText = windows[w].list
        .map(function (s) {
          return s.text;
        })
        .join(' ');
      var sentences = splitSentences(windowText);
      for (var i = 0; i < sentences.length; i++) {
        var text = sentences[i];
        var wc = wordCount(text);
        if (wc < o.minWords || wc > o.maxWords) continue;
        if (isQuestion(text)) continue;
        if (looksLikeLyrics(text)) continue;
        var toks = tokenSet(text);
        var dup = false;
        for (var s = 0; s < seen.length; s++) {
          if (jaccard(seen[s], toks) > 0.85) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        seen.push(toks);
        claims.push({ id: 'c' + ++n, text: text, timestampMs: windows[w].start });
        if (o.maxClaims > 0 && claims.length >= o.maxClaims) return claims;
      }
    }
    return claims;
  }

  function formatStamp(ms) {
    var total = Math.max(0, Math.floor(Number(ms) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function buildTranscriptText(segments) {
    return sortedSegments(segments)
      .map(function (seg) {
        return '[' + formatStamp(seg.t) + '] ' + cleanSpace(seg.text);
      })
      .join('\n');
  }

  window.SDSKClaims = {
    buildClaims: buildClaims,
    buildTranscriptText: buildTranscriptText
  };
})();
