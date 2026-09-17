// The bridge itself. Its entire job is to find Solar Agenda, agree a protocol
// version, hand over a payload, and pass the result back. It holds no session,
// makes no network calls, and keeps no conversation state — all of that lives
// in the app, which is what stops this becoming a second TARS.

const PROTOCOL = 1;
const APP_ORIGIN = 'https://solar-agenda.vercel.app';
const APP_URL_MATCH = 'https://solar-agenda.vercel.app/*';
const HANDSHAKE_TIMEOUT_MS = 5000;

// Standing host access is limited to Solar Agenda + Hyperflow. Hyperflow
// needs this because its capture layer must start automatically and remain
// alive in the SPA, rather than waiting for a TARS Vision click.
let appTabId = null;

const AUTOMATION_ENABLED_KEY = 'tarsAutomationEnabled';
const EMERGENCY_STOP_KEY = 'tarsEmergencyStop';
const EMERGENCY_STOP_AT_KEY = 'tarsEmergencyStopAt';
const OBSERVER_MODE_KEY = 'tarsObserverMode';
const LEARNING_MODE_KEY = 'tarsLearningMode';
const TARS_OBSERVER_BACKEND_KEY = 'tarsObserverBackendUrl';
const DEFAULT_TARS_OBSERVER_BACKEND = 'https://solar-agenda.vercel.app/api/tars/observer/events';
const OBSERVER_404_PAUSE_KEY = 'tarsObserverBackend404';
let observerActiveCases = new Map();
let observerQueue = [];
let observerFlushTimer = null;
let observerBackendPaused = false;
const windowActiveCases = new Map();
const injectedLearningTabs = new Set();

async function ensureObserverDefaults() {
  try {
    const r = await chrome.storage.local.get([OBSERVER_MODE_KEY, LEARNING_MODE_KEY, OBSERVER_404_PAUSE_KEY]);
    if (r[OBSERVER_MODE_KEY] === undefined) {
      await chrome.storage.local.set({ [OBSERVER_MODE_KEY]: true, [LEARNING_MODE_KEY]: false, [AUTOMATION_ENABLED_KEY]: false });
      console.info('[TARS Observer] default observer mode enabled; customer automation disabled');
    }
  } catch (error) { console.warn('[TARS Observer] could not initialize observer defaults', error); }
}

chrome.runtime.onInstalled.addListener(() => ensureObserverDefaults());
chrome.runtime.onStartup.addListener(() => ensureObserverDefaults());
ensureObserverDefaults();


chrome.tabs.onActivated.addListener(({tabId, windowId}) => {
  if (learningEnabled().catch(() => false)) observeTab(tabId, 'tab_activated');
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) observeTab(tabId, changeInfo.url ? 'url_changed' : 'page_loaded');
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  injectedLearningTabs.delete(tabId);
  observerActiveCases.delete(tabId);
});


async function automationEmergencyStopped() {
  const r = await chrome.storage.local.get([EMERGENCY_STOP_KEY]);
  return r[EMERGENCY_STOP_KEY] === true;
}

async function broadcastEmergencyStop() {
  const tabs = await chrome.tabs.query({});
  const results = [];
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    const url = String(tab.url || '');
    if (!/^https:\/\/(conversas\.hyperflow\.global|global\.hoymiles\.com|solar-agenda\.vercel\.app)\//i.test(url)) continue;
    try {
      const response = await new Promise(resolve => chrome.tabs.sendMessage(tab.id, { type: 'TARS_EMERGENCY_STOP' }, r => resolve(chrome.runtime.lastError ? { ok:false, error:chrome.runtime.lastError.message } : (r || {ok:true}))));
      results.push({ tabId: tab.id, ok: response?.ok !== false, error: response?.error || null });
    } catch (error) { results.push({ tabId: tab.id, ok:false, error:String(error?.message || error) }); }
  }
  return results;
}


// ---------------------------------------------------------------- app tab ---

async function findAppTab() {
  const tabs = await chrome.tabs.query({ url: APP_URL_MATCH });
  // Prefer a tab that is already loaded; a discarded one cannot answer.
  const live = tabs.find(t => t.status === 'complete') || tabs[0];
  return live || null;
}

async function openAppTab() {
  // Opened in the background: the point of the bridge is that you stay on the
  // page you were looking at.
  const tab = await chrome.tabs.create({ url: APP_ORIGIN, active: false });
  await waitForLoad(tab.id);
  return tab;
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    // Never hang forever if the tab fails to load.
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, HANDSHAKE_TIMEOUT_MS);
  });
}

// -------------------------------------------------------------- messaging ---

// Every message to the app goes through here, so version checking and timeout
// behaviour exist in exactly one place.
function send(tabId, message, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = r => { if (!settled) { settled = true; resolve(r); } };

    // Only the handshake is time-boxed. A vision request is left pending
    // because a slow answer is still the right answer.
    if (timeoutMs) {
      setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    }

    try {
      chrome.tabs.sendMessage(tabId, { type: 'RELAY_TO_APP', payload: message }, reply => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: 'timeout' });
          return;
        }
        finish({ ok: true, reply });
      });
    } catch (e) {
      finish({ ok: false, error: 'timeout' });
    }
  });
}

// Agree a protocol version before sending anything real. An app that is newer
// still accepts v1 — that is the contract — so only an OLDER app is a failure.
async function handshake(tabId) {
  const res = await send(tabId, { v: PROTOCOL, type: 'HELLO', id: 'hello-' + Date.now() },
                         HANDSHAKE_TIMEOUT_MS);
  if (!res.ok) { console.warn('[bridge] Solar Agenda send failed', res); return { ok: false, error: res.error }; }

  const r = res.reply;
  if (!r || r.type !== 'HELLO_ACK') return { ok: false, error: 'bad_message' };
  if (!Array.isArray(r.accepts) || !r.accepts.includes(PROTOCOL)) {
    return { ok: false, error: 'bad_version' };
  }
  return { ok: true };
}

async function waitForAppReady(tabId) {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await handshake(tabId);
    if (r.ok) return r;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return { ok: false, error: 'solar_agenda_not_ready' };
}


// ------------------------------------------------------------------ capture ---
// ------------------------------------------------------- Hyperflow memory ---

