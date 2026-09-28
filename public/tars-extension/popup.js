// TARS Vision Bridge - Popup Controller
// Provides interactive safety switches, Hoymiles parent organization configuration,
// live Solar Agenda ping diagnostics, and page vision relay.

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

// Storage Keys
const AUTOMATION_ENABLED_KEY = 'tarsAutomationEnabled';
const OBSERVER_MODE_KEY = 'tarsObserverMode';
const LEARNING_MODE_KEY = 'tarsLearningMode';
const AI_ENABLED_KEY = 'tarsAiEnabled';
const EMERGENCY_STOP_KEY = 'tarsEmergencyStop';
const HOYMILES_PARENT_ORG_KEY = 'tarsHoymilesParentOrg';
const HOYMILES_STATUS_KEY = 'tarsHoymilesAutomationStatus';

// DOM Elements
const statusEl = document.getElementById('status');
const btn = document.getElementById('go');
const qEl = document.getElementById('q');
const micBtn = document.getElementById('mic');

const headerDot = document.getElementById('headerDot');
const headerStatusText = document.getElementById('headerStatusText');

const safetyToggle = document.getElementById('safetyToggle');
const safetyText = document.getElementById('safetyText');

const observerToggle = document.getElementById('observerToggle');
const observerText = document.getElementById('observerText');

const learningToggle = document.getElementById('learningToggle');
const learningText = document.getElementById('learningText');

const aiToggle = document.getElementById('aiToggle');
const aiText = document.getElementById('aiText');

const emergencyStopBtn = document.getElementById('emergencyStop');

const hoymilesParentOrgInput = document.getElementById('hoymilesParentOrg');
const saveHoymilesParentOrgBtn = document.getElementById('saveHoymilesParentOrg');

const syncBtn = document.getElementById('sync');
const webhookBtn = document.getElementById('webhook');
const automationStatusEl = document.getElementById('automationStatus') || statusEl;

// Structured Diagnostics Logging
function popupLog(scope, message, data) {
  if (data !== undefined) {
    console.info(`[TARS Popup] ${scope}: ${message}`, data);
  } else {
    console.info(`[TARS Popup] ${scope}: ${message}`);
  }
}

