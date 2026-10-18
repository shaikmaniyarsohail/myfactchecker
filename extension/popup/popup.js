const DEFAULTS = {
  serverUrl: 'http://localhost:8787',
  enabled: true,
  minConfidence: 0.3,
  showSupported: true,
  showContradicted: true,
  showMisleading: true,
  showUnverified: true,
  language: 'en',
};

const $ = (id) => document.getElementById(id);

const els = {
  statusLed: $('statusLed'),
  statusText: $('statusText'),
  enabledSwitch: $('enabledSwitch'),
  serverUrl: $('serverUrl'),
  testBtn: $('testBtn'),
  testResult: $('testResult'),
  showSupported: $('showSupported'),
  showContradicted: $('showContradicted'),
  showMisleading: $('showMisleading'),
  showUnverified: $('showUnverified'),
  minConfidence: $('minConfidence'),
  confidenceOut: $('confidenceOut'),
  language: $('language'),
  openOptions: $('openOptions'),
};

let saveTimer = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(online) {
  els.statusLed.classList.toggle('sd-led--on', online);
  els.statusLed.classList.toggle('sd-led--off', !online);
  els.statusText.textContent = online ? 'SERVER ONLINE' : 'SERVER OFFLINE';
  els.statusText.classList.toggle('is-online', online);
  els.statusText.classList.toggle('is-offline', !online);
}

async function ping() {
  try {
    const res = await send({ type: 'PING' });
    setStatus(Boolean(res && res.server));
  } catch {
    setStatus(false);
  }
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', String(on));
}

function updateSliderFill() {
  const min = Number(els.minConfidence.min);
  const max = Number(els.minConfidence.max);
  const val = Number(els.minConfidence.value);
  const pct = ((val - min) / (max - min)) * 100;
  els.minConfidence.style.setProperty('--sd-fill', `${pct}%`);
  els.confidenceOut.textContent = val.toFixed(2);
}

function flashSaved(row) {
  const block = row.closest('[data-save-row]') || row;
  block.classList.remove('is-saved');
  void block.offsetWidth;
  block.classList.add('is-saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => block.classList.remove('is-saved'), 450);
}

function collectPatch() {
  return {
    enabled: els.enabledSwitch.getAttribute('aria-checked') === 'true',
    serverUrl: els.serverUrl.value.trim(),
    showSupported: els.showSupported.checked,
    showContradicted: els.showContradicted.checked,
    showMisleading: els.showMisleading.checked,
    showUnverified: els.showUnverified.checked,
    minConfidence: Number(els.minConfidence.value),
    language: els.language.value,
  };
}

async function save(sourceEl) {
  if (sourceEl) flashSaved(sourceEl);
  try {
    await send({ type: 'SET_CONFIG', patch: collectPatch() });
  } catch {
    els.testResult.textContent = 'SAVE FAILED';
    els.testResult.className = 'sd-hint is-err';
  }
}

function applyConfig(config) {
  const cfg = { ...DEFAULTS, ...config };
  setSwitch(els.enabledSwitch, Boolean(cfg.enabled));
  els.serverUrl.value = cfg.serverUrl || DEFAULTS.serverUrl;
  els.showSupported.checked = Boolean(cfg.showSupported);
  els.showContradicted.checked = Boolean(cfg.showContradicted);
  els.showMisleading.checked = Boolean(cfg.showMisleading);
  els.showUnverified.checked = Boolean(cfg.showUnverified);
  els.minConfidence.value = String(cfg.minConfidence);
  updateSliderFill();
  els.language.value = cfg.language || 'en';
}

function bind() {
  els.enabledSwitch.addEventListener('click', () => {
    const next = els.enabledSwitch.getAttribute('aria-checked') !== 'true';
    setSwitch(els.enabledSwitch, next);
    save(els.enabledSwitch);
  });

  els.enabledSwitch.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      els.enabledSwitch.click();
    }
  });

  for (const key of ['showSupported', 'showContradicted', 'showMisleading', 'showUnverified']) {
    els[key].addEventListener('change', () => save(els[key]));
  }

  els.minConfidence.addEventListener('input', updateSliderFill);
  els.minConfidence.addEventListener('change', () => save(els.minConfidence));

  els.language.addEventListener('change', () => save(els.language));

  els.serverUrl.addEventListener('change', () => save(els.serverUrl));

  els.testBtn.addEventListener('click', async () => {
    els.testBtn.disabled = true;
    els.testResult.textContent = 'TESTING…';
    els.testResult.className = 'sd-hint';
    await save(els.serverUrl);
    await ping();
    if (els.statusText.classList.contains('is-online')) {
      els.testResult.textContent = 'CONNECTION OK';
      els.testResult.className = 'sd-hint is-ok';
    } else {
      els.testResult.textContent = 'NO RESPONSE';
      els.testResult.className = 'sd-hint is-err';
    }
    els.testBtn.disabled = false;
  });

  els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function init() {
  bind();
  try {
    const config = await send({ type: 'GET_CONFIG' });
    applyConfig(config);
  } catch {
    applyConfig(DEFAULTS);
  }
  ping();
}

init();
