// TARS Vision Bridge Popup Controller (v1.2.37)
// Provides SLA Webhook configuration & testing, Hoymiles Lab actions, and Vision capture.

const DEFAULT_SLA_WEBHOOK_URL = 'https://solar-agenda.vercel.app/api/sla/webhook';

// UI Elements
const slaStatusEl = document.getElementById('slaStatus');
const labStatusEl = document.getElementById('labStatus');
const visionStatusEl = document.getElementById('visionStatus');

const slaWebhookUrlInput = document.getElementById('slaWebhookUrl');
const btnSaveSlaUrl = document.getElementById('btnSaveSlaUrl');
const btnResetSlaUrl = document.getElementById('btnResetSlaUrl');
const btnTestSlaPing = document.getElementById('btnTestSlaPing');
const btnClearHoymilesMemory = document.getElementById('btnClearHoymilesMemory');
const btnOpenSolarAgenda = document.getElementById('btnOpenSolarAgenda');

const infoLastEmail = document.getElementById('infoLastEmail');
const infoLastCompany = document.getElementById('infoLastCompany');
const infoLastDate = document.getElementById('infoLastDate');
const slaWebhookStatusText = document.getElementById('slaWebhookStatusText');

// ------------------------------------------------------------- Tabs Navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const targetId = btn.getAttribute('data-tab');
    const targetContent = document.getElementById(targetId);
    if (targetContent) targetContent.classList.add('active');
  });
});

// ------------------------------------------------------------- Helper Logger
function showSla(msg, isError = false, isOk = false) {
  if (!slaStatusEl) return;
  slaStatusEl.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  slaStatusEl.className = 'log-box' + (isError ? ' err' : isOk ? ' ok' : '');
}

function showLab(msg, isError = false) {
  if (!labStatusEl) return;
  labStatusEl.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  labStatusEl.className = 'log-box' + (isError ? ' err' : '');
}

function showVision(msg, isError = false) {
  if (!visionStatusEl) return;
  visionStatusEl.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  visionStatusEl.className = 'log-box' + (isError ? ' err' : '');
}

// --------------------------------------------------- Load SLA Webhook & Info
async function loadSlaInfo() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TARS_GET_SLA_INFO' });
    if (res && res.ok) {
      if (slaWebhookUrlInput) slaWebhookUrlInput.value = res.webhookUrl || DEFAULT_SLA_WEBHOOK_URL;
      const last = res.lastCreated || {};
      if (infoLastEmail) infoLastEmail.textContent = last.email || 'Nenhuma criada ainda';
      if (infoLastCompany) infoLastCompany.textContent = last.company || '—';
      if (infoLastDate) {
        infoLastDate.textContent = last.createdAt
          ? new Date(last.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
          : '—';
      }
    }
  } catch (err) {
    console.warn('[popup] could not load SLA info', err);
  }
}

// -------------------------------------------------- SLA Webhook Action Buttons
if (btnSaveSlaUrl) {
  btnSaveSlaUrl.addEventListener('click', async () => {
    const url = (slaWebhookUrlInput.value || '').trim();
    if (!url) {
      showSla('Por favor, informe uma URL válida para o Webhook SLA.', true);
      return;
    }
    btnSaveSlaUrl.disabled = true;
    showSla('Salvando endpoint SLA...');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'TARS_SLA_WEBHOOK_SET', url });
      if (r && r.ok) {
        showSla(`✓ Endpoint SLA salvo com sucesso:\n${r.url}`, false, true);
      } else {
        showSla(r?.error || 'Erro ao salvar endpoint.', true);
      }
    } catch (e) {
      showSla(String(e?.message || e), true);
    } finally {
      btnSaveSlaUrl.disabled = false;
    }
  });
}

if (btnResetSlaUrl) {
  btnResetSlaUrl.addEventListener('click', async () => {
    if (slaWebhookUrlInput) slaWebhookUrlInput.value = DEFAULT_SLA_WEBHOOK_URL;
    try {
      await chrome.runtime.sendMessage({ type: 'TARS_SLA_WEBHOOK_SET', url: DEFAULT_SLA_WEBHOOK_URL });
      showSla(`✓ Endpoint restaurado para o padrão Solar Agenda:\n${DEFAULT_SLA_WEBHOOK_URL}`, false, true);
    } catch (e) {
      showSla(String(e?.message || e), true);
    }
  });
}

