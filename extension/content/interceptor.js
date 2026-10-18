(function () {
  'use strict';

  if (window.__sksdkInstalled) return;
  window.__sksdkInstalled = true;

  var TARGET = '/api/timedtext';
  var MAX_BODY = 6 * 1024 * 1024;

  function emit(url, body) {
    try {
      if (typeof body !== 'string' || !body) return;
      if (body.length > MAX_BODY) return;
      window.postMessage(
        { source: 'SDSK', type: 'TIMEDTEXT', url: String(url), body: body, ts: Date.now() },
        '*'
      );
    } catch (e) {}
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input || '');
    } catch (e) {
      return '';
    }
  }

  function withText(value, cb) {
    try {
      if (typeof value === 'string') {
        cb(value);
        return;
      }
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        if (value.size > MAX_BODY) return;
        value.text().then(cb, function () {});
        return;
      }
      if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
        if (value.byteLength > MAX_BODY) return;
        cb(new TextDecoder().decode(value));
        return;
      }
      if (value && typeof value === 'object') cb(JSON.stringify(value));
    } catch (e) {}
  }

  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input) {
        var url = urlOf(input);
        if (url.indexOf(TARGET) === -1) return origFetch.apply(this, arguments);
        var result = origFetch.apply(this, arguments);
        try {
          if (result && typeof result.then === 'function') {
            result.then(
              function (res) {
                try {
                  if (!res || typeof res.clone !== 'function') return;
                  res.clone()
                    .text()
                    .then(
                      function (body) {
                        emit(url, body);
                      },
                      function () {}
                    );
                } catch (e) {}
              },
              function () {}
            );
          }
        } catch (e) {}
        return result;
      };
    }
  } catch (e) {}

  try {
    var proto = XMLHttpRequest.prototype;
    var origOpen = proto.open;
    var origSend = proto.send;

    proto.open = function (method, url) {
      try {
        this.__sksdkUrl = url == null ? '' : String(url);
        this.__sksdkTarget = this.__sksdkUrl.indexOf(TARGET) !== -1;
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };

    proto.send = function () {
      try {
        var xhr = this;
        if (xhr.__sksdkTarget && !xhr.__sksdkHooked) {
          xhr.__sksdkHooked = true;
          xhr.addEventListener('load', function () {
            try {
              var kind = '';
              try {
                kind = xhr.responseType || '';
              } catch (e) {}
              if (kind === '' || kind === 'text') {
                withText(xhr.responseText, function (body) {
                  emit(xhr.__sksdkUrl, body);
                });
              } else {
                withText(xhr.response, function (body) {
                  emit(xhr.__sksdkUrl, body);
                });
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  } catch (e) {}
})();