function popupWarn(scope, message, data) {
  if (data !== undefined) {
    console.warn(`[TARS Popup] ${scope}: ${message}`, data);
  } else {
    console.warn(`[TARS Popup] ${scope}: ${message}`);
  }
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
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        return resolve({ ok: false, error: 'no_chrome_runtime' });
      }
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || 'connection_error' });
        } else {
          resolve(response !== undefined ? response : { ok: true });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

function show(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = isError ? 'err' : '';
}

// ------------------------------------------------------------- 1. Solar Agenda Ping & Header Status ---
async function checkSolarAgendaPing() {
  const started = Date.now();
  popupLog('Bridge', 'pinging Solar Agenda application...');
  try {
    const res = await sendRuntimeMessage({ type: 'BRIDGE_PING' });
    const latency = res.latencyMs || (Date.now() - started);
    const isFound = res?.found === true || res?.ok === true;

    if (isFound) {
      if (headerDot) {
        headerDot.style.background = '#25a965';
        headerDot.style.boxShadow = '0 0 0 3px #e7f7ee';
      }
      if (headerStatusText) {
        headerStatusText.textContent = `Online (${latency}ms)`;
        headerStatusText.title = `Connected to Solar Agenda (Tab: ${res.tabId || 'active'}, Protocol: ${res.protocol || 1})`;
      }
      console.info('[TARS Bridge] Solar Agenda ping response confirmed:', {
        connected: true,
        latencyMs: latency,
        tabId: res.tabId || null,
        url: res.url || null,
        title: res.title || null,
        protocol: res.protocol || 1,
        bridgeVersion: res.version || '1.2.90'
      });
    } else {
      if (headerDot) {
        headerDot.style.background = '#f59e0b';
        headerDot.style.boxShadow = '0 0 0 3px #fef3c7';
      }
      if (headerStatusText) {
        headerStatusText.textContent = 'Standby (Tab Closed)';
        headerStatusText.title = 'Open Solar Agenda in a tab to enable direct relay synchronization.';
      }
      console.warn('[TARS Bridge] Solar Agenda ping check: tab not found or sleeping. (Open Solar Agenda tab to activate instant link)');
    }
    return { ok: isFound, latency };
  } catch (error) {
    if (headerDot) {
      headerDot.style.background = '#ef4444';
      headerDot.style.boxShadow = '0 0 0 3px #fee2e2';
    }
    if (headerStatusText) headerStatusText.textContent = 'Offline';
    popupWarn('Bridge', 'Solar Agenda ping check error', error);
    return { ok: false, error: String(error?.message || error) };
  }
}

// ------------------------------------------------------------- 2. Hoymiles Parent Organization ---
async function loadHoymilesParentOrg() {
  try {
    const r = await chrome.storage.local.get([HOYMILES_PARENT_ORG_KEY]);
    const val = String(r[HOYMILES_PARENT_ORG_KEY] || 'APItest').trim() || 'APItest';
    if (hoymilesParentOrgInput) {
      hoymilesParentOrgInput.value = val;
    }
    console.info('[TARS Safety] Hoymiles Parent Organization loaded:', val);
  } catch (error) {
    popupWarn('Hoymiles', 'could not read parent org from storage', error);
  }
}

async function saveHoymilesParentOrg() {
  const val = String(hoymilesParentOrgInput?.value || '').trim() || 'APItest';
  if (hoymilesParentOrgInput) {
    hoymilesParentOrgInput.value = val;
  }
  try {
    await chrome.storage.local.set({ [HOYMILES_PARENT_ORG_KEY]: val });
    const verify = await chrome.storage.local.get([HOYMILES_PARENT_ORG_KEY]);
    const saved = verify[HOYMILES_PARENT_ORG_KEY] || 'APItest';
    
    console.info('[TARS Safety] Hoymiles Parent Organization updated & confirmed:', {
      configuredParentOrg: saved,
      timestamp: new Date().toISOString()
    });

    if (saveHoymilesParentOrgBtn) {
      const origText = saveHoymilesParentOrgBtn.textContent;
      saveHoymilesParentOrgBtn.textContent = 'Saved ✓';
      saveHoymilesParentOrgBtn.style.background = '#e7f7ee';
      saveHoymilesParentOrgBtn.style.color = '#25a965';
      saveHoymilesParentOrgBtn.style.borderColor = '#9bd7b7';
      setTimeout(() => {
        saveHoymilesParentOrgBtn.textContent = origText;
        saveHoymilesParentOrgBtn.style.background = '';
        saveHoymilesParentOrgBtn.style.color = '';
        saveHoymilesParentOrgBtn.style.borderColor = '';
      }, 1500);
    }
    show(`Hoymiles Parent Organization saved as "${saved}".`, false);
  } catch (error) {
    popupWarn('Hoymiles', 'could not save parent organization', error);
    show('Failed to save Hoymiles Parent Organization.', true);
  }
}

if (saveHoymilesParentOrgBtn) {
  saveHoymilesParentOrgBtn.addEventListener('click', saveHoymilesParentOrg);
}
if (hoymilesParentOrgInput) {
  hoymilesParentOrgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveHoymilesParentOrg();
    }
  });
}

// ------------------------------------------------------------- 3. Automation Safety Switch ---
async function loadSafetyState() {
  try {
    const r = await chrome.storage.local.get([AUTOMATION_ENABLED_KEY, EMERGENCY_STOP_KEY, OBSERVER_MODE_KEY]);
    const isEmergency = r[EMERGENCY_STOP_KEY] === true;
    const enabled = r[AUTOMATION_ENABLED_KEY] !== false && !isEmergency;
    if (safetyToggle) safetyToggle.checked = enabled;
    if (safetyText) {
      safetyText.textContent = isEmergency
        ? 'AUTOMATION HALTED — Emergency Stop is Active'
        : (enabled ? 'Automatic replies and workflows are ON' : 'Automatic replies and workflows are OFF');
    }
    updateEmergencyButton(isEmergency);
    console.info('[TARS Safety] Automation Safety state confirmed:', {
      automationEnabled: enabled,
      emergencyStopActive: isEmergency,
      observerMode: r[OBSERVER_MODE_KEY] === true
    });
  } catch (error) {
    popupWarn('Safety', 'could not read safety state', error);
  }
}

