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

// ---------------------------------------------------------------- app tab ---

async function findAppTab() {
  const tabs = await chrome.tabs.query({ url: [APP_URL_MATCH, 'http://localhost:3000/*', 'https://*.run.app/*'] });
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


// ------------------------------------------------------------------ capture ---
// ------------------------------------------------------- Hyperflow memory ---

// Hyperflow memory is deliberately NOT part of the Vision critical path.
// The Hyperflow content script is declared in manifest.json and can capture
// independently. A failure there must never prevent the original bridge from
// reaching Solar Agenda.

// The extension captures the BROWSER TAB you are looking at. It cannot see a
// shared window from the app's own screen share — that is a separate stream
// living in the app tab — and it does not need to: for anything outside the
// browser, the app's share is the right tool.

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
  } catch (e) {
    // Page with strict CSP
  }

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
    return { error: 'Torne a aba do Hoymiles ativa primeiro no navegador.' };
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

// --------------------------------------------------- Solar Agenda SLA Webhook ---
const TARS_SLA_WEBHOOK_STORAGE_KEY = 'tarsSlaWebhookUrl';
const DEFAULT_SLA_WEBHOOK_URL = 'https://solar-agenda.vercel.app/api/sla/webhook';

async function getSlaWebhookUrl() {
  const stored = await chrome.storage.local.get([TARS_SLA_WEBHOOK_STORAGE_KEY]);
  return String(stored[TARS_SLA_WEBHOOK_STORAGE_KEY] || DEFAULT_SLA_WEBHOOK_URL).trim();
}

async function reportHoymilesAccountToSlaWebhook({ data, conversationId, reporting }) {
  const url = await getSlaWebhookUrl();
  if (!url) return { ok: false, skipped: true, error: 'sla_webhook_not_configured' };

  const payload = {
    event: 'hoymiles.account.created',
    version: '1.0',
    source: 'tars-vision-bridge',
    bridgeVersion: '1.2.37',
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
      // Do not transmit/store the generated password in the SLA webhook by default.
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
  console.info('[TARS Hoymiles BG] sending HOYMILES_RUN_INSTALLER', { tabId: tab.id });
  const result = await sendToHoymiles(tab.id, { type: 'HOYMILES_RUN_INSTALLER', data });
  console.info('[TARS Hoymiles BG] automation result', result);
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'TARS_SLA_WEBHOOK_SET') {
    (async () => {
      const url = String(msg.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: 'sla_webhook_requires_http_or_https' };
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
      const url = String(msg.url || await getSlaWebhookUrl()).trim();
      if (!url) return { ok: false, error: 'sla_webhook_not_configured' };
      const testData = msg.data || {
        company: 'SolarTech Brasil Teste',
        fullName: 'Eng. Marcelo Rocha',
        email: 'marcelo.solar@teste.com.br',
        phone: '11988776655',
        state: 'São Paulo'
      };
      const result = await reportHoymilesAccountToSlaWebhook({
        data: testData,
        conversationId: 'hyperflow-test-' + Date.now().toString().slice(-4),
        reporting: { ok: true, method: 'manual_extension_test' }
      });
      return result;
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'TARS_GET_SLA_INFO') {
    (async () => {
      const webhookUrl = await getSlaWebhookUrl();
      const mem = await chrome.storage.local.get([
        'tarsHoymilesLastEmail',
        'tarsHoymilesLastCreatedAt',
        'tarsHoymilesLastCompany',
        'tarsHoymilesLastConversationId'
      ]);
      return {
        ok: true,
        webhookUrl,
        defaultWebhookUrl: DEFAULT_SLA_WEBHOOK_URL,
        version: '1.2.37',
        lastCreated: {
          email: mem.tarsHoymilesLastEmail || null,
          company: mem.tarsHoymilesLastCompany || null,
          createdAt: mem.tarsHoymilesLastCreatedAt || null,
          conversationId: mem.tarsHoymilesLastConversationId || null
        }
      };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (msg && msg.type === 'OPEN_SOLAR_AGENDA_SLA') {
    (async () => {
      let tab = await findAppTab();
      if (tab) {
        chrome.tabs.update(tab.id, { active: true });
        chrome.tabs.sendMessage(tab.id, { type: 'NAVIGATE_VIEW', view: 'sla' }, () => {});
        return { ok: true, opened: false, focused: true };
      }
      const newTab = await chrome.tabs.create({ url: APP_ORIGIN + '#view-sla', active: true });
      return { ok: true, opened: true, tabId: newTab.id };
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
    console.info('[TARS Hoymiles BG] CREATE_REQUEST received', {
      conversationId: msg.conversation?.conversationId || null,
      email: msg.data?.email || null,
      company: msg.data?.company || null,
      state: msg.data?.state || null
    });
    (async () => {
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

        const reporting = await sendHoymilesSuccessToHyperflow(
          sender?.tab?.id,
          conversationId,
          data
        );

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
            status: reporting.ok ? 'COMPLETED' : 'REPORTING_FAILED',
            email,
            company: data.company || '',
            accountCreated: true,
            reporting,
            slaWebhook,
            completedAt: new Date().toISOString()
          };
          await chrome.storage.local.set({ tarsHoymilesStates: map });
        }

        await chrome.storage.local.remove('tarsHoymilesPending');
        return { ...result, reporting, slaWebhook };
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
