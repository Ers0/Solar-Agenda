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

function popupLog(scope, message, data) {
  const fn = console.info;
  fn(`[TARS Popup] ${scope}: ${message}`, data ?? '');
}
function popupWarn(scope, message, data) {
  console.warn(`[TARS Popup] ${scope}: ${message}`, data ?? '');
}

function formatPopupError(err) {
  if (!err) return 'erro desconhecido';
  if (typeof err === 'string') return err;
  if (err.message && typeof err.message === 'string') return err.message;
  if (err.error) return formatPopupError(err.error);
  if (err.observer && err.observer.error) return formatPopupError(err.observer.error);
  if (err.status) return `HTTP ${err.status}`;
  try {
    const s = JSON.stringify(err);
    return s === '{}' ? String(err) : s;
  } catch (_) {
    return String(err);
  }
}

function sendRuntimeMessage(message) {
  return new Promise(resolve => {
    try {
      const p = chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || 'connection_error' });
        } else {
          resolve(response !== undefined ? response : { ok: false, error: 'empty_response' });
        }
      });
      if (p && typeof p.catch === 'function') {
        p.catch(e => resolve({ ok: false, error: e?.message || String(e) }));
      }
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

async function loadObserverState() {
  popupLog('Observer', 'checking current state');
  try {
    const r = await chrome.storage.local.get([OBSERVER_MODE_KEY, AUTOMATION_ENABLED_KEY]);
    const enabled = r[OBSERVER_MODE_KEY] === true;
    if (observerToggle) observerToggle.checked = enabled;
    if (observerText) observerText.textContent = enabled
      ? 'Observing support; customer automation is OFF'
      : 'Observer is OFF';
    popupLog('Observer', enabled ? 'currently ON' : 'currently OFF', r);
  } catch (error) {
    popupWarn('Observer', 'could not read state', error);
    show('Could not read Observer Mode status.', true);
  }
}

if (observerToggle) {
  observerToggle.addEventListener('change', async () => {
    const enabled = !!observerToggle.checked;
    popupLog('Observer', enabled ? 'switching ON' : 'switching OFF');
    try {
      let result = await sendRuntimeMessage({ type: 'TARS_OBSERVER_SET_MODE', enabled });
      if (!result?.ok) {
        popupWarn('Observer', 'background switch returned error; writing storage directly', result);
        await chrome.storage.local.set({ [OBSERVER_MODE_KEY]: enabled });
      }
      const verify = await chrome.storage.local.get([OBSERVER_MODE_KEY, LEARNING_MODE_KEY]);
      if (verify[OBSERVER_MODE_KEY] !== enabled) throw new Error('storage_verification_failed');
      popupLog('Observer', 'saved and verified', verify);
      if (observerText) observerText.textContent = enabled
        ? 'Observing support; customer automation is OFF'
        : 'Observer is OFF';
      show(enabled ? 'Observer Mode is ON. TARS will observe without talking to customers.' : 'Observer Mode is OFF. Customer automation can run if Safety is ON.', false);
    } catch (error) {
      observerToggle.checked = !enabled;
      popupWarn('Observer', 'switch failed', error);
      show('Observer Mode could not be changed. Check extension permissions.', true);
    }
  });
  loadObserverState();
}

const LEARNING_MODE_KEY = 'tarsLearningMode';
const learningToggle = document.getElementById('learningToggle');
const learningText = document.getElementById('learningText');
async function loadLearningState() {
  popupLog('Workflow Learning', 'checking current state');
  try {
    const r = await chrome.storage.local.get([LEARNING_MODE_KEY]);
    const enabled = r[LEARNING_MODE_KEY] === true;
    if (learningToggle) learningToggle.checked = enabled;
    popupLog('Workflow Learning', enabled ? 'currently ON' : 'currently OFF', r);
    if (learningText) learningText.textContent = enabled ? 'Cross-site workflow learning is ON' : 'Cross-site workflow learning is OFF';
  } catch (_) {}
}
if (learningToggle) {
  learningToggle.addEventListener('change', async () => {
    const enabled = !!learningToggle.checked;
    try {
      const result = await sendRuntimeMessage({ type:'TARS_OBSERVER_SET_LEARNING', enabled });
      if (!result?.ok) {
        popupWarn('Workflow Learning', 'background handler unavailable; using local storage fallback', result);
        await chrome.storage.local.set({ [LEARNING_MODE_KEY]: enabled });
      }
    } catch (error) {
      await chrome.storage.local.set({ [LEARNING_MODE_KEY]: enabled });
    }
    const verify = await chrome.storage.local.get([LEARNING_MODE_KEY]);
    popupLog('Workflow Learning', enabled ? 'enabled and verified' : 'disabled and verified', verify);
    if (learningText) learningText.textContent = enabled ? 'Cross-site workflow learning is ON' : 'Cross-site workflow learning is OFF';
    show(enabled ? 'Workflow learning enabled — TARS will passively observe linked sites.' : 'Workflow learning disabled.', false);
  });
  loadLearningState();
}

