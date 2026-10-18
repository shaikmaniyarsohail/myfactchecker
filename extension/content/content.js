(function () {
  'use strict';

  var Transcript = window.SDSKTranscript;
  var Claims = window.SDSKClaims;

  var BATCH_SIZE = 8;
  var CAPTION_WAIT_MS = 4000;
  var DEBOUNCE_MS = 350;
  var POLL_MS = 2000;
  var PLAYER_TIMEOUT_MS = 8000;
  var DOCK_POLL_MS = 500;
  var DOCK_TIMEOUT_MS = 60000;
  var CAPTION_TOAST_TEXT =
    'Captions unavailable — press CC (c) to enable, or check the server';

  window.SDSK = {
    videoId: null,
    segments: [],
    claims: [],
    results: {},
    config: null,
    checking: false,
    getVideoId: function () {
      return state.videoId;
    },
    getResults: function () {
      return state.results;
    },
    getPlayerRect: function () {
      var el = playerEl();
      if (!el || typeof el.getBoundingClientRect !== 'function') {
        return { left: 0, top: 0, width: 0, height: 0 };
      }
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    seekTo: function (ms) {
      var video = document.querySelector('video');
      var t = Number(ms);
      if (!video || !isFinite(t) || t < 0) return false;
      try {
        video.currentTime = t / 1000;
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  var state = window.SDSK;
  var runToken = 0;
  var debounceTimer = null;
  var dockTimer = null;
  var dockApiWarned = false;
  var hiddenToastShown = false;
  var allHiddenToastShown = false;
  var lastStatusName = 'idle';
  var lastDetail = null;
  var captionToasted = new Set();

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          void chrome.runtime.lastError;
          resolve(response);
        });
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  function playerEl() {
    return document.getElementById('movie_player') || document.querySelector('#movie_player');
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function waitForPlayer(timeoutMs) {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function tick() {
        if (playerEl() || document.querySelector('ytd-app')) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      })();
    });
  }

  function isFactCheckPage() {
    var path = String(location.pathname || '');
    if (path === '/watch' || path.indexOf('/watch') === 0) return true;
    if (path.indexOf('/shorts/') === 0) return true;
    if (path.indexOf('/live/') === 0) return true;
    if (path.indexOf('/embed/') === 0) return true;
    return false;
  }

  function dockHost() {
    return (
      document.getElementById('movie_player') ||
      document.querySelector('#movie_player') ||
      document.getElementById('shorts-player') ||
      document.querySelector('ytd-player #movie_player, ytd-player') ||
      null
    );
  }

  function initDockOnce() {
    var host = dockHost();
    if (!host) return false;
    try {
      if (!window.SDSKBubbles || typeof window.SDSKBubbles.init !== 'function') {
        if (!dockApiWarned) {
          dockApiWarned = true;
          console.error('[SDSK] bubbles API missing — dock unavailable');
        }
        return false;
      }
      var ok = window.SDSKBubbles.init(host);
      if (ok === false) {
        console.error('[SDSK] bubbles init refused host', host.id || host.tagName);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[SDSK] dock init failed', err);
      return false;
    }
  }

  function ensureDock() {
    try {
      if (!isFactCheckPage()) return false;
      if (initDockOnce()) {
        if (dockTimer) {
          clearInterval(dockTimer);
          dockTimer = null;
        }
        return true;
      }
      if (dockTimer) return false;
      var started = Date.now();
      console.info('[SDSK] waiting for player to mount dock');
      dockTimer = setInterval(function () {
        if (initDockOnce()) {
          clearInterval(dockTimer);
          dockTimer = null;
          console.info('[SDSK] dock initialized after poll');
          return;
        }
        if (Date.now() - started >= DOCK_TIMEOUT_MS) {
          clearInterval(dockTimer);
          dockTimer = null;
          console.error('[SDSK] dock not mounted — no player host after 60s');
        }
      }, DOCK_POLL_MS);
      return false;
    } catch (err) {
      console.error('[SDSK] ensureDock failed', err);
      return false;
    }
  }

  function bubbleToast(msg, ms) {
    try {
      if (window.SDSKBubbles && typeof window.SDSKBubbles.showToast === 'function') {
        window.SDSKBubbles.showToast(msg, ms);
      }
    } catch (err) {
      console.error('[SDSK] toast failed', err);
    }
  }

  function maybeCaptionToast(videoId) {
    if (!videoId || captionToasted.has(videoId)) return;
    captionToasted.add(videoId);
    bubbleToast(CAPTION_TOAST_TEXT, 7000);
  }

  function normalizeRemoteSegments(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (seg) {
      if (!seg || typeof seg !== 'object') return;
      var raw = seg.t != null ? seg.t : seg.start != null ? seg.start : seg.time;
      var t = Number(raw);
      if (!isFinite(t) || t < 0) t = 0;
      var text = String(seg.text == null ? '' : seg.text).replace(/\s+/g, ' ').trim();
      if (!text) return;
      out.push({ t: Math.round(t), text: text, lang: seg.lang || configLang(), source: 'server' });
    });
    out.sort(function (a, b) {
      return a.t - b.t;
    });
    return out;
  }

  function normalizeVerdict(v) {
    var s = String(v == null ? '' : v).toLowerCase().trim();
    if (s === 'supported' || s === 'contradicted' || s === 'misleading' || s === 'unverified') {
      return s;
    }
    if (s.indexOf('support') === 0 || s === 'true' || s === 'verified') return 'supported';
    if (s.indexOf('contradict') === 0 || s.indexOf('false') === 0) return 'contradicted';
    if (s.indexOf('misle') === 0 || s === 'partly_false') return 'misleading';
    return 'unverified';
  }

  function verdictAllowed(verdict) {
    var cfg = state.config;
    if (!cfg) return true;
    var toggles = cfg.verdicts || cfg.verdictToggles || cfg.enabledVerdicts;
    if (toggles) {
      if (typeof toggles === 'function') {
        if (!toggles(verdict)) return false;
      } else if (typeof toggles === 'object') {
        if (typeof toggles[verdict] === 'boolean' && !toggles[verdict]) return false;
        if (typeof toggles[verdict] === 'number' && !(toggles[verdict] > 0)) return false;
      }
    }
    var map = {
      supported: 'showSupported',
      contradicted: 'showContradicted',
      misleading: 'showMisleading',
      unverified: 'showUnverified'
    };
    var key = map[verdict];
    return key ? cfg[key] !== false : true;
  }

  function confidenceAllowed(result, claim) {
    var cfg = state.config;
    if (!cfg) return true;
    var raw = cfg.minConfidence;
    if (raw == null) return true;
    var min = Number(raw);
    if (isNaN(min)) return true;
    if (min > 0 && min <= 1) min = min * 100;
    if (min <= 0) return true;
    var conf = result && result.confidence;
    if (conf == null && claim) conf = claim.confidence;
    if (conf == null) return true;
    var pct = Number(conf);
    if (isNaN(pct) || pct < 0) return true;
    if (pct <= 1) pct = pct * 100;
    return pct >= min;
  }

  function renderable() {
    var results = {};
    var claims = [];
    var total = 0;
    var hidden = 0;
    state.claims.forEach(function (claim) {
      if (!claim || claim.id == null) return;
      var id = String(claim.id);
      var result = state.results[id];
      if (!result) return;
      total++;
      var verdict = normalizeVerdict(result.verdict != null ? result.verdict : result.label);
      if (!verdictAllowed(verdict) || !confidenceAllowed(result, claim)) {
        hidden++;
        return;
      }
      results[id] = result;
      claims.push(claim);
    });
    return {
      results: results,
      claims: claims,
      total: total,
      shown: claims.length,
      hidden: hidden
    };
  }

  function dispatchEvent(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {
      console.error('[SDSK] dispatch ' + name + ' failed', e);
    }
  }

  function publishResults() {
    var visible = renderable();
    dispatchEvent('sksdk:results', { results: visible.results, claims: visible.claims });
    renderBubbles(visible);
    lastDetail = {
      shown: visible.shown,
      hidden: visible.hidden,
      claims: state.claims.length
    };
    bubbleShowAll(visible.hidden > 0 ? visible.hidden : 0);
    if (!state.checking && visible.total > 0) {
      if (visible.shown === 0 && visible.hidden > 0) {
        lastStatusName = 'all-hidden';
        bubbleStatus('all-hidden', { text: 'ALL HIDDEN \u00b7 ' + visible.hidden });
      } else if (visible.shown > 0 && lastStatusName === 'all-hidden') {
        lastStatusName = 'done';
        bubbleStatus('done', lastDetail);
      }
    }
    if (visible.total > 0 && visible.shown === 0 && visible.hidden > 0 && !allHiddenToastShown) {
      allHiddenToastShown = true;
      console.info('[SDSK] ALL ' + visible.hidden + ' results hidden by filters');
      bubbleToast('All ' + visible.hidden + ' results hidden — tap SHOW ALL on the dock', 7000);
    }
    if (visible.shown > 0 && visible.hidden > 0 && !hiddenToastShown) {
      hiddenToastShown = true;
      console.info('[SDSK] filters hiding ' + visible.hidden + ' results');
      bubbleToast(visible.hidden + ' results hidden by filters — tap SHOW ALL on the dock', 6000);
    }
  }

  function publishConfig() {
    dispatchEvent('sksdk:config', { config: state.config });
  }

  function renderBubbles(visible) {
    try {
      if (window.SDSKBubbles && typeof window.SDSKBubbles.render === 'function') {
        var pair = visible || renderable();
        window.SDSKBubbles.render(pair.results, pair.claims, state.config);
      }
    } catch (e) {
      console.error('[SDSK] bubbles render failed', e);
    }
  }

  function bubbleStatus(status, detail) {
    try {
      if (window.SDSKBubbles && typeof window.SDSKBubbles.setStatus === 'function') {
        window.SDSKBubbles.setStatus(status, detail);
      }
    } catch (e) {
      console.error('[SDSK] bubbles setStatus failed', e);
    }
  }

  function bubbleShowAll(count) {
    try {
      if (window.SDSKBubbles && typeof window.SDSKBubbles.setShowAll === 'function') {
        window.SDSKBubbles.setShowAll(count, enableAllFilters);
      }
    } catch (err) {
      console.error('[SDSK] setShowAll failed', err);
    }
  }

  function enableAllFilters() {
    var patch = {
      showSupported: true,
      showContradicted: true,
      showMisleading: true,
      showUnverified: true,
      minConfidence: 0
    };
    console.info('[SDSK] SHOW ALL clicked — enabling all filters');
    send({ type: 'SET_CONFIG', patch: patch }).then(function (cfg) {
      if (cfg && typeof cfg === 'object') {
        state.config = cfg;
        publishConfig();
      }
      hiddenToastShown = false;
      publishResults();
      bubbleToast('All filters enabled — showing every result', 4000);
    });
  }

  function bubbleClear() {
    try {
      if (window.SDSKBubbles && typeof window.SDSKBubbles.clear === 'function') {
        window.SDSKBubbles.clear();
      }
    } catch (e) {
      console.error('[SDSK] bubbles clear failed', e);
    }
  }

  function configEnabled() {
    return !state.config || state.config.enabled !== false;
  }

  function configLang() {
    return (state.config && state.config.language) || 'en';
  }

  function resetState(videoId) {
    state.videoId = videoId || null;
    state.segments = [];
    state.claims = [];
    state.results = {};
    state.checking = false;
    lastDetail = null;
    hiddenToastShown = false;
    allHiddenToastShown = false;
    lastStatusName = 'idle';
  }

  function mergeResults(batch, results) {
    if (!Array.isArray(results)) return;
    results.forEach(function (result, index) {
      if (!result || typeof result !== 'object') return;
      var claimId =
        result.claimId != null
          ? result.claimId
          : result.claim_id != null
            ? result.claim_id
            : result.id != null
              ? result.id
              : batch[index]
                ? batch[index].id
                : null;
      if (claimId == null) return;
      state.results[String(claimId)] = result;
    });
  }

  async function run() {
    var token = ++runToken;
    var videoId = null;
    try {
      ensureDock();
      videoId = Transcript.getCandidateVideoId();
      resetState(videoId);
      console.info(
        '[SDSK] run start videoId=' + videoId + ' enabled=' + configEnabled() + ' lang=' + configLang()
      );
      if (!videoId || !configEnabled()) {
        bubbleStatus('idle');
        return;
      }

      await waitForPlayer(PLAYER_TIMEOUT_MS);
      if (token !== runToken) return;
      console.info('[SDSK] player detected for ' + videoId);

      await sleep(CAPTION_WAIT_MS);
      if (token !== runToken || Transcript.getCandidateVideoId() !== videoId) return;
      console.info('[SDSK] caption wait elapsed — collecting captions');

      var segments = [];
      try {
        segments = Transcript.getSegments(videoId) || [];
      } catch (err) {
        console.error('[SDSK] getSegments failed', err);
        segments = [];
      }
      console.info('[SDSK] segments (interceptor): ' + segments.length);

      if (!segments.length) {
        try {
          segments = (await Transcript.fetchDirect(videoId, configLang())) || [];
        } catch (err) {
          console.error('[SDSK] fetchDirect failed', err);
          segments = [];
        }
        if (token !== runToken) return;
        console.info('[SDSK] segments (direct fetch): ' + segments.length);
      }

      if (!segments.length) {
        console.info('[SDSK] requesting remote transcript from server');
        var remote = await send({
          type: 'GET_REMOTE_TRANSCRIPT',
          videoId: videoId,
          lang: configLang()
        });
        if (token !== runToken) return;
        if (remote && remote.ok && Array.isArray(remote.segments)) {
          segments = normalizeRemoteSegments(remote.segments);
          console.info('[SDSK] segments (server): ' + segments.length);
        } else {
          console.info(
            '[SDSK] server transcript unavailable: ' + ((remote && remote.error) || 'no response')
          );
        }
      }

      state.segments = segments;

      var claims = [];
      try {
        claims = Claims.buildClaims(state.segments) || [];
      } catch (err) {
        console.error('[SDSK] buildClaims failed', err);
        claims = [];
      }
      state.claims = claims;
      console.info('[SDSK] claims extracted: ' + claims.length);

      if (!state.segments.length) {
        console.info('[SDSK] no captions at all for ' + videoId);
        publishResults();
        bubbleStatus('no-captions', { text: 'NO CAPTIONS' });
        maybeCaptionToast(videoId);
        return;
      }

      if (!claims.length) {
        console.info('[SDSK] no claims extracted for ' + videoId);
        publishResults();
        bubbleStatus('idle');
        return;
      }

      state.checking = true;
      bubbleStatus('checking');
      publishResults();
      await send({ type: 'CHECKING_STARTED' });

      var failed = false;
      try {
        for (var i = 0; i < claims.length; i += BATCH_SIZE) {
          if (token !== runToken || Transcript.getCandidateVideoId() !== videoId) return;
          var batch = claims.slice(i, i + BATCH_SIZE);
          var response;
          try {
            response = await send({ type: 'FACT_CHECK', videoId: videoId, claims: batch });
          } catch (err) {
            console.error('[SDSK] FACT_CHECK batch threw', err);
            failed = true;
            publishResults();
            continue;
          }
          if (token !== runToken) return;
          if (response && response.ok) {
            mergeResults(batch, response.results);
            console.info(
              '[SDSK] FACT_CHECK batch ok: ' +
                batch.length +
                ' claims → ' +
                (Array.isArray(response.results) ? response.results.length : 0) +
                ' results'
            );
          } else {
            failed = true;
            console.info(
              '[SDSK] FACT_CHECK batch fail: ' + ((response && response.error) || 'no response')
            );
          }
          publishResults();
        }
      } catch (err) {
        console.error('[SDSK] FACT_CHECK loop error', err);
        failed = true;
      } finally {
        if (token === runToken) state.checking = false;
        await send({ type: 'CHECKING_ENDED' });
        if (token === runToken) {
          var visible = renderable();
          console.info(
            '[SDSK] final render: ' +
              visible.shown +
              ' shown / ' +
              visible.total +
              ' checked (' +
              visible.hidden +
              ' hidden by filters)'
          );
          if (!failed && visible.total > 0 && visible.shown === 0 && visible.hidden > 0) {
            lastStatusName = 'all-hidden';
            bubbleStatus('all-hidden', { text: 'ALL HIDDEN \u00b7 ' + visible.hidden });
          } else {
            lastStatusName = failed ? 'error' : 'done';
            bubbleStatus(failed ? 'error' : 'done', lastDetail);
          }
        }
      }
    } catch (err) {
      console.error('[SDSK] run error', err);
      state.checking = false;
      bubbleStatus('error');
    }
  }

  function scheduleRun() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      run().catch(function (err) {
        console.error('[SDSK] run error', err);
        state.checking = false;
        bubbleStatus('error');
      });
    }, DEBOUNCE_MS);
  }

  async function loadConfig() {
    var cfg = await send({ type: 'GET_CONFIG' });
    if (cfg && typeof cfg === 'object') {
      state.config = cfg;
      publishConfig();
    }
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes || !changes.config) return;
    var next = changes.config.newValue || null;
    var wasEnabled = !state.config || state.config.enabled !== false;
    state.config = next;
    publishConfig();
    var nowEnabled = !next || next.enabled !== false;
    if (!nowEnabled) {
      state.claims = [];
      state.results = {};
      state.checking = false;
      bubbleClear();
      bubbleStatus('idle');
      publishResults();
      return;
    }
    if (!wasEnabled) {
      publishResults();
      scheduleRun();
      return;
    }
    publishResults();
  }

  function pollVideoId() {
    try {
      var id = Transcript.getCandidateVideoId();
      if (id !== state.videoId) scheduleRun();
    } catch (e) {}
  }

  async function boot() {
    try {
      ensureDock();
      if (document.readyState === 'loading') {
        await new Promise(function (resolve) {
          document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
        ensureDock();
      }
      try {
        await loadConfig();
      } catch (err) {
        console.error('[SDSK] config load failed', err);
      }
      console.info('[SDSK] boot: config enabled=' + configEnabled() + ' lang=' + configLang());
      try {
        chrome.storage.onChanged.addListener(onStorageChanged);
      } catch (err) {
        console.error('[SDSK] storage listener failed', err);
      }
      document.addEventListener('yt-navigate-finish', scheduleRun);
      setInterval(pollVideoId, POLL_MS);
      scheduleRun();
    } catch (err) {
      console.error('[SDSK] boot error', err);
      try {
        ensureDock();
        bubbleStatus('error');
      } catch (e) {}
    }
  }

  boot();
})();