if (safetyToggle) {
  safetyToggle.addEventListener('change', async () => {
    const enabled = !!safetyToggle.checked;
    console.info('[TARS Safety] Automation Safety toggled by technician:', enabled ? 'ENABLED (ON)' : 'DISABLED (OFF)');
    try {
      // 1. Direct local persistence
      await chrome.storage.local.set({
        [AUTOMATION_ENABLED_KEY]: enabled,
        ...(enabled ? { [EMERGENCY_STOP_KEY]: false } : {})
      });
      // 2. Notify background runtime
      const result = await sendRuntimeMessage({ type: 'TARS_AUTOMATION_SET', enabled });
      console.info('[TARS Safety] Background acknowledged Automation Safety change:', result);
      
      if (safetyText) {
        safetyText.textContent = enabled
          ? 'Automatic replies and workflows are ON'
          : 'Automatic replies and workflows are OFF';
      }
      show(enabled ? 'Automation Safety is ON. Workflows permitted.' : 'Automation Safety is OFF. Customer actions paused.', false);
    } catch (error) {
      popupWarn('Safety', 'error setting automation safety state', error);
      show('Could not update Automation Safety setting.', true);
    }
  });
}

// ------------------------------------------------------------- 4. Emergency Stop ---
function updateEmergencyButton(active) {
  if (!emergencyStopBtn) return;
  emergencyStopBtn.classList.toggle('active', !!active);
  emergencyStopBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  emergencyStopBtn.innerHTML = active
    ? '<span class="stop-icon resume-icon" aria-hidden="true"></span><span class="emergency-copy">RELEASE EMERGENCY STOP<small>Resume automation for new actions</small></span>'
    : '<span class="stop-icon" aria-hidden="true"></span><span class="emergency-copy">EMERGENCY STOP<small>Stops all automation immediately</small></span>';
}

if (emergencyStopBtn) {
  emergencyStopBtn.addEventListener('click', async () => {
    emergencyStopBtn.disabled = true;
    const active = emergencyStopBtn.classList.contains('active');
    console.warn('[TARS Safety] Emergency Stop button clicked:', { action: active ? 'RELEASE' : 'ENGAGE' });
    try {
      const result = await sendRuntimeMessage({
        type: active ? 'TARS_EMERGENCY_RESUME' : 'TARS_EMERGENCY_STOP'
      });
      if (result?.ok) {
        updateEmergencyButton(!active);
        if (safetyToggle) safetyToggle.checked = active; // if releasing, safety resumes on
        if (safetyText) {
          safetyText.textContent = !active
            ? 'AUTOMATION HALTED — Emergency Stop is Active'
            : 'Automatic replies and workflows are ON';
        }
        console.warn('[TARS Safety] Emergency Stop state confirmed:', {
          emergencyStopActive: !active,
          at: new Date().toISOString()
        });
        show(active
          ? 'Emergency stop released — automation is available again.'
          : 'EMERGENCY STOP ACTIVE — all automation halted immediately.', !active);
      } else {
        show(`Emergency stop failed: ${result?.error || 'unknown error'}`, true);
      }
    } catch (error) {
      show('Emergency stop action failed.', true);
    } finally {
      emergencyStopBtn.disabled = false;
    }
  });
}

// ------------------------------------------------------------- 5. Observer Mode Switch ---
async function loadObserverState() {
  try {
    const r = await chrome.storage.local.get([OBSERVER_MODE_KEY]);
    const enabled = r[OBSERVER_MODE_KEY] === true;
    if (observerToggle) observerToggle.checked = enabled;
    if (observerText) {
      observerText.textContent = enabled
        ? 'Passively records support work; customer automation is OFF'
        : 'Observer Mode is OFF';
    }
    console.info('[TARS Observer] Observer Mode state confirmed:', { observerModeActive: enabled });
  } catch (error) {
    popupWarn('Observer', 'could not read observer state', error);
  }
}

if (observerToggle) {
  observerToggle.addEventListener('change', async () => {
    const enabled = !!observerToggle.checked;
    console.info('[TARS Observer] Observer Mode toggled by technician:', enabled ? 'ACTIVE (ON)' : 'INACTIVE (OFF)');
    try {
      // 1. Direct local persistence
      await chrome.storage.local.set({ [OBSERVER_MODE_KEY]: enabled });
      // 2. Notify background runtime
      const result = await sendRuntimeMessage({ type: 'TARS_OBSERVER_SET_MODE', enabled });
      console.info('[TARS Observer] Background acknowledged Observer Mode change:', result);

      if (observerText) {
        observerText.textContent = enabled
          ? 'Passively records support work; customer automation is OFF'
          : 'Observer Mode is OFF';
      }
      show(enabled
        ? 'Observer Mode is ON. TARS records passively without customer messaging.'
        : 'Observer Mode is OFF. Workflows can run normally.', false);
    } catch (error) {
      popupWarn('Observer', 'switch failed', error);
      show('Observer Mode could not be updated.', true);
    }
  });
}

