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

// ------------------------------------------------- extension -> page ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'RELAY_TO_APP') return;

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
try {
  chrome.runtime.sendMessage({ type: 'RELAY_READY', url: window.location.href });
} catch (e) { /* the worker may be asleep; discovery still works without this */ }
