(function () {
  'use strict';

  var MAX_VISIBLE = 5;
  var STACK_STEP = 44;
  var STACK_TOP = 12;
  var SUMMARY_MAX = 240;

  var VERDICT_LABELS = {
    supported: 'SUPPORTED',
    contradicted: 'CONTRADICTED',
    misleading: 'MISLEADING',
    unverified: 'UNVERIFIED'
  };

  var STATUS_STATES = ['idle', 'checking', 'done', 'error', 'no-captions', 'all-hidden'];

  var STATUS_LABELS = {
    idle: 'Signal Desk idle',
    checking: 'Checking claims',
    done: 'Check complete',
    error: 'Check failed',
    'no-captions': 'Captions unavailable',
    'all-hidden': 'All results hidden by filters'
  };

  var anchor = null;
  var layer = null;
  var dock = null;
  var statusDot = null;
  var countEl = null;
  var toastEl = null;
  var toastTimer = null;
  var bubblesVisible = true;
  var lastHiddenCount = 0;
  var lastTotal = 0;
  var showAllBtn = null;
  var showAllHandler = null;

  function el(tag, className, parent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function toPercent(conf) {
    if (conf == null || isNaN(conf)) return null;
    var n = Number(conf);
    if (n < 0 || isNaN(n)) return null;
    if (n <= 1) n = n * 100;
    n = Math.max(0, Math.min(100, Math.round(n)));
    return n;
  }

  function truncate(text, max) {
    var s = String(text || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  }

  function safeHttp(url) {
    var s = String(url || '').trim();
    return /^https?:\/\//i.test(s) ? s : null;
  }

  function normalizeVerdict(v) {
    var s = String(v || '').toLowerCase().trim();
    if (VERDICT_LABELS[s]) return s;
    if (s.indexOf('support') === 0 || s === 'true' || s === 'verified') return 'supported';
    if (s.indexOf('contradict') === 0 || s.indexOf('false') === 0) return 'contradicted';
    if (s.indexOf('misle') === 0 || s === 'partly_false') return 'misleading';
    return 'unverified';
  }

  function isVerdictEnabled(config, verdict) {
    if (!config) return true;
    var toggles = config.verdicts || config.verdictToggles || config.enabledVerdicts;
    if (!toggles) return true;
    if (typeof toggles === 'function') return !!toggles(verdict);
    if (typeof toggles[verdict] === 'boolean') return toggles[verdict];
    if (typeof toggles[verdict] === 'number') return toggles[verdict] > 0;
    return true;
  }

  function passConfidence(config, pct) {
    if (!config || pct == null) return true;
    var raw = config.minConfidence;
    if (raw == null) return true;
    var min = Number(raw);
    if (isNaN(min)) return true;
    if (min > 0 && min <= 1) min = min * 100;
    return pct >= min;
  }

  function indexResults(results) {
    var map = Object.create(null);
    if (!results) return map;
    if (Array.isArray(results)) {
      results.forEach(function (r) {
        if (!r) return;
        var id = r.claimId || r.id;
        if (id != null) map[String(id)] = r;
      });
    } else if (typeof results === 'object') {
      Object.keys(results).forEach(function (key) {
        map[String(key)] = results[key];
      });
    }
    return map;
  }

  function pairItems(results, claims) {
    var map = indexResults(results);
    var items = [];

    if (Array.isArray(claims) && claims.length) {
      claims.forEach(function (claim) {
        if (!claim) return;
        var id = claim.id != null ? String(claim.id) : null;
        var res = id && map[id] ? map[id] : null;
        var merged = {};
        if (res) Object.keys(res).forEach(function (k) { merged[k] = res[k]; });
        Object.keys(claim).forEach(function (k) { merged[k] = claim[k]; });
        items.push(merged);
      });
      return items;
    }

    if (Array.isArray(results)) return results.slice();
    if (results && typeof results === 'object') {
      Object.keys(results).forEach(function (k) { items.push(results[k]); });
    }
    return items;
  }

  function toItem(entry) {
    if (!entry) return null;
    var claim = entry.claim || entry;
    var verdict = normalizeVerdict(
      entry.verdict != null ? entry.verdict : claim.verdict
    );
    var pct = toPercent(
      entry.confidence != null ? entry.confidence : claim.confidence
    );
    var summaryRaw = entry.summary || entry.explanation || entry.text || claim.text || '';
    var sourcesRaw = entry.sources || entry.links || claim.sources || [];
    var sources = [];
    if (Array.isArray(sourcesRaw)) {
      sourcesRaw.forEach(function (s) {
        var url = typeof s === 'string' ? s : (s && (s.url || s.href)) || '';
        url = safeHttp(url);
        if (url && sources.length < 2) sources.push(url);
      });
    } else if (typeof sourcesRaw === 'string') {
      var one = safeHttp(sourcesRaw);
      if (one) sources.push(one);
    }

    var ts = claim.timestampMs;
    if (ts == null) ts = claim.timestamp_ms;
    if (ts == null) ts = entry.timestampMs;
    ts = Number(ts);
    if (isNaN(ts) || ts < 0) ts = null;

    return {
      claimId: claim.id != null ? claim.id : entry.claimId,
      verdict: verdict,
      confidence: pct,
      summary: truncate(summaryRaw, SUMMARY_MAX),
      sources: sources,
      timestampMs: ts
    };
  }

  function formatTs(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function seekTo(ms) {
    try {
      if (window.SDSK && typeof window.SDSK.seekTo === 'function') {
        window.SDSK.seekTo(ms);
        return true;
      }
    } catch (e) { /* fall through */ }
    return false;
  }

  function buildBubble(item) {
    var bubble = el('div', 'sksdk-bubble sksdk-v-' + item.verdict);
    bubble.setAttribute('data-claim-id', item.claimId != null ? String(item.claimId) : '');

    var head = el('div', 'sksdk-head', bubble);
    head.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('button, a')) return;
      if (layer) {
        Array.prototype.forEach.call(layer.querySelectorAll('.sksdk-bubble.is-open'), function (o) {
          if (o !== bubble) o.classList.remove('is-open');
        });
      }
      bubble.classList.toggle('is-open');
    });

    var chip = el('span', 'sksdk-verdict sksdk-v-' + item.verdict, head);
    el('span', 'sksdk-dot', chip);
    chip.appendChild(document.createTextNode(VERDICT_LABELS[item.verdict]));

    var right = el('div', 'sksdk-head-right', head);

    if (item.timestampMs != null) {
      var tsBtn = el('button', 'sksdk-ts', right);
      tsBtn.type = 'button';
      tsBtn.textContent = formatTs(item.timestampMs);
      tsBtn.title = 'Seek to ' + formatTs(item.timestampMs);
      tsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!seekTo(item.timestampMs)) {
          showToast('Seek unavailable', 2500);
        }
      });
    }

    if (item.confidence != null) {
      var conf = el('span', 'sksdk-conf', right);
      conf.textContent = item.confidence + '%';
    }

    if (item.summary) {
      var body = el('div', 'sksdk-body', bubble);
      body.appendChild(document.createTextNode(item.summary));
    }

    if (item.sources.length) {
      var src = el('div', 'sksdk-sources', bubble);
      item.sources.forEach(function (url) {
        var a = el('a', null, src);
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        try {
          a.textContent = new URL(url).hostname.replace(/^www\./, '');
        } catch (e) {
          a.textContent = 'source';
        }
        a.appendChild(document.createTextNode(' ↗'));
      });
    }

    return bubble;
  }

  function positionBubbles(bubbleNodes) {
    if (!layer || !bubbleNodes.length) return;
    var playerH = layer.clientHeight || 0;
    var maxTop = Math.max(STACK_TOP, playerH - 40);
    var start = STACK_TOP;
    if (start + (bubbleNodes.length - 1) * STACK_STEP > maxTop) {
      start = Math.max(8, maxTop - (bubbleNodes.length - 1) * STACK_STEP);
    }

    bubbleNodes.forEach(function (node, i) {
      node.style.top = (start + i * STACK_STEP) + 'px';
    });
  }

  function ensureToast() {
    if (!layer) return null;
    if (!toastEl || !toastEl.isConnected) {
      toastEl = el('div', 'sksdk-toast', layer);
      toastEl.setAttribute('role', 'status');
    }
    return toastEl;
  }

  function showToast(msg, ms) {
    var t = ensureToast();
    if (!t) return;
    t.textContent = String(msg || '');
    if (toastTimer) clearTimeout(toastTimer);
    requestAnimationFrame(function () {
      t.classList.add('is-in');
    });
    toastTimer = setTimeout(function () {
      t.classList.remove('is-in');
      toastTimer = null;
    }, ms || 4000);
  }

  function setCountText(main, secondary) {
    if (!countEl) return;
    countEl.textContent = '';
    countEl.appendChild(document.createTextNode(String(main)));
    if (secondary) {
      var span = el('span', 'sksdk-count-secondary', countEl);
      span.textContent = String(secondary);
    }
    var title = String(main) + (secondary ? ' ' + String(secondary) : '');
    countEl.title = title;
  }

  function toNumber(v, fallback) {
    var n = Number(v);
    if (v == null || v === '' || isNaN(n)) return fallback;
    return Math.max(0, Math.round(n));
  }

  function updateDockCount(total) {
    lastTotal = toNumber(total, 0);
    if (!countEl) return;
    var text = lastTotal + (lastTotal === 1 ? ' claim' : ' claims');
    var secondary = lastHiddenCount > 0 ? '· ' + lastHiddenCount + ' hidden' : null;
    setCountText(text, secondary);
  }

  function formatStatusCount(stateName, detail) {
    var isObj = detail && typeof detail === 'object';
    if (isObj && detail.text) {
      var hiddenMatch = String(detail.text).match(/ALL HIDDEN \u00b7\s*(\d+)/);
      if (hiddenMatch) return { main: 'ALL HIDDEN', secondary: '\u00b7 ' + hiddenMatch[1] };
      return { main: String(detail.text) };
    }
    if (stateName === 'no-captions') {
      if (detail != null && detail !== '' && !isObj) return { main: String(detail) };
      return { main: 'NO CAPTIONS' };
    }
    if (isObj && (detail.shown != null || detail.claims != null || detail.hidden != null)) {
      var shown = toNumber(detail.shown, toNumber(detail.claims, lastTotal));
      var hidden = toNumber(detail.hidden, 0);
      var main = shown + ' checked';
      return { main: main, secondary: hidden > 0 ? '· ' + hidden + ' hidden' : null };
    }
    if (detail != null && detail !== '' && !isObj) {
      return { main: String(detail) };
    }
    return null;
  }

  function setStatus(state, detail) {
    var s = String(state || 'idle').toLowerCase();
    if (STATUS_STATES.indexOf(s) === -1) s = 'idle';
    if (statusDot) statusDot.setAttribute('data-state', s);

    var labels = STATUS_LABELS;
    if (dock) {
      if (detail != null && detail !== '' && typeof detail !== 'object') {
        dock.title = String(detail);
      } else if (isObjWithText(detail)) {
        dock.title = String(detail.text) + ' — ' + labels[s];
      } else {
        dock.title = labels[s];
      }
    }

    if (!countEl) return;
    var count = formatStatusCount(s, detail);
    if (count) {
      setCountText(count.main, count.secondary);
    } else {
      updateDockCount(lastTotal);
    }
  }

  function isObjWithText(detail) {
    return !!(detail && typeof detail === 'object' && detail.text);
  }

  function setVisibility(visible) {
    bubblesVisible = !!visible;
    if (!layer) return;
    var nodes = layer.querySelectorAll('.sksdk-bubble, .sksdk-more');
    Array.prototype.forEach.call(nodes, function (n) {
      n.style.display = bubblesVisible ? '' : 'none';
    });
    if (dock) {
      var btn = dock.querySelector('.sksdk-dock-toggle');
      if (btn) {
        btn.textContent = bubblesVisible ? 'HIDE' : 'SHOW';
        btn.setAttribute('aria-pressed', bubblesVisible ? 'true' : 'false');
      }
    }
  }

  function init(anchorEl) {
    if (!anchorEl) return false;
    try {
      if (getComputedStyle(anchorEl).position === 'static') {
        anchorEl.style.position = 'relative';
      }
    } catch (e) { /* keep going */ }
    if (
      anchor &&
      anchor.isConnected &&
      anchor.parentElement === anchorEl &&
      dock &&
      dock.isConnected &&
      statusDot &&
      statusDot.isConnected &&
      countEl &&
      countEl.isConnected
    ) {
      return true;
    }

    if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);

    anchor = el('div', 'sksdk-anchor sksdk-root');
    anchorEl.appendChild(anchor);

    layer = el('div', 'sksdk-bubble-layer', anchor);
    layer.setAttribute('data-sksdk', 'layer');

    dock = el('div', 'sksdk-dock', layer);
    dock.setAttribute('data-sksdk', 'dock');

    var toggle = el('button', 'sksdk-dock-toggle', dock);
    toggle.type = 'button';
    toggle.textContent = 'HIDE';
    toggle.setAttribute('aria-pressed', 'true');
    toggle.setAttribute('aria-label', 'Toggle fact-check bubbles');
    toggle.addEventListener('click', function () {
      setVisibility(!bubblesVisible);
    });

    statusDot = el('span', 'sksdk-status-dot', dock);
    statusDot.setAttribute('data-state', 'idle');

    countEl = el('span', 'sksdk-count', dock);
    countEl.textContent = '0 claims';

    showAllBtn = el('button', 'sksdk-showall', dock);
    showAllBtn.type = 'button';
    showAllBtn.hidden = true;
    showAllBtn.setAttribute('aria-label', 'Show all hidden results');
    showAllBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof showAllHandler === 'function') showAllHandler();
    });

    bubblesVisible = true;
    lastHiddenCount = 0;
    toastEl = null;
    return true;
  }

  function setShowAll(count, handler) {
    if (!showAllBtn || !showAllBtn.isConnected) return;
    var n = toNumber(count, 0);
    showAllHandler = handler || null;
    if (n > 0 && typeof handler === 'function') {
      showAllBtn.hidden = false;
      showAllBtn.textContent = 'SHOW ALL (' + n + ')';
    } else {
      showAllBtn.hidden = true;
      showAllBtn.textContent = 'SHOW ALL';
    }
  }

  function removeBubbles() {
    if (!layer) return;
    var nodes = layer.querySelectorAll('.sksdk-bubble, .sksdk-more');
    Array.prototype.forEach.call(nodes, function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
  }

  function clear() {
    if (!layer) return;
    removeBubbles();
    var toasts = layer.querySelectorAll('.sksdk-toast');
    Array.prototype.forEach.call(toasts, function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastEl = null;
    lastHiddenCount = 0;
    updateDockCount(0);
    setShowAll(0, null);
  }

  function render(results, claims, config) {
    if (!layer || !anchor || !anchor.isConnected || !layer.isConnected) {
      var host =
        document.getElementById('movie_player') ||
        document.getElementById('shorts-player') ||
        document.querySelector('ytd-player');
      if (!host || !init(host)) return { shown: 0, hidden: 0 };
    }

    if (!config || typeof config !== 'object') config = null;

    removeBubbles();

    var items = pairItems(results, claims)
      .map(toItem)
      .filter(function (it) {
        return it && isVerdictEnabled(config, it.verdict) && passConfidence(config, it.confidence);
      });

    items.sort(function (a, b) {
      if (a.timestampMs == null && b.timestampMs == null) return 0;
      if (a.timestampMs == null) return 1;
      if (b.timestampMs == null) return -1;
      return a.timestampMs - b.timestampMs;
    });

    var total = items.length;
    lastHiddenCount = Math.max(0, total - MAX_VISIBLE);
    var shown = items.slice(0, MAX_VISIBLE);

    var nodes = shown.map(function (item) {
      var node = buildBubble(item);
      layer.appendChild(node);
      return node;
    });

    positionBubbles(nodes);

    if (bubblesVisible) {
      requestAnimationFrame(function () {
        nodes.forEach(function (node) {
          node.classList.add('is-in');
        });
      });
    } else {
      nodes.forEach(function (n) { n.style.display = 'none'; });
    }

    updateDockCount(total);

    return { shown: shown.length, hidden: lastHiddenCount };
  }

  window.SDSKBubbles = {
    init: init,
    render: render,
    clear: clear,
    setStatus: setStatus,
    setShowAll: setShowAll,
    showToast: showToast,
    setVisibility: setVisibility
  };
})();