async function captureActiveTab() {
  console.info('[bridge] captureActiveTab start');
  if (!chrome.tabs || !chrome.tabs.captureVisibleTab) {
    return { error: 'not_capturable', detail: 'this browser has no tab capture API' };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: 'no_frame' };

  if (!tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    return { error: 'not_capturable' };
  }

  let image = null;
  try {
    image = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg', quality: 80,
    });
    if (!image) return { error: 'capture_empty', detail: 'the browser returned no image' };
  } catch (e) {
    const why = (chrome.runtime.lastError && chrome.runtime.lastError.message)
             || (e && e.message) || 'unknown';
    console.warn('[bridge] capture failed:', why);
    return { error: 'not_capturable', detail: why };
  }

  let domText = null, selection = null, thread = null, domLength = 0;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = String(window.getSelection() || '').trim();
        const body = document.body ? document.body.innerText : '';

        function findThread(){
          let best = null, bestScore = 0;
          document.querySelectorAll('div, ul, ol, section, main').forEach(box => {
            const kids = [...box.children].filter(k => (k.innerText || '').trim().length > 1);
            if(kids.length < 4) return;
            const sig = k => k.tagName + ':' + (k.className || '').split(/\s+/)[0];
            const sigs = new Set(kids.map(sig));
            if(sigs.size > Math.max(4, kids.length * 0.6)) return;
            const text = kids.reduce((n, k) => n + (k.innerText || '').length, 0);
            if(text < 120) return;
            const depth = (() => { let d = 0, e = box; while(e.parentElement){ d++; e = e.parentElement; } return d; })();
            const score = text + kids.length * 40 + depth * 25;
            if(score > bestScore){ bestScore = score; best = box; }
          });
          return best;
        }

        function readThread(box){
          if(!box) return null;
          const kids = [...box.children].filter(k => (k.innerText || '').trim());
          const shapeOf = k => {
            const cs = getComputedStyle(k);
            const cls = (k.className || '').toString().split(/\s+/).slice(0, 2).join(' ');
            return [cls, cs.textAlign, cs.alignSelf,
                    Math.round(parseFloat(cs.marginLeft) / 20),
                    Math.round(parseFloat(cs.marginRight) / 20)].join('|');
          };
          const shapes = {};
          kids.forEach(k => { const s = shapeOf(k); shapes[s] = (shapes[s] || 0) + 1; });
          const ranked = Object.keys(shapes).sort((a, b) => shapes[b] - shapes[a]).slice(0, 4);
          const label = {};
          ranked.forEach((s, i) => { label[s] = String.fromCharCode(65 + i); });

          return kids.slice(-80).map(k => {
            const who = label[shapeOf(k)] || '?';
            const t = (k.innerText.match(/\b\d{1,2}:\d{2}\b/) || [''])[0];
            const txt = k.innerText.replace(/\s+/g, ' ').trim().slice(0, 400);
            return `[${who}]${t ? ' ' + t : ''} ${txt}`;
          }).join('\n');
        }

        let thread = null;
        try{ thread = readThread(findThread()); }catch(e){}

        return {
          sel: sel || null,
          text: body.replace(/\n{3,}/g, '\n\n').trim().slice(0, 40000),
          fullLength: body.replace(/\n{3,}/g, '\n\n').trim().length,
          thread: thread ? thread.slice(0, 9000) : null,
        };
      },
    });
    if (res && res.result) {
      domText = res.result.text || null;
      selection = res.result.sel;
      thread = res.result.thread || null;
      domLength = res.result.fullLength || 0;
    }
  } catch (e) {}

  console.info('[bridge] captureActiveTab success', { url: tab.url, domLength });

  return {
    image,
    url: tab.url,
    title: tab.title || '',
    selection,
    domText,
    thread,
    domLength,
  };
}

// ------------------------------------------------------------------ bridge ---

async function requestVision(payload, onStatus) {
  console.info('[bridge] requestVision start');
  onStatus('connecting');

  let tab = await findAppTab();
  if (!tab) {
    tab = await openAppTab();
    if (!tab) return { ok: false, error: 'no_app' };
  }
  appTabId = tab.id;
  console.info('[bridge] Solar Agenda tab', tab.id, tab.url);

  const hs = await handshake(tab.id);
  if (!hs.ok) { console.warn('[bridge] handshake failed', hs); return { ok: false, error: hs.error }; }
  console.info('[bridge] handshake ok');

  onStatus('analyzing');

  console.info('[bridge] sending VISION_REQUEST');
  const res = await send(tab.id, {
    v: PROTOCOL,
    type: 'VISION_REQUEST',
    id: crypto.randomUUID(),
    ...payload,
  }, null);

  if (!res.ok) return { ok: false, error: res.error };
  const r = res.reply;
  if (!r || r.type !== 'VISION_RESULT') return { ok: false, error: 'bad_message' };
  if (r.v !== PROTOCOL) return { ok: false, error: 'bad_version' };
  console.info('[bridge] VISION_RESULT received', { ok: r.ok });

  if (r.ok) chrome.tabs.update(tab.id, { active: true });

  return { ok: r.ok, error: r.error || null };
}

// ---------------------------------------------------------- Hoymiles test lab ---
async function getActiveHoymilesTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !String(tab.url || '').startsWith('https://global.hoymiles.com/')) {
    return { error: 'Make the Hoymiles tab active first.' };
  }
  return { tab };
}

async function sendHoymilesTest(type, data = {}) {
  const active = await getActiveHoymilesTab();
  if (active.error) return { ok:false, error:active.error };
  return await sendToHoymiles(active.tab.id, { type, data }, 15000);
}

// ---------------------------------------------------------- Hoymiles automation ---
const HOYMILES_URL = 'https://global.hoymiles.com/website/home';
const HOYMILES_URL_MATCH = 'https://global.hoymiles.com/*';
const HOYMILES_AUTOMATION_TIMEOUT_MS = 120000;
const HOYMILES_READY_TIMEOUT_MS = 30000;
const HOYMILES_READY_POLL_MS = 500;

async function findHoymilesTab() {
  const tabs = await chrome.tabs.query({ url: HOYMILES_URL_MATCH });
  return tabs.find(t => t.status === 'complete') || tabs[0] || null;
}

async function openHoymilesTab() {
  const tab = await chrome.tabs.create({ url: HOYMILES_URL, active: true });
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } };
    const onUpdated = (id, info) => { if (id === tab.id && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(finish, 15000);
  });
  return tab;
}

function sendToHoymiles(tabId, message, timeoutMs = HOYMILES_AUTOMATION_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'hoymiles_timeout' }), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message || 'hoymiles_message_failed' });
          return;
        }
        finish(response || { ok: false, error: 'empty_hoymiles_response' });
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e?.message || e) });
    }
  });
}

async function waitForHoymilesNavigation(tabId, timeoutMs = 30000) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(value);
    };
    const onUpdated = (id, info, updatedTab) => {
      if (id !== tabId) return;
      if (info.status === 'complete') finish(updatedTab || { id: tabId });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => finish({ id: tabId }), timeoutMs);
  });
}

async function ensureHoymilesHome(tabId) {
  const state = await sendToHoymiles(tabId, { type: 'HOYMILES_PREFLIGHT' }, 4000);
  console.info('[TARS Hoymiles BG] preflight: where am I?', state);

  if (state?.isHome) {
    console.info('[TARS Hoymiles BG] preflight: already on the right page');
    return { ok: true, navigated: false, state };
  }

  console.info('[TARS Hoymiles BG] preflight: wrong page, navigating to Hoymiles home', {
    from: state?.url || null,
    page: state?.page || 'UNKNOWN'
  });
  const navigationWait = waitForHoymilesNavigation(tabId, 30000);
  await chrome.tabs.update(tabId, { url: HOYMILES_URL, active: true });
  await navigationWait;

  const ready = await waitForHoymilesReady(tabId);
  if (!ready) return { ok: false, error: 'hoymiles_home_not_ready' };

  const after = await sendToHoymiles(tabId, { type: 'HOYMILES_PREFLIGHT' }, 4000);
  console.info('[TARS Hoymiles BG] preflight: now at', after);
  if (!after?.isHome) return { ok: false, error: 'hoymiles_home_navigation_failed', state: after };
  return { ok: true, navigated: true, state: after };
}

async function waitForHoymilesReady(tabId) {
  console.info('[TARS Hoymiles BG] waiting for adapter', { tabId });
  const started = Date.now();
  let injected = false;
  while (Date.now() - started < HOYMILES_READY_TIMEOUT_MS) {
    const ping = await sendToHoymiles(tabId, { type: 'HOYMILES_PING' }, 2000);
    if (ping?.ok && ping?.ready) {
      console.info('[TARS Hoymiles BG] adapter ready', { tabId, url: ping.url });
      return true;
    }

    if (!injected) {
      injected = true;
      try {
        console.warn('[TARS Hoymiles BG] adapter ping failed; injecting hoymiles.js', ping);
        await chrome.scripting.executeScript({ target: { tabId }, files: ['hoymiles.js'] });
      } catch (e) {
        console.warn('[TARS Hoymiles BG] injection failed', String(e?.message || e));
      }
    }
    await new Promise(r => setTimeout(r, HOYMILES_READY_POLL_MS));
  }
  console.error('[TARS Hoymiles BG] adapter not ready', { tabId });
  return false;
}