const AI_ENABLED_KEY = 'tarsAiEnabled';

async function loadSafetyState() {
  popupLog('Automation Safety', 'checking current state');
  try {
    const r = await chrome.storage.local.get([AUTOMATION_ENABLED_KEY, 'tarsEmergencyStop', OBSERVER_MODE_KEY]);
    const enabled = r[AUTOMATION_ENABLED_KEY] !== false;
    if (safetyToggle) safetyToggle.checked = enabled;
    popupLog('Automation Safety', enabled ? 'currently ON' : 'currently OFF', r);
    if (safetyText) safetyText.textContent = enabled
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
  popupLog('AI Assistant', 'checking current state');
  try {
    const r = await chrome.storage.local.get([AI_ENABLED_KEY]);
    const enabled = r[AI_ENABLED_KEY] === true;
    if (aiToggle) aiToggle.checked = enabled;
    popupLog('AI Assistant', enabled ? 'currently ON' : 'currently OFF', r);
    if (aiText) aiText.textContent = enabled ? 'AI features are ON' : 'AI features are OFF';
  } catch (_) {}
}

if (aiToggle) {
  aiToggle.addEventListener('change', async () => {
    const enabled = !!aiToggle.checked;
    popupLog('AI Assistant', enabled ? 'switching ON' : 'switching OFF');
    try {
      await chrome.storage.local.set({ [AI_ENABLED_KEY]: enabled });
      const verify = await chrome.storage.local.get([AI_ENABLED_KEY]);
      if (verify[AI_ENABLED_KEY] !== enabled) throw new Error('storage_verification_failed');
      popupLog('AI Assistant', enabled ? 'enabled and verified' : 'disabled and verified', verify);
    } catch (error) {
      popupWarn('AI Assistant', 'switch failed', error);
      show('AI Assistant setting could not be saved.', true);
      return;
    }
    if (aiText) aiText.textContent = enabled ? 'AI features are ON' : 'AI features are OFF';
    show(enabled ? 'AI assistant enabled.' : 'AI assistant disabled.', false);
  });
  loadAiState();
}

if (safetyToggle) {
  safetyToggle.addEventListener('change', async () => {
    const enabled = !!safetyToggle.checked;
    popupLog('Automation Safety', enabled ? 'switching ON' : 'switching OFF');
    try {
      const result = await sendRuntimeMessage({ type: 'TARS_AUTOMATION_SET', enabled });
      popupLog('Automation Safety', 'background acknowledged switch', result);
      if (!result?.ok) {
        popupWarn('Automation Safety', 'background switch failed; using local storage fallback', result);
        await chrome.storage.local.set({ [AUTOMATION_ENABLED_KEY]: enabled });
      }
    } catch (error) {
      await chrome.storage.local.set({ [AUTOMATION_ENABLED_KEY]: enabled });
    }
    if (safetyText) safetyText.textContent = enabled
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
    const result = await sendRuntimeMessage({
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

const automationStatusEl = document.getElementById('automationStatus') || statusEl;

const FRIENDLY_AUTOMATION_ERRORS = {
  automation_disabled: 'Automation did not start because Automation Safety is turned off.',
  emergency_stopped: 'Automation did not start because the Emergency Stop is active.',
  observer_mode: 'Automation did not start because Observer Mode is active. Turn Observer Mode off to allow customer actions.',
  missing_email: 'Automation stopped because the customer email address is missing.',
  incomplete_data: 'Automation stopped because some required customer information is missing.',
  incomplete_hoymiles_data: 'Automation stopped because the required Hoymiles account information is incomplete.',
  email_already_created: 'TARS found that this email was already used for a previous account, so it did not create another one.',
  not_on_hoymiles: 'Automation stopped because the Hoymiles portal is not open.',
  parent_organization_missing: 'Automation stopped because the parent organization could not be selected.',
  organization_not_created: 'Automation stopped because Hoymiles did not confirm that the organization was created.',
  contact_not_filled: 'Automation stopped because the organization contact information could not be entered or verified.',
  organization_form_validation: 'Hoymiles rejected the organization form. One or more required fields are missing or invalid.',
  timeout: 'Automation stopped because Hoymiles took too long to show the required screen or field.',
};

function friendlyAutomationError(result) {
  const raw = String(result?.error || result?.message || '');
  if (result?.friendlyError) return result.friendlyError;
  for (const [key, text] of Object.entries(FRIENDLY_AUTOMATION_ERRORS)) if (raw === key || raw.includes(key)) return text;
  if (/ReferenceError|is not defined/i.test(raw)) return 'Automation stopped because one of TARS\'s automation functions is missing. The account was not marked as completed.';
  if (/Form item not found|control not found/i.test(raw)) return 'Automation stopped because Hoymiles changed or did not show a required field.';
  if (/Timeout waiting/i.test(raw)) return 'Automation stopped because Hoymiles did not show the required page or field in time.';
  if (/value mismatch/i.test(raw)) return 'Automation stopped because Hoymiles did not accept a value that TARS entered.';
  return 'Automation stopped before completion. TARS could not safely confirm the account was created.';
}

function showAutomationResult(result) {
  const ok = !!result?.ok;
  const text = ok
    ? 'Hoymiles automation completed successfully.'
    : `Hoymiles automation failed: ${friendlyAutomationError(result)}`;
  if (automationStatusEl) {
    automationStatusEl.textContent = text;
    automationStatusEl.className = ok ? 'ok' : 'err';
  }
  show(text, !ok);
  if (ok) popupLog('Hoymiles Automation', 'completed', result);
  else popupWarn('Hoymiles Automation', 'failed', { ...result, friendlyMessage: friendlyAutomationError(result) });
}

function show(text, isError) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = isError ? 'err' : '';
}

chrome.runtime.onMessage.addListener(m => {
  if (!m) return;
  if (m.type === 'BRIDGE_STATUS') show(LABEL[m.status] || m.status, false);
  if (m.type === 'TARS_AUTOMATION_STATUS') showAutomationResult(m.result || m);
  if (m.type === 'TARS_DIAGNOSTIC') popupLog(m.scope || 'Runtime', m.message || 'event', m.data);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tarsHoymilesAutomationStatus?.newValue) {
    showAutomationResult(changes.tarsHoymilesAutomationStatus.newValue);
  }
  if (changes.tarsObserverMode) popupLog('Observer', 'storage changed', changes.tarsObserverMode.newValue);
  if (changes.tarsLearningMode) popupLog('Workflow Learning', 'storage changed', changes.tarsLearningMode.newValue);
  if (changes.tarsAiEnabled) popupLog('AI Assistant', 'storage changed', changes.tarsAiEnabled.newValue);
});

popupLog('Popup', 'loaded — diagnostics active');

if (btn) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    show('Capturing…', false);

    const slow = setTimeout(() => show('Still analyzing — this can take a moment…', false), 6000);

    let res;
    try {
      res = await sendRuntimeMessage({
        type: 'BRIDGE_VISION',
        question: (qEl?.value || '').trim() || null,
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
}

if (qEl) {
  qEl.addEventListener('keydown', e => { if (e.key === 'Enter') btn?.click(); });
}

(async () => {
  try {
    const r = await chrome.storage.local.get(['tarsHoymilesAutomationStatus']);
    if (r.tarsHoymilesAutomationStatus) {
      popupLog('Hoymiles Automation', 'last stored result loaded', r.tarsHoymilesAutomationStatus);
      showAutomationResult(r.tarsHoymilesAutomationStatus);
    }
  } catch (error) { popupWarn('Hoymiles Automation', 'could not load last result', error); }
})();

const syncBtn = document.getElementById('sync');
if (syncBtn) syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  show('Sincronizando conversa…', false);
  try {
    const result = await sendRuntimeMessage({ type: 'TARS_OBSERVER_SYNC_HYPERFLOW', tabId: null });
    if (result?.ok) {
      const protocol = result.snapshot?.protocol || result.protocol || 'sem protocolo';
      const count = result.snapshot?.messageCount ?? result.messageCount ?? 0;
      show(`Sincronizado — ${protocol} · ${count} interações`, false);
      console.info('[TARS Observer] Hyperflow sync result', result);
    } else {
      const errStr = formatPopupError(result?.error || result?.observer?.error || result?.observer || result);
      show(`Falha na sincronização — ${errStr}`, true);
      console.warn('[TARS Observer] Hyperflow sync failed', result);
    }
  } catch (error) {
    const msg = formatPopupError(error);
    show(`Falha na sincronização — ${msg}`, true);
    console.error('[TARS Observer] Hyperflow sync error', error);
  } finally {
    syncBtn.disabled = false;
  }
});

const webhookBtn = document.getElementById('webhook');
if (webhookBtn) webhookBtn.addEventListener('click', async () => {
  webhookBtn.disabled = true; show('Testing Solar Agenda SLA webhook…', false);
  try {
    const result = await sendRuntimeMessage({ type: 'TARS_SLA_WEBHOOK_TEST' });
    if (result?.ok) show(`Webhook OK — HTTP ${result.status}`, false);
    else {
      const errStr = formatPopupError(result?.error || ('HTTP ' + (result?.status || '?')));
      show(`Webhook failed — ${errStr}`, true);
    }
    console.info('[TARS SLA] webhook test result', result);
  } catch (error) {
    const msg = formatPopupError(error);
    show(`Webhook test failed: ${msg}`, true);
    console.error('[TARS SLA] webhook test error', error);
  } finally {
    webhookBtn.disabled = false;
  }
});
