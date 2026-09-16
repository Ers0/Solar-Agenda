// Status only. The answer itself appears in Solar Agenda — one conversation,
// in one place, rather than a second transcript living in a popup.

const ERRORS = {
  no_session:     'Sign in to Solar Agenda first.',
  cooling:        'Vision is rate-limited — try again shortly.',
  no_frame:       'No tab to capture.',
  not_capturable: 'Chrome will not let extensions capture this page.',
  vision_failed:  'TARS could not read that.',
  timeout:        'Solar Agenda did not respond.',
  no_app:         'Solar Agenda could not be opened.',
  bad_version:    'Update Solar Agenda — this extension needs a newer version.',
  bad_message:    'The app rejected the request.',
};

const LABEL = {
  capturing:  'Capturing…',
  connecting: 'Connecting…',
  analyzing:  'Analyzing…',
};

const statusEl = document.getElementById('status');
const btn = document.getElementById('go');
const qEl = document.getElementById('q');

const safetyToggle = document.getElementById('safetyToggle');
const safetyText = document.getElementById('safetyText');
const AUTOMATION_ENABLED_KEY = 'tarsAutomationEnabled';
const OBSERVER_MODE_KEY = 'tarsObserverMode';
const observerToggle = document.getElementById('observerToggle');
const observerText = document.getElementById('observerText');
async function loadObserverState() {
  try {
    const r = await chrome.storage.local.get([OBSERVER_MODE_KEY]);
    const enabled = r[OBSERVER_MODE_KEY] === true;
    if (observerToggle) observerToggle.checked = enabled;
    if (observerText) observerText.textContent = enabled
      ? 'Observing support; customer automation is OFF'
      : 'Observer is OFF';
  } catch (_) {}
}
if (observerToggle) {
  observerToggle.addEventListener('change', async () => {
    const enabled = !!observerToggle.checked;
    try {
      await chrome.storage.local.set({ [OBSERVER_MODE_KEY]: enabled, [AUTOMATION_ENABLED_KEY]: enabled ? false : true });
    } catch (_) {}
    if (observerText) observerText.textContent = enabled
      ? 'Observing support; customer automation is OFF'
      : 'Observer is OFF';
    show(enabled ? 'Observer mode enabled — customer automation disabled.' : 'Observer mode disabled.', false);
  });
  loadObserverState();
}

const LEARNING_MODE_KEY = 'tarsLearningMode';
const learningToggle = document.getElementById('learningToggle');
const learningText = document.getElementById('learningText');
async function loadLearningState() {
  try {
    const r = await chrome.storage.local.get([LEARNING_MODE_KEY]);
    const enabled = r[LEARNING_MODE_KEY] === true;
    if (learningToggle) learningToggle.checked = enabled;
    if (learningText) learningText.textContent = enabled ? 'Cross-site workflow learning is ON' : 'Cross-site workflow learning is OFF';
  } catch (_) {}
}
if (learningToggle) {
  learningToggle.addEventListener('change', async () => {
    const enabled = !!learningToggle.checked;
    try {
      const result = await chrome.runtime.sendMessage({ type:'TARS_OBSERVER_SET_LEARNING', enabled });
      if (!result?.ok) throw new Error(result?.error || 'learning_toggle_failed');
    } catch (_) {
      await chrome.storage.local.set({ [LEARNING_MODE_KEY]: enabled });
    }
    if (learningText) learningText.textContent = enabled ? 'Cross-site workflow learning is ON' : 'Cross-site workflow learning is OFF';
    show(enabled ? 'Workflow learning enabled — TARS will passively observe linked sites.' : 'Workflow learning disabled.', false);
  });
  loadLearningState();
}

const AI_ENABLED_KEY = 'tarsAiEnabled';

async function loadSafetyState() {
  try {
    const r = await chrome.storage.local.get([AUTOMATION_ENABLED_KEY, 'tarsEmergencyStop', OBSERVER_MODE_KEY]);
    const enabled = r[OBSERVER_MODE_KEY] === true ? false : r[AUTOMATION_ENABLED_KEY] !== false;
    safetyToggle.checked = enabled;
    safetyText.textContent = enabled
      ? 'Automatic replies and workflows are ON'
      : 'Automatic replies and workflows are OFF';
    updateEmergencyButton(r.tarsEmergencyStop === true);
  } catch (_) {}
}

function updateEmergencyButton(active) {
  if (!emergencyStopBtn) return;
  emergencyStopBtn.classList.toggle('active', !!active);
  emergencyStopBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  emergencyStopBtn.innerHTML = active
    ? '<span class="stop-icon resume-icon" aria-hidden="true"></span><span class="emergency-copy">RELEASE EMERGENCY STOP<small>Resume automation for new actions</small></span>'
    : '<span class="stop-icon" aria-hidden="true"></span><span class="emergency-copy">EMERGENCY STOP<small>Stops all automation immediately</small></span>';
}

