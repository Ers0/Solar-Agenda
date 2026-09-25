// The relay. Chrome will not let the service worker talk to page JavaScript
// directly, so this script sits in the Solar Agenda tab and passes messages
// across the one boundary that does work: window.postMessage.
//
// It understands nothing about vision, TARS, or the payload's meaning. It
// moves an envelope from one side to the other and correlates the reply.

const CHANNEL = 'tars-bridge';

// Replies are matched by the id the app echoes back, so two requests in flight
// can never be confused for one another.
const waiting = new Map();

function safeRuntimeSendMessage(message) {
  return new Promise(resolve => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        return resolve({ ok: false, error: 'no_chrome_runtime' });
      }
      const p = chrome.runtime.sendMessage(message, response => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          resolve({ ok: false, error: lastErr.message || 'runtime_error' });
        } else {
          resolve(response !== undefined ? response : { ok: true });
        }
      });
      if (p && typeof p.catch === 'function') {
        p.catch(err => resolve({ ok: false, error: err?.message || String(err) }));
      }
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

// ------------------------------------------------- extension -> page ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'TARS_HOYMILES_AI_CLASSIFY_PAGE') {
    (async () => {
      try {
        const prompt = String(msg.prompt || '').trim();
        if (!prompt) return { ok: false, error: 'empty_prompt' };
        const resp = await fetch('/agenda-ai', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [
            { role: 'system', content: 'You are a strict intent classifier for a photovoltaic support workflow. Return ONLY valid JSON with keys intent, confidence, action, reason. intent must be one of HOYMILES_ACCOUNT_CREATION, OTHER_HOYMILES, OTHER. action must be START_HOYMILES_ACCOUNT_FLOW or NO_ACTION. Understand Portuguese and English. Choose HOYMILES_ACCOUNT_CREATION only when the customer wants, needs, lacks, or asks who creates a Hoymiles INSTALLER account. Do not trigger for monitoring, inverter faults, login troubleshooting, app questions, device registration, or generic Hoymiles questions. Confidence is 0 to 1.' },
            { role: 'user', content: prompt }
          ] })
        });
        const raw = await resp.text();
        if (!resp.ok) return { ok: false, error: 'ai_http_' + resp.status, response: raw.slice(0, 1000) };
        let data; try { data = JSON.parse(raw); } catch (_) { return { ok: false, error: 'ai_invalid_transport_json', response: raw.slice(0, 1000) }; }
        const content = data?.message?.content ?? data?.reply ?? data?.content ?? '';
        let parsed; try { parsed = typeof content === 'string' ? JSON.parse(content) : content; } catch (_) {
          const match = String(content).match(/\{[\s\S]*\}/);
          if (match) { try { parsed = JSON.parse(match[0]); } catch (_) {} }
        }
        if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'ai_invalid_classifier_output', raw: String(content).slice(0, 1000) };
        return { ok: true, intent: String(parsed.intent || 'OTHER').toUpperCase(), confidence: Number(parsed.confidence) || 0, action: String(parsed.action || 'NO_ACTION').toUpperCase(), reason: String(parsed.reason || '') };
      } catch (error) { return { ok: false, error: String(error?.message || error) }; }
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg.type !== 'RELAY_TO_APP') return;

  const id = msg.payload && msg.payload.id ? msg.payload.id : String(Math.random());
  waiting.set(id, sendResponse);

  window.postMessage({ channel: CHANNEL, dir: 'to-app', payload: msg.payload }, window.location.origin);

  // Kept open: the app may take a long time to answer, and the service worker
  // is the only place that decides what counts as too long.
  return true;
});

// ------------------------------------------------- page -> extension ---
window.addEventListener('message', ev => {
  // Only this window, only this channel. Anything else is not the bridge.
  if (ev.source !== window) return;
  const m = ev.data;
  if (!m || m.channel !== CHANNEL || m.dir !== 'to-ext') return;

  const p = m.payload || {};

  // A HELLO_ACK carries no id, so it is matched by being the only handshake
  // in flight; everything else is matched on the id the app echoed.
  const key = p.id || [...waiting.keys()].find(k => k.startsWith('hello')) || null;
  const resolve = key !== null ? waiting.get(key) : null;

  if (resolve) {
    waiting.delete(key);
    try { resolve(p); } catch (e) { /* the port closed; nothing to do */ }
  }
});

// Tell the service worker this tab is a live Solar Agenda, so tab discovery
// can prefer a tab that has actually finished loading its script.
safeRuntimeSendMessage({ type: 'RELAY_READY', url: window.location.href });

// Solar Agenda page can request a live Hyperflow sync without knowing anything
// about Chrome extension APIs. The page sends a request over postMessage; this
// isolated content script asks the service worker to read the active Hyperflow
// tab and returns only the sanitized webhook result.
window.addEventListener('message', async ev => {
  if (ev.source !== window) return;
  const m = ev.data;
  if (!m || m.channel !== CHANNEL || m.dir !== 'to-ext' || m.payload?.type !== 'TARS_SLA_SYNC_REQUEST') return;
  const id = m.payload?.id || crypto.randomUUID();
  try {
    const result = await safeRuntimeSendMessage({ type: 'TARS_SLA_SYNC_HYPERFLOW', tabId: null });
    window.postMessage({ channel: CHANNEL, dir: 'to-page', payload: { type: 'TARS_SLA_SYNC_RESULT', id, ...result } }, window.location.origin);
  } catch (error) {
    window.postMessage({ channel: CHANNEL, dir: 'to-page', payload: { type: 'TARS_SLA_SYNC_RESULT', id, ok: false, error: String(error?.message || error) } }, window.location.origin);
  }
});