const TARS_SLA_WEBHOOK_STORAGE_KEY = 'tarsSlaWebhookUrl';
const DEFAULT_SLA_WEBHOOK_URL = 'https://solar-agenda.vercel.app/api/sla/webhook';
const FALLBACK_SLA_WEBHOOK_URLS = [
  'https://solar-agenda-ers0s-projects.vercel.app/api/sla/webhook',
  'https://solar-agenda-git-main-ers0s-projects.vercel.app/api/sla/webhook'
];

async function getSlaWebhookUrl() {
  const stored = await chrome.storage.local.get([TARS_SLA_WEBHOOK_STORAGE_KEY]);
  return String(stored[TARS_SLA_WEBHOOK_STORAGE_KEY] || DEFAULT_SLA_WEBHOOK_URL).trim();
}

async function getCandidateSlaWebhookUrls() {
  const primary = await getSlaWebhookUrl();
  const urls = [primary];
  for (const fb of FALLBACK_SLA_WEBHOOK_URLS) {
    if (!urls.includes(fb)) urls.push(fb);
  }
  return urls;
}

async function findHyperflowTab(preferredTabId = null) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab?.id && /^https:\/\/conversas\.hyperflow\.global\//i.test(String(tab.url || ''))) return tab;
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ url: 'https://conversas.hyperflow.global/*' });
  return tabs.find(t => t.active && t.status === 'complete')
    || tabs.find(t => t.status === 'complete')
    || tabs[0]
    || null;
}

async function reportHyperflowConversationToSlaWebhook(snapshot) {
  const candidateUrls = await getCandidateSlaWebhookUrls();
  if (!candidateUrls.length || !candidateUrls[0]) return { ok: false, skipped: true, error: 'sla_webhook_not_configured' };
  const payload = {
    event: 'hyperflow.conversation.synced',
    version: '1.0',
    source: 'tars-vision-bridge',
    bridgeVersion: '1.2.84',
    occurredAt: new Date().toISOString(),
    status: 'SYNCED',
    protocol: snapshot?.protocol || null,
    conversationUrl: snapshot?.conversationUrl || null,
    conversationId: snapshot?.conversationId || null,
    messageCount: Number(snapshot?.messageCount || (Array.isArray(snapshot?.messages) ? snapshot.messages.length : 0)),
    timeline: Array.isArray(snapshot?.timeline) ? snapshot.timeline : [],
    customer: snapshot?.customer || null,
    messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
    privacy: snapshot?.privacy || { sensitiveFieldsOmitted: true, messagePiiRedacted: true }
  };

  let lastError = null;
  let lastStatus = 500;
  let lastResponseText = '';
  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TARS-Webhook-Event': 'hyperflow.conversation.synced' },
        body: JSON.stringify(payload), credentials: 'omit', cache: 'no-store'
      });
      const responseText = await response.text().catch(() => '');
      if (response.ok) {
        return { ok: true, status: response.status, response: responseText.slice(0, 500), protocol: payload.protocol, messageCount: payload.messageCount, endpoint: url };
      }
      lastStatus = response.status;
      lastResponseText = responseText;
      lastError = `sla_webhook_http_${response.status}`;
      // If error is 500 (Vercel invocation error) or 404, try next candidate
      if (response.status !== 500 && response.status !== 404 && response.status !== 502 && response.status !== 503) {
        break;
      }
    } catch (error) {
      lastError = String(error?.message || error);
    }
  }

  return { ok: false, status: lastStatus, error: lastError || 'all_endpoints_failed', response: lastResponseText.slice(0, 500) };
}

async function ensureHyperflowCapture(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'invalid_hyperflow_tab' };

  const sendStatus = () => new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'HYPERFLOW_STATUS' }, response => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message || 'no_receiver' });
      resolve(response || { ok: false, error: 'empty_status_response' });
    });
  });

  let status = await sendStatus();
  if (status?.ok && status?.active !== undefined) return { ok: true, status, injected: false };

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['hyperflow.js', 'observer.js'] });
  } catch (error) {
    return { ok: false, error: `hyperflow_injection_failed:${String(error?.message || error)}` };
  }

  await new Promise(r => setTimeout(r, 150));
  status = await sendStatus();
  if (status?.ok) return { ok: true, status, injected: true };
  return { ok: false, error: status?.error || 'hyperflow_capture_not_ready' };
}

async function syncHyperflowToSla(preferredTabId = null) {
  const tab = await findHyperflowTab(preferredTabId);
  if (!tab?.id) return { ok: false, error: 'no_hyperflow_tab' };

  const ready = await ensureHyperflowCapture(tab.id);
  if (!ready.ok) return { ok: false, error: ready.error };

  const snapshotResult = await new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { type: 'HYPERFLOW_GET_SLA_SNAPSHOT' }, response => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message || 'hyperflow_snapshot_failed' });
      resolve(response || { ok: false, error: 'empty_hyperflow_snapshot' });
    });
  });
  if (!snapshotResult?.ok || !snapshotResult.snapshot) return { ok: false, error: snapshotResult?.error || 'hyperflow_snapshot_failed' };
  const webhook = await reportHyperflowConversationToSlaWebhook(snapshotResult.snapshot);
  console.info('[TARS SLA] Hyperflow conversation sync', {
    tabId: tab.id,
    protocol: snapshotResult.snapshot.protocol,
    messageCount: snapshotResult.snapshot.messageCount,
    webhook
  });
  return { ok: webhook.ok, tabId: tab.id, snapshot: snapshotResult.snapshot, webhook };
}

const HYPERFLOW_SYNC_ALARM = 'tars-hyperflow-sync-5min';
const HYPERFLOW_EOD_ALARM = 'tars-hyperflow-eod-purge';
const HYPERFLOW_SYNC_STATE_KEY = 'tarsHyperflowLastWebhookSync';

async function getHyperflowSyncState() {
  const data = await chrome.storage.local.get([HYPERFLOW_SYNC_STATE_KEY]);
  return data[HYPERFLOW_SYNC_STATE_KEY] || {};
}

async function setHyperflowSyncState(state) {
  await chrome.storage.local.set({ [HYPERFLOW_SYNC_STATE_KEY]: state });
}

async function syncHyperflowDirtyConversations() {
  const tabs = await chrome.tabs.query({ url: 'https://conversas.hyperflow.global/*' });
  if (!tabs.length) return { ok: true, tabs: 0, conversations: 0 };
  const state = await getHyperflowSyncState();
  const seen = new Set();
  let synced = 0;
  let failed = 0;

  for (const tab of tabs) {
    if (!tab?.id || tab.status !== 'complete') continue;
    const result = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: 'HYPERFLOW_GET_SLA_SNAPSHOTS_FOR_SYNC' }, response => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message || 'snapshot_failed' });
        resolve(response || { ok: false, error: 'empty_snapshot_response' });
      });
    });
    if (!result?.ok) { failed++; continue; }

    for (const snapshot of (result.snapshots || [])) {
      const cid = String(snapshot?.conversationId || '');
      if (!cid || seen.has(cid)) continue;
      const last = state[cid] || '';
      if (last && String(snapshot.updatedAt || '') <= last) continue;
      seen.add(cid);
      const webhook = await reportHyperflowConversationToSlaWebhook(snapshot);
      if (webhook.ok) {
        state[cid] = snapshot.updatedAt || snapshot.capturedAt || new Date().toISOString();
        synced++;
      } else {
        failed++;
      }
    }
  }

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [cid, ts] of Object.entries(state)) {
    if (!ts || Date.parse(ts) < cutoff) delete state[cid];
  }
  await setHyperflowSyncState(state);
  console.info('[TARS SLA] 5-minute Hyperflow sync', { tabs: tabs.length, conversations: synced, failed });
  return { ok: failed === 0, tabs: tabs.length, conversations: synced, failed };
}