if (btnTestSlaPing) {
  btnTestSlaPing.addEventListener('click', async () => {
    btnTestSlaPing.disabled = true;
    showSla('Disparando evento de teste para o Webhook SLA do Solar Agenda...');
    const url = (slaWebhookUrlInput.value || '').trim();

    try {
      const started = Date.now();
      const r = await chrome.runtime.sendMessage({
        type: 'TARS_SLA_WEBHOOK_TEST',
        url
      });
      const elapsed = Date.now() - started;

      if (r && r.ok) {
        showSla(
          `✓ SUCESSO: Webhook SLA respondeu com HTTP ${r.status || 200} (${elapsed}ms)!\n\n` +
          `Evento enviado: hoymiles.account.created\n` +
          `Resposta Solar Agenda:\n${r.response || '(OK)'}`,
          false,
          true
        );
      } else {
        showSla(
          `❌ FALHA AO ALCANÇAR WEBHOOK SLA (${elapsed}ms):\n` +
          `${r?.error || 'Sem resposta do servidor'}\n\n` +
          `URL testada: ${r?.url || url}\n` +
          `Dica: Verifique se o Solar Agenda está aberto ou publique a rota na Vercel.`,
          true
        );
      }
    } catch (e) {
      showSla(`Erro na extensão: ${String(e?.message || e)}`, true);
    } finally {
      btnTestSlaPing.disabled = false;
    }
  });
}

if (btnClearHoymilesMemory) {
  btnClearHoymilesMemory.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'HOYMILES_CLEAR_MEMORY' });
      if (infoLastEmail) infoLastEmail.textContent = 'Memória limpa';
      if (infoLastCompany) infoLastCompany.textContent = '—';
      if (infoLastDate) infoLastDate.textContent = '—';
      showSla('✓ Memória de emails criados foi limpa. Você pode testar a automação novamente para o mesmo email.');
    } catch (e) {
      showSla(String(e?.message || e), true);
    }
  });
}

if (btnOpenSolarAgenda) {
  btnOpenSolarAgenda.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'OPEN_SOLAR_AGENDA_SLA' });
    } catch (e) {
      window.open('https://solar-agenda.vercel.app', '_blank');
    }
  });
}

// ------------------------------------------------------- Hoymiles Lab Handlers
const labButtons = [
  'inspect', 'ping', 'org', 'add', 'parent', 'name', 'type',
  'country', 'region', 'contact', 'contactNumber', 'address', 'intro'
];

async function sendLabAction(type) {
  const allBtns = labButtons.map(id => document.getElementById(id)).filter(Boolean);
  allBtns.forEach(b => b.disabled = true);
  showLab(`Executando ${type}...`);
  try {
    const r = await chrome.runtime.sendMessage({ type });
    if (!r) {
      showLab('Sem resposta da extensão.', true);
      return;
    }
    showLab(r.ok ? (r.message || r) : (r.error || r), !r.ok);
  } catch (e) {
    showLab(String(e?.message || e), true);
  } finally {
    allBtns.forEach(b => b.disabled = false);
  }
}

const actionMap = {
  inspect: 'HOYMILES_TEST_INSPECT',
  ping: 'HOYMILES_TEST_PING',
  org: 'HOYMILES_TEST_ORG',
  add: 'HOYMILES_TEST_ADD_ORG',
  parent: 'HOYMILES_TEST_PARENT',
  name: 'HOYMILES_TEST_NAME',
  type: 'HOYMILES_TEST_TYPE',
  country: 'HOYMILES_TEST_COUNTRY',
  region: 'HOYMILES_TEST_REGION',
  contact: 'HOYMILES_TEST_CONTACT',
  contactNumber: 'HOYMILES_TEST_CONTACT_NUMBER',
  address: 'HOYMILES_TEST_ADDRESS',
  intro: 'HOYMILES_TEST_INTRO'
};

Object.entries(actionMap).forEach(([btnId, actionType]) => {
  const el = document.getElementById(btnId);
  if (el) el.addEventListener('click', () => sendLabAction(actionType));
});

// --------------------------------------------------------------- Vision Bridge
const btnAskVision = document.getElementById('btnAskVision');
const visionQuestionInput = document.getElementById('visionQuestion');

if (btnAskVision) {
  btnAskVision.addEventListener('click', async () => {
    btnAskVision.disabled = true;
    showVision('Capturando aba e transmitindo ao Solar Agenda...');
    try {
      const q = (visionQuestionInput?.value || '').trim();
      const r = await chrome.runtime.sendMessage({
        type: 'BRIDGE_VISION',
        question: q || null
      });
      if (r && r.ok) {
        showVision('✓ Análise enviada ao Solar Agenda! A aba do Solar Agenda foi focada.');
      } else {
        showVision(r?.error || 'Erro na comunicação de visão.', true);
      }
    } catch (e) {
      showVision(String(e?.message || e), true);
    } finally {
      btnAskVision.disabled = false;
    }
  });
}

// Initialize on open
loadSlaInfo();
