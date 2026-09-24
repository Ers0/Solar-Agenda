// TARS Observer / Learning Mode content layer.
// Passive only: never sends customer-facing messages, never clicks on behalf of TARS,
// never records input values/keystrokes. Learning Mode adds cross-site workflow observation.
(() => {
  if (window.__tarsObserver) return;
  window.__tarsObserver = true;
  const VERSION = '1.2.83';
  const MAX_LABEL = 180;
  const MAX_EVENTS_PER_MINUTE = 180;
  let eventCount = 0;
  let windowStarted = Date.now();
  let lastUrl = location.href;
  let snapshotTimer = null;

  const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const enabled = async () => {
    try {
      const r = await chrome.storage.local.get(['tarsObserverMode','tarsLearningMode']);
      return r.tarsObserverMode === true || r.tarsLearningMode === true;
    } catch (_) { return false; }
  };
  const learningEnabled = async () => {
    try { const r = await chrome.storage.local.get(['tarsLearningMode']); return r.tarsLearningMode === true; }
    catch (_) { return false; }
  };
  const safePath = () => {
    try {
      const u = new URL(location.href);
      const path = u.pathname.replace(/\/+/g, '/').split('/').map(seg => {
        if (/^[0-9]{5,}$/.test(seg) || /^[a-f0-9]{16,}$/i.test(seg) || /^[0-9a-f-]{24,}$/i.test(seg)) return '[id]';
        return seg.length > 100 ? seg.slice(0,100) : seg;
      }).join('/');
      return u.origin + path;
    } catch (_) { return location.origin; }
  };
  const semanticText = el => {
    if (!el || !(el instanceof Element)) return '';
    if (el.matches('input,textarea,select,[contenteditable="true"]') || el.closest('input,textarea,select,[contenteditable="true"]')) return '';
    return clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '').slice(0, MAX_LABEL);
  };
  const emit = async (type, data={}) => {
    if (!(await enabled())) return;
    const now = Date.now();
    if (now - windowStarted >= 60000) { windowStarted = now; eventCount = 0; }
    if (eventCount >= MAX_EVENTS_PER_MINUTE) return;
    eventCount++;
    try {
      chrome.runtime.sendMessage({
        type: 'TARS_OBSERVER_EVENT',
        event: {
          eventId: crypto.randomUUID(), eventType: type,
          observedAt: new Date().toISOString(), version: VERSION,
          origin: location.origin, page: safePath(),
          title: clean(document.title).slice(0,180), ...data
        }
      });
    } catch (_) {}
  };

  function domStructure() {
    const pick = (selector, limit=20) => [...document.querySelectorAll(selector)].slice(0,limit)
      .map(el => semanticText(el)).filter(Boolean);
    const fields = [...document.querySelectorAll('input,textarea,select')].slice(0,30).map(el => ({
      tag: el.tagName.toLowerCase(), type: clean(el.getAttribute('type') || '').slice(0,30),
      name: clean(el.getAttribute('name') || '').slice(0,80),
      placeholder: clean(el.getAttribute('placeholder') || '').slice(0,120),
      aria: clean(el.getAttribute('aria-label') || '').slice(0,120)
    })).filter(x => !/password|token|secret|api[-_ ]?key/i.test(`${x.type} ${x.name} ${x.placeholder} ${x.aria}`));
    return {
      headings: pick('h1,h2,h3,h4,[role="heading"]', 20),
      buttons: pick('button,[role="button"]', 30),
      links: pick('a,[role="link"]', 25),
      navigation: pick('nav,[role="navigation"] [role="menuitem"],aside', 20),
      tabs: pick('[role="tab"]', 20),
      forms: pick('form', 10),
      fields,
      bodyTextSample: clean(document.body?.innerText || '').slice(0,2500)
    };
  }

  async function emitSnapshot(reason) {
    if (!(await learningEnabled())) return;
    const dom = domStructure();
    emit('DOM_STRUCTURE_SNAPSHOT', { reason, dom });
  }

  document.addEventListener('click', ev => {
    const el = ev.target instanceof Element ? ev.target.closest('button,a,[role="button"],[role="menuitem"],[role="tab"]') : null;
    if (!el) return;
    if (el.closest('.message-in-wrapper,.message-out-wrapper,.list-messages')) return;
    const label = semanticText(el);
    if (!label) return;
    emit('TECHNICIAN_UI_ACTION', {
      action: 'click', targetRole: el.getAttribute('role') || el.tagName.toLowerCase(), target: label
    });
  }, true);

  const reportNavigation = () => {
    if (location.href === lastUrl) return;
    const previous = lastUrl; lastUrl = location.href;
    emit('PAGE_NAVIGATION', { previousPage: previous.split('?')[0].split('#')[0].slice(0,240), page: safePath() });
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => emitSnapshot('navigation'), 700);
  };
  for (const method of ['pushState','replaceState']) {
    const original = history[method];
    history[method] = function(...args) { const result = original.apply(this,args); setTimeout(reportNavigation,0); return result; };
  }
  window.addEventListener('popstate', reportNavigation);
  window.addEventListener('hashchange', reportNavigation);
  setInterval(reportNavigation, 1000);

  emit('OBSERVER_ATTACHED', { mode: 'observer', learningCapable: true });
  emitSnapshot('initial');
})();