async function purgeHyperflowLocalCaptureAtEod() {
  const tabs = await chrome.tabs.query({ url: 'https://conversas.hyperflow.global/*' });
  let purged = 0;
  for (const tab of tabs) {
    if (!tab?.id || tab.status !== 'complete') continue;
    const result = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: 'HYPERFLOW_PURGE_LOCAL_CAPTURE' }, response => {
        if (chrome.runtime.lastError) return resolve({ ok: false });
        resolve(response || { ok: false });
      });
    });
    if (result?.ok) purged++;
  }
  await chrome.storage.local.remove([HYPERFLOW_SYNC_STATE_KEY]);
  console.info('[TARS SLA] EOD local Hyperflow capture purge', { tabs: tabs.length, purged });
  return { ok: true, tabs: tabs.length, purged };
}

function scheduleHyperflowEodPurge() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(18, 10, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  chrome.alarms.create(HYPERFLOW_EOD_ALARM, { when: next.getTime(), periodInMinutes: 24 * 60 });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  try {
    if (alarm.name === HYPERFLOW_SYNC_ALARM) await syncHyperflowDirtyConversations();
    if (alarm.name === HYPERFLOW_EOD_ALARM) {
      await purgeHyperflowLocalCaptureAtEod();
      scheduleHyperflowEodPurge();
    }
  } catch (error) {
    console.warn('[TARS SLA] scheduled Hyperflow task failed', error);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HYPERFLOW_SYNC_ALARM, { delayInMinutes: 5, periodInMinutes: 5 });
  scheduleHyperflowEodPurge();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HYPERFLOW_SYNC_ALARM, { delayInMinutes: 5, periodInMinutes: 5 });
  scheduleHyperflowEodPurge();
});

async function reportHoymilesAccountToSlaWebhook({ data, conversationId, reporting }) {
  const url = await getSlaWebhookUrl();
  if (!url) return { ok: false, skipped: true, error: 'sla_webhook_not_configured' };

  const payload = {
    event: 'hoymiles.account.created',
    version: '1.0',
    source: 'tars-vision-bridge',
    bridgeVersion: '1.2.59',
    occurredAt: new Date().toISOString(),
    status: reporting?.ok ? 'COMPLETED' : 'ACCOUNT_CREATED',
    conversationId: conversationId || null,
    customer: {
      name: data?.fullName || null,
      email: data?.email || null,
      phone: data?.phone || null,
      state: data?.state || null
    },
    organization: {
      name: data?.company || null,
      parentOrganization: 'APItest',
      type: 'Installer',
      role: 'Installer'
    },
    account: {
      loginEmail: data?.email || null,
      passwordSharedWithCustomer: true
    },
    reporting: reporting || null
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      cache: 'no-store'
    });
    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, status: response.status, error: `sla_webhook_http_${response.status}`, response: responseText.slice(0, 500) };
    }
    return { ok: true, status: response.status, response: responseText.slice(0, 500) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), url };
  }
}

async function sendHoymilesHelpPromptToHyperflow(tabId, conversationId) {
  if (!tabId) return { ok: false, error: 'no_hyperflow_tab' };
  const text = 'Por hora, posso auxiliar com algo mais?';
  console.info('[TARS Hoymiles BG] asking customer if further help is needed', { tabId, conversationId });
  return await new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'HYPERFLOW_DO_SEND_REPLY', text, conversationId }, response => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message || 'hyperflow_send_failed' });
      resolve(response || { ok: false, error: 'empty_hyperflow_response' });
    });
  });
}

async function closeHoymilesConversationAsSuccess(tabId, conversationId) {
  if (!tabId || !conversationId) return { ok: false, error: 'missing_hyperflow_context' };
  console.info('[TARS Hoymiles BG] requesting safe Hyperflow close', { tabId, conversationId });
  return await new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, {
      type: 'HYPERFLOW_CLOSE_SUCCESS',
      conversationId
    }, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || 'hyperflow_close_failed' });
        return;
      }
      resolve(response || { ok: false, error: 'empty_hyperflow_close_response' });
    });
  });
}

async function sendHoymilesSuccessToHyperflow(tabId, conversationId, data) {
  if (!tabId) return { ok: false, error: 'no_hyperflow_tab' };
  const email = String(data?.email || '').trim();
  const text = `Sua conta Hoymiles foi criada com sucesso!\n\nE-mail/Login: ${email}\nSenha: Solar123\n\nAcesse a plataforma Hoymiles para realizar o primeiro acesso.\nAplicativo de Instalador: S-miles Installer.\nAplicativo de proprietario: S-miles Enduser.\nPlataforma Web: https://global.hoymiles.com/\n\nPara monitoramento HOYMILES, podem seguir os exemplos abaixo. Caso ainda reste alguma dúvida, orientamos acessar o último link da Universidade Bel,\nonde esclarecemos dúvidas sobre todas as fabricantes com as quais trabalhamos.\n\nGuia Geral:\nhttps://drive.google.com/drive/folders/13boBQDl5VFlsvkUx_rjs4Gg-YK9AZGGf?usp=sharing\n\nInstalação e comissionamento completo do DW:\nhttps://www.youtube.com/watch?v=zxlvAUMXpNI\n\nComo adicionar dispositivos a uma planta:\nhttps://youtu.be/Eceg3MtSEEY?si=spdOVfnPG-55tFhN\n\nComo criar uma planta do zero:\nhttps://youtu.be/LTHzCXIan1g?si=2TvBL0UwqfZk2Odm\n\nComo inserir senha na DTU:\nhttps://youtu.be/6wJX6OaAzV0?si=kKw3TxMAlYLQvwdf\n\nUniversidade Bel:\nhttps://belenus.com.br/universidade-bel/vitrine-catalogo-universidade`;

  console.info('[TARS Hoymiles BG] reporting created account to Hyperflow', {
    tabId, conversationId, email
  });

  return await new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, {
      type: 'HYPERFLOW_DO_SEND_REPLY',
      text,
      conversationId
    }, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || 'hyperflow_send_failed' });
        return;
      }
      resolve(response || { ok: false, error: 'empty_hyperflow_response' });
    });
  });
}

async function runHoymilesAutomation(data) {
  if (await automationEmergencyStopped()) return { ok:false, error:'emergency_stopped' };
  console.info('[TARS Hoymiles BG] automation start', { email: data?.email, company: data?.company, state: data?.state });
  let tab = await findHoymilesTab();
  console.info('[TARS Hoymiles BG] existing tab', tab ? { id: tab.id, url: tab.url, status: tab.status } : null);
  if (!tab) {
    console.info('[TARS Hoymiles BG] opening Hoymiles portal');
    tab = await openHoymilesTab();
  }
  console.info('[TARS Hoymiles BG] portal tab ready', tab ? { id: tab.id, url: tab.url, status: tab.status } : null);
  if (!tab?.id) return { ok: false, error: 'no_hoymiles_tab' };

  await chrome.tabs.update(tab.id, { active: true });
  const ready = await waitForHoymilesReady(tab.id);
  if (!ready) return { ok: false, error: 'hoymiles_adapter_not_ready' };

  const preflight = await ensureHoymilesHome(tab.id);
  if (!preflight.ok) return preflight;

  console.info('[TARS Hoymiles BG] sending HOYMILES_RUN_INSTALLER', { tabId: tab.id, preflight });
  const result = await sendToHoymiles(tab.id, { type: 'HOYMILES_RUN_INSTALLER', data });
  console.info('[TARS Hoymiles BG] automation result', result);
  if (await automationEmergencyStopped()) return { ok:false, error:'emergency_stopped', interruptedResult:result };

  return result;
}