const aiToggle = document.getElementById('aiToggle');
const aiText = document.getElementById('aiText');
async function loadAiState() {
  try {
    const r = await chrome.storage.local.get([AI_ENABLED_KEY]);
    const enabled = r[AI_ENABLED_KEY] === true;
    if (aiToggle) aiToggle.checked = enabled;
    if (aiText) aiText.textContent = enabled ? 'AI features are ON' : 'AI features are OFF';
  } catch (_) {}
}

if (aiToggle) {
  aiToggle.addEventListener('change', async () => {
    const enabled = !!aiToggle.checked;
    try { await chrome.storage.local.set({ [AI_ENABLED_KEY]: enabled }); } catch (_) {}
    if (aiText) aiText.textContent = enabled ? 'AI features are ON' : 'AI features are OFF';
    show(enabled ? 'AI assistant enabled.' : 'AI assistant disabled.', false);
  });
  loadAiState();
}

if (safetyToggle) {
  safetyToggle.addEventListener('change', async () => {
    const enabled = !!safetyToggle.checked;
    try {
      await chrome.runtime.sendMessage({ type: 'TARS_AUTOMATION_SET', enabled });
    } catch (_) {
      await chrome.storage.local.set({ [AUTOMATION_ENABLED_KEY]: enabled });
    }
    safetyText.textContent = enabled
      ? 'Automatic replies and workflows are ON'
      : 'Automatic replies and workflows are OFF';
    show(enabled ? 'Automation enabled.' : 'Automation disabled.', false);
  });
  loadSafetyState();
}

const emergencyStopBtn = document.getElementById('emergencyStop');
if (emergencyStopBtn) emergencyStopBtn.addEventListener('click', async () => {
  emergencyStopBtn.disabled = true;
  const active = emergencyStopBtn.classList.contains('active');
  updateEmergencyButton(active);
  emergencyStopBtn.querySelector('.emergency-copy').firstChild.textContent = active
    ? 'RELEASING EMERGENCY STOP'
    : 'STOPPING AUTOMATION…';
  try {
    const result = await chrome.runtime.sendMessage({
      type: active ? 'TARS_EMERGENCY_RESUME' : 'TARS_EMERGENCY_STOP'
    });
    if (result?.ok) {
      updateEmergencyButton(!active);
      show(active
        ? 'Emergency stop released — automation is available again.'
        : 'EMERGENCY STOP ACTIVE — all automation halted.', false);
    } else {
      updateEmergencyButton(active);
      show(`${active ? 'Emergency stop release' : 'Emergency stop'} failed — ${result?.error || 'unknown error'}`, true);
    }
  } catch (error) {
    updateEmergencyButton(active);
    show(`${active ? 'Emergency stop release' : 'Emergency stop'} failed.`, true);
  } finally {
    emergencyStopBtn.disabled = false;
  }
});

function show(text, isError) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'err' : '';
}

chrome.runtime.onMessage.addListener(m => {
  if (m && m.type === 'BRIDGE_STATUS') show(LABEL[m.status] || m.status, false);
});

btn.addEventListener('click', async () => {
  btn.disabled = true;
  show('Capturing…', false);

  const slow = setTimeout(() => show('Still analyzing — this can take a moment…', false), 6000);

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'BRIDGE_VISION',
      question: (qEl.value || '').trim() || null,
    });
  } catch (e) {
    res = null;
  }
  clearTimeout(slow);
  btn.disabled = false;

  if (!res) { show(ERRORS.timeout, true); return; }
  if (res.ok) { show('Done — see Solar Agenda.', false); setTimeout(() => window.close(), 700); return; }
  show(ERRORS[res.error] || res.error || 'Something went wrong.', true);
});

qEl.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });

const syncBtn = document.getElementById('sync');
if (syncBtn) syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  show('Sincronizando conversa…', false);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TARS_SLA_SYNC_HYPERFLOW', tabId: null });
    if (result?.ok) {
      const protocol = result.snapshot?.protocol || 'sem protocolo';
      const count = result.snapshot?.messageCount ?? 0;
      show(`Sincronizado — ${protocol} · ${count} interações`, false);
      console.info('[TARS SLA] Hyperflow sync result', result);
    } else {
      show(`Falha na sincronização — ${result?.error || 'erro desconhecido'}`, true);
      console.warn('[TARS SLA] Hyperflow sync failed', result);
    }
  } catch (error) {
    show('Falha na sincronização.', true);
    console.error('[TARS SLA] Hyperflow sync error', error);
  } finally {
    syncBtn.disabled = false;
  }
});

const webhookBtn = document.getElementById('webhook');
if (webhookBtn) webhookBtn.addEventListener('click', async () => {
  webhookBtn.disabled = true; show('Testing Solar Agenda SLA webhook…', false);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TARS_SLA_WEBHOOK_TEST' });
    if (result?.ok) show(`Webhook OK — HTTP ${result.status}`, false);
    else show(`Webhook failed — ${result?.error || ('HTTP ' + (result?.status || '?'))}`, true);
    console.info('[TARS SLA] webhook test result', result);
  } catch (error) { show('Webhook test failed.', true); console.error('[TARS SLA] webhook test error', error); }
  finally { webhookBtn.disabled = false; }
});