// ------------------------------------------------------------- 6. Workflow Learning Switch ---
async function loadLearningState() {
  try {
    const r = await chrome.storage.local.get([LEARNING_MODE_KEY]);
    const enabled = r[LEARNING_MODE_KEY] === true;
    if (learningToggle) learningToggle.checked = enabled;
    if (learningText) {
      learningText.textContent = enabled
        ? 'Cross-site workflow learning is ON'
        : 'Cross-site workflow learning is OFF';
    }
    console.info('[TARS Workflow Learning] Learning Mode state confirmed:', { learningModeActive: enabled });
  } catch (error) {
    popupWarn('Workflow Learning', 'could not read learning state', error);
  }
}

if (learningToggle) {
  learningToggle.addEventListener('change', async () => {
    const enabled = !!learningToggle.checked;
    console.info('[TARS Workflow Learning] Learning Mode toggled by technician:', enabled ? 'ACTIVE (ON)' : 'INACTIVE (OFF)');
    try {
      // 1. Direct local persistence
      await chrome.storage.local.set({ [LEARNING_MODE_KEY]: enabled });
      // 2. Notify background runtime
      const result = await sendRuntimeMessage({ type: 'TARS_OBSERVER_SET_LEARNING', enabled });
      console.info('[TARS Workflow Learning] Background acknowledged Learning Mode change:', result);

      if (learningText) {
        learningText.textContent = enabled
          ? 'Cross-site workflow learning is ON'
          : 'Cross-site workflow learning is OFF';
      }
      show(enabled
        ? 'Workflow Learning enabled — TARS passively maps linked sites.'
        : 'Workflow Learning disabled.', false);
    } catch (error) {
      popupWarn('Workflow Learning', 'switch failed', error);
      show('Workflow Learning setting could not be updated.', true);
    }
  });
}

// ------------------------------------------------------------- 7. AI Assistant Switch ---
async function loadAiState() {
  try {
    const r = await chrome.storage.local.get([AI_ENABLED_KEY]);
    const enabled = r[AI_ENABLED_KEY] === true;
    if (aiToggle) aiToggle.checked = enabled;
    if (aiText) {
      aiText.textContent = enabled ? 'AI features are ON' : 'AI features are OFF';
    }
    console.info('[TARS AI Assistant] AI Features state confirmed:', { aiEnabled: enabled });
  } catch (error) {
    popupWarn('AI Assistant', 'could not read AI state', error);
  }
}

if (aiToggle) {
  aiToggle.addEventListener('change', async () => {
    const enabled = !!aiToggle.checked;
    console.info('[TARS AI Assistant] AI Features toggled by technician:', enabled ? 'ENABLED (ON)' : 'DISABLED (OFF)');
    try {
      await chrome.storage.local.set({ [AI_ENABLED_KEY]: enabled });
      if (aiText) aiText.textContent = enabled ? 'AI features are ON' : 'AI features are OFF';
      show(enabled ? 'AI Assistant features enabled.' : 'AI Assistant features disabled.', false);
    } catch (error) {
      popupWarn('AI Assistant', 'switch failed', error);
      show('AI Assistant setting could not be saved.', true);
    }
  });
}

// ------------------------------------------------------------- 8. Automation Status Card ---
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
  for (const [key, text] of Object.entries(FRIENDLY_AUTOMATION_ERRORS)) {
    if (raw === key || raw.includes(key)) return text;
  }
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
  if (ok) {
    popupLog('Hoymiles Automation', 'completed', result);
  } else {
    popupWarn('Hoymiles Automation', 'failed', { ...result, friendlyMessage: friendlyAutomationError(result) });
  }
}

async function loadLastAutomationStatus() {
  try {
    const r = await chrome.storage.local.get([HOYMILES_STATUS_KEY]);
    if (r[HOYMILES_STATUS_KEY]) {
      popupLog('Hoymiles Automation', 'last stored result loaded', r[HOYMILES_STATUS_KEY]);
      showAutomationResult(r[HOYMILES_STATUS_KEY]);
    }
  } catch (error) {
    popupWarn('Hoymiles Automation', 'could not load last result', error);
  }
}

// ------------------------------------------------------------- 9. Page Vision & Microphone ---
if (btn) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    show('Capturing page & context…', false);

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

    if (!res) {
      show(ERRORS.timeout, true);
      return;
    }
    if (res.ok) {
      show('Done — see Solar Agenda workspace.', false);
      setTimeout(() => window.close(), 700);
      return;
    }
    show(ERRORS[res.error] || res.error || 'Something went wrong.', true);
  });
}

if (qEl) {
  qEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') btn?.click();
  });
}