async function learningEnabled() {
  const r = await chrome.storage.local.get([LEARNING_MODE_KEY]);
  return r[LEARNING_MODE_KEY] === true;
}

async function anyObservationEnabled() {
  const r = await chrome.storage.local.get([OBSERVER_MODE_KEY, LEARNING_MODE_KEY]);
  return r[OBSERVER_MODE_KEY] === true || r[LEARNING_MODE_KEY] === true;
}

function tabIsWebPage(tab) {
  return !!tab && Number.isInteger(tab.id) && /^https?:\/\//i.test(String(tab.url || '')) && !/^https:\/\/solar-agenda\.vercel\.app\//i.test(String(tab.url || ''));
}

async function injectLearningObserver(tabId) {
  if (!(await learningEnabled())) return { ok:false, skipped:true };
  if (injectedLearningTabs.has(tabId)) return { ok:true, already:true };
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames:false }, files:['observer.js'] });
    injectedLearningTabs.add(tabId);
    return { ok:true };
  } catch (error) {
    return { ok:false, error:String(error?.message || error) };
  }
}

async function observeTab(tabId, reason='tab') {
  if (!(await learningEnabled())) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tabIsWebPage(tab)) return;
    const caseHint = windowActiveCases.get(tab.windowId) || null;
    queueObserverEvent({
      eventId: crypto.randomUUID(), eventType:'SITE_ACCESSED', observedAt:new Date().toISOString(),
      reason, url: String(tab.url || '').split('#')[0].slice(0,500),
      title: String(tab.title || '').slice(0,180), windowId: tab.windowId,
      caseHint: caseHint ? { conversationId:caseHint.conversationId||null, protocol:caseHint.protocol||null } : null
    }, tab.id, caseHint);
    await injectLearningObserver(tab.id);
  } catch (_) {}
}

async function getObserverBackendUrl() {
  const r = await chrome.storage.local.get([TARS_OBSERVER_BACKEND_KEY]);
  return String(r[TARS_OBSERVER_BACKEND_KEY] || DEFAULT_TARS_OBSERVER_BACKEND).trim();
}

async function observerEnabled() {
  const r = await chrome.storage.local.get([OBSERVER_MODE_KEY]);
  return r[OBSERVER_MODE_KEY] === true;
}

function queueObserverEvent(event, senderTabId = null, conversation = null) {
  const active = conversation || (senderTabId != null ? observerActiveCases.get(senderTabId) : null) || null;
  const resolvedCase = {
    conversationId: active?.conversationId || event?.case?.conversationId || event?.conversationId || null,
    protocol: active?.protocol || event?.case?.protocol || event?.protocol || null,
    conversationUrl: active?.conversationUrl || event?.case?.conversationUrl || event?.conversationUrl || null,
    customerName: active?.customerName || event?.case?.customerName || event?.customerName || null,
    customerPhone: active?.customerPhone || event?.case?.customerPhone || event?.customerPhone || null,
    manufacturer: active?.manufacturer || event?.case?.manufacturer || null,
    equipmentModel: active?.equipmentModel || event?.case?.equipmentModel || null,
    serialNumber: active?.serialNumber || event?.case?.serialNumber || null
  };
  const hasCase = !!(resolvedCase.conversationId || resolvedCase.protocol);
  if (senderTabId != null && hasCase) {
    observerActiveCases.set(senderTabId, resolvedCase);
  }
  observerQueue.push({
    eventId: event.eventId || crypto.randomUUID(),
    eventType: event.eventType || 'OBSERVER_EVENT',
    observedAt: event.observedAt || new Date().toISOString(),
    source: 'tars-vision-bridge',
    bridgeVersion: '1.2.83',
    tabId: senderTabId,
    case: hasCase ? resolvedCase : null,
    data: event.data || event,
    event
  });
  if (observerQueue.length > 250) observerQueue.splice(0, observerQueue.length - 250);
  scheduleObserverFlush();
}

function scheduleObserverFlush() {
  if (observerFlushTimer) return;
  observerFlushTimer = setTimeout(() => { observerFlushTimer = null; flushObserverQueue(); }, 1000);
}

