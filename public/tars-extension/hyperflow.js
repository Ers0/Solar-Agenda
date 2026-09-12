// Hyperflow conversation capture layer for TARS Vision Bridge.
// Purpose: persist messages while they exist in Hyperflow's DOM so virtualized
// messages remain available to Solar Agenda/TARS later in the day.
//
// This file deliberately contains no network calls and no AI logic.
// It uses IndexedDB in the Hyperflow origin and exposes a tiny runtime-message
// API to the extension background service worker.

(() => {
  if (window.__tarsHyperflowCapture) return;
  window.__tarsHyperflowCapture = true;
  console.info('[TARS Hyperflow] real capture script injected', '1.2.37', location.href);
  try { document.documentElement.dataset.tarsHyperflowCapture = 'active'; } catch (_) {}

  const DB_NAME = 'tars-hyperflow-memory';
  const DB_VERSION = 2;
  const STORE_CONVERSATIONS = 'conversations';
  const STORE_MESSAGES = 'messages';
  const STORE_ATTACHMENTS = 'attachments';
  const MAX_TEXT = 12000;
  const MAX_CONTEXT_MESSAGES = 2500;
  const SCAN_DEBOUNCE_MS = 250;
  const DEBUG_PREFIX = '[TARS DEBUG]';
  let debugScanCount = 0;

  function debugSnapshot(stage, data = {}) {
    try {
      console.groupCollapsed(`${DEBUG_PREFIX} ${stage}`);
      console.log({
        version: '1.2.37',
        href: location.href,
        scan: debugScanCount,
        ...data
      });
      console.groupEnd();
    } catch (_) {}
  }

  // Expose a read-only diagnostic helper in the Hyperflow content-script console.
  // It does not send data anywhere; it only inspects the current page.
  window.TARS_DEBUG_HOYMILES = () => {
    const candidates = collectMessageCandidates(document);
    const conversation = (() => { try { return findConversationIdentity(); } catch (e) { return { error: String(e?.message || e) }; } })();
    const messages = candidates.map(el => {
      try {
        const m = extractHyperflowMessage(el, conversation);
        return {
          direction: m?.direction || null,
          text: m?.text || null,
          itemIndex: m?.itemIndex ?? null,
          explicitId: m?.explicitId || null,
          classes: el.className || null
        };
      } catch (e) { return { error: String(e?.message || e), classes: el.className || null }; }
    });
    const result = {
      version: '1.2.37',
      url: location.href,
      boot: document.documentElement?.dataset?.tarsHyperflowBoot || null,
      capture: document.documentElement?.dataset?.tarsHyperflowCapture || null,
      messageListFound: !!messageListRoot(document),
      candidateCount: candidates.length,
      conversation,
      messages,
      hoymilesIntentExamples: messages.filter(m => /hoymiles/i.test(m.text || '')).map(m => m.text)
    };
    console.group(`${DEBUG_PREFIX} HOYMILES DIAGNOSTIC`);
    console.table(messages);
    console.log(result);
    console.groupEnd();
    return result;
  };

  let dbPromise = null;
  let observer = null;
  let scanTimer = null;
  let activeConversation = null;
  let sequenceCache = new Map();
  let lastLoggedConversationId = null;
  let lastLoggedCount = 0;
  // Prevent overlapping MutationObserver scans from evaluating the same
  // Hoymiles conversation concurrently. The persistent state below is the
  // durable guard across page reloads.
  const hoymilesProcessing = new Set();
  // Runtime state is the immediate guard; chrome.storage.local is the durable backup.
  // Hyperflow can re-render the message tree while an async send is still in flight,
  // so relying only on storage can allow the same trigger to be seen again.
  const hoymilesRuntimeState = new Map();
  const hoymilesRuntimeFormRequested = new Map();

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // v2 replaces the old generic heuristic records. The old parser could
        // persist UI/container text, so keeping those rows would poison TARS
        // even after the extractor is fixed. Conversation metadata is retained.
        if (req.oldVersion < 2) {
          if (db.objectStoreNames.contains(STORE_MESSAGES)) db.deleteObjectStore(STORE_MESSAGES);
          if (db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.deleteObjectStore(STORE_ATTACHMENTS);
        }
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          const s = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'conversationId' });
          s.createIndex('updatedAt', 'updatedAt');
          s.createIndex('customerId', 'customerId');
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const s = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
          s.createIndex('conversationId', 'conversationId');
          s.createIndex('sequence', ['conversationId', 'sequence']);
          s.createIndex('fingerprint', 'fingerprint');
        }
        if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) {
          const s = db.createObjectStore(STORE_ATTACHMENTS, { keyPath: 'id' });
          s.createIndex('conversationId', 'conversationId');
          s.createIndex('messageId', 'messageId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode = 'readonly') {
    return openDb().then(db => db.transaction(store, mode).objectStore(store));
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getConversation(id) {
    return request((await tx(STORE_CONVERSATIONS)).get(id));
  }

  async function putConversation(value) {
    return request((await tx(STORE_CONVERSATIONS, 'readwrite')).put(value));
  }

  async function putMessage(value) {
    return request((await tx(STORE_MESSAGES, 'readwrite')).put(value));
  }

  async function getAllMessages(conversationId) {
    const store = await tx(STORE_MESSAGES);
    const idx = store.index('conversationId');
    return request(idx.getAll(conversationId));
  }

  async function getAllConversations() {
    return request((await tx(STORE_CONVERSATIONS)).getAll());
  }

  async function sha256(text) {
    if (!crypto.subtle) return simpleHash(text);
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function simpleHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function cleanText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function stableAttribute(el, names) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    for (const name of names) {
      const value = el.getAttribute(name);
      if (value && value.length < 300) return value.trim();
    }
    return null;
  }

  // Hyperflow exposes a stable message wrapper and a virtualized message list.
  // Use those structures directly instead of generic DOM heuristics.
  function findStableId(root) {
    const own = stableAttribute(root, [
      'data-message-id', 'data-messageid', 'data-id', 'data-key',
      'data-conversation-id', 'data-chat-id', 'data-contact-id'
    ]);
    if (own) return own;

    const domId = root?.id || '';
    if (/^message-wamid\./i.test(domId)) return domId;

    const descendant = root.querySelector?.(
      '[data-message-id],[data-messageid],[data-conversation-id],[data-chat-id],[data-contact-id]'
    );
    return descendant ? stableAttribute(descendant, [
      'data-message-id', 'data-messageid', 'data-conversation-id', 'data-chat-id', 'data-contact-id'
    ]) : null;
  }

  function findPhone(text) {
    const m = String(text || '').match(/(?:\+?\d[\d ()-]{8,}\d)/);
    return m ? m[0].replace(/\D/g, '') : null;
  }

  function findConversationIdentity() {
    const activeChat = document.querySelector('.chat-item.active');
    const protocolClass = [...(activeChat?.classList || [])].find(c => /^protocol-/.test(c));
    const protocol = protocolClass ? protocolClass.slice('protocol-'.length) : null;

    const nameEl = document.querySelector('.chat-user');
    const phoneEl = document.querySelector('.chat-user-phone');
    const customerName = cleanText(nameEl?.innerText || '') || null;
    const phone = cleanText(phoneEl?.innerText || '') || findPhone(customerName);
    const departmentEl = [...document.querySelectorAll('[aria-label^="Departamento:" i]')]
      .find(visible);
    const channelEl = document.querySelector('[aria-label^="Canal:" i]');
    const department = departmentEl ? cleanText(departmentEl.getAttribute('aria-label')).replace(/^Departamento:\s*/i, '') : null;
    const channel = channelEl ? cleanText(channelEl.getAttribute('aria-label')).replace(/^Canal:\s*/i, '') : null;
    const url = location.href;

    const activeChatId = stableAttribute(activeChat, [
      'data-conversation-id', 'data-chat-id', 'data-contact-id',
      'data-ticket-id', 'data-id', 'data-key', 'data-protocol', 'data-wamid'
    ]);
    const activeChatHref = activeChat?.querySelector?.('a[href]')?.getAttribute('href') ||
      activeChat?.closest?.('a[href]')?.getAttribute('href') || null;

    const routeChatId = location.pathname.match(/\/chats\/([^/?#]+)/i)?.[1] || null;
    const stableChatIdentity = activeChatId
      ? `chat:${activeChatId}`
      : activeChatHref
        ? `href:${activeChatHref}`
        : routeChatId
          ? `route:${routeChatId}`
          : null;

    const identity = protocol || phone || stableChatIdentity || customerName || url;
    const confidence = protocol
      ? 'high'
      : phone
        ? 'medium'
        : stableChatIdentity
          ? 'medium'
          : customerName
            ? 'low'
            : 'low';
    const identitySource = protocol
      ? 'protocol'
      : phone
        ? 'phone'
        : stableChatIdentity
          ? 'active-chat'
          : customerName
            ? 'header'
            : 'url';
    const conversationId = `hyperflow:${simpleHash(`${location.origin}|${identity}`)}`;

    return {
      conversationId,
      customerId: phone || null,
      customerName,
      ticketId: protocol || null,
      department,
      channel,
      url,
      identitySource,
      identityConfidence: confidence,
      identityRaw: identity,
      activeChatId: activeChatId || null,
      activeChatHref: activeChatHref || null
    };
  }

  function messageListRoot(root = document) {
    return root.querySelector?.('.list-messages[data-testid="virtuoso-scroller"]')
      || root.querySelector?.('.list-messages')
      || null;
  }

  function collectMessageCandidates(root = document) {
    const list = messageListRoot(root);

    const globalWrappers = [...root.querySelectorAll('.message-out-wrapper, .message-in-wrapper')]
      .filter(visible);
    if (globalWrappers.length) return [...new Set(globalWrappers)];

    if (!list) return [];

    const items = [...list.querySelectorAll('[data-testid="virtuoso-item-list"] [data-index], [data-testid="virtuoso-item-list"] [data-item-index], [data-index], [data-item-index]')];
    const candidates = [];
    for (const item of items) {
      const wrapper = item.querySelector('.message-out-wrapper, .message-in-wrapper');
      if (!wrapper || !visible(wrapper)) continue;
      candidates.push(wrapper);
    }
    return [...new Set(candidates)];
  }

  function messageItemIndex(el) {
    const item = el.closest('[data-index][data-item-index], [data-index], [data-item-index]');
    const raw = item?.getAttribute('data-item-index') ?? item?.getAttribute('data-index');
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function extractHyperflowMessage(el, conversation) {
    const outgoing = el.classList.contains('message-out-wrapper');
    const incoming = el.classList.contains('message-in-wrapper');
    if (!outgoing && !incoming) return null;

    const isTimestampText = value => {
      const v = cleanText(value || '');
      return /^(?:today|yesterday|hoje|ontem)?\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+\d{1,2}:\d{2}$/i.test(v)
        || /^\d{1,2}:\d{2}$/.test(v);
    };

    const preferred = [
      ...el.querySelectorAll('[data-message-text], .message-text'),
      ...el.querySelectorAll('.sc-fjvvzt p'),
      ...el.querySelectorAll('.sc-fjvvzt'),
      ...el.querySelectorAll('p')
    ];
    const content = [...new Set(preferred)]
      .filter(node => visible(node))
      .map(node => ({ node, text: cleanText(node.innerText || node.textContent || '') }))
      .filter(x => x.text && !isTimestampText(x.text))
      .sort((a, b) => b.text.length - a.text.length)[0]?.node;
    if (!content) return null;

    let text = cleanText(content.innerText || content.textContent || '');
    let sender = null;

    if (outgoing) {
      const strong = content.querySelector('strong');
      const strongText = cleanText(strong?.innerText || strong?.textContent || '');
      sender = strongText || null;
      if (strongText) {
        const raw = String(content.innerText || content.textContent || '');
        const prefix = new RegExp(`^\\s*${strongText.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*:\\s*`, 'i');
        text = cleanText(raw.replace(prefix, ''));
      }
    } else {
      sender = conversation.customerName || 'customer';
    }

    if (!text || isTimestampText(text) || /^(Você|Responder|Continuar atendimento)$/i.test(text)) return null;

    const timestampEl = outgoing
      ? el.querySelector('p.css-i4e46s')
      : el.querySelector('p.css-1wlknvx');
    const timestamp = cleanText(timestampEl?.innerText || '');
    const explicitId = findStableId(el);
    const itemIndex = messageItemIndex(el);

    return {
      explicitId,
      itemIndex,
      direction: outgoing ? 'outgoing' : 'incoming',
      sender,
      speaker: outgoing ? 'agent' : 'customer',
      text,
      timestamp,
      attachments: extractAttachments(el)
    };
  }

  function extractAttachments(el) {
    return [...el.querySelectorAll?.('a[href],img[src],video[src],audio[src]') || []]
      .map(node => {
        const source = node.getAttribute('href') || node.getAttribute('src');
        if (!source) return null;
        return {
          filename: node.getAttribute('download') || node.getAttribute('title') || null,
          mimeType: node.getAttribute('type') || null,
          source,
          kind: node.tagName.toLowerCase()
        };
      }).filter(Boolean).slice(0, 20);
  }

  async function captureElement(el, conversation) {
    const parsed = extractHyperflowMessage(el, conversation);
    if (!parsed) return null;

    const { explicitId, itemIndex, direction, sender, speaker, text, timestamp, attachments } = parsed;
    const fingerprintBase = [
      conversation.conversationId,
      explicitId || '',
      direction,
      text
    ].join('|');
    const fingerprint = await sha256(fingerprintBase);
    const id = explicitId ? `msg:${simpleHash(`${conversation.conversationId}|${explicitId}`)}` : `msg:${fingerprint}`;

    const existing = await request((await tx(STORE_MESSAGES)).get(id));
    if (existing) return { stored: false, duplicate: true, message: existing };

    let sequence = itemIndex;
    if (!Number.isFinite(sequence)) {
      sequence = (sequenceCache.get(conversation.conversationId) || 0) + 1;
    }
    const previousSeq = sequenceCache.get(conversation.conversationId) || 0;
    sequenceCache.set(conversation.conversationId, Math.max(previousSeq, sequence));

    const message = {
      id,
      conversationId: conversation.conversationId,
      sequence,
      speaker,
      sender,
      direction,
      text,
      timestamp,
      capturedAt: new Date().toISOString(),
      source: 'hyperflow-dom-v2',
      explicitMessageId: explicitId,
      virtualItemIndex: itemIndex,
      fingerprint,
      attachments
    };

    await putMessage(message);
    for (const a of attachments) {
      const aid = `att:${await sha256(`${id}|${a.source}|${a.filename || ''}`)}`;
      await request((await tx(STORE_ATTACHMENTS, 'readwrite')).put({
        id: aid,
        conversationId: conversation.conversationId,
        messageId: id,
        ...a,
        status: 'PENDING',
        capturedAt: new Date().toISOString()
      }));
    }

    return { stored: true, duplicate: false, message };
  }

  async function scan() {
    scanTimer = null;
    debugScanCount++;
    try {
      const conversation = findConversationIdentity();
      const changedConversation = !activeConversation || activeConversation.conversationId !== conversation.conversationId;
      activeConversation = conversation;

      const previous = await getConversation(conversation.conversationId);
      await putConversation({
        ...(previous || {}),
        ...conversation,
        startedAt: previous?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenUrl: location.href
      });

      if (!sequenceCache.has(conversation.conversationId)) {
        const messages = await getAllMessages(conversation.conversationId);
        sequenceCache.set(conversation.conversationId, messages.reduce((n, m) => Math.max(n, Number(m.sequence) || 0), 0));
      }

      const candidates = collectMessageCandidates(document);
      debugSnapshot('scan', {
        messageListFound: !!messageListRoot(document),
        rawIncomingWrappers: document.querySelectorAll('.list-messages .message-in-wrapper').length,
        rawOutgoingWrappers: document.querySelectorAll('.list-messages .message-out-wrapper').length,
        candidateCount: candidates.length,
        conversationId: conversation.conversationId,
        customerName: conversation.customerName,
        phone: conversation.customerId,
        activeChat: !!document.querySelector('.chat-item.active')
      });
      const stored = [];
      for (const el of candidates) {
        const result = await captureElement(el, conversation);
        if (result?.stored) stored.push(result.message);
      }

      if (changedConversation || stored.length > 0) {
        console.info('[TARS Hyperflow] conversation scan', {
          conversationId: conversation.conversationId,
          identitySource: conversation.identitySource,
          identityConfidence: conversation.identityConfidence,
          customerName: conversation.customerName,
          capturedNow: stored.length,
          candidateCount: candidates.length
        });
      }

      const allMessages = await getAllMessages(conversation.conversationId);
      const domMessages = candidates
        .map(el => extractHyperflowMessage(el, conversation))
        .filter(Boolean);
      debugSnapshot('messages', {
        indexedDbCount: allMessages.length,
        domCount: domMessages.length,
        incoming: domMessages.filter(m => m.direction === 'incoming').map(m => m.text).slice(-10),
        outgoing: domMessages.filter(m => m.direction === 'outgoing').map(m => m.text).slice(-5)
      });
      const triggerMessages = [...allMessages];
      for (const msg of domMessages) {
        if (!triggerMessages.some(existing => existing.id === msg.id || (existing.text === msg.text && existing.direction === msg.direction && existing.sequence === msg.sequence))) {
          triggerMessages.push(msg);
        }
      }
      const liveIncoming = triggerMessages.filter(m => m?.direction === 'incoming').at(-1);
      if (liveIncoming && /hoymiles/i.test(liveIncoming.text || '')) {
        console.info('[TARS Hoymiles] live incoming candidate', {
          text: liveIncoming.text,
          conversationId: conversation.conversationId,
          source: domMessages.some(m => m?.text === liveIncoming.text) ? 'dom' : 'indexeddb'
        });
      }
      debugSnapshot('hoymiles trigger input', {
        latestIncoming: triggerMessages.filter(m => m?.direction === 'incoming').at(-1)?.text || null,
        triggerMessageCount: triggerMessages.length,
        hoymilesMessages: triggerMessages.filter(m => /hoymiles/i.test(m?.text || '')).map(m => ({ direction: m.direction, text: m.text, sequence: m.sequence })).slice(-10)
      });
      await maybeStartHoymilesConversation(conversation, triggerMessages);

      return {
        ok: true,
        changedConversation,
        conversation,
        capturedNow: stored.length,
        candidateCount: candidates.length
      };
    } catch (error) {
      console.warn('[TARS Hyperflow] scan failed', error);
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => scan(), SCAN_DEBOUNCE_MS);
  }

  async function getContext(options = {}) {
    const conversation = findConversationIdentity();
    activeConversation = conversation;

    await scan();

    const all = await getAllMessages(conversation.conversationId);
    all.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    const limit = Math.max(1, Math.min(Number(options.limit) || MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES));
    const messages = all.slice(-limit);

    return {
      id: conversation.conversationId,
      customerId: conversation.customerId,
      customerName: conversation.customerName,
      ticketId: conversation.ticketId,
      url: conversation.url,
      identitySource: conversation.identitySource,
      identityConfidence: conversation.identityConfidence,
      messageCount: all.length,
      complete: messages.length === all.length,
      messages,
      capturedAt: new Date().toISOString()
    };
  }

  async function listConversations() {
    const rows = await getAllConversations();
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // ----------------------------------------------------------- Hoymiles trigger ---
  const HOYMILES_INTENT_RE = /(?:\b(?:criar|crie|quero|preciso|gostaria|precisamos|podem|pode|posso)\b.{0,80}\bconta\b.{0,40}\bhoymiles\b|\bconta\s+(?:da\s+)?hoymiles\b|\b(?:i\s+want|i\s+need|i\s+would\s+like)\b.{0,80}\b(?:create|open)\b.{0,40}\bhoymiles\b.{0,40}\baccount\b)/i;
  const HOYMILES_FORM_TEXT = `Para criarmos sua conta Hoymiles, preciso das seguintes informações:\n\nNome da empresa:\nNome completo:\nE-mail:\nTelefone para contato:\nEstado:`;

  const normalizeHoymilesBotText = text => String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const HOYMILES_FORM_FINGERPRINT = normalizeHoymilesBotText(HOYMILES_FORM_TEXT);
  const isHoymilesBotForm = text => normalizeHoymilesBotText(text) === HOYMILES_FORM_FINGERPRINT;

  function parseHoymilesFields(messages, seed = {}) {
    const result = {
      company: seed.company || null,
      fullName: seed.fullName || null,
      email: seed.email || null,
      phone: seed.phone || null,
      state: seed.state || null,
    };

    const labels = [
      ['company', 'Nome da empresa'],
      ['fullName', 'Nome completo'],
      ['email', 'E-mail'],
      ['phone', 'Telefone para contato'],
      ['state', 'Estado']
    ];
    const labelAlternation = labels.map(([, label]) =>
      label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('|');

    const normalizeResponse = text => String(text || '')
      .replace(/\\([:;,!?])/g, '$1')
      .replace(/\r/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const cleanParsedValue = (value, key) => {
      let v = String(value || '')
        .replace(/^[:\-\s]+/, '')
        .replace(/[\s,;]+$/, '')
        .trim();
      if (key === 'email') {
        const md = v.match(/^\[([^\]]+)\]\(mailto:\s*([^\)]+)\)$/i);
        if (md) v = md[1].trim();
        v = v.replace(/^mailto:\s*/i, '').trim();
      }
      if (key === 'state') v = v.replace(/^[:\-\s]+/, '').trim();
      return v || null;
    };

    function extract(text, key, label) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '(?:^|\\s)' + escaped + '\\s*:?\\s*(.*?)(?=(?:\\s|^)(' + labelAlternation + ')\\s*:?\\s*|$)',
        'i'
      );
      const m = text.match(re);
      return cleanParsedValue(m?.[1], key);
    }

    const incoming = messages.filter(m => m?.direction === 'incoming')
      .map(m => normalizeResponse(m.text))
      .filter(Boolean)
      .filter(text => !isHoymilesBotForm(text));

    for (const text of incoming) {
      for (const [key, label] of labels) {
        const value = extract(text, key, label);
        if (value && !result[key]) result[key] = value;
      }
    }

    console.info('[TARS Hoymiles DEBUG] parsed customer fields', {
      messages: incoming.length,
      company: result.company,
      fullName: result.fullName,
      email: result.email,
      phone: result.phone,
      state: result.state
    });
    return result;
  }

  function hoymilesDataComplete(data) {
    return !!(
      data?.company &&
      data?.fullName &&
      data?.email &&
      data?.phone &&
      data?.state &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(data.email).trim())
    );
  }

  async function getLastHoymilesMemory() {
    return new Promise(resolve => chrome.storage.local.get([
      'tarsHoymilesLastEmail',
      'tarsHoymilesLastCreatedAt',
      'tarsHoymilesLastCompany',
      'tarsHoymilesLastConversationId'
    ], resolve));
  }

  async function clearHoymilesFormRequested(conversationId) {
    const stored = await chrome.storage.local.get('tarsHoymilesFormRequested');
    const map = stored?.tarsHoymilesFormRequested || {};
    delete map[conversationId];
    await chrome.storage.local.set({ tarsHoymilesFormRequested: map });
    return true;
  }

  async function getHoymilesFormRequested(conversationId) {
    if (hoymilesRuntimeFormRequested.has(conversationId)) return true;
    return new Promise(resolve => chrome.storage.local.get(['tarsHoymilesFormRequested'], r => {
      resolve(!!(r.tarsHoymilesFormRequested || {})[conversationId]);
    }));
  }

  async function markHoymilesFormRequested(conversationId, triggerMessageKey) {
    hoymilesRuntimeFormRequested.set(conversationId, {
      at: new Date().toISOString(),
      triggerMessageKey: triggerMessageKey || null
    });
    return new Promise(resolve => chrome.storage.local.get(['tarsHoymilesFormRequested'], r => {
      const map = r.tarsHoymilesFormRequested || {};
      map[conversationId] = {
        at: new Date().toISOString(),
        triggerMessageKey: triggerMessageKey || null
      };
      chrome.storage.local.set({ tarsHoymilesFormRequested: map }, resolve);
    }));
  }

  async function getHoymilesState(conversationId) {
    const runtime = hoymilesRuntimeState.get(conversationId);
    if (runtime) return runtime;
    return new Promise(resolve => chrome.storage.local.get(['tarsHoymilesStates'], r => {
      const stored = (r.tarsHoymilesStates || {})[conversationId];
      const state = stored || { status: 'NONE' };
      hoymilesRuntimeState.set(conversationId, state);
      resolve(state);
    }));
  }

  async function setHoymilesState(conversationId, patch) {
    const current = hoymilesRuntimeState.get(conversationId) || { status: 'NONE' };
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    hoymilesRuntimeState.set(conversationId, next);
    return new Promise(resolve => chrome.storage.local.get(['tarsHoymilesStates'], r => {
      const states = r.tarsHoymilesStates || {};
      states[conversationId] = next;
      chrome.storage.local.set({ tarsHoymilesStates: states }, resolve);
    }));
  }

  async function sendHyperflowReply(text, conversationId) {
    debugSnapshot('send information request start', { conversationId, text });
    try {
      const result = await sendReplyToComposer(text);
      debugSnapshot('send information request result', result);
      return result;
    } catch (error) {
      const result = { ok: false, error: String(error?.message || error) };
      debugSnapshot('send information request result', result);
      return result;
    }
  }

  async function processHoymilesData(conversation, incoming, state) {
    if (state.status !== 'WAITING_FOR_DATA') return false;

    const collected = state.collectedData || {};
    const data = parseHoymilesFields(incoming, collected);

    const partialPatch = {
      collectedData: {
        company: data.company || null,
        fullName: data.fullName || null,
        email: data.email || null,
        phone: data.phone || null,
        state: data.state || null,
      }
    };

    if (!hoymilesDataComplete(data)) {
      if (Object.values(partialPatch.collectedData).some(Boolean)) {
        await setHoymilesState(conversation.conversationId, partialPatch);
        console.info('[TARS Hoymiles DEBUG] partial data collected', {
          conversationId: conversation.conversationId,
          fields: Object.entries(partialPatch.collectedData)
            .filter(([, value]) => !!value)
            .map(([key]) => key)
        });
      }
      return false;
    }

    const email = String(data.email).trim().toLowerCase();
    const memory = await getLastHoymilesMemory();
    if (memory.tarsHoymilesLastEmail === email) {
      await setHoymilesState(conversation.conversationId, {
        status: 'COMPLETED', email, data, collectedData: data
      });
      console.info('[TARS Hoymiles] suppressed: this email was already created');
      return true;
    }

    const pending = await new Promise(resolve =>
      chrome.storage.local.get(['tarsHoymilesPending'], r => resolve(r.tarsHoymilesPending || null))
    );
    const pendingKey = `${conversation.conversationId}|${email}`;
    if (pending === pendingKey || state.status === 'DATA_COMPLETE' || state.status === 'CREATING') return true;

    await new Promise(resolve => chrome.storage.local.set({ tarsHoymilesPending: pendingKey }, resolve));
    await setHoymilesState(conversation.conversationId, {
      status: 'CREATING', email, data, collectedData: data
    });

    console.info('[TARS Hoymiles] complete data detected', {
      conversationId: conversation.conversationId,
      email,
      company: data.company,
      fullName: data.fullName,
      phone: data.phone,
      state: data.state
    });
    console.info('[TARS Hoymiles] sending automation request to background');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'HOYMILES_CREATE_REQUEST',
        data,
        conversation
      });
      console.info('[TARS Hoymiles] background automation response', response || null);
      if (response?.ok) {
        await setHoymilesState(conversation.conversationId, {
          status: response.reporting?.ok === false ? 'REPORTING_FAILED' : 'COMPLETED',
          email,
          data,
          accountCreated: true,
          reporting: response.reporting || null,
          completedAt: new Date().toISOString()
        });
        return true;
      }

      await setHoymilesState(conversation.conversationId, {
        status: 'FAILED',
        email,
        data,
        error: response?.error || 'automation_request_failed'
      });
      return false;
    } catch (error) {
      const message = String(error?.message || error);
      console.error('[TARS Hoymiles] background request failed', message);
      await setHoymilesState(conversation.conversationId, {
        status: 'FAILED', email, data, error: message
      });
      return false;
    }
  }

  async function maybeStartHoymilesConversation(conversation, all) {
    const conversationId = conversation.conversationId;
    if (!conversationId || hoymilesProcessing.has(conversationId)) return;
    hoymilesProcessing.add(conversationId);

    try {
      const incoming = all
        .filter(m => m?.direction === 'incoming')
        .filter(m => !isHoymilesBotForm(m?.text))
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
      if (!incoming.length) return;

      let state;
      try {
        state = await getHoymilesState(conversationId);
      } catch (e) {
        console.error('[TARS Hoymiles DEBUG] get state failed', e);
        state = { status: 'NONE' };
      }

      const messageKey = (m) => {
        if (m?.explicitMessageId) return `explicit|${m.explicitMessageId}`;
        const text = String(m?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const timestamp = String(m?.timestamp || '').replace(/\s+/g, ' ').trim();
        const item = Number.isFinite(m?.virtualItemIndex) ? String(m.virtualItemIndex) : '';
        return `fallback|${m?.direction || ''}|${timestamp}|${item}|${text}`;
      };
      const currentIds = incoming.map(messageKey);

      if (!state.baselineEstablished) {
        await setHoymilesState(conversationId, {
          status: state.status || 'NONE',
          baselineEstablished: true,
          seenIncomingIds: currentIds.slice(-1000)
        });
        console.info('[TARS Hoymiles DEBUG] baseline established', {
          conversationId,
          baselineIncomingCount: incoming.length
        });
        return;
      }

      const seen = new Set(Array.isArray(state.seenIncomingIds) ? state.seenIncomingIds : []);
      const newIncoming = incoming.filter(m => !seen.has(messageKey(m)));
      if (!newIncoming.length) return;

      const mergedSeen = [...new Set([...seen, ...currentIds])].slice(-1000);
      await setHoymilesState(conversationId, { seenIncomingIds: mergedSeen });

      const latestNew = newIncoming.at(-1);
      const latestTextRaw = String(latestNew?.text || '');
      const normalizeIntent = text => String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.,!?;:()[\]{}"']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const isHoymilesIntent = text => {
        const normalized = normalizeIntent(text);
        return HOYMILES_INTENT_RE.test(text) ||
          /\b(?:quero|preciso|gostaria|precisamos|posso|podem|pode|criar|crie)\b.{0,100}\bconta\b.{0,60}\bhoymiles\b/i.test(normalized) ||
          /\bconta\s+(?:da\s+)?hoymiles\b/i.test(normalized);
      };
      const intentMessage = [...newIncoming].reverse().find(m => isHoymilesIntent(m?.text));
      const intentMatched = !!intentMessage;

      console.info('[TARS Hoymiles DEBUG] new incoming', {
        conversationId,
        count: newIncoming.length,
        messages: newIncoming.map(m => ({ id: m.id, sequence: m.sequence, text: m.text }))
      });
      debugSnapshot('hoymiles intent evaluation', {
        latestIncoming: latestTextRaw || null,
        newIncomingCount: newIncoming.length,
        intentMatched,
        state: state.status,
        conversationId
      });

      const formAlreadyRequested = await getHoymilesFormRequested(conversationId);
      const terminalRetryable = ['FAILED', 'REQUEST_DETECTED'].includes(state.status);
      const alreadyAsked = !terminalRetryable && (formAlreadyRequested || [
        'WAITING_FOR_DATA',
        'DATA_COMPLETE',
        'CREATING',
        'COMPLETED'
      ].includes(state.status));

      console.info('[TARS Hoymiles DEBUG] pre-send decision', {
        alreadyAsked,
        intentMatch: intentMatched,
        state: state.status,
        conversationId
      });

      if (!alreadyAsked && intentMatched) {
        if (terminalRetryable) {
          await clearHoymilesFormRequested(conversationId);
          console.info('[TARS Hoymiles DEBUG] retrying new intent after previous failure/request state');
        }
        await setHoymilesState(conversationId, {
          status: 'REQUEST_DETECTED',
          requestTriggerMessageId: intentMessage.id || null,
          requestTriggerSequence: intentMessage.sequence || null,
          requestTriggerText: String(intentMessage.text || ''),
          requestMessageKey: messageKey(intentMessage)
        });
        await markHoymilesFormRequested(conversationId, messageKey(intentMessage));

        console.info('[TARS Hoymiles DEBUG] calling sendHyperflowReply');
        let sent;
        try {
          sent = await Promise.race([
            sendHyperflowReply(HOYMILES_FORM_TEXT, conversationId),
            new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'reply_timeout' }), 12000))
          ]);
        } catch (e) {
          sent = { ok: false, error: String(e?.message || e) };
        }

        debugSnapshot('send information request result', {
          ok: sent?.ok,
          error: sent?.error,
          method: sent?.method
        });

        if (sent?.ok) {
          console.info('[TARS Hoymiles DEBUG] TARS form sent; exact form text is now protected from re-ingestion');
          const waitingState = {
            status: 'WAITING_FOR_DATA',
            requestMessageId: intentMessage.id || null,
            requestSequence: intentMessage.sequence || 0,
            requestMessageKey: messageKey(intentMessage),
            collectedData: {}
          };
          await setHoymilesState(conversationId, waitingState);
          console.info('[TARS Hoymiles] account intent detected; requested five fields');
          return;
        } else {
          await setHoymilesState(conversationId, {
            status: 'REQUEST_DETECTED',
            requestError: sent?.error || 'send_failed'
          });
          await clearHoymilesFormRequested(conversationId);
          console.warn('[TARS Hoymiles] could not send information request', sent);
        }
        return;
      }

      let activeState = await getHoymilesState(conversationId);
      if (await getHoymilesFormRequested(conversationId) && activeState.status === 'NONE') {
        activeState = { ...activeState, status: 'WAITING_FOR_DATA' };
        await setHoymilesState(conversationId, activeState);
      }
      const triggerKey = activeState.requestMessageKey || null;
      const triggerText = normalizeHoymilesBotText(activeState.requestTriggerText || '');
      const dataMessages = newIncoming.filter(m => {
        const key = messageKey(m);
        if (triggerKey && key === triggerKey) return false;
        if (triggerText && normalizeHoymilesBotText(m?.text || '') === triggerText) return false;
        return true;
      });
      if (dataMessages.length) {
        await processHoymilesData(conversation, dataMessages, activeState);
      }
    } catch (error) {
      console.warn('[TARS Hoymiles] conversation trigger failed', error);
    } finally {
      hoymilesProcessing.delete(conversationId);
    }
  }

  window.TARS_TEST_HOYMILES_REPLY = async () => {
    console.info('[TARS Hoymiles DEBUG] manual reply test started');
    const result = await sendReplyToComposer(HOYMILES_FORM_TEXT);
    console.info('[TARS Hoymiles DEBUG] manual reply test result', result);
    return result;
  };

  async function sendReplyToComposer(text) {
    const value = String(text ?? '').trim();
    if (!value) return { ok: false, error: 'empty_reply' };

    debugSnapshot('composer lookup start', { text: value });

    const selectors = [
      'textarea.input-chat-footer[placeholder="Digite uma mensagem..."]',
      'textarea[placeholder="Digite uma mensagem..."]',
      'textarea[placeholder*="Digite uma mensagem"]',
      '[contenteditable="true"][data-placeholder*="mensagem"]',
      '[contenteditable="true"][aria-label*="mensagem"]',
      '[role="textbox"][aria-label*="mensagem"]'
    ];

    let editor = null;
    let matchedSelector = null;
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].filter(el =>
        visible(el) && !el.disabled && !el.readOnly
      );
      if (found.length) {
        editor = found.at(-1);
        matchedSelector = selector;
        break;
      }
    }

    if (!editor) {
      debugSnapshot('composer lookup failed', {
        textareaCount: document.querySelectorAll('textarea').length,
        exactComposerCount: document.querySelectorAll('textarea[placeholder="Digite uma mensagem..."]').length
      });
      return { ok: false, error: 'composer_not_found' };
    }

    const footer = editor.closest('.input-chat-footer') || editor.closest('form') || editor.parentElement?.parentElement?.parentElement;
    const ancestor = footer?.parentElement || editor.parentElement?.parentElement?.parentElement?.parentElement;

    debugSnapshot('composer found', {
      selector: matchedSelector,
      tag: editor.tagName,
      placeholder: editor.getAttribute('placeholder'),
      aria: editor.getAttribute('aria-label'),
      className: editor.className,
      parentClass: editor.parentElement?.className || null,
      footerClass: footer?.className || null
    });

    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const proto = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(editor, value); else editor.value = value;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (editor.isContentEditable) {
      editor.textContent = value;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }

    await sleep(700);

    const currentValue = 'value' in editor ? editor.value : (editor.innerText || editor.textContent || '');
    debugSnapshot('composer value after input', { currentValue, expectedLength: value.length });

    const scope = ancestor || document.body;
    const buttons = [...scope.querySelectorAll('button,[role="button"]')].filter(visible).map((el, i) => ({
      i,
      tag: el.tagName,
      text: cleanText(el.innerText || el.textContent),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      testid: el.getAttribute('data-testid'),
      type: el.getAttribute('type'),
      disabled: !!el.disabled,
      cls: String(el.className || '').slice(0, 180)
    })).slice(-20);
    debugSnapshot('composer nearby buttons', { buttons });

    const sendRe = /(?:enviar|send|enviar mensagem|send message|send-message|send_message)/i;
    let sendButton = [...scope.querySelectorAll('button,[role="button"]')]
      .filter(el => visible(el) && !el.disabled)
      .find(el => sendRe.test(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''}`));

    if (!sendButton && footer) {
      const local = [...footer.querySelectorAll('button,[role="button"]')].filter(el => visible(el) && !el.disabled);
      if (local.length) sendButton = local.at(-1);
    }

    if (sendButton) {
      debugSnapshot('composer send button selected', {
        text: cleanText(sendButton.innerText || sendButton.textContent),
        aria: sendButton.getAttribute('aria-label'),
        title: sendButton.getAttribute('title'),
        testid: sendButton.getAttribute('data-testid'),
        className: String(sendButton.className || '').slice(0, 200)
      });
      sendButton.click();
      await sleep(700);
      const after = 'value' in editor ? editor.value : (editor.innerText || editor.textContent || '');
      if (!after.trim()) return { ok: true, method: 'button' };
      debugSnapshot('composer button did not clear', { after });
    }

    debugSnapshot('composer submit fallback', { hasForm: !!editor.closest('form') });
    editor.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      editor.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
    await sleep(700);
    const afterEnter = 'value' in editor ? editor.value : (editor.innerText || editor.textContent || '');
    if (!afterEnter.trim()) return { ok: true, method: 'enter' };

    const form = editor.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      debugSnapshot('composer form requestSubmit fallback');
      form.requestSubmit();
      await sleep(700);
      const afterForm = 'value' in editor ? editor.value : (editor.innerText || editor.textContent || '');
      if (!afterForm.trim()) return { ok: true, method: 'form' };
    }

    return { ok: false, error: 'composer_value_not_submitted', method: 'none', currentValue: afterEnter };
  }

  async function start() {
    console.info('[TARS Hyperflow] capture layer loaded', {
      version: '1.2.37',
      url: location.href,
      origin: location.origin
    });

    await openDb();
    console.info('[TARS Hyperflow] IndexedDB ready', DB_NAME);
    const initial = await scan();
    if (!initial.ok) throw new Error(initial.error || 'initial_scan_failed');

    observer = new MutationObserver(mutations => {
      let relevant = false;
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          relevant = true;
          break;
        }
        if (m.type === 'characterData') {
          relevant = true;
          break;
        }
      }
      if (relevant) scheduleScan();
    });

    observer.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
      characterData: true
    });

    console.info('[TARS Hyperflow] observer started');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type || !msg.type.startsWith('HYPERFLOW_')) return;

    (async () => {
      if (msg.type === 'HYPERFLOW_DO_SEND_REPLY') {
        return await sendReplyToComposer(msg.text);
      }
      if (msg.type === 'HYPERFLOW_GET_CONTEXT') {
        return { ok: true, context: await getContext({ limit: msg.limit }) };
      }
      if (msg.type === 'HYPERFLOW_SCAN') {
        return await scan();
      }
      if (msg.type === 'HYPERFLOW_LIST_CONVERSATIONS') {
        return { ok: true, conversations: await listConversations() };
      }
      if (msg.type === 'HYPERFLOW_SEND_REPLY') {
        return await sendReplyToComposer(msg.text);
      }
      if (msg.type === 'HYPERFLOW_STATUS') {
        const context = await getContext({ limit: 1 });
        return {
          ok: true,
          active: context.id,
          customerName: context.customerName,
          messageCount: context.messageCount,
          identityConfidence: context.identityConfidence
        };
      }
      return { ok: false, error: 'unknown_hyperflow_command' };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));

    return true;
  });

  start().catch(error => console.error('[TARS Hyperflow] startup failed', error));
})();
