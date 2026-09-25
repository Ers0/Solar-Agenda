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
  console.info('[TARS Hyperflow] real capture script injected', '1.2.88', location.href);
  try { document.documentElement.dataset.tarsHyperflowCapture = 'active'; } catch (_) {}

  const DB_NAME = 'tars-hyperflow-memory';
  const DB_VERSION = 3;
  const STORE_CONVERSATIONS = 'conversations';
  const STORE_MESSAGES = 'messages';
  const STORE_ATTACHMENTS = 'attachments';
  const MAX_TEXT = 12000;
  const MAX_CONTEXT_MESSAGES = 2500;
  const SCAN_DEBOUNCE_MS = 250;
  const DEBUG_PREFIX = '[TARS DEBUG]';
  let debugScanCount = 0;
  let emergencyStopped = false;

  function debugSnapshot(stage, data = {}) {
    try {
      console.groupCollapsed(`${DEBUG_PREFIX} ${stage}`);
      console.log({
        version: '1.2.88',
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
      version: '1.2.88',
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
  let scrollRoot = null;
  let scrollHandler = null;
  let scanTimer = null;
  let activeConversation = null;
  let sequenceCache = new Map();
  let lastLoggedConversationId = null;
  let lastLoggedCount = 0;
  const hoymilesProcessing = new Set();
  const hoymilesRuntimeState = new Map();
  const hoymilesRuntimeFormRequested = new Map();
  const hoymilesSessionBaselined = new Set();

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let extensionContextAlive = true;

  function extensionContextIsAlive() {
    if (!extensionContextAlive) return false;
    try { return !!chrome?.runtime?.id; } catch (_) { return false; }
  }

  function markExtensionContextInvalidated(error) {
    if (!extensionContextAlive) return;
    extensionContextAlive = false;
    try { observer?.disconnect(); } catch (_) {}
    try { if (scrollRoot && scrollHandler) scrollRoot.removeEventListener('scroll', scrollHandler); } catch (_) {}
    try { if (scanTimer) clearTimeout(scanTimer); } catch (_) {}
    scanTimer = null;
    console.warn('[TARS Hyperflow] extension context invalidated; stopping extension activity. Refresh this Hyperflow tab after updating/reloading the extension.', error?.message || error || 'context_invalidated');
  }

  function runtimeSendMessage(message) {
    return new Promise(resolve => {
      if (!extensionContextIsAlive()) return resolve({ ok: false, error: 'extension_context_invalidated' });
      try {
        chrome.runtime.sendMessage(message, response => {
          let lastError = null;
          try { lastError = chrome.runtime.lastError || null; } catch (_) { lastError = null; }
          if (lastError) {
            const text = String(lastError.message || lastError);
            if (/context invalidated|extension context/i.test(text)) markExtensionContextInvalidated(lastError);
            return resolve({ ok: false, error: text });
          }
          resolve(response === undefined ? { ok: true } : response);
        });
      } catch (error) {
        if (/context invalidated|extension context/i.test(String(error?.message || error))) markExtensionContextInvalidated(error);
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  async function waitFor(predicate, timeoutMs = 8000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await predicate();
        if (value) return value;
      } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  }

  function bridgeStorageGet(keys) {
    return new Promise(resolve => {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.get(keys, result => resolve(result || {}));
          return;
        }
      } catch (_) {}
      runtimeSendMessage({ type: 'TARS_STORAGE_GET', keys }).then(response => {
        resolve(response?.ok ? (response.data || {}) : {});
      });
    });
  }

  function bridgeStorageSet(items) {
    return new Promise(resolve => {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.set(items, () => resolve(true));
          return;
        }
      } catch (_) {}
      runtimeSendMessage({ type: 'TARS_STORAGE_SET', items }).then(response => {
        resolve(!!response?.ok);
      });
    });
  }

  function bridgeStorageRemove(keys) {
    return new Promise(resolve => {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.remove(keys, () => resolve(true));
          return;
        }
      } catch (_) {}
      runtimeSendMessage({ type: 'TARS_STORAGE_REMOVE', keys }).then(response => {
        resolve(!!response?.ok);
      });
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const attachHandlers = (req) => {
        req.onupgradeneeded = () => {
          const db = req.result;
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
        req.onerror = () => {
          if (req.error && req.error.name === 'VersionError') {
            console.warn('[TARS Hyperflow] VersionError on openDb; falling back to opening existing database version', req.error);
            const fallbackReq = indexedDB.open(DB_NAME);
            fallbackReq.onsuccess = () => resolve(fallbackReq.result);
            fallbackReq.onerror = () => reject(fallbackReq.error);
            return;
          }
          reject(req.error);
        };
      };

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        attachHandlers(req);
      } catch (err) {
        if (err && err.name === 'VersionError') {
          const fallbackReq = indexedDB.open(DB_NAME);
          fallbackReq.onsuccess = () => resolve(fallbackReq.result);
          fallbackReq.onerror = () => reject(fallbackReq.error);
        } else {
          reject(err);
        }
      }
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

  function findStableId(root) {
    const own = stableAttribute(root, [
      'data-message-id', 'data-messageid', 'data-id', 'data-key'
    ]);
    if (own) return own;

    const domId = root?.id || '';
    if (/^message-wamid\./i.test(domId)) return domId;

    const descendant = root.querySelector?.(
      '[data-message-id],[data-messageid],[data-id],[data-key]'
    );
    return descendant ? stableAttribute(descendant, [
      'data-message-id', 'data-messageid', 'data-id', 'data-key'
    ]) : null;
  }

  function findPhone(text) {
    const m = String(text || '').match(/(?:\+?\d[\d ()-]{8,}\d)/);
    return m ? m[0].replace(/\D/g, '') : null;
  }

  function findVisibleProtocol() {
    const explicit = [
      '[data-testid*="protocol" i]', '[class*="protocol" i]',
      '[aria-label*="protocolo" i]', '[title*="protocolo" i]'
    ];
    for (const selector of explicit) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const text = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
        const m = text.match(/protocolo\s*:\s*([A-Za-z0-9._/-]+)/i);
        if (m) return m[1].trim();
        if (text && /^\d{8,20}$/.test(text)) return text;
      }
    }
    const candidates = [...document.querySelectorAll('body *')].filter(visible);
    for (const el of candidates.slice(0, 5000)) {
      const text = cleanText(el.innerText || el.textContent || '');
      if (!/^protocolo\s*:/i.test(text) || text.length > 120) continue;
      const m = text.match(/protocolo\s*:\s*([A-Za-z0-9._/-]+)/i);
      if (m) return m[1].trim();
    }
    return null;
  }

  function findDirectConversationUrl() {
    const route = location.href;
    const activeChat = document.querySelector('.chat-item.active');
    const href = activeChat?.querySelector?.('a[href]')?.href || activeChat?.closest?.('a[href]')?.href;
    return href && /^https:\/\/conversas\.hyperflow\.global\//i.test(href) ? href : route;
  }

  function findConversationIdentity() {
    const activeChat = document.querySelector('.chat-item.active');
    const protocolClass = [...(activeChat?.classList || [])].find(c => /^protocol-/.test(c));
    const protocol = (protocolClass ? protocolClass.slice('protocol-'.length) : null) || findVisibleProtocol();

    const nameEl = document.querySelector('.chat-user');
    const phoneEl = document.querySelector('.chat-user-phone');
    const customerName = cleanText(nameEl?.innerText || '') || null;
    const phone = cleanText(phoneEl?.innerText || '') || findPhone(customerName);
    const departmentEl = [...document.querySelectorAll('[aria-label^="Departamento:" i]')]
      .find(visible);
    const channelEl = document.querySelector('[aria-label^="Canal:" i]');
    const department = departmentEl ? cleanText(departmentEl.getAttribute('aria-label')).replace(/^Departamento:\s*/i, '') : null;
    const channel = channelEl ? cleanText(channelEl.getAttribute('aria-label')).replace(/^Canal:\s*/i, '') : null;
    const url = findDirectConversationUrl();

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
    const globalWrappers = [...root.querySelectorAll('.message-out-wrapper, .message-in-wrapper')]
      .filter(visible);
    if (globalWrappers.length) return [...new Set(globalWrappers)];

    const list = messageListRoot(root);
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

  function getTimestamp(el) {
    const t = el.querySelector?.('time, [class*="time"], [class*="date"]');
    return cleanText(t?.innerText || t?.textContent || '');
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
    const timestamp = cleanText(timestampEl?.innerText || '') || getTimestamp(el);
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
    const cleanStr = String(text || '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!cleanStr && !hasAttachments) {
      return {
        stored: false,
        duplicate: false,
        ignored: true,
        reason: 'empty_message'
      };
    }

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
      if (await isObserverMode()) {
        runtimeSendMessage({ type: 'TARS_OBSERVER_CASE_ACTIVE', tabId: null, conversation: { conversationId: conversation.conversationId, protocol: conversation.ticketId || null, conversationUrl: conversation.url || location.href } });
      }

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

      attachScrollCapture();
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
      const triggerMessages = stored
        .filter(m => m?.direction === 'incoming')
        .slice()
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

      if (triggerMessages.length) {
        console.info('[TARS Hoymiles] new captured incoming', {
          conversationId: conversation.conversationId,
          count: triggerMessages.length,
          messages: triggerMessages.map(m => ({ id: m.id, text: m.text }))
        });
      }

      if (await isObserverMode() && stored.length > 0) {
        await runtimeSendMessage({
          type: 'TARS_OBSERVER_HYPERFLOW_BATCH',
          conversation: {
            conversationId: conversation.conversationId,
            protocol: conversation.ticketId || null,
            conversationUrl: conversation.url || location.href,
            identitySource: conversation.identitySource || null,
            identityConfidence: conversation.identityConfidence || null
          },
          messages: stored
            .filter(m => m && String(m.text || '').trim().length > 0 || Number(m.attachmentCount) > 0)
            .map(m => ({
              id: m.id,
              direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
              speaker: m.speaker === 'agent' ? 'technician' : 'customer',
              timestamp: m.timestamp || null,
              capturedAt: m.capturedAt || null,
              text: String(m.text || '').trim().slice(0, MAX_TEXT),
              attachmentCount: Array.isArray(m.attachments)
                ? m.attachments.length
                : Number(m.attachmentCount || 0)
            }))
            .filter(m => m.text.length > 0 || m.attachmentCount > 0)
        });
      }

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

  function attachScrollCapture() {
    const root = messageListRoot(document);
    if (!root || root === scrollRoot) return;
    if (scrollRoot && scrollHandler) {
      try { scrollRoot.removeEventListener('scroll', scrollHandler); } catch (_) {}
    }
    scrollRoot = root;
    scrollHandler = () => scheduleScan();
    try { scrollRoot.addEventListener('scroll', scrollHandler, { passive: true }); } catch (_) {}
    console.info('[TARS Hyperflow] scroll capture attached', {
      testId: scrollRoot.getAttribute?.('data-testid') || null,
      className: scrollRoot.className || null
    });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => scan(), SCAN_DEBOUNCE_MS);
  }

  function sanitizeSlaText(text, conversation) {
    let value = cleanText(text);
    if (!value) return '';
    const names = [conversation?.customerName].filter(Boolean).map(cleanText).filter(Boolean);
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escaped.length >= 3) value = value.replace(new RegExp(escaped, 'ig'), '[CLIENT_NAME]');
    }
    value = value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
      .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[\s-]?\d{4}\b/g, '[PHONE]')
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]')
      .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/??\d{4}-?\d{2}\b/g, '[CNPJ]')
      .replace(/(senha|password|token|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
      .replace(/https?:\/\/[^\s]+/gi, '[LINK]');
    return value.slice(0, MAX_TEXT);
  }

  async function getSlaSnapshot() {
    const conversation = findConversationIdentity();
    await scan();
    const all = await getAllMessages(conversation.conversationId);
    all.sort((a, b) => {
      const sa = Number.isFinite(Number(a.sequence)) ? Number(a.sequence) : 0;
      const sb = Number.isFinite(Number(b.sequence)) ? Number(b.sequence) : 0;
      return sa - sb || String(a.capturedAt || '').localeCompare(String(b.capturedAt || ''));
    });
    const messages = all.map((m, index) => ({
      sequence: index + 1,
      direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
      speaker: m.speaker === 'agent' ? 'agent' : 'customer',
      timestamp: m.timestamp || null,
      capturedAt: m.capturedAt || null,
      text: sanitizeSlaText(m.text, conversation),
      attachmentCount: Array.isArray(m.attachments) ? m.attachments.length : 0
    })).filter(m => m.text || m.attachmentCount);

    return {
      protocol: conversation.ticketId || null,
      conversationId: conversation.conversationId,
      conversationUrl: conversation.url,
      customer: {
        identifierType: conversation.ticketId ? 'hyperflow_protocol' : 'conversation_id',
        identifier: conversation.ticketId || conversation.conversationId
      },
      timeline: messages,
      messageCount: messages.length,
      capturedAt: new Date().toISOString(),
      privacy: {
        sensitiveFieldsOmitted: true,
        messagePiiRedacted: true,
        attachmentSourcesOmitted: true,
        rawLocalCaptureOnly: true
      }
    };
  }

  async function getSlaSnapshotsForSync() {
    const conversations = await getAllConversations();
    const out = [];
    for (const row of conversations) {
      if (!row?.conversationId) continue;
      const all = await getAllMessages(row.conversationId);
      all.sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
      const messages = all.map((m, index) => ({
        sequence: index + 1,
        direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
        speaker: m.speaker === 'agent' ? 'agent' : 'customer',
        timestamp: m.timestamp || null,
        capturedAt: m.capturedAt || null,
        text: sanitizeSlaText(m.text, row),
        attachmentCount: Array.isArray(m.attachments) ? m.attachments.length : 0
      })).filter(m => m.text || m.attachmentCount);
      out.push({
        protocol: row.ticketId || null,
        conversationId: row.conversationId,
        conversationUrl: row.url || null,
        customer: {
          identifierType: row.ticketId ? 'hyperflow_protocol' : 'conversation_id',
          identifier: row.ticketId || row.conversationId
        },
        timeline: messages,
        messageCount: messages.length,
        updatedAt: row.updatedAt || null,
        capturedAt: new Date().toISOString(),
        privacy: { sensitiveFieldsOmitted: true, messagePiiRedacted: true, attachmentSourcesOmitted: true, rawLocalCaptureOnly: true }
      });
    }
    return out;
  }

  async function purgeLocalCapture() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_ATTACHMENTS], 'readwrite');
      transaction.objectStore(STORE_MESSAGES).clear();
      transaction.objectStore(STORE_ATTACHMENTS).clear();
      transaction.objectStore(STORE_CONVERSATIONS).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('purge_failed'));
      transaction.onabort = () => reject(transaction.error || new Error('purge_aborted'));
    });
    sequenceCache = new Map();
    activeConversation = null;
    console.info('[TARS Hyperflow] local capture purged');
    return { ok: true };
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

  const HOYMILES_INTENT_RE = /(?:\b(?:criar|crie|quero|preciso|gostaria|precisamos|podem|pode|posso)\b.{0,80}\bconta\b.{0,40}\bhoymiles\b|\bconta\s+(?:da\s+)?hoymiles\b|\b(?:i\s+want|i\s+need|i\s+would\s+like)\b.{0,80}\b(?:create|open)\b.{0,40}\bhoymiles\b.{0,40}\baccount\b)/i;
  const HOYMILES_FORM_TEXT = `Para criarmos sua conta Hoymiles, preciso das seguintes informações:\n\nNome da empresa:\nNome completo:\nE-mail:\nTelefone para contato:\nEstado:`;

  function buildHoymilesSuccessMessage(data) {
    const email = String(data?.email || '').trim();
    return `Sua conta Hoymiles foi criada com sucesso!\n\nE-mail/Login: ${email}\nSenha: Solar123\n\nAcesse a plataforma Hoymiles para realizar o primeiro acesso.\nAplicativo de Instalador: S-miles Installer.\nAplicativo de proprietario: S-miles Enduser.\nPlataforma Web: https://global.hoymiles.com/\n\nPara monitoramento HOYMILES, podem seguir os exemplos abaixo. Caso ainda reste alguma dúvida, orientamos acessar o último link da Universidade Bel,\nonde esclarecemos dúvidas sobre todas as fabricantes com as quais trabalhamos.\n\nGuia Geral:\nhttps://drive.google.com/drive/folders/13boBQDl5VFlsvkUx_rjs4Gg-YK9AZGGf?usp=sharing\n\nInstalação e comissionamento completo do DW:\nhttps://www.youtube.com/watch?v=zxlvAUMXpNI\n\nComo adicionar dispositivos a uma planta:\nhttps://youtu.be/Eceg3MtSEEY?si=spdOVfnPG-55tFhN\n\nComo criar uma planta do zero:\nhttps://youtu.be/LTHzCXIan1g?si=2TvBL0UwqfZk2Odm\n\nComo inserir senha na DTU:\nhttps://youtu.be/6wJX6OaAzV0?si=kKw3TxMAlYLQvwdf\n\nUniversidade Bel:\nhttps://belenus.com.br/universidade-bel/vitrine-catalogo-universidade`;
  }

  const normalizeHoymilesBotText = text => String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const HOYMILES_HELP_PROMPT = 'Por hora, posso auxiliar com algo mais?';
  const HOYMILES_CLOSING_MESSAGE = 'Por nada! Com isso, finalizo seu atendimento por aqui. Sigo à disposição caso surja qualquer outra dúvida ou precise de mais algum auxílio.\nTenha um ótimo dia!';
  const HOYMILES_HELP_PROMPT_FINGERPRINT = normalizeHoymilesBotText(HOYMILES_HELP_PROMPT);
  const isHoymilesHelpPrompt = text => normalizeHoymilesBotText(text) === HOYMILES_HELP_PROMPT_FINGERPRINT;

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
    return await bridgeStorageGet([
      'tarsHoymilesLastEmail',
      'tarsHoymilesLastCreatedAt',
      'tarsHoymilesLastCompany',
      'tarsHoymilesLastConversationId'
    ]);
  }

  async function clearHoymilesFormRequested(conversationId) {
    const stored = await bridgeStorageGet('tarsHoymilesFormRequested');
    const map = stored?.tarsHoymilesFormRequested || {};
    delete map[conversationId];
    await bridgeStorageSet({ tarsHoymilesFormRequested: map });
    return true;
  }

  async function getHoymilesFormRequested(conversationId) {
    if (hoymilesRuntimeFormRequested.has(conversationId)) return true;
    return new Promise(resolve => bridgeStorageGet(['tarsHoymilesFormRequested']).then(r => {
      resolve(!!(r.tarsHoymilesFormRequested || {})[conversationId]);
    }));
  }

  async function markHoymilesFormRequested(conversationId, triggerMessageKey) {
    hoymilesRuntimeFormRequested.set(conversationId, {
      at: new Date().toISOString(),
      triggerMessageKey: triggerMessageKey || null
    });
    return new Promise(resolve => bridgeStorageGet(['tarsHoymilesFormRequested']).then(r => {
      const map = r.tarsHoymilesFormRequested || {};
      map[conversationId] = {
        at: new Date().toISOString(),
        triggerMessageKey: triggerMessageKey || null
      };
      bridgeStorageSet({ tarsHoymilesFormRequested: map }).then(resolve);
    }));
  }

  async function getHoymilesState(conversationId) {
    const runtime = hoymilesRuntimeState.get(conversationId);
    if (runtime) return runtime;
    return new Promise(resolve => bridgeStorageGet(['tarsHoymilesStates']).then(r => {
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
    return new Promise(resolve => bridgeStorageGet(['tarsHoymilesStates']).then(r => {
      const states = r.tarsHoymilesStates || {};
      states[conversationId] = next;
      bridgeStorageSet({ tarsHoymilesStates: states }).then(resolve);
    }));
  }

  async function sendHyperflowReply(text, conversationId) {
    const currentConversation = findConversationIdentity();
    if (!conversationId || currentConversation.conversationId !== conversationId) {
      console.error('[TARS Hoymiles SAFETY] refusing to send: conversation mismatch', {
        expectedConversationId: conversationId || null,
        currentConversationId: currentConversation.conversationId,
        expectedProtocol: null,
        currentProtocol: currentConversation.ticketId || null,
        currentUrl: location.href
      });
      return { ok: false, error: 'conversation_identity_mismatch', expectedConversationId: conversationId || null, currentConversationId: currentConversation.conversationId };
    }

    debugSnapshot('send information request start', { conversationId, text });
    try {
      const result = await sendReplyToComposer(text, conversationId);
      debugSnapshot('send information request result', result);
      return result;
    } catch (error) {
      const result = { ok: false, error: String(error?.message || error) };
      debugSnapshot('send information request result', result);
      return result;
    }
  }

  async function processHoymilesData(conversation, incoming, state) {
    const automationEnabled = await isAutomationEnabled();
    const observerMode = await isObserverMode();
    const interactionAllowed = automationEnabled && !observerMode;

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

    if (!interactionAllowed) {
      await setHoymilesState(conversation.conversationId, {
        status: 'DATA_COMPLETE_OBSERVED',
        email,
        data,
        collectedData: data
      });

      console.info('[TARS Hoymiles DEBUG] complete data observed; automation suppressed', {
        conversationId: conversation.conversationId,
        email,
        reason: observerMode ? 'observer_mode' : 'automation_disabled'
      });

      return true;
    }

    const memory = await getLastHoymilesMemory();

    if (memory.tarsHoymilesLastEmail === email) {
      await setHoymilesState(conversation.conversationId, {
        status: 'COMPLETED',
        email,
        data,
        collectedData: data
      });

      console.info('[TARS Hoymiles] suppressed: this email was already created');
      return true;
    }

    const pending = await new Promise(resolve =>
      bridgeStorageGet(['tarsHoymilesPending'])
        .then(r => resolve(r.tarsHoymilesPending || null))
    );

    const pendingKey = `${conversation.conversationId}|${email}`;

    if (
      pending === pendingKey ||
      state.status === 'DATA_COMPLETE' ||
      state.status === 'CREATING'
    ) {
      return true;
    }

    await bridgeStorageSet({
      tarsHoymilesPending: pendingKey
    });

    await setHoymilesState(conversation.conversationId, {
      status: 'CREATING',
      email,
      data,
      collectedData: data
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
      const response = await runtimeSendMessage({
        type: 'HOYMILES_CREATE_REQUEST',
        data,
        conversation
      });

      console.info(
        '[TARS Hoymiles] background automation response',
        response || null
      );

      if (response?.ok) {
        await setHoymilesState(conversation.conversationId, {
          status: response.helpPrompt?.ok
            ? 'AWAITING_HELP_RESPONSE'
            : (
                response.reporting?.ok === false
                  ? 'REPORTING_FAILED'
                  : 'COMPLETED'
              ),
          email,
          data,
          accountCreated: true,
          reporting: response.reporting || null,
          helpPromptSent: !!response.helpPrompt?.ok,
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

      console.error(
        '[TARS Hoymiles] background request failed',
        message
      );

      await setHoymilesState(conversation.conversationId, {
        status: 'FAILED',
        email,
        data,
        error: message
      });

      return false;
    }
  }

  async function isObserverMode() {
    try {
      const r = await bridgeStorageGet(['tarsObserverMode']);
      return r.tarsObserverMode === true;
    } catch (_) { return false; }
  }

  async function isAutomationEnabled() {
    try {
      if (emergencyStopped) return false;

      const r = await bridgeStorageGet([
        'tarsAutomationEnabled'
      ]);

      return r.tarsAutomationEnabled !== false;

    } catch (_) {
      return true;
    }
  }

  async function maybeStartHoymilesConversation(conversation, all) {
    const automationEnabled = await isAutomationEnabled();
    const observerMode = await isObserverMode();
    const interactionAllowed = automationEnabled && !observerMode;

    const conversationId = conversation.conversationId;

    if (!conversationId || hoymilesProcessing.has(conversationId)) return;

    hoymilesProcessing.add(conversationId);

    try {
      const incoming = all
        .filter(m => m?.direction === 'incoming')
        .filter(m => !isHoymilesBotForm(m?.text))
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
      if (!incoming.length) return;

      hoymilesSessionBaselined.add(conversationId);

      let state;
      try {
        state = await getHoymilesState(conversationId);
      } catch (e) {
        console.error('[TARS Hoymiles DEBUG] get state failed', e);
        state = { status: 'NONE' };
      }

      const HOYMILES_SEEN_KEY_VERSION = 3;
      const messageKey = (m) => {
        if (m?.explicitMessageId) return `explicit|${m.explicitMessageId}`;
        const text = String(m?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const timestamp = String(m?.timestamp || '').replace(/\s+/g, ' ').trim();
        return `fallback|${m?.direction || ''}|${timestamp}|${text}`;
      };
      const currentIds = incoming.map(messageKey);

      const freshlyCaptured = new Set(
        all.filter(m => m?.direction === 'incoming').map(messageKey)
      );

      if (state.seenKeyVersion !== HOYMILES_SEEN_KEY_VERSION) {
        const migrationSeen = currentIds.filter(id => !freshlyCaptured.has(id));
        await setHoymilesState(conversationId, {
          status: state.status || 'NONE',
          seenKeyVersion: HOYMILES_SEEN_KEY_VERSION,
          baselineEstablished: true,
          seenIncomingIds: migrationSeen.slice(-1000)
        });
        console.info('[TARS Hoymiles DEBUG] seen-key migration established', {
          conversationId,
          baselineIncomingCount: incoming.length,
          freshlyCapturedIncomingCount: freshlyCaptured.size,
          fromVersion: state.seenKeyVersion || 1,
          toVersion: HOYMILES_SEEN_KEY_VERSION
        });
      } else if (!state.baselineEstablished) {
        const baselineSeen = currentIds.filter(id => !freshlyCaptured.has(id));
        await setHoymilesState(conversationId, {
          status: state.status || 'NONE',
          baselineEstablished: true,
          seenKeyVersion: HOYMILES_SEEN_KEY_VERSION,
          seenIncomingIds: baselineSeen.slice(-1000)
        });
        console.info('[TARS Hoymiles DEBUG] baseline established', {
          conversationId,
          baselineIncomingCount: incoming.length,
          freshlyCapturedIncomingCount: freshlyCaptured.size
        });
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
      const deterministicHoymilesIntent = text => {
        const normalized = normalizeIntent(text);
        return HOYMILES_INTENT_RE.test(text) ||
          /\b(?:quero|preciso|gostaria|precisamos|posso|podem|pode|criar|crie|fazer)\b.{0,120}\bconta\b.{0,80}\bhoymiles\b/i.test(normalized) ||
          /\b(?:nao|não)\s+(?:tenho|possuo)\b.{0,80}\bconta\b.{0,60}\bhoymiles\b/i.test(normalized) ||
          /\bconta\s+(?:da\s+)?hoymiles\b/i.test(normalized) && /\b(?:criar|cadastro|cadastrar|tenho|possuo|preciso|como|quem|voc[eê]s?)\b/i.test(normalized);
      };

      async function askTarsHoymilesIntent(text, contextMessages = []) {
        const prompt = [
          'Classify the latest customer message for the Hoymiles installer-account workflow.',
          'Latest customer message:', String(text || ''), '',
          'Recent conversation context:', contextMessages.slice(-8).map(m => `[${m.direction || '?'}] ${m.text || ''}`).join('\n'), '',
          'Return ONLY JSON: {"intent":"HOYMILES_ACCOUNT_CREATION|OTHER_HOYMILES|OTHER","confidence":0-1,"action":"START_HOYMILES_ACCOUNT_FLOW|NO_ACTION","reason":"short reason"}.',
          'Trigger only when the customer wants, needs, lacks, or asks who creates a Hoymiles INSTALLER account. Do not trigger for monitoring, inverter faults, login problems, app questions, device registration, or generic Hoymiles questions.'
        ].join('\n');
        try {
          const result = await new Promise(resolve => {
            let settled = false; const finish = v => { if (!settled) { settled = true; resolve(v); } };
            runtimeSendMessage({ type: 'TARS_HOYMILES_AI_INTENT', prompt }).then(response => {
              finish(response || { ok: false, error: 'empty_response' });
            });
            setTimeout(() => finish({ ok: false, error: 'ai_timeout' }), 9500);
          });
          debugSnapshot('AI Hoymiles intent result', result);
          if (result?.ok) return { ...result, source: 'tars-ai' };
          console.warn('[TARS Hoymiles] AI intent unavailable; using deterministic fallback', result);
        } catch (error) { console.warn('[TARS Hoymiles] AI intent error; using deterministic fallback', error); }
        const fallback = deterministicHoymilesIntent(text);
        return { ok: true, intent: fallback ? 'HOYMILES_ACCOUNT_CREATION' : 'OTHER', confidence: fallback ? 0.99 : 0, action: fallback ? 'START_HOYMILES_ACCOUNT_FLOW' : 'NO_ACTION', source: 'deterministic-fallback' };
      }

      const intentCandidate = [...newIncoming].reverse().find(m => /hoymiles/i.test(m?.text || '') || deterministicHoymilesIntent(m?.text || ''));
      let intentMessage = null;
      let intentMatched = false;
      let intentSource = 'none';
      let intentResult = null;
      if (intentCandidate) {
        intentResult = await askTarsHoymilesIntent(intentCandidate.text, incoming.slice(-8));
        intentMessage = intentCandidate;
        intentMatched = intentResult?.action === 'START_HOYMILES_ACCOUNT_FLOW' && intentResult?.intent === 'HOYMILES_ACCOUNT_CREATION' && Number(intentResult?.confidence || 0) >= 0.78;
        intentSource = intentResult?.source || 'unknown';
      }
      if (!intentMatched && intentResult?.source === 'deterministic-fallback') {
        intentMatched = deterministicHoymilesIntent(intentMessage?.text || '');
      }

      console.info('[TARS Hoymiles DEBUG] new incoming', {
        conversationId,
        count: newIncoming.length,
        messages: newIncoming.map(m => ({ id: m.id, sequence: m.sequence, text: m.text }))
      });
      debugSnapshot('hoymiles intent evaluation', {
        latestIncoming: latestTextRaw || null,
        newIncomingCount: newIncoming.length,
        intentMatched,
        intentSource,
        intentResult,
        state: state.status,
        conversationId
      });

      const helpResponseState = await getHoymilesState(conversationId);
      if (helpResponseState.status === 'AWAITING_HELP_RESPONSE' && newIncoming.length) {
        const latestHelpReply = newIncoming.at(-1);
        const normalizedHelpReply = normalizeHoymilesBotText(latestHelpReply?.text || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        const noOrThanks = /^(?:nao|obrigad[oa]|valeu|tudo certo|tudo bem|so isso|por enquanto nao)(?:\s*[,;.!?:-]?\s*(?:obrigad[oa]|valeu|tudo certo|tudo bem|so isso|por enquanto nao))?[.!?, ]*$/i.test(normalizedHelpReply);
        if (noOrThanks) {
          await setHoymilesState(conversationId, {
            status: 'CLOSING_PENDING',
            helpResponseMessageKey: messageKey(latestHelpReply),
            helpResponseText: latestHelpReply.text,
            closingReason: 'customer_declined_additional_help'
          });
          const closingSent = await sendHyperflowReply(HOYMILES_CLOSING_MESSAGE, conversationId);
          if (closingSent?.ok) {
            await setHoymilesState(conversationId, {
              status: 'READY_TO_CLOSE',
              closingMessageSent: true,
              closingSentAt: new Date().toISOString()
            });
            await sleep(900);
            const closeResult = await closeHyperflowAsSuccess(conversationId);
            if (closeResult?.ok) {
              await setHoymilesState(conversationId, { status: 'CLOSED_SUCCESS', closedAt: new Date().toISOString() });
            } else {
              await setHoymilesState(conversationId, { status: 'READY_TO_CLOSE', closeError: closeResult?.error || 'close_failed' });
              console.warn('[TARS Hoymiles] automatic close refused/failed; chat remains open', closeResult);
            }
            console.info('[TARS Hoymiles] customer declined additional help; closing message sent', { conversationId, closeResult });
          } else {
            await setHoymilesState(conversationId, { status: 'CLOSING_PENDING', closingSendError: closingSent?.error || 'send_failed' });
            console.warn('[TARS Hoymiles] closing message failed; chat will NOT be closed', closingSent);
          }
          return;
        }
      }

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

  const HOYMILES_TRIGGER_RE = /criar\s+conta\s+hoymiles/i;

  function setReactInputValue(input, value) {
    if (!input) return false;
    const nextValue = String(value ?? '');
    try {
      input.focus();
      if (input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, nextValue); else input.value = nextValue;
      } else if (input instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(input, nextValue); else input.value = nextValue;
      } else {
        input.value = nextValue;
      }
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: nextValue
      }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (error) {
      console.warn('[TARS Hoymiles] failed to set controlled input value', error);
      return false;
    }
  }

  function triggerDomClick(element) {
    if (!element) return false;
    try {
      element.focus?.();
      element.click();
      return true;
    } catch (error) {
      console.warn('[TARS Hoymiles] click failed', error);
      return false;
    }
  }

  async function closeHyperflowAsSuccess(expectedConversationId = null) {
    if (!expectedConversationId) return { ok: false, error: 'missing_conversation_id' };
    const identity = findConversationIdentity();
    if (identity.conversationId !== expectedConversationId) {
      console.error('[TARS Hoymiles SAFETY] refusing to close chat: conversation mismatch', {
        expectedConversationId,
        currentConversationId: identity.conversationId,
        currentProtocol: identity.ticketId || null,
        currentUrl: location.href
      });
      return { ok: false, error: 'conversation_identity_mismatch' };
    }

    const closeButton = await waitFor(() => {
      const el = document.querySelector('button.option-close_chat[aria-label="Encerrar atendimento"]');
      return el && visible(el) ? el : null;
    }, 8000, 150);

    const beforeClick = findConversationIdentity();
    if (beforeClick.conversationId !== expectedConversationId) {
      return { ok: false, error: 'conversation_identity_mismatch_before_close' };
    }
    if (!triggerDomClick(closeButton)) return { ok: false, error: 'close_button_click_failed' };

    const dialog = await waitFor(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      return dialogs.find(d =>
        d.querySelector('input[name="status"][value="success"]') &&
        d.querySelector('#classifications')
      ) || dialogs.find(d => /Encerrar atendimento/i.test(cleanText(d.innerText || d.textContent || ''))) || null;
    }, 8000, 150);
    if (!dialog) return { ok: false, error: 'close_dialog_not_found' };

    const successRadio = dialog.querySelector('input[name="status"][value="success"]');
    if (!successRadio) return { ok: false, error: 'success_status_radio_not_found' };
    if (!successRadio.checked) {
      const label = successRadio.closest('label');
      if (!triggerDomClick(label || successRadio)) return { ok: false, error: 'success_status_click_failed' };
      await sleep(150);
    }
    if (!successRadio.checked) return { ok: false, error: 'success_status_not_selected' };

    const classification = dialog.querySelector('#classifications[aria-label="Selecione uma classificação"]');
    if (!classification) return { ok: false, error: 'classification_input_not_found' };

    const classificationRoot = classification.parentElement?.parentElement || classification.parentElement;
    const pickerButton = [
      ...classificationRoot?.querySelectorAll('button.MuiAutocomplete-popupIndicator, button[aria-label="Aberto"], button[title="Aberto"]') || [],
      ...dialog.querySelectorAll('button.MuiAutocomplete-popupIndicator, button[aria-label="Aberto"], button[title="Aberto"]'),
      ...dialog.querySelectorAll('svg path[d^="M699 353h-46.9"]').map?.(p => p.closest('button')) || []
    ].find(el => el && visible(el)) || null;
    console.info('[TARS Hoymiles] classification picker lookup', {
      found: !!pickerButton,
      aria: pickerButton?.getAttribute('aria-label') || null,
      title: pickerButton?.getAttribute('title') || null
    });
    if (pickerButton && visible(pickerButton)) {
      console.info('[TARS Hoymiles] opening classification picker', {
        buttonAria: pickerButton.getAttribute('aria-label'),
        buttonTitle: pickerButton.getAttribute('title')
      });
      if (!triggerDomClick(pickerButton)) return { ok: false, error: 'classification_picker_click_failed' };
      await waitFor(() => classification.getAttribute('aria-expanded') === 'true' ||
        [...document.querySelectorAll('[role="option"]')].some(visible), 2500, 100);
    } else {
      console.warn('[TARS Hoymiles] classification popup indicator not found; opening input directly');
      if (!triggerDomClick(classification)) return { ok: false, error: 'classification_input_click_failed' };
    }

    const CLASSIFICATION = 'Atendimento Concluído';
    const classificationNorm = norm(CLASSIFICATION);

    const hasClassificationChip = () => !![
      ...dialog.querySelectorAll('.MuiAutocomplete-tag .MuiChip-label, .MuiChip-label')
    ].find(el => norm(el.innerText || el.textContent) === classificationNorm);

    const getClassificationOption = () => [...document.querySelectorAll('[role="option"]')]
      .filter(visible)
      .find(el => norm(el.innerText || el.textContent) === classificationNorm) || null;

    const openClassificationPopup = async () => {
      if (classification.getAttribute('aria-expanded') === 'true' || getClassificationOption()) return true;
      const root = classification.parentElement?.parentElement || classification.parentElement;
      const button = [
        ...root?.querySelectorAll('button.MuiAutocomplete-popupIndicator, button[aria-label="Aberto"], button[title="Aberto"]') || [],
        ...dialog.querySelectorAll('button.MuiAutocomplete-popupIndicator, button[aria-label="Aberto"], button[title="Aberto"]')
      ].find(el => visible(el)) || null;
      if (button) {
        if (!triggerDomClick(button)) return false;
      } else {
        if (!triggerDomClick(classification)) return false;
      }
      return !!await waitFor(() => classification.getAttribute('aria-expanded') === 'true' || getClassificationOption(), 2500, 100);
    };

    if (!setReactInputValue(classification, CLASSIFICATION)) {
      return { ok: false, error: 'classification_input_failed' };
    }
    classification.focus();
    await sleep(350);

    let option = await waitFor(getClassificationOption, 5000, 150);
    if (!option) {
      if (!(await openClassificationPopup())) return { ok: false, error: 'classification_popup_not_opened' };
      option = await waitFor(getClassificationOption, 3000, 100);
    }
    if (!option) return { ok: false, error: 'classification_option_not_found' };

    console.info('[TARS Hoymiles] classification option found', {
      text: cleanText(option.innerText || option.textContent || ''),
      id: option.id || null,
      ariaSelected: option.getAttribute('aria-selected') || null
    });

    const reactClickFallback = async (target) => {
      try {
        const reactPropsKey = Object.keys(target).find(key => key.startsWith('__reactProps$'));
        const reactProps = reactPropsKey ? target[reactPropsKey] : null;
        const onClick = reactProps?.onClick;
        if (typeof onClick !== 'function') return false;
        console.info('[TARS Hoymiles] invoking React option onClick fallback', {
          optionId: target.id || null
        });
        const nativeEvent = new MouseEvent('click', {
          bubbles: true, cancelable: true, composed: true, view: window,
          button: 0, buttons: 0
        });
        const reactEvent = {
          nativeEvent,
          target,
          currentTarget: target,
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; nativeEvent.preventDefault(); },
          stopPropagation() { nativeEvent.stopPropagation(); },
          stopImmediatePropagation() { nativeEvent.stopImmediatePropagation?.(); },
          persist() {}
        };
        onClick(reactEvent);
        await sleep(500);
        return true;
      } catch (error) {
        console.warn('[TARS Hoymiles] React option handler fallback failed', error);
        return false;
      }
    };

    const commitOption = async (target) => {
      if (!target || !visible(target)) return false;
      try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}

      try {
        console.info('[TARS Hoymiles] committing classification via DOM click');
        target.click();
        await sleep(500);
        if (hasClassificationChip()) return true;
      } catch (error) {
        console.warn('[TARS Hoymiles] DOM click classification failed', error);
      }

      let current = getClassificationOption() || target;
      if (current && visible(current)) {
        try {
          const mouseInit = {
            bubbles: true, cancelable: true, composed: true,
            view: window, button: 0, buttons: 1, clientX: 1, clientY: 1
          };
          current.dispatchEvent(new PointerEvent('pointerdown', {
            ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true
          }));
          current.dispatchEvent(new MouseEvent('mousedown', mouseInit));
          current.dispatchEvent(new PointerEvent('pointerup', {
            ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0
          }));
          current.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
          current.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
          await sleep(500);
          if (hasClassificationChip()) return true;
        } catch (error) {
          console.warn('[TARS Hoymiles] pointer classification commit failed', error);
        }
      }

      current = getClassificationOption();
      if (current && visible(current) && await reactClickFallback(current)) {
        if (hasClassificationChip()) return true;
      }

      return false;
    };

    let committed = await commitOption(option);

    if (!committed) {
      console.info('[TARS Hoymiles] classification click paths did not confirm; trying keyboard commit');
      await openClassificationPopup();
      option = await waitFor(getClassificationOption, 2500, 100);
      if (option) {
        try {
          classification.focus();
          if (option.id) classification.setAttribute('aria-activedescendant', option.id);
          classification.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40,
            bubbles: true, cancelable: true, composed: true, view: window
          }));
          await sleep(180);
          classification.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true, view: window
          }));
          await sleep(600);
        } catch (error) {
          console.warn('[TARS Hoymiles] keyboard classification commit failed', error);
        }
        committed = hasClassificationChip();
      }
    }

    if (!committed && !hasClassificationChip()) {
      console.info('[TARS Hoymiles] reopening classification picker for final commit');
      await openClassificationPopup();
      option = await waitFor(getClassificationOption, 2500, 100);
      if (option) committed = await reactClickFallback(option) && hasClassificationChip();
    }

    if (!committed && !hasClassificationChip()) {
      console.error('[TARS Hoymiles] classification selection not confirmed', {
        inputValue: classification.value,
        expanded: classification.getAttribute('aria-expanded'),
        activeDescendant: classification.getAttribute('aria-activedescendant'),
        options: [...document.querySelectorAll('[role="option"]')].filter(visible).map(el => ({
          text: cleanText(el.innerText || el.textContent || ''),
          id: el.id || null,
          selected: el.getAttribute('aria-selected') || null,
          focused: el.classList.contains('Mui-focused') || el.getAttribute('data-focus') === 'true'
        })),
        chips: [...dialog.querySelectorAll('.MuiAutocomplete-tag .MuiChip-label, .MuiChip-label')]
          .map(el => cleanText(el.innerText || el.textContent || ''))
      });
      return { ok: false, error: 'classification_not_confirmed' };
    }

    const chip = await waitFor(() =>
      [...dialog.querySelectorAll('.MuiAutocomplete-tag .MuiChip-label, .MuiChip-label')]
        .find(el => norm(el.innerText || el.textContent) === norm(CLASSIFICATION)) || null,
      3000,
      100
    );
    if (!chip) {
      console.error('[TARS Hoymiles] classification selection not confirmed', {
        inputValue: classification.value,
        expanded: classification.getAttribute('aria-expanded'),
        activeDescendant: classification.getAttribute('aria-activedescendant'),
        options: [...document.querySelectorAll('[role="option"]')].filter(visible).map(el => ({
          text: cleanText(el.innerText || el.textContent || ''),
          id: el.id || null,
          selected: el.getAttribute('aria-selected') || null,
          focused: el.classList.contains('Mui-focused') || el.getAttribute('data-focus') === 'true'
        })),
        chips: [...dialog.querySelectorAll('.MuiAutocomplete-tag .MuiChip-label, .MuiChip-label')]
          .map(el => cleanText(el.innerText || el.textContent || ''))
      });
      return { ok: false, error: 'classification_not_confirmed' };
    }
    console.info('[TARS Hoymiles] classification confirmed', { value: cleanText(chip.innerText || chip.textContent || '') });

    const submit = [...dialog.querySelectorAll('button#form-submit[type="submit"], button#form-submit, button[type="submit"]')]
      .find(el => visible(el)) || null;
    if (!submit) return { ok: false, error: 'close_submit_not_found' };
    if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') {
      await waitFor(() => !submit.disabled && submit.getAttribute('aria-disabled') !== 'true', 3000, 100);
    }
    if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: 'close_submit_not_ready' };
    }
    console.info('[TARS Hoymiles] submitting close chat', { text: cleanText(submit.innerText || submit.textContent || '') });

    const finalIdentity = findConversationIdentity();
    if (finalIdentity.conversationId !== expectedConversationId) {
      return { ok: false, error: 'conversation_identity_mismatch_before_submit' };
    }

    if (!triggerDomClick(submit)) return { ok: false, error: 'close_submit_click_failed' };
    console.info('[TARS Hoymiles] close chat submit clicked');
    const closed = await waitFor(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      return !dialogs.some(d =>
        d.querySelector('#classifications') ||
        d.querySelector('input[name="status"][value="success"]')
      );
    }, 8000, 150);
    if (!closed) return { ok: false, error: 'close_dialog_still_open' };

    console.info('[TARS Hoymiles] Hyperflow chat closed as success', {
      conversationId: expectedConversationId,
      protocol: finalIdentity.ticketId || null
    });
    return { ok: true, status: 'success', classification: 'Atendimento Concluído' };
  }

  async function sendReplyToComposer(text, expectedConversationId = null) {
    const value = String(text ?? '').trim();
    if (!value) return { ok: false, error: 'empty_reply' };
    if (emergencyStopped) return { ok: false, error: 'emergency_stopped' };

    if (expectedConversationId) {
      const currentConversation = findConversationIdentity();
      if (currentConversation.conversationId !== expectedConversationId) {
        console.error('[TARS Hoymiles SAFETY] refusing composer send: conversation mismatch', {
          expectedConversationId,
          currentConversationId: currentConversation.conversationId,
          expectedProtocol: null,
          currentProtocol: currentConversation.ticketId || null,
          currentUrl: location.href
        });
        return { ok: false, error: 'conversation_identity_mismatch', expectedConversationId, currentConversationId: currentConversation.conversationId };
      }
    }

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
      version: '1.2.88',
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

    attachScrollCapture();
    console.info('[TARS Hyperflow] observer started');
  }

  window.TARS_HOYMILES_DEBUG = Object.freeze({
    returnToOrigin: async () => {
      const result = await runtimeSendMessage({ type: 'TARS_HOYMILES_DEBUG_RETURN_TO_ORIGIN' });
      console.info('[TARS Hoymiles DEBUG] returnToOrigin result', result);
      return result;
    },
    origin: async () => {
      const result = await runtimeSendMessage({ type: 'TARS_HOYMILES_DEBUG_GET_ORIGIN' });
      console.info('[TARS Hoymiles DEBUG] stored origin', result);
      return result;
    },
    status: async () => {
      const result = await runtimeSendMessage({ type: 'TARS_HOYMILES_DEBUG_STATUS' });
      console.info('[TARS Hoymiles DEBUG] background status', result);
      return result;
    }
  });

  window.VisionBridge = Object.freeze({
    getConversation: async () => getSlaSnapshot(),
    syncConversation: async () => {
      const result = await runtimeSendMessage({ type: 'TARS_SLA_SYNC_HYPERFLOW', tabId: null });
      return result;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TARS_EMERGENCY_STOP') {
      emergencyStopped = true;
      console.warn('[TARS Hyperflow SAFETY] EMERGENCY STOP received; automatic replies and closure are halted');
      sendResponse({ ok: true, stopped: true });
      return true;
    }
    if (!msg || !msg.type || !msg.type.startsWith('HYPERFLOW_')) return;

    (async () => {
      if (msg.type === 'HYPERFLOW_DO_SEND_REPLY') {
        return await sendReplyToComposer(msg.text, msg.conversationId || null);
      }
      if (msg.type === 'HYPERFLOW_CLOSE_SUCCESS') {
        return await closeHyperflowAsSuccess(msg.conversationId || null);
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
        return await sendReplyToComposer(msg.text, msg.conversationId || null);
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
      if (msg.type === 'HYPERFLOW_GET_SLA_SNAPSHOT') {
        return { ok: true, snapshot: await getSlaSnapshot() };
      }
      if (msg.type === 'HYPERFLOW_GET_SLA_SNAPSHOTS_FOR_SYNC') {
        return { ok: true, snapshots: await getSlaSnapshotsForSync() };
      }
      if (msg.type === 'HYPERFLOW_PURGE_LOCAL_CAPTURE') {
        return await purgeLocalCapture();
      }
      return { ok: false, error: 'unknown_hyperflow_command' };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));

    return true;
  });

  start().catch(error => console.error('[TARS Hyperflow] startup failed', error));
})();