async function flushObserverQueue() {
  if (!(await anyObservationEnabled())) return;
  if (observerBackendPaused) return;
  if (!observerQueue.length) return;
  const url = await getObserverBackendUrl();
  if (!/^https:\/\//i.test(url)) return;
  const batch = observerQueue.splice(0, 25);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TARS-Event': 'observer' },
      credentials: 'omit', cache: 'no-store',
      body: JSON.stringify({ version: '1.0', source: 'tars-vision-bridge', bridgeVersion: '1.2.83', events: batch })
    });
    if (!response.ok) {
      if (response.status === 404) {
        observerBackendPaused = true;
        await chrome.storage.local.set({ [OBSERVER_404_PAUSE_KEY]: true });
        observerQueue.unshift(...batch);
        console.warn('[TARS Observer] backend endpoint returned 404; delivery paused until backend URL is changed or extension is reloaded after the route is deployed');
        return;
      }
      throw new Error(`observer_backend_http_${response.status}`);
    }
    console.info('[TARS Observer] batch delivered', { count: batch.length, status: response.status });
  } catch (error) {
    observerQueue.unshift(...batch);
    if (observerQueue.length > 250) observerQueue.splice(0, observerQueue.length - 250);
    console.warn('[TARS Observer] delivery failed; queued locally', String(error?.message || error));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg && msg.type === 'TARS_OBSERVER_CASE_ACTIVE') {
    if (Number.isInteger(sender?.tab?.id)) {
      observerActiveCases.set(sender.tab.id, msg.conversation || null);
      if (Number.isInteger(sender?.tab?.windowId)) windowActiveCases.set(sender.tab.windowId, msg.conversation || null);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg && msg.type === 'TARS_OBSERVER_HYPERFLOW_BATCH') {
    if (Number.isInteger(sender?.tab?.id)) {
      observerActiveCases.set(sender.tab.id, msg.conversation || null);
      if (Number.isInteger(sender?.tab?.windowId)) windowActiveCases.set(sender.tab.windowId, msg.conversation || null);
    }
    const conversation = msg.conversation || null;
    for (const m of (msg.messages || [])) {
      queueObserverEvent({
        eventId: m.id ? `hf:${m.id}` : crypto.randomUUID(),
        eventType: 'HYPERFLOW_MESSAGE',
        observedAt: m.capturedAt || new Date().toISOString(),
        direction: m.direction,
        speaker: m.speaker,
        messageId: m.id || null,
        timestamp: m.timestamp || null,
        text: String(m.text || '').slice(0, 12000),
        attachmentCount: Number(m.attachmentCount || 0),
        page: 'https://conversas.hyperflow.global/'
      }, sender?.tab?.id || null, conversation);
    }
    sendResponse({ ok: true, queued: (msg.messages || []).length });
    return true;
  }

  if (msg && msg.type === 'TARS_OBSERVER_EVENT') {
    queueObserverEvent(msg.event || {}, sender?.tab?.id || null);
    sendResponse({ ok: true, queued: true });
    return true;
  }

  if (msg && msg.type === 'TARS_OBSERVER_SET_LEARNING') {
    (async () => {
      const enabled = !!msg.enabled;
      await chrome.storage.local.set({ [LEARNING_MODE_KEY]: enabled });
      if (enabled) {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) if (tabIsWebPage(tab)) observeTab(tab.id, 'learning_enabled');
      } else {
        injectedLearningTabs.clear();
      }
      return { ok:true, enabled };
    })().then(sendResponse).catch(error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (msg && msg.type === 'TARS_OBSERVER_BACKEND_RESET') {
    observerBackendPaused = false;
    chrome.storage.local.remove([OBSERVER_404_PAUSE_KEY]).then(() => { scheduleObserverFlush(); sendResponse({ok:true}); }).catch(error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (msg && msg.type === 'TARS_EMERGENCY_STOP') {
    (async () => {
      const now = new Date().toISOString();
      await chrome.storage.local.set({
        [EMERGENCY_STOP_KEY]: true,
        [EMERGENCY_STOP_AT_KEY]: now,
        [AUTOMATION_ENABLED_KEY]: false
      });
      const results = await broadcastEmergencyStop();
      console.warn('[TARS SAFETY] EMERGENCY STOP ACTIVE', { at: now, results });
      return { ok: true, stopped: true, at: now, results };
    })().then(sendResponse).catch(error => sendResponse({ ok:false, error:String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_EMERGENCY_RESUME') {
    (async () => {
      const now = new Date().toISOString();
      await chrome.storage.local.set({
        [EMERGENCY_STOP_KEY]: false,
        [AUTOMATION_ENABLED_KEY]: true
      });
      console.info('[TARS SAFETY] EMERGENCY STOP RELEASED — new automation permitted', { at: now });
      return { ok: true, stopped: false, resumed: true, at: now };
    })().then(sendResponse).catch(error => sendResponse({ ok:false, error:String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_AUTOMATION_SET') {
    (async () => {
      const enabled = !!msg.enabled;
      if (enabled) {
        await chrome.storage.local.set({ [AUTOMATION_ENABLED_KEY]: true, [EMERGENCY_STOP_KEY]: false });
        console.info('[TARS SAFETY] automation re-enabled for NEW runs; previously stopped runs do not resume');
      } else {
        await chrome.storage.local.set({ [AUTOMATION_ENABLED_KEY]: false });
      }
      return { ok:true, enabled, emergencyStopped: enabled ? false : await automationEmergencyStopped() };
    })().then(sendResponse).catch(error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (msg && msg.type === 'TARS_SLA_SYNC_HYPERFLOW') {
    syncHyperflowToSla(msg.tabId || sender?.tab?.id || null).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_SLA_WEBHOOK_SET') {
    (async () => {
      const url = String(msg.url || '').trim();
      if (url && !/^https:\/\//i.test(url)) return { ok: false, error: 'sla_webhook_requires_https' };
      await chrome.storage.local.set({ [TARS_SLA_WEBHOOK_STORAGE_KEY]: url });
      return { ok: true, url: url || DEFAULT_SLA_WEBHOOK_URL };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_SLA_WEBHOOK_GET') {
    getSlaWebhookUrl().then(url => sendResponse({ ok: true, url })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_SLA_WEBHOOK_TEST') {
    (async () => {
      const explicitUrl = msg.url ? String(msg.url).trim() : null;
      const candidateUrls = explicitUrl ? [explicitUrl] : await getCandidateSlaWebhookUrls();
      if (!candidateUrls.length || !candidateUrls[0]) return { ok: false, error: 'sla_webhook_not_configured' };
      const payload = {
        event: 'hoymiles.account.created', version: '1.0', source: 'tars-vision-bridge',
        bridgeVersion: '1.2.84', occurredAt: new Date().toISOString(), status: 'COMPLETED', test: true,
        conversationId: 'TEST-WEBHOOK-' + Date.now(),
        customer: { name: 'TARS Webhook Test', email: 'webhook-test@example.invalid', phone: '', state: 'São Paulo' },
        organization: { name: 'TARS Webhook Test Org', parentOrganization: 'APItest', type: 'Installer', role: 'Installer' },
        account: { loginEmail: 'webhook-test@example.invalid', passwordSharedWithCustomer: true },
        reporting: { ok: true, method: 'test' }
      };

      let lastRes = null;
      for (const url of candidateUrls) {
        if (!/^https:\/\//i.test(url)) continue;
        console.info('[TARS SLA] sending explicit webhook test to', url);
        try {
          const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TARS-Webhook-Test': '1' }, body: JSON.stringify(payload), credentials: 'omit', cache: 'no-store' });
          const responseText = await response.text().catch(() => '');
          lastRes = { ok: response.ok, status: response.status, url, response: responseText.slice(0, 1000), payload };
          if (response.ok) return lastRes;
          // If invocation failed, attempt next candidate
          if (response.status !== 500 && response.status !== 404 && response.status !== 502 && response.status !== 503) {
            return lastRes;
          }
        } catch (error) {
          lastRes = { ok: false, url, error: String(error?.message || error), payload };
        }
      }
      return lastRes || { ok: false, error: 'sla_webhook_test_failed' };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && ['TARS_STORAGE_GET','TARS_STORAGE_SET','TARS_STORAGE_REMOVE'].includes(msg.type)) {
    (async () => {
      try {
        if (msg.type === 'TARS_STORAGE_GET') {
          const data = await chrome.storage.local.get(msg.keys || []);
          return { ok: true, data };
        }
        if (msg.type === 'TARS_STORAGE_SET') {
          await chrome.storage.local.set(msg.items || {});
          return { ok: true };
        }
        await chrome.storage.local.remove(msg.keys || []);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    })().then(sendResponse);
    return true;
  }

  if (msg && msg.type === 'TARS_HOYMILES_AI_INTENT') {
    (async () => {
      let tab = await findAppTab();
      if (!tab?.id) {
        console.info('[TARS Hoymiles BG] Solar Agenda tab not found; opening background tab for AI intent');
        try {
          tab = await openAppTab();
        } catch (error) {
          return { ok: false, error: 'solar_agenda_tab_open_failed', detail: String(error?.message || error) };
        }
      }
      if (!tab?.id) return { ok: false, error: 'solar_agenda_tab_not_found_after_open' };
      const ready = await waitForAppReady(tab.id);
      if (!ready.ok) return ready;
      const prompt = String(msg.prompt || '').trim();
      if (!prompt) return { ok: false, error: 'empty_intent_prompt' };
      const result = await new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TARS_HOYMILES_AI_CLASSIFY_PAGE',
          prompt
        }, response => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message || 'ai_content_message_failed' });
          resolve(response || { ok: false, error: 'empty_ai_reply' });
        });
      });
      return result;
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_HOYMILES_DEBUG_GET_ORIGIN') {
    chrome.storage.local.get(['tarsHoymilesOrigin']).then(async r => {
      const origin = r.tarsHoymilesOrigin || null;
      let live = null;
      if (origin?.tabId != null) {
        try {
          const tab = await chrome.tabs.get(origin.tabId);
          live = { id: tab.id, windowId: tab.windowId, active: !!tab.active, status: tab.status, url: tab.url || null, title: tab.title || null };
        } catch (error) {
          live = { error: String(error?.message || error) };
        }
      }
      sendResponse({ ok: true, origin, live });
    }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_HOYMILES_DEBUG_STATUS') {
    chrome.storage.local.get(['tarsHoymilesOrigin', 'tarsHoymilesLastEmail', 'tarsHoymilesLastConversationId', 'tarsHoymilesStates']).then(async r => {
      sendResponse({
        ok: true,
        origin: r.tarsHoymilesOrigin || null,
        lastEmail: r.tarsHoymilesLastEmail || null,
        lastConversationId: r.tarsHoymilesLastConversationId || null,
        states: r.tarsHoymilesStates || {}
      });
    }).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_HOYMILES_DEBUG_RETURN_TO_ORIGIN') {
    (async () => {
      const r = await chrome.storage.local.get(['tarsHoymilesOrigin']);
      const origin = r.tarsHoymilesOrigin || null;
      if (!Number.isInteger(origin?.tabId)) return { ok: false, error: 'no_stored_origin', origin };
      let lastError = null;
      const attempts = [];
      for (let attempt = 1; attempt <= 5; attempt++) {
        const step = { attempt };
        try {
          const tab = await chrome.tabs.get(origin.tabId);
          const windowId = Number.isInteger(origin.windowId) ? origin.windowId : tab.windowId;
          const win = await chrome.windows.get(windowId);
          step.before = { tabId: tab.id, windowId: tab.windowId, active: !!tab.active, url: tab.url || null, windowState: win.state };
          await chrome.windows.update(windowId, { state: win.state === 'minimized' ? 'normal' : win.state, focused: true });
          await chrome.tabs.update(origin.tabId, { active: true });
          await new Promise(r => setTimeout(r, 200));
          const verify = await chrome.tabs.get(origin.tabId);
          const active = await chrome.tabs.query({ active: true, windowId });
          step.after = { tabId: verify.id, windowId: verify.windowId, active: !!verify.active, activeTabs: active.map(t => ({ id: t.id, url: t.url || null })) };
          attempts.push(step);
          if (verify.active && verify.windowId === windowId) {
            return { ok: true, tabId: verify.id, windowId, attempts };
          }
          lastError = new Error('activation_not_confirmed');
        } catch (error) {
          lastError = error;
          step.error = String(error?.message || error);
          attempts.push(step);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      return { ok: false, error: String(lastError?.message || lastError || 'debug_return_failed'), origin, attempts };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'HYPERFLOW_SEND_REPLY') {
    (async () => {
      if (!sender?.tab?.id) return { ok: false, error: 'no_hyperflow_tab' };
      return await new Promise(resolve => {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'HYPERFLOW_DO_SEND_REPLY',
          text: msg.text,
          conversationId: msg.conversationId
        }, response => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message || 'send_failed' });
          resolve(response || { ok: false, error: 'empty_send_response' });
        });
      });
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && ['HOYMILES_TEST_PING','HOYMILES_TEST_INSPECT','HOYMILES_TEST_ORG','HOYMILES_TEST_PARENT','HOYMILES_TEST_ADD_ORG','HOYMILES_TEST_NAME','HOYMILES_TEST_TYPE','HOYMILES_TEST_COUNTRY','HOYMILES_TEST_REGION','HOYMILES_TEST_CONTACT','HOYMILES_TEST_CONTACT_NUMBER','HOYMILES_TEST_ADDRESS','HOYMILES_TEST_INTRO'].includes(msg.type)) {
    (async () => {
      let result;
      if (msg.type === 'HOYMILES_TEST_PING') result = await sendHoymilesTest('HOYMILES_TEST_PING');
      if (msg.type === 'HOYMILES_TEST_INSPECT') result = await sendHoymilesTest('HOYMILES_TEST_INSPECT');
      if (msg.type === 'HOYMILES_TEST_ORG') result = await sendHoymilesTest('HOYMILES_TEST_ORG');
      if (msg.type === 'HOYMILES_TEST_PARENT') result = await sendHoymilesTest('HOYMILES_TEST_PARENT');
      if (msg.type === 'HOYMILES_TEST_ADD_ORG') result = await sendHoymilesTest('HOYMILES_TEST_ADD_ORG');
      if (msg.type === 'HOYMILES_TEST_NAME') result = await sendHoymilesTest('HOYMILES_TEST_NAME');
      if (msg.type === 'HOYMILES_TEST_TYPE') result = await sendHoymilesTest('HOYMILES_TEST_TYPE');
      if (msg.type === 'HOYMILES_TEST_COUNTRY') result = await sendHoymilesTest('HOYMILES_TEST_COUNTRY');
      if (msg.type === 'HOYMILES_TEST_REGION') result = await sendHoymilesTest('HOYMILES_TEST_REGION');
      if (msg.type === 'HOYMILES_TEST_CONTACT') result = await sendHoymilesTest('HOYMILES_TEST_CONTACT');
      if (msg.type === 'HOYMILES_TEST_CONTACT_NUMBER') result = await sendHoymilesTest('HOYMILES_TEST_CONTACT_NUMBER');
      if (msg.type === 'HOYMILES_TEST_ADDRESS') result = await sendHoymilesTest('HOYMILES_TEST_ADDRESS');
      if (msg.type === 'HOYMILES_TEST_INTRO') result = await sendHoymilesTest('HOYMILES_TEST_INTRO');
      sendResponse(result || {ok:false,error:'unknown_test'});
    })();
    return true;
  }

  if (msg && msg.type === 'HOYMILES_CREATE_REQUEST') {
    const originTabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
    const originWindowId = Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null;
    console.info('[TARS Hoymiles BG] CREATE_REQUEST received', {
      conversationId: msg.conversation?.conversationId || null,
      email: msg.data?.email || null,
      company: msg.data?.company || null,
      state: msg.data?.state || null,
      originTabId,
      originWindowId
    });
    chrome.storage.local.set({
      tarsHoymilesOrigin: {
        tabId: originTabId,
        windowId: originWindowId,
        conversationId: msg.conversation?.conversationId || null,
        url: sender?.tab?.url || null,
        title: sender?.tab?.title || null,
        capturedAt: new Date().toISOString()
      }
    }).catch(error => console.warn('[TARS Hoymiles BG] failed to persist origin diagnostic', error));
    (async () => {
      const automationSetting = await chrome.storage.local.get(['tarsAutomationEnabled', 'tarsEmergencyStop']);
      if (automationSetting.tarsEmergencyStop === true) {
        console.warn('[TARS Hoymiles BG] automation blocked by EMERGENCY STOP');
        return { ok: false, error: 'emergency_stopped' };
      }
      if (automationSetting.tarsAutomationEnabled === false) {
        console.warn('[TARS Hoymiles BG] automation blocked by safety switch');
        return { ok: false, error: 'automation_disabled' };
      }
      const data = msg.data;
      if (!data?.email) return { ok: false, error: 'missing_email' };
      const memory = await chrome.storage.local.get(['tarsHoymilesLastEmail']);
      if (memory.tarsHoymilesLastEmail === String(data.email).trim().toLowerCase()) {
        return { ok: true, skipped: true, reason: 'email_already_created' };
      }

      const result = await runHoymilesAutomation(data);
      if (result.ok) {
        const email = String(data.email).trim().toLowerCase();
        const conversationId = msg.conversation?.conversationId || '';
        const requestedOriginTabId = Number.isInteger(msg.originTabId) ? msg.originTabId : null;
        const hyperflowTabId = requestedOriginTabId || originTabId;

        await chrome.storage.local.set({
          tarsHoymilesLastEmail: email,
          tarsHoymilesLastCreatedAt: new Date().toISOString(),
          tarsHoymilesLastCompany: data.company || '',
          tarsHoymilesLastConversationId: conversationId
        });

        if (conversationId && sender?.tab?.id) {
          const states = await chrome.storage.local.get(['tarsHoymilesStates']);
          const map = states.tarsHoymilesStates || {};
          map[conversationId] = {
            ...(map[conversationId] || {}),
            status: 'ACCOUNT_CREATED',
            email,
            company: data.company || '',
            accountCreated: true,
            accountCreatedAt: new Date().toISOString()
          };
          await chrome.storage.local.set({ tarsHoymilesStates: map });
        }

        if (await automationEmergencyStopped()) return { ok:false, error:'emergency_stopped_after_creation', accountCreated:true };

        const reporting = await sendHoymilesSuccessToHyperflow(
          hyperflowTabId,
          conversationId,
          data
        );

        if (await automationEmergencyStopped()) return { ok:false, error:'emergency_stopped_before_reporting', accountCreated:true };

        let helpPrompt = { ok: false, error: 'no_hyperflow_tab' };
        if (reporting?.ok && hyperflowTabId && conversationId) {
          await new Promise(r => setTimeout(r, 900));
          helpPrompt = await sendHoymilesHelpPromptToHyperflow(hyperflowTabId, conversationId);
        }
        if (helpPrompt?.ok && conversationId) {
          const statesAfterHelp = await chrome.storage.local.get(['tarsHoymilesStates']);
          const helpMap = statesAfterHelp.tarsHoymilesStates || {};
          helpMap[conversationId] = {
            ...(helpMap[conversationId] || {}),
            status: 'AWAITING_HELP_RESPONSE',
            helpPromptSentAt: new Date().toISOString(),
            helpPromptText: 'Por hora, posso auxiliar com algo mais?'
          };
          await chrome.storage.local.set({ tarsHoymilesStates: helpMap });
        }

        const restoreOriginHyperflowTab = async () => {
          const diagnostic = {
            expectedTabId: hyperflowTabId,
            expectedWindowId: originWindowId,
            startedAt: new Date().toISOString(),
            attempts: []
          };
          if (!Number.isInteger(hyperflowTabId)) {
            diagnostic.error = 'no_origin_hyperflow_tab';
            console.warn('[TARS Hoymiles BG] RETURN DEBUG', diagnostic);
            return { ok: false, ...diagnostic };
          }
          let lastError = null;
          for (let attempt = 1; attempt <= 5; attempt++) {
            const step = { attempt };
            try {
              const originTab = await chrome.tabs.get(hyperflowTabId);
              step.tabExists = true;
              step.tabUrl = originTab.url || null;
              step.tabWindowId = originTab.windowId;
              step.tabActiveBefore = !!originTab.active;
              step.windowStateBefore = (await chrome.windows.get(originTab.windowId)).state;

              const targetWindowId = Number.isInteger(originWindowId) ? originWindowId : originTab.windowId;
              step.targetWindowId = targetWindowId;

              try {
                const targetWindow = await chrome.windows.get(targetWindowId);
                step.targetWindowState = targetWindow.state;
                if (targetWindow.state === 'minimized') {
                  await chrome.windows.update(targetWindowId, { state: 'normal', focused: true });
                } else {
                  await chrome.windows.update(targetWindowId, { focused: true });
                }
                step.windowFocused = true;
              } catch (windowError) {
                step.windowFocusError = String(windowError?.message || windowError);
                throw windowError;
              }

              await chrome.tabs.update(hyperflowTabId, { active: true });
              step.tabActivationRequested = true;
              await new Promise(r => setTimeout(r, 200));

              const verify = await chrome.tabs.get(hyperflowTabId);
              const activeTabs = await chrome.tabs.query({ active: true, windowId: targetWindowId });
              step.tabActiveAfter = !!verify.active;
              step.verifiedWindowId = verify.windowId;
              step.activeTabs = activeTabs.map(t => ({ id: t.id, url: t.url || null, active: !!t.active }));
              diagnostic.attempts.push(step);

              if (verify.active && verify.windowId === targetWindowId) {
                diagnostic.ok = true;
                diagnostic.finishedAt = new Date().toISOString();
                console.info('[TARS Hoymiles BG] RETURN DEBUG success', diagnostic);
                return { ok: true, tabId: hyperflowTabId, windowId: targetWindowId, diagnostic };
              }
              lastError = new Error('hyperflow_tab_activation_not_confirmed');
            } catch (error) {
              lastError = error;
              step.error = String(error?.message || error);
              diagnostic.attempts.push(step);
            }
            await new Promise(r => setTimeout(r, 400));
          }
          diagnostic.ok = false;
          diagnostic.error = String(lastError?.message || lastError || 'tab_activation_failed');
          diagnostic.finishedAt = new Date().toISOString();
          console.warn('[TARS Hoymiles BG] RETURN DEBUG failed', diagnostic);
          return { ok: false, error: diagnostic.error, diagnostic };
        };

        const restoreResult = await restoreOriginHyperflowTab();

        const slaWebhook = await reportHoymilesAccountToSlaWebhook({
          data,
          conversationId,
          reporting
        });
        console.info('[TARS SLA] Hoymiles account event', slaWebhook);

        if (conversationId) {
          const states = await chrome.storage.local.get(['tarsHoymilesStates']);
          const map = states.tarsHoymilesStates || {};
          map[conversationId] = {
            ...(map[conversationId] || {}),
            status: helpPrompt?.ok ? 'AWAITING_HELP_RESPONSE' : (reporting.ok ? 'COMPLETED' : 'REPORTING_FAILED'),
            email,
            company: data.company || '',
            accountCreated: true,
            reporting,
            slaWebhook,
            restoreResult,
            completedAt: new Date().toISOString()
          };
          await chrome.storage.local.set({ tarsHoymilesStates: map });
        }

        await chrome.storage.local.remove('tarsHoymilesPending');
        return { ...result, reporting, helpPrompt };
      }
      if (msg.conversation?.conversationId) {
        const states = await chrome.storage.local.get(['tarsHoymilesStates']);
        const map = states.tarsHoymilesStates || {};
        map[msg.conversation.conversationId] = { ...(map[msg.conversation.conversationId] || {}), status: 'FAILED', email: String(data.email).trim().toLowerCase(), failedAt: new Date().toISOString(), error: result.error || 'automation_failed' };
        await chrome.storage.local.set({ tarsHoymilesStates: map });
      }
      setTimeout(() => chrome.storage.local.remove('tarsHoymilesPending').catch(() => {}), 15000);
      return result;
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'HOYMILES_CLEAR_MEMORY') {
    chrome.storage.local.remove([
      'tarsHoymilesLastEmail', 'tarsHoymilesLastCreatedAt',
      'tarsHoymilesLastCompany', 'tarsHoymilesLastConversationId',
      'tarsHoymilesPending'
    ]).then(() => sendResponse({ ok: true }));
    return true;
  }
});

function onStatusBroadcast(status) {
  try { chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS', status }); } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'BRIDGE_VISION') {
    console.info('[bridge] BRIDGE_VISION received', { voice: !!msg.voice, question: !!msg.question });
    (async () => {
      onStatusBroadcast('capturing');
      const shot = await captureActiveTab();
      if (shot.error) return { ok: false, error: shot.error, detail: shot.detail || null };
      return requestVision({ ...shot, question: msg.question || null,
                              voice: !!msg.voice }, onStatusBroadcast);
    })().then(sendResponse);
    return true;
  }

  if (msg && msg.type === 'BRIDGE_VISION_LEGACY') {
    requestVision(msg.payload || {}, status => {
      try { chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS', status }); } catch (e) {}
    }).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'BRIDGE_PING') {
    findAppTab().then(t => sendResponse({ found: !!t }));
    return true;
  }
});