if (micBtn) {
  micBtn.addEventListener('click', () => {
    micBtn.classList.toggle('on');
    show('Speak your question — Solar Agenda is listening...', false);
    sendRuntimeMessage({ type: 'BRIDGE_VISION', voice: true, question: (qEl?.value || '').trim() || null });
  });
}

// ------------------------------------------------------------- 10. Tools: Sync & Webhook ---
if (syncBtn) {
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    show('Sincronizando conversa ativa no Hyperflow…', false);
    try {
      const result = await sendRuntimeMessage({ type: 'TARS_OBSERVER_SYNC_HYPERFLOW', tabId: null });
      if (result?.ok) {
        const protocol = result.snapshot?.protocol || result.protocol || 'sem protocolo';
        const count = result.snapshot?.messageCount ?? result.messageCount ?? 0;
        show(`Sincronizado — ${protocol} · ${count} interações gravadas`, false);
        console.info('[TARS Observer] Hyperflow sync result confirmed:', result);
      } else {
        const errStr = formatPopupError(result?.error || result?.observer?.error || result?.observer || result);
        show(`Falha na sincronização — ${errStr}`, true);
        console.warn('[TARS Observer] Hyperflow sync failed:', result);
      }
      await checkSolarAgendaPing();
    } catch (error) {
      const msg = formatPopupError(error);
      show(`Falha na sincronização — ${msg}`, true);
      console.error('[TARS Observer] Hyperflow sync error:', error);
    } finally {
      syncBtn.disabled = false;
    }
  });
}

if (webhookBtn) {
  webhookBtn.addEventListener('click', async () => {
    webhookBtn.disabled = true;
    show('Testing Solar Agenda SLA webhook…', false);
    try {
      const result = await sendRuntimeMessage({ type: 'TARS_SLA_WEBHOOK_TEST' });
      if (result?.ok) {
        show(`Webhook OK — HTTP ${result.status}`, false);
        console.info('[TARS SLA] Webhook test succeeded:', result);
      } else {
        const errStr = formatPopupError(result?.error || ('HTTP ' + (result?.status || '?')));
        show(`Webhook failed — ${errStr}`, true);
        console.warn('[TARS SLA] Webhook test failed:', result);
      }
    } catch (error) {
      const msg = formatPopupError(error);
      show(`Webhook test failed: ${msg}`, true);
      console.error('[TARS SLA] Webhook test error:', error);
    } finally {
      webhookBtn.disabled = false;
    }
  });
}

// ------------------------------------------------------------- 11. Listeners & Real-Time Sync ---
chrome.runtime.onMessage.addListener(m => {
  if (!m) return;
  if (m.type === 'BRIDGE_STATUS') show(LABEL[m.status] || m.status, false);
  if (m.type === 'TARS_AUTOMATION_STATUS') showAutomationResult(m.result || m);
  if (m.type === 'TARS_DIAGNOSTIC') popupLog(m.scope || 'Runtime', m.message || 'event', m.data);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[HOYMILES_STATUS_KEY]?.newValue) {
    showAutomationResult(changes[HOYMILES_STATUS_KEY].newValue);
  }
  if (changes[HOYMILES_PARENT_ORG_KEY]?.newValue) {
    const val = changes[HOYMILES_PARENT_ORG_KEY].newValue;
    if (hoymilesParentOrgInput && document.activeElement !== hoymilesParentOrgInput) {
      hoymilesParentOrgInput.value = val;
    }
    console.info('[TARS Safety] Storage sync: Parent Organization is now:', val);
  }
  if (changes[AUTOMATION_ENABLED_KEY]) {
    loadSafetyState();
  }
  if (changes[OBSERVER_MODE_KEY]) {
    loadObserverState();
  }
  if (changes[LEARNING_MODE_KEY]) {
    loadLearningState();
  }
  if (changes[AI_ENABLED_KEY]) {
    loadAiState();
  }
  if (changes[EMERGENCY_STOP_KEY]) {
    updateEmergencyButton(changes[EMERGENCY_STOP_KEY].newValue === true);
  }
});

// ------------------------------------------------------------- 12. Bootstrap ---
(async function init() {
  popupLog('Init', 'Loading TARS Vision Bridge popup interface');
  await Promise.all([
    checkSolarAgendaPing(),
    loadSafetyState(),
    loadObserverState(),
    loadLearningState(),
    loadAiState(),
    loadHoymilesParentOrg(),
    loadLastAutomationStatus()
  ]);
  console.info('[TARS Vision Bridge] All popup safety controls & ping diagnostics initialized.');
})();
