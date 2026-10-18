(function () {
  'use strict';

  if (window.__sdsdkPlayerInfoInstalled) return;
  window.__sdsdkPlayerInfoInstalled = true;

  var POLL_MS = 400;
  var MAX_MS = 45000;
  var timer = null;
  var startedAt = 0;
  var lastKey = '';
  var lastVideoId = null;

  function trackKey(tracks) {
    try {
      return tracks
        .map(function (t) {
          return (t.baseUrl || '') + '|' + (t.languageCode || '') + '|' + (t.kind || '');
        })
        .join(' ');
    } catch (e) {
      return String(tracks.length);
    }
  }

  function extractTracks(payload) {
    try {
      if (!payload) return null;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          return null;
        }
      }
      var raw =
        payload.captions &&
        payload.captions.playerCaptionsTracklistRenderer &&
        payload.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!Array.isArray(raw) || !raw.length) return null;
      var tracks = [];
      raw.forEach(function (t) {
        if (!t || !t.baseUrl) return;
        tracks.push({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode || '',
          kind: t.kind || null,
          name:
            (t.name && t.name.simpleText) ||
            (t.name && t.name.runs && t.name.runs[0] && t.name.runs[0].text) ||
            ''
        });
      });
      if (!tracks.length) return null;
      return { tracks: tracks, videoId: payload.videoId || null };
    } catch (e) {
      return null;
    }
  }

  function getPayload() {
    try {
      var fromInit = extractTracks(window.ytInitialPlayerResponse);
      if (fromInit) return fromInit;
    } catch (e) {}
    try {
      var flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && flexy.data && flexy.data.playerResponse) {
        var fromFlexy = extractTracks(flexy.data.playerResponse);
        if (fromFlexy) return fromFlexy;
      }
    } catch (e) {}
    try {
      var cfg = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      if (cfg) {
        var pr = cfg.player_response;
        if (pr) {
          var fromCfg = extractTracks(pr);
          if (fromCfg) return fromCfg;
        }
      }
    } catch (e) {}
    return null;
  }

  function emit(result) {
    var key = trackKey(result.tracks);
    if (key === lastKey) return false;
    lastKey = key;
    lastVideoId = result.videoId || lastVideoId;
    try {
      console.info('[SDSK] player-info: ' + result.tracks.length + ' tracks found');
    } catch (e) {}
    try {
      window.postMessage(
        {
          source: 'SDSK',
          type: 'CAPTION_TRACKS',
          videoId: result.videoId,
          tracks: result.tracks,
          ts: Date.now()
        },
        '*'
      );
    } catch (e) {}
    return true;
  }

  function stopPolling() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function tick() {
    try {
      var result = getPayload();
      if (result) emit(result);
    } catch (e) {}
    var elapsed = Date.now() - startedAt;
    if (elapsed < MAX_MS) {
      timer = setTimeout(tick, POLL_MS);
    } else {
      stopPolling();
    }
  }

  function startPolling() {
    stopPolling();
    startedAt = Date.now();
    timer = setTimeout(tick, POLL_MS);
  }

  function rearmOnNavigate() {
    lastKey = '';
    startPolling();
  }

  try {
    window.addEventListener('yt-navigate-finish', rearmOnNavigate, true);
    window.addEventListener('popstate', rearmOnNavigate);
    document.addEventListener('yt-navigate-finish', rearmOnNavigate, true);
    startPolling();
  } catch (e) {}
})();
