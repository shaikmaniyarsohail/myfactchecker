(function () {
  'use strict';

  var TARGET = '/api/timedtext';
  var store = new Map();
  var captionTracks = new Map();
  var trackWaiters = [];

  function queryParam(url, key) {
    try {
      return new URL(url, location.origin).searchParams.get(key);
    } catch (e) {
      return null;
    }
  }

  function getCandidateVideoId() {
    try {
      var path = location.pathname || '';
      var match = path.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{5,})/);
      if (match) return match[1];
      if (path.indexOf('/watch') === 0) {
        var v = new URLSearchParams(location.search || '').get('v');
        if (v && /^[A-Za-z0-9_-]{5,}$/.test(v)) return v;
      }
    } catch (e) {}
    return null;
  }

  function normalizeText(s) {
    return String(s == null ? '' : s).replace(/ /g, ' ').trim();
  }

  function detectFormat(body, url) {
    var head = String(body || '').replace(/^\s+/, '').slice(0, 1);
    if (head === '<') return 'xml';
    if (head === '{' || head === '[') return 'json';
    if (/[?&]fmt=json3\b/.test(String(url || ''))) return 'json';
    return 'unknown';
  }

  function parseJson3(body, lang) {
    var data = JSON.parse(body);
    var events = data && Array.isArray(data.events) ? data.events : [];
    var out = [];
    events.forEach(function (ev) {
      if (!ev || !Array.isArray(ev.segs) || !ev.segs.length) return;
      var text = normalizeText(
        ev.segs
          .map(function (seg) {
            return seg && seg.utf8 != null ? String(seg.utf8) : '';
          })
          .join('')
      );
      if (!text) return;
      var t = Number(ev.tStartMs);
      if (!isFinite(t) || t < 0) t = 0;
      out.push({ t: Math.round(t), text: text, lang: lang, source: 'captions' });
    });
    return out;
  }

  function parseXml(body, lang) {
    var doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    var nodes = doc.getElementsByTagName('text');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var t = Math.round(parseFloat(node.getAttribute('start') || '0') * 1000);
      if (!isFinite(t) || t < 0) t = 0;
      var text = normalizeText(node.textContent);
      if (!text) continue;
      out.push({ t: t, text: text, lang: lang, source: 'captions' });
    }
    return out;
  }

  function parseTimedText(body, url) {
    if (typeof body !== 'string' || !body) return [];
    var lang = queryParam(url, 'lang') || 'en';
    var kind = detectFormat(body, url);
    var parsed = null;
    if (kind === 'json' || kind === 'unknown') {
      try {
        parsed = parseJson3(body, lang);
      } catch (e) {
        parsed = null;
      }
    }
    if (!parsed) {
      try {
        parsed = parseXml(body, lang);
      } catch (e) {
        parsed = null;
      }
    }
    if (!parsed) {
      try {
        parsed = parseJson3(body, lang);
      } catch (e) {
        parsed = null;
      }
    }
    return parsed || [];
  }

  function storeSegments(videoId, segments) {
    if (!videoId || !segments || !segments.length) return;
    var entry = store.get(videoId);
    if (!entry) {
      entry = { segments: [] };
      store.set(videoId, entry);
    }
    var seen = new Set();
    entry.segments.forEach(function (s) {
      seen.add(s.t + '|' + s.text);
    });
    segments.forEach(function (s) {
      var key = s.t + '|' + s.text;
      if (seen.has(key)) return;
      seen.add(key);
      entry.segments.push({ t: s.t, text: s.text, lang: s.lang, source: s.source });
    });
  }

  function getSegments(videoId) {
    var entry = store.get(videoId);
    if (!entry) return [];
    var seen = new Set();
    var out = [];
    entry.segments
      .slice()
      .sort(function (a, b) {
        return a.t - b.t;
      })
      .forEach(function (s) {
        var key = s.t + '|' + s.text;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ t: s.t, text: s.text, lang: s.lang, source: s.source });
      });
    return out;
  }

  function buildTimedTextUrl(videoId, lang) {
    return (
      'https://www.youtube.com/api/timedtext?v=' +
      encodeURIComponent(videoId) +
      '&lang=' +
      encodeURIComponent(lang || 'en') +
      '&fmt=json3'
    );
  }

  function fetchOne(url, videoId) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) return null;
        return res.text();
      })
      .then(function (body) {
        if (!body) return null;
        var segments = parseTimedText(body, url);
        if (!segments.length) return null;
        segments.forEach(function (s) {
          s.source = 'direct';
        });
        storeSegments(videoId, segments);
        return getSegments(videoId);
      })
      .catch(function () {
        return null;
      });
  }

  function orderTracks(tracks, preferredLang) {
    var preferred = String(preferredLang || 'en');
    var prefix = preferred.split('-')[0];
    var scored = tracks.map(function (t, i) {
      var lang = t.languageCode || '';
      var kind = t.kind || null;
      var score = 0;
      if (lang === preferred) score = 0;
      else if (lang.indexOf(prefix + '-') === 0 || prefix.indexOf(lang + '-') === 0) score = 1;
      else if (lang === prefix) score = 2;
      else if (!lang) score = 3;
      else score = 5;
      if (kind === 'asr') score += 1;
      return { t: t, score: score, i: i };
    });
    scored.sort(function (a, b) {
      return a.score - b.score || a.i - b.i;
    });
    return scored.map(function (s) {
      return s.t;
    });
  }

  function withJson3Fmt(baseUrl) {
    if (/[?&]fmt=/.test(baseUrl)) return baseUrl;
    return baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'fmt=json3';
  }

  function fetchTracks(videoId, preferredLang) {
    var tracks = captionTracks.get(videoId);
    if (!tracks || !tracks.length) return Promise.resolve(null);
    var ordered = orderTracks(tracks, preferredLang).slice(0, 6);
    var chain = Promise.resolve(null);
    ordered.forEach(function (track) {
      chain = chain.then(function (found) {
        if (found && found.length) return found;
        var url = withJson3Fmt(track.baseUrl);
        return fetch(url, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(8000)
        })
          .then(function (res) {
            if (!res.ok) return null;
            return res.text();
          })
          .then(function (body) {
            if (!body || body.length < 50) return null;
            var segments = parseTimedText(body, url);
            if (!segments.length) return null;
            var lang = track.languageCode || queryParam(url, 'lang') || 'en';
            segments.forEach(function (s) {
              s.lang = lang;
              s.source = 'direct';
            });
            storeSegments(videoId, segments);
            return getSegments(videoId);
          })
          .catch(function () {
            return null;
          });
      });
    });
    return chain;
  }

  function waitForCaptionTracks(videoId) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish(value) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        var idx = trackWaiters.indexOf(waiter);
        if (idx !== -1) trackWaiters.splice(idx, 1);
        resolve(value);
      }
      var waiter = function (id) {
        if (id === videoId) finish(captionTracks.get(videoId) || null);
      };
      trackWaiters.push(waiter);
      timer = setTimeout(function () {
        finish(captionTracks.get(videoId) || null);
      }, 2500);
    });
  }

  function fetchDirect(videoId, lang) {
    if (!videoId) return Promise.resolve(getSegments(videoId));
    var preferred = lang || 'en';
    var runFallback = function () {
      var candidates = [buildTimedTextUrl(videoId, preferred), buildTimedTextUrl(videoId, preferred) + '&kind=asr'];
      if (preferred !== 'en') {
        candidates.push(buildTimedTextUrl(videoId, 'en'), buildTimedTextUrl(videoId, 'en') + '&kind=asr');
      }
      var chain = Promise.resolve(null);
      candidates.forEach(function (url) {
        chain = chain.then(function (found) {
          if (found && found.length) return found;
          return fetchOne(url, videoId);
        });
      });
      return chain.then(function (found) {
        return found && found.length ? found : getSegments(videoId);
      });
    };
    var waitForTracks =
      !captionTracks.has(videoId) && getCandidateVideoId()
        ? waitForCaptionTracks(videoId)
        : Promise.resolve(null);
    return waitForTracks.then(function () {
      return fetchTracks(videoId, preferred).then(function (found) {
        if (found && found.length) return found;
        return runFallback();
      });
    });
  }

  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || data.source !== 'SDSK') return;
      if (data.type === 'CAPTION_TRACKS') {
        var tid = data.videoId || getCandidateVideoId();
        if (!tid || !Array.isArray(data.tracks) || !data.tracks.length) return;
        var existing = captionTracks.get(tid) || [];
        var byKey = new Map();
        existing.forEach(function (t) {
          byKey.set(t.baseUrl + '|' + (t.languageCode || '') + '|' + (t.kind || ''), t);
        });
        data.tracks.forEach(function (t) {
          if (!t || !t.baseUrl) return;
          byKey.set(t.baseUrl + '|' + (t.languageCode || '') + '|' + (t.kind || ''), t);
        });
        var merged = Array.from(byKey.values());
        captionTracks.set(tid, merged);
        console.info('[SDSK] caption tracks received: ' + merged.length + ' for ' + tid);
        trackWaiters.slice().forEach(function (w) {
          try {
            w(tid);
          } catch (e) {}
        });
        return;
      }
      if (data.type !== 'TIMEDTEXT') return;
      var url = String(data.url || '');
      if (url.indexOf(TARGET) === -1) return;
      var videoId = queryParam(url, 'v') || getCandidateVideoId();
      if (!videoId) return;
      var segments = parseTimedText(data.body, url);
      if (segments.length) storeSegments(videoId, segments);
    } catch (e) {}
  });

  window.SDSKTranscript = {
    parseTimedText: parseTimedText,
    getCandidateVideoId: getCandidateVideoId,
    getSegments: getSegments,
    buildTimedTextUrl: buildTimedTextUrl,
    fetchDirect: fetchDirect,
    store: store
  };
})();
