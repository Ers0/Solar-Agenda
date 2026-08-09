const SUPABASE_URL = "https://iqclmfebspladyuzwwpy.supabase.co";
const FN_URL = SUPABASE_URL + "/functions/v1";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxY2xtZmVic3BsYWR5dXp3d3B5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMTYzNDcsImV4cCI6MjEwMTY5MjM0N30.Rz3nb7Zo_IFOeWa1cbQgOHjuRZ4FliDeZhC6NfBpvZM";
const SESSION_KEY = "agenda-solar-session";

let session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
let cases = [];
let notebooks = [];
let editingId = null;
let activeNotebookId = null;
let calendarMonth = new Date();
calendarMonth.setDate(1);

function todayStr(){ return new Date().toLocaleDateString('en-CA'); } // yyyy-mm-dd local

function authHeaders(extra){
  return Object.assign({ "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": "Bearer " + (session ? session.token : "") }, extra || {});
}

// --- Auth ---
async function login(name, password){
  const resp = await fetch(FN_URL + "/agenda-login", { method: "POST", headers: { "Content-Type": "application/json", "apikey": ANON_KEY }, body: JSON.stringify({ name, password }) });
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error || "Login failed.");
  return data;
}
function showApp(){ document.getElementById("login-screen").classList.add("hidden"); document.getElementById("app-root").classList.remove("hidden"); document.getElementById("user-pill").textContent = session.name; }
function showLogin(){ document.getElementById("login-screen").classList.remove("hidden"); document.getElementById("app-root").classList.add("hidden"); }

document.getElementById("login-btn").addEventListener("click", doLogin);
document.getElementById("login-password").addEventListener("keydown", (e) => { if(e.key === "Enter") doLogin(); });

async function doLogin(){
  const name = document.getElementById("login-name").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if(!name || !password){ errEl.textContent = "Enter both username and password."; return; }
  try{
    const data = await login(name, password);
    session = { token: data.token, name: data.name, expires_at: data.expires_at };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    showApp();
    await Promise.all([loadCases(), loadNotebooks(), loadNotes()]);
    loadWeather();
  }catch(err){ errEl.textContent = err.message; }
}
document.getElementById("logout-btn").addEventListener("click", () => { session = null; localStorage.removeItem(SESSION_KEY); showLogin(); });

// --- View switching ---
document.getElementById("tab-agenda").addEventListener("click", () => switchView("agenda"));
document.getElementById("tab-history").addEventListener("click", () => switchView("history"));
document.getElementById("tab-calendar").addEventListener("click", () => switchView("calendar"));
document.getElementById("tab-notebooks").addEventListener("click", () => switchView("notebooks"));
document.getElementById("tab-settings").addEventListener("click", () => switchView("settings"));
function switchView(view){
  ["agenda","history","calendar","notebooks","settings"].forEach(v => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== view);
    document.getElementById("tab-" + v).classList.toggle("active", v === view);
  });
  // keep the mobile bottom bar in sync with the desktop pill tabs
  document.querySelectorAll('.bn-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  SFX.tick();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if(view === "calendar") renderCalendar();
  if(view === "history") renderHistory();
  if(view === "settings") renderSettings();
}
document.querySelectorAll('.bn-item').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// --- Cases API ---
async function loadCases(){
  const resp = await fetch(FN_URL + "/agenda-cases", { headers: authHeaders() });
  if(resp.status === 401){ session = null; localStorage.removeItem(SESSION_KEY); showLogin(); return; }
  cases = await resp.json();
  render();
}
async function createCase(payload){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  if(!resp.ok) throw new Error((await resp.json()).error || "Error creating case.");
  return resp.json();
}
async function updateCase(id, payload){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ id, ...payload }) });
  if(!resp.ok) throw new Error((await resp.json()).error || "Error updating case.");
  return resp.json();
}
async function deleteCaseApi(id){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ id }) });
  if(!resp.ok) throw new Error((await resp.json()).error || "Error deleting case.");
}

function prioLabel(p){ return {urgente:'Urgent', alta:'High', media:'Medium', baixa:'Low'}[p] || p; }
function statusRank(s){ return s === 'pending' || !s ? 0 : 1; }
function prioColor(p){ return {urgente:'#e15b4c', alta:'#f2a71b', media:'#4fa3a0', baixa:'#6d7f92'}[p] || '#6d7f92'; }
function blocoLabel(b){ return {'primeira-hora':'First hour', manha:'Morning', tarde:'Afternoon', 'fim-do-dia':'End of day'}[b] || b; }

function render(){ renderFirstHour(); renderBlocks(); renderArc(); updateHudStrip(); }

function todaysCases(){ const t = todayStr(); return cases.filter(c => (c.case_date || t) === t); }
function pendingTodaysCases(){ return todaysCases().filter(c => statusRank(c.status) === 0); }

function makeCaseCard(c){
  const div = document.createElement('div');
  div.className = 'case-card prio-' + c.prioridade + (c.status && c.status !== 'pending' ? ' status-' + c.status : '');
  const statusIcon = c.status === 'success' ? '<span class="status-icon success">✓</span>' : c.status === 'failed' ? '<span class="status-icon failed">✕</span>' : '';
  div.innerHTML = `
    <span class="swipe-hint hint-success">✓</span>
    <span class="swipe-hint hint-fail">✕</span>
    <div class="case-top">
      <div class="case-title">${escapeHtml(c.titulo || '(untitled)')}</div>
    </div>
    ${statusIcon}
    <div class="case-meta">
      <span class="chip">${prioLabel(c.prioridade)}</span>
      ${c.ticket ? `<span class="chip mono">${escapeHtml(c.ticket)}</span>` : ''}
      ${c.horario ? `<span class="chip">${c.horario}</span>` : ''}
      ${(c.tags || []).map(t => `<span class="chip tag"><span class="tag-hash">#</span>${escapeHtml(t)}</span>`).join('')}
    </div>`;
  attachCardGestures(div, c);
  return div;
}

// Swipe right = mark resolved (success), swipe left = mark failed,
// press-and-hold = open the edit modal (postpone / add info), plain tap = open the edit modal too.
function attachCardGestures(cardEl, c){
  const THRESHOLD = 90;
  const LONG_PRESS_MS = 480;
  // `pressed` is the fix for the desktop bug: without it, pointermove fired on
  // plain hover and cards slid around under the cursor with no button held.
  let startX = 0, startY = 0, dx = 0, dragging = false, pressed = false,
      longPressTimer = null, longPressTriggered = false;

  function reset(){
    cardEl.classList.remove('swiping');
    cardEl.style.transform = '';
    cardEl.style.opacity = '';
    cardEl.querySelector('.hint-success').style.opacity = 0;
    cardEl.querySelector('.hint-fail').style.opacity = 0;
  }

  cardEl.addEventListener('pointerdown', (e) => {
    if(e.button !== undefined && e.button !== 0) return;
    pressed = true;
    startX = e.clientX; startY = e.clientY; dx = 0; dragging = false; longPressTriggered = false;
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      reset();
      openModal(c.id);
    }, LONG_PRESS_MS);
    cardEl.setPointerCapture?.(e.pointerId);
  });

  cardEl.addEventListener('pointermove', (e) => {
    if(!pressed || longPressTriggered) return;
    // mouse released outside the card (e.g. over a modal) — bail out cleanly
    if(e.pointerType === 'mouse' && e.buttons === 0){ pressed = false; clearTimeout(longPressTimer); reset(); return; }
    const mdx = e.clientX - startX, mdy = e.clientY - startY;
    if(!dragging && (Math.abs(mdx) > 10 || Math.abs(mdy) > 10)){
      dragging = true;
      clearTimeout(longPressTimer);
      cardEl.classList.add('swiping');
    }
    if(dragging){
      dx = mdx;
      cardEl.style.transform = `translateX(${dx}px)`;
      const ratio = Math.max(-1, Math.min(1, dx / THRESHOLD));
      cardEl.querySelector('.hint-success').style.opacity = Math.max(0, ratio);
      cardEl.querySelector('.hint-fail').style.opacity = Math.max(0, -ratio);
    }
  });

  async function finish(e){
    if(!pressed) return;
    pressed = false;
    clearTimeout(longPressTimer);
    cardEl.releasePointerCapture?.(e.pointerId);
    if(longPressTriggered) return;
    if(dragging){
      if(dx > THRESHOLD){
        cardEl.style.transform = `translateX(500px)`; cardEl.style.opacity = '0';
        const nowTime = new Date().toTimeString().slice(0,5);
        SFX.success();
        try{ await updateCase(c.id, { status: 'success', actual_end: nowTime }); c.status = 'success'; c.actual_end = nowTime; }catch(err){ alert(err.message); }
        render(); renderHistory();
      } else if(dx < -THRESHOLD){
        cardEl.style.transform = `translateX(-500px)`; cardEl.style.opacity = '0';
        const nowTime = new Date().toTimeString().slice(0,5);
        SFX.fail();
        try{ await updateCase(c.id, { status: 'failed', actual_end: nowTime }); c.status = 'failed'; c.actual_end = nowTime; }catch(err){ alert(err.message); }
        render(); renderHistory();
      } else {
        reset();
      }
    } else {
      openModal(c.id);
    }
  }
  cardEl.addEventListener('pointerup', finish);
  cardEl.addEventListener('pointercancel', () => { pressed = false; clearTimeout(longPressTimer); reset(); });
  cardEl.addEventListener('pointerleave', (e) => {
    if(pressed && e.pointerType === 'mouse' && e.buttons === 0){ pressed = false; clearTimeout(longPressTimer); reset(); }
  });
}

function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

function renderFirstHour(){
  const list = document.getElementById('first-hour-list');
  list.innerHTML = '';
  const items = pendingTodaysCases().filter(c => c.bloco === 'primeira-hora' || c.prioridade === 'urgente')
                      .sort((a,b) => (a.horario || '').localeCompare(b.horario || ''));
  if(items.length === 0){ list.innerHTML = '<div class="empty">No urgent cases right now. Use the first hour to plan your day.</div>'; return; }
  items.forEach(c => list.appendChild(makeCaseCard(c)));
}
function renderBlocks(){
  const container = document.getElementById('blocks-container');
  container.innerHTML = '';
  const today = pendingTodaysCases();
  ['manha', 'tarde', 'fim-do-dia'].forEach(b => {
    const items = today.filter(c => c.bloco === b).sort((a,b2) => (a.horario||'').localeCompare(b2.horario||''));
    const group = document.createElement('div');
    group.className = 'block-group';
    group.innerHTML = `<h3>${blocoLabel(b)}</h3>`;
    const list = document.createElement('div');
    list.className = 'case-list';
    if(items.length === 0){ list.innerHTML = '<div class="empty">No cases in this block.</div>'; }
    else { items.forEach(c => list.appendChild(makeCaseCard(c))); }
    group.appendChild(list);
    container.appendChild(group);
  });
}

// Full 24h dial. Work hours are highlighted rather than being the whole
// scale, so evening work from home still has somewhere to land.
// The dial has two faces. Day shows 07h-18h; night shows 18h-07h (hours past
// midnight are carried as 24-31 so the maths stays linear). Crossing between
// them spins the wheel edge-on and the other face comes up.
const PHASES = { day: { s: 7, e: 18 }, night: { s: 18, e: 31 } };
const WORK_START = 8, WORK_END = 18;
let curPhase = 'day';
function phaseRange(){ return PHASES[curPhase]; }
function isNightHour(h){ return h >= 18 || h < 7; }
// map a real clock hour onto the active face, or null if it isn't on it
function toFaceHour(h){
  const { s, e } = phaseRange();
  if(h >= s && h <= e) return h;
  if(h + 24 >= s && h + 24 <= e) return h + 24;   // early morning on the night face
  return null;
}
function hourToAngle(h){
  const { s, e } = phaseRange();
  const t = Math.min(1, Math.max(0, (h - s) / (e - s)));
  return Math.PI - t * Math.PI;
}
function arcPoint(angle, r){ const cx = 400, cy = 190; return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) }; }

function renderHistory(){
  const container = document.getElementById('history-container');
  container.innerHTML = '';
  const finished = cases.filter(c => statusRank(c.status) === 1)
                         .sort((a,b) => (b.case_date || '').localeCompare(a.case_date || ''));
  if(finished.length === 0){
    container.innerHTML = '<div class="empty">No finished cases yet. Swipe a case right or left on the Agenda tab.</div>';
    return;
  }
  const byDate = {};
  finished.forEach(c => { const d = c.case_date || 'Unknown date'; (byDate[d] = byDate[d] || []).push(c); });
  Object.keys(byDate).sort((a,b) => b.localeCompare(a)).forEach(dateStr => {
    const group = document.createElement('div');
    group.className = 'history-date-group';
    const label = dateStr === todayStr() ? 'Today' : new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
    group.innerHTML = `<h3>${label}</h3>`;
    const list = document.createElement('div');
    list.className = 'case-list';
    byDate[dateStr].forEach(c => list.appendChild(makeCaseCard(c)));
    group.appendChild(list);
    container.appendChild(group);
  });
}

function renderArc(){
  const svg = document.getElementById('day-arc');
  const r = 160;
  const { s: FS, e: FE } = phaseRange();
  const night = curPhase === 'night';
  const AC = night ? 'var(--accent2)' : 'var(--amber)';
  let parts = [];

  parts.push(`<defs>
    <linearGradient id="arcTrack" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${night ? 'var(--dusk)' : 'var(--amber)'}" stop-opacity="0.55"/>
      <stop offset="38%" stop-color="${night ? 'var(--accent2)' : 'var(--accent3)'}" stop-opacity="0.5"/>
      <stop offset="70%" stop-color="var(--line)" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${night ? 'var(--dusk)' : 'var(--accent2)'}" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="arcFirstHour" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${night ? 'var(--accent2)' : 'var(--amber)'}"/>
      <stop offset="55%" stop-color="${night ? 'var(--dusk)' : 'var(--accent3)'}"/>
      <stop offset="100%" stop-color="${night ? 'var(--panel-2)' : 'var(--accent2)'}"/>
    </linearGradient>
    <filter id="bloom" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`);

  const pS = arcPoint(hourToAngle(FS), r), pE = arcPoint(hourToAngle(FE), r);
  parts.push(`<path d="M ${pS.x} ${pS.y} A ${r} ${r} 0 0 1 ${pE.x} ${pE.y}" fill="none" stroke="${AC}" stroke-width="14" stroke-opacity="0.05" stroke-linecap="round"/>`);
  parts.push(`<path d="M ${pS.x} ${pS.y} A ${r} ${r} 0 0 1 ${pE.x} ${pE.y}" fill="none" stroke="url(#arcTrack)" stroke-width="3" stroke-linecap="round"/>`);

  // day: highlight the first working hour. night: highlight the evening stretch.
  const hlS = night ? 18 : WORK_START, hlE = night ? 22 : WORK_START + 1;
  const hS = arcPoint(hourToAngle(hlS), r), hE = arcPoint(hourToAngle(hlE), r);
  parts.push(`<path d="M ${hS.x} ${hS.y} A ${r} ${r} 0 0 1 ${hE.x} ${hE.y}" fill="none" stroke="url(#arcFirstHour)" stroke-width="5" stroke-linecap="round" filter="url(#bloom)"/>`);

  for(let h = FS; h <= FE; h++){
    const major = (h - FS) % 2 === 0;   // every 2h on both faces, evenly spaced
    const p = arcPoint(hourToAngle(h), r), pO = arcPoint(hourToAngle(h), r + (major ? 12 : 7));
    parts.push(`<line x1="${p.x}" y1="${p.y}" x2="${pO.x}" y2="${pO.y}" stroke="${major ? AC : 'var(--line)'}" stroke-opacity="${major ? 0.7 : 0.35}" stroke-width="2"/>`);
    if(major){
      const pL = arcPoint(hourToAngle(h), r + 27);
      parts.push(`<text x="${pL.x}" y="${pL.y + 3}" fill="var(--text)" font-size="11" text-anchor="middle" font-family="JetBrains Mono, monospace">${String(h % 24).padStart(2,'0')}h</text>`);
    }
  }

  const now = new Date();
  const nowFace = toFaceHour(now.getHours() + now.getMinutes() / 60);
  if(nowFace !== null){
    const p = arcPoint(hourToAngle(nowFace), r);
    parts.push(`<line x1="400" y1="190" x2="${p.x}" y2="${p.y}" stroke="${AC}" stroke-width="1.5" stroke-opacity="0.28" stroke-dasharray="4 5"/>`);
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="7" fill="none" stroke="${AC}" stroke-width="2" stroke-opacity="0.5">
      <animate attributeName="r" values="7;20;7" dur="3s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="3s" repeatCount="indefinite"/></circle>`);
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="7" fill="${AC}" filter="url(#bloom)"><animate attributeName="r" values="6;9;6" dur="2.4s" repeatCount="indefinite"/></circle>`);
    if(night) parts.push(`<circle cx="${p.x + 3}" cy="${p.y - 2.4}" r="5.4" fill="var(--panel)"/>`);
  }

  function timeToHour(t){ const [hh, mm] = t.split(':').map(Number); return hh + (mm || 0) / 60; }
  pendingTodaysCases().forEach(c2 => {
    if(!c2.horario) return;
    const h = toFaceHour(timeToHour(c2.horario));
    if(h === null) return;                       // belongs to the other face
    if(c2.horario_fim){
      const hEnd = Math.max(h, Math.min(FE, toFaceHour(timeToHour(c2.horario_fim)) ?? FE));
      const a = arcPoint(hourToAngle(h), r), b = arcPoint(hourToAngle(hEnd), r);
      parts.push(`<g class="arc-dot" data-id="${c2.id}"><path d="M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}" fill="none" stroke="${prioColor(c2.prioridade)}" stroke-width="7" stroke-linecap="round" stroke-opacity="0.6" filter="url(#bloom)"/></g>`);
    } else {
      const p = arcPoint(hourToAngle(h), r);
      parts.push(`<g class="arc-dot" data-id="${c2.id}"><circle cx="${p.x}" cy="${p.y}" r="5.5" fill="${prioColor(c2.prioridade)}" stroke="var(--bg)" stroke-width="2" filter="url(#bloom)"/></g>`);
    }
  });

  if(night){
    for(let i = 0; i < 16; i++){
      parts.unshift(`<circle class="arc-star" cx="${60 + ((i * 137) % 690)}" cy="${-14 + ((i * 53) % 120)}" r="${0.7 + ((i * 7) % 3) * 0.35}" fill="var(--text)" opacity="0.5" style="animation-delay:${(i % 7) * 0.42}s"/>`);
    }
  }

  svg.innerHTML = parts.join('');
  svg.querySelectorAll('.arc-dot').forEach(el => el.addEventListener('click', () => openModal(el.getAttribute('data-id'))));
  document.getElementById('clock-label').textContent = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  const cnt = document.getElementById('face-count');
  if(cnt){
    const n = pendingTodaysCases().filter(x => x.horario && toFaceHour(timeToHour(x.horario)) !== null).length;
    cnt.textContent = n ? `${n} on this face` : 'nothing scheduled';
  }
}

// The wheel spins edge-on, swaps face while it is invisible, then rolls back.
let spinning = false;
function spinToPhase(night, silent){
  const svg = document.getElementById('day-arc');
  const wrap = document.querySelector('.arc-wrap');
  const target = night ? 'night' : 'day';
  if(!svg || curPhase === target || spinning){ curPhase = target; renderArc(); applyPhaseChrome(night); return; }
  spinning = true;
  wrap?.classList.add('spinning');
  if(!silent) SFX.phase(night);

  svg.style.transition = 'transform .52s cubic-bezier(.55,.06,.68,.19), filter .52s ease';
  svg.style.transform = 'perspective(950px) rotateX(90deg)';
  svg.style.filter = 'brightness(1.6)';

  setTimeout(() => {
    curPhase = target;
    renderArc();
    applyPhaseChrome(night);
    svg.style.transition = 'none';
    svg.style.transform = 'perspective(950px) rotateX(-90deg)';
    requestAnimationFrame(() => {
      svg.style.transition = 'transform .6s cubic-bezier(.16,.9,.3,1), filter .6s ease';
      svg.style.transform = 'perspective(950px) rotateX(0deg)';
      svg.style.filter = 'none';
      setTimeout(() => { spinning = false; wrap?.classList.remove('spinning'); }, 620);
    });
  }, 530);
}

function applyPhaseChrome(night){
  const wrap = document.querySelector('.arc-wrap');
  if(wrap) wrap.classList.toggle('night', night);
  const lab = document.getElementById('phase-label');
  if(lab) lab.textContent = night ? 'NIGHT' : 'DAY';
  const ico = document.querySelector('.phase-ico');
  if(ico) ico.innerHTML = night
    ? '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5z"/>'
    : '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
}

// watch the clock and spin when the real phase changes
let phaseOverride = null, lastRealNight = null;
function syncPhase(){
  const realNight = isNightHour(new Date().getHours());
  const want = phaseOverride !== null ? phaseOverride : realNight;
  const first = lastRealNight === null;
  lastRealNight = realNight;
  if(first){ curPhase = want ? 'night' : 'day'; renderArc(); applyPhaseChrome(want); return; }
  if((curPhase === 'night') !== want) spinToPhase(want, false);
}

// Preview the opposite face on demand — otherwise you'd wait until 18:00 to
// find out whether the spin works.
document.getElementById('phase-pill').addEventListener('click', () => {
  const realNight = isNightHour(new Date().getHours());
  phaseOverride = (phaseOverride === null) ? !realNight : null;
  spinToPhase(phaseOverride !== null ? phaseOverride : realNight, false);
});

setInterval(() => { syncPhase(); renderArc(); if(!document.getElementById('view-calendar').classList.contains('hidden')) renderCalendar(); }, 15000);

// --- HUD mode -------------------------------------------------------
// F11 does NOT fire the Fullscreen API's fullscreenchange event, so we
// detect it three ways: the display-mode media query (which Chrome does
// flip on F11), the Fullscreen API for the button path, and a viewport
// heuristic as a backstop. A manual toggle covers anything that slips through.
const fsQuery = window.matchMedia('(display-mode: fullscreen)');
let hudActive = false;
let hudManual = false; // set when the user forces it via the button

function viewportIsFullscreen(){
  return Math.abs(window.innerHeight - screen.height) <= 3;
}
function detectHud(){
  if(hudManual) return;
  setHudMode(fsQuery.matches || !!document.fullscreenElement || viewportIsFullscreen());
}
function setHudMode(on){
  if(on === hudActive) return;
  hudActive = on;
  document.body.classList.toggle('hud-mode', on);
  if(on){ runBootSequence(); updateHudStrip(); }
  renderArc();
}
fsQuery.addEventListener('change', detectHud);
document.addEventListener('fullscreenchange', detectHud);
window.addEventListener('resize', detectHud);

document.getElementById('hud-toggle').addEventListener('click', async () => {
  if(hudActive){
    hudManual = false;
    if(document.fullscreenElement) { try{ await document.exitFullscreen(); }catch(e){} }
    setHudMode(false);
  } else {
    try{ await document.documentElement.requestFullscreen(); }
    catch(e){ hudManual = true; } // fullscreen refused — still give them the HUD look
    setHudMode(true);
  }
});

// --- Boot intro ------------------------------------------------------
const BOOT_STEPS = [
  ['INITIALISING INTERFACE', 'OK'],
  ['LINKING SUPABASE NODE', 'OK'],
  ['LOADING CASE REGISTRY', 'OK'],
  ['SYNCING NOTEBOOKS', 'OK'],
  ['ASSISTANT UPLINK', 'READY'],
  ['WEATHER FEED', 'OK'],
  ['DIAGNOSTICS', 'PASS'],
];
let bootTimers = [];
// Timings lifted straight from the reference analysis, so the visuals land on
// the audio: lines run through the riser (1.0s -> 2.2s), the confirmation hits
// the activation burst (2.75s), and the overlay clears while the tail decays.
const BOOT_T = { firstLine: 1.0, step: 0.24, online: 2.75, end: 3.55 };

function runBootSequence(){
  const overlay = document.getElementById('boot-overlay');
  const linesEl = document.getElementById('boot-lines');
  const fill = document.getElementById('boot-bar-fill');
  linesEl.innerHTML = '';
  if(fill) fill.style.width = '0%';
  overlay.classList.remove('fading');
  overlay.classList.add('on');

  bootTimers.forEach(clearTimeout);
  bootTimers = [];
  SFX.bootStart();

  BOOT_STEPS.forEach(([label, state], i) => {
    bootTimers.push(setTimeout(() => {
      const row = document.createElement('div');
      row.className = 'boot-line';
      row.innerHTML = `<span>${label}</span><span>${state}</span>`;
      linesEl.appendChild(row);
      SFX.bootTick(i);
      if(fill) fill.style.width = Math.round(((i + 1) / BOOT_STEPS.length) * 85) + '%';
    }, (BOOT_T.firstLine + i * BOOT_T.step) * 1000));
  });

  bootTimers.push(setTimeout(() => {
    const row = document.createElement('div');
    row.className = 'boot-line final';
    row.innerHTML = `<span>SYSTEM</span><span>ONLINE</span>`;
    linesEl.appendChild(row);
    if(fill) fill.style.width = '100%';
    document.querySelector('.boot-core')?.classList.add('surge');
  }, BOOT_T.online * 1000));

  bootTimers.push(setTimeout(endBootSequence, BOOT_T.end * 1000));
}
function endBootSequence(){
  const overlay = document.getElementById('boot-overlay');
  if(!overlay.classList.contains('on')) return;
  bootTimers.forEach(clearTimeout);
  bootTimers = [];
  overlay.classList.add('fading');
  setTimeout(() => { overlay.classList.remove('on', 'fading');
    document.querySelector('.boot-core')?.classList.remove('surge'); }, 550);
}
document.getElementById('boot-overlay').addEventListener('click', endBootSequence);

// --- HUD telemetry strip ---------------------------------------------
function updateHudStrip(){
  if(!hudActive) return;
  const today = todaysCases();
  const pending = today.filter(c => statusRank(c.status) === 0);
  const done = today.filter(c => statusRank(c.status) === 1);
  const urgent = pending.filter(c => c.prioridade === 'urgente');

  document.getElementById('hud-date').textContent =
    new Date().toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }).toUpperCase();
  document.getElementById('hud-open').textContent = pending.length;
  document.getElementById('hud-urgent').textContent = urgent.length;
  document.getElementById('hud-done').textContent = done.length;
  document.getElementById('hud-nb').textContent = notebooks.length;

  const upcoming = pending.filter(c => c.horario).sort((a,b) => a.horario.localeCompare(b.horario))[0];
  document.getElementById('hud-next').textContent =
    upcoming ? `NEXT ${upcoming.horario} · ${(upcoming.titulo || '').slice(0, 34).toUpperCase()}` : 'NEXT —';
}

// --- Case modal ---
function initCustomSelect(id, labels){
  const hidden = document.getElementById(id);
  const wrap = document.getElementById(id + '-wrap');
  const trigger = document.getElementById(id + '-trigger');
  const panel = document.getElementById(id + '-panel');
  const labelEl = trigger.querySelector('.select-trigger-label');

  function render(){
    labelEl.textContent = labels[hidden.value] || Object.values(labels)[0];
    panel.querySelectorAll('.select-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.value === hidden.value);
    });
  }
  function close(){ wrap.classList.remove('open'); }
  function setValue(v){ hidden.value = v; render(); }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.select-wrap.open').forEach(w => { if(w !== wrap) w.classList.remove('open'); });
    wrap.classList.toggle('open');
  });
  panel.querySelectorAll('.select-option').forEach(el => {
    el.addEventListener('click', () => { setValue(el.dataset.value); close(); });
  });
  document.addEventListener('click', (e) => { if(!wrap.contains(e.target)) close(); });

  render();
  return { render, setValue };
}
const prioridadeSelect = initCustomSelect('f-prioridade', { urgente:'Urgent', alta:'High', media:'Medium', baixa:'Low' });
const blocoSelect = initCustomSelect('f-bloco', { 'primeira-hora':'First hour', manha:'Morning', tarde:'Afternoon', 'fim-do-dia':'End of day' });

// Reusable chip-style tag input. Type + Enter/comma to add, click × or Backspace-on-empty to remove.
function initTagInput(chipsId, inputId){
  const chipsEl = document.getElementById(chipsId);
  const inputEl = document.getElementById(inputId);
  let tags = [];
  function render(){
    chipsEl.innerHTML = '';
    tags.forEach((tag, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `<span class="tag-hash">#</span>${escapeHtml(tag)} <button type="button" aria-label="Remove tag">×</button>`;
      chip.querySelector('button').addEventListener('click', () => { tags.splice(i, 1); render(); });
      chipsEl.appendChild(chip);
    });
  }
  function addFromInput(){
    let changed = false;
    inputEl.value.split(',').forEach(part => {
      const t = part.trim().replace(/^#/, '').toLowerCase();
      if(t && !tags.includes(t)){ tags.push(t); changed = true; }
    });
    if(changed) render();
    inputEl.value = '';
  }
  inputEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter' || e.key === ','){ e.preventDefault(); addFromInput(); }
    else if(e.key === 'Backspace' && inputEl.value === '' && tags.length){ tags.pop(); render(); }
  });
  inputEl.addEventListener('blur', () => { if(inputEl.value.trim()) addFromInput(); });
  return { get: () => tags.slice(), set: (arr) => { tags = Array.isArray(arr) ? arr.slice() : []; render(); } };
}
const caseTags = initTagInput('f-tags-chips', 'f-tags-input');
const noteTags = initTagInput('nb-tags-chips', 'nb-tags-input');

const backdrop = document.getElementById('modal-backdrop');
let caseNotesLog = [];

function formatNoteTime(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}
function renderCaseNotesLog(){
  const logEl = document.getElementById('f-notes-log');
  logEl.innerHTML = '';
  caseNotesLog.forEach((entry, i) => {
    const sticky = document.createElement('div');
    sticky.className = 'case-note-sticky';
    sticky.innerHTML = `<div class="sticky-time">${formatNoteTime(entry.at)}</div><div class="sticky-text">${escapeHtml(entry.text)}</div><span class="sticky-more">open</span>`;
    sticky.title = 'Click to read the full note';
    sticky.addEventListener('click', () => openStickyViewer(entry, i));
    logEl.appendChild(sticky);
  });
}


// Case notes were being clipped inside 96px squares with no way to read them.
function openStickyViewer(entry, idx){
  const back = document.getElementById('sticky-modal-backdrop');
  document.getElementById('sticky-time').textContent = formatNoteTime(entry.at);
  const ta = document.getElementById('sticky-text');
  ta.value = entry.text;
  const locked = editingId && (cases.find(x => x.id === editingId) || {}).status === 'success';
  ta.readOnly = !!locked;
  document.getElementById('sticky-save').style.display = locked ? 'none' : 'inline-block';
  document.getElementById('sticky-del').style.display = locked ? 'none' : 'inline-block';
  document.getElementById('sticky-lock').style.display = locked ? 'block' : 'none';
  back.dataset.idx = idx;
  back.classList.add('open');
}
function closeSticky(){ document.getElementById('sticky-modal-backdrop').classList.remove('open'); }
document.getElementById('sticky-close').addEventListener('click', closeSticky);
document.getElementById('sticky-modal-backdrop').addEventListener('click', (e) => {
  if(e.target.id === 'sticky-modal-backdrop') closeSticky();
});
document.getElementById('sticky-save').addEventListener('click', async () => {
  const idx = +document.getElementById('sticky-modal-backdrop').dataset.idx;
  const txt = document.getElementById('sticky-text').value.trim();
  if(!txt || !editingId) return;
  caseNotesLog[idx] = { ...caseNotesLog[idx], text: txt };
  try{
    const up = await updateCase(editingId, { notes_log: caseNotesLog });
    const i = cases.findIndex(x => x.id === editingId); cases[i] = up;
    renderCaseNotesLog(); closeSticky();
  }catch(err){ alert(err.message); }
});
document.getElementById('sticky-del').addEventListener('click', async () => {
  const idx = +document.getElementById('sticky-modal-backdrop').dataset.idx;
  if(!editingId || !confirm('Delete this note entry?')) return;
  caseNotesLog.splice(idx, 1);
  try{
    const up = await updateCase(editingId, { notes_log: caseNotesLog });
    const i = cases.findIndex(x => x.id === editingId); cases[i] = up;
    renderCaseNotesLog(); closeSticky();
  }catch(err){ alert(err.message); }
});

function openModal(id, presetDate){
  editingId = id || null;
  const c = id ? cases.find(x => x.id === id) : null;
  document.getElementById('modal-title').textContent = c ? 'Edit case' : 'New case';
  document.getElementById('f-titulo').value = c?.titulo || '';
  document.getElementById('f-ticket').value = c?.ticket || '';
  document.getElementById('f-horario').value = c?.horario || '';
  document.getElementById('f-horario-fim').value = c?.horario_fim || '';
  document.getElementById('f-actual-end').value = c?.actual_end || '';
  document.getElementById('f-date').value = c?.case_date || presetDate || todayStr();
  prioridadeSelect.setValue(c?.prioridade || 'media');
  blocoSelect.setValue(c?.bloco || 'manha');
  caseTags.set(c?.tags || []);
  caseNotesLog = (c?.notes_log || []).slice().sort((a,b) => (b.at || '').localeCompare(a.at || ''));
  renderCaseNotesLog();
  document.getElementById('f-notas').value = '';
  document.getElementById('add-note-entry-btn').style.display = c ? 'block' : 'none';
  document.getElementById('delete-btn').style.display = c ? 'inline-block' : 'none';

  const finished = c && statusRank(c.status) === 1;
  document.getElementById('f-actual-end-wrap').style.display = finished ? 'block' : 'none';
  document.getElementById('ai-time-suggest-wrap').style.display = (c && caseNotesLog.length) ? 'block' : 'none';
  document.getElementById('time-suggestion-text').textContent = '';

  // Notes stay editable until the case is swiped right (resolved successfully).
  const locked = c && c.status === 'success';
  document.getElementById('notes-editable-wrap').style.display = locked ? 'none' : 'block';
  document.getElementById('notes-locked-hint').style.display = locked ? 'block' : 'none';

  backdrop.classList.add('open');
  SFX.open();
}
function closeModal(){ backdrop.classList.remove('open'); editingId = null; }
document.getElementById('add-case-btn').addEventListener('click', () => openModal(null));
document.getElementById('cancel-btn').addEventListener('click', closeModal);
backdrop.addEventListener('click', (e) => { if(e.target === backdrop) closeModal(); });

// Adds the composed note to the case's history right away (only once the case
// already exists — for a brand-new case it gets folded into the first Save).
document.getElementById('add-note-entry-btn').addEventListener('click', async () => {
  if(!editingId) return;
  const textarea = document.getElementById('f-notas');
  const text = textarea.value.trim();
  if(!text) return;
  const newLog = [{ text, at: new Date().toISOString() }, ...caseNotesLog];
  try{
    const updated = await updateCase(editingId, { notes_log: newLog });
    const idx = cases.findIndex(x => x.id === editingId);
    cases[idx] = updated;
    caseNotesLog = newLog;
    renderCaseNotesLog();
    textarea.value = '';
  }catch(err){ alert(err.message); }
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const titulo = document.getElementById('f-titulo').value.trim();
  if(!titulo){ alert('Give the case a name (client or subject).'); return; }
  const saveBtn = document.getElementById('save-btn');
  if(saveBtn.disabled) return; // guard against double-tap creating two cases
  saveBtn.disabled = true;
  const pendingNote = document.getElementById('f-notas').value.trim();
  const notesLog = pendingNote ? [{ text: pendingNote, at: new Date().toISOString() }, ...caseNotesLog] : caseNotesLog;
  const data = {
    titulo,
    ticket: document.getElementById('f-ticket').value.trim(),
    horario: document.getElementById('f-horario').value,
    horario_fim: document.getElementById('f-horario-fim').value,
    actual_end: document.getElementById('f-actual-end').value,
    case_date: document.getElementById('f-date').value || todayStr(),
    prioridade: document.getElementById('f-prioridade').value,
    bloco: document.getElementById('f-bloco').value,
    tags: caseTags.get(),
    notes_log: notesLog,
  };
  try{
    if(editingId){
      const updated = await updateCase(editingId, data);
      const idx = cases.findIndex(x => x.id === editingId);
      cases[idx] = updated;
    } else {
      const created = await createCase(data);
      cases.push(created);
    }
    closeModal(); render(); renderCalendar(); renderHistory();
  }catch(err){ alert(err.message); }
  finally{ saveBtn.disabled = false; }
});
document.getElementById('delete-btn').addEventListener('click', async () => {
  if(!editingId) return;
  if(!confirm('Delete this case?')) return;
  try{ await deleteCaseApi(editingId); cases = cases.filter(x => x.id !== editingId); closeModal(); render(); renderCalendar(); renderHistory(); }
  catch(err){ alert(err.message); }
});

// --- AI assistant ---
const aiPanel = document.getElementById('ai-panel');
const aiMessages = document.getElementById('ai-messages');
document.getElementById('ai-toggle').addEventListener('click', () => aiPanel.classList.add('open'));
document.getElementById('ai-close').addEventListener('click', () => aiPanel.classList.remove('open'));
function addAiMessage(role, text){
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  div.textContent = text;
  aiMessages.appendChild(div);
  aiMessages.scrollTop = aiMessages.scrollHeight;
  return div;
}
// One-shot call (used by Rephrase and the time-estimate suggestion).
async function callAi(message, system){
  const resp = await fetch(FN_URL + "/agenda-ai", { method: "POST", headers: authHeaders(), body: JSON.stringify({ message, system }) });
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error || "Couldn't reach the assistant.");
  return data.reply;
}
// Full agent turn: sends conversation + tool definitions, returns the raw message
// (which may contain tool_calls instead of content).
async function callAiAgent(messages, tools){
  const body = tools && tools.length ? { messages, tools } : { messages };
  const resp = await fetch(FN_URL + "/agenda-ai", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error || "Couldn't reach the assistant.");
  return data.message || { content: data.reply || '' };
}

// Tools the assistant is allowed to call on your behalf.
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_case',
      description: "Create a new support case in the user's agenda. Only call this when the user clearly asks to create/add/schedule a case.",
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Client name and/or short subject of the case.' },
          case_date: { type: 'string', description: 'Date in YYYY-MM-DD. Defaults to today if omitted.' },
          horario: { type: 'string', description: 'Start time HH:MM, 24h. Optional.' },
          horario_fim: { type: 'string', description: 'End time HH:MM, 24h. Optional.' },
          prioridade: { type: 'string', enum: ['urgente','alta','media','baixa'], description: 'Priority.' },
          bloco: { type: 'string', enum: ['primeira-hora','manha','tarde','fim-do-dia'], description: 'Time block of the day.' },
          ticket: { type: 'string', description: 'Ticket number if mentioned. Optional.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase tags. Optional.' },
          note: { type: 'string', description: 'An initial note about the case. Optional.' },
        },
        required: ['titulo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_notebook',
      description: "Create a new notebook (a folder that holds notes). Only call when the user asks for a new notebook.",
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Name of the notebook.' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: "Create a note inside a notebook. If the named notebook does not exist yet, create it first with create_notebook.",
      parameters: {
        type: 'object',
        properties: {
          notebook_title: { type: 'string', description: 'Name of the notebook this note belongs to.' },
          title: { type: 'string', description: 'Title of the note.' },
          content: { type: 'string', description: 'Body text of the note.' },
          linked_date: { type: 'string', description: 'Optional YYYY-MM-DD to pin the note to a calendar day.' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['notebook_title', 'title'],
      },
    },
  },
];



// ===== Sound =========================================================
// A small synth rig rather than bare beeps: everything runs through a
// convolution reverb + stereo delay so sounds sit in a space, and layers
// are detuned/filtered to give them body. No audio files to host.
let audioCtx = null, busDry = null, busWet = null;
let bootUsedFile = false;
function ac(){
  if(settings.muted) return null;
  if(!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    audioCtx = new AC();

    // master chain
    const master = audioCtx.createGain(); master.gain.value = 0.9;
    master.connect(audioCtx.destination);

    // impulse-response reverb, generated rather than downloaded
    const len = audioCtx.sampleRate * 2.4;
    const ir = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for(let ch = 0; ch < 2; ch++){
      const d = ir.getChannelData(ch);
      for(let i = 0; i < len; i++){
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    const rev = audioCtx.createConvolver(); rev.buffer = ir;
    const revGain = audioCtx.createGain(); revGain.gain.value = 0.55;
    rev.connect(revGain).connect(master);

    // ping-pong-ish delay for the tech shimmer
    const dl = audioCtx.createDelay(1.0); dl.delayTime.value = 0.19;
    const fb = audioCtx.createGain(); fb.gain.value = 0.32;
    const dlFilter = audioCtx.createBiquadFilter();
    dlFilter.type = 'highpass'; dlFilter.frequency.value = 700;
    dl.connect(fb).connect(dlFilter).connect(dl);
    const dlGain = audioCtx.createGain(); dlGain.gain.value = 0.3;
    dl.connect(dlGain).connect(master);

    busDry = audioCtx.createGain(); busDry.gain.value = 1; busDry.connect(master);
    busWet = audioCtx.createGain(); busWet.gain.value = 1;
    busWet.connect(rev); busWet.connect(dl);
  }
  if(audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// one detuned, filtered voice
function voice({ freq = 440, to = null, dur = 0.3, type = 'sawtooth', vol = 0.05,
                 delay = 0, detune = 0, cut = 2600, cutTo = null, q = 6, space = 0.5 }){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type; osc.detune.value = detune;
  osc.frequency.setValueAtTime(freq, t0);
  if(to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);

  const flt = ctx.createBiquadFilter();
  flt.type = 'lowpass'; flt.Q.value = q;
  flt.frequency.setValueAtTime(cut, t0);
  if(cutTo) flt.frequency.exponentialRampToValueAtTime(Math.max(80, cutTo), t0 + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.05, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  const send = ctx.createGain(); send.gain.value = space;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if(pan) pan.pan.value = arguments[0].pan || 0;
  osc.connect(flt).connect(g);
  const outNode = pan ? (g.connect(pan), pan) : g;
  outNode.connect(busDry); outNode.connect(send); send.connect(busWet);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}

// filtered noise, for air and transients
function air({ dur = 0.6, vol = 0.02, delay = 0, from = 300, to = 6000, type = 'bandpass', q = 1.2, space = 0.6 }){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for(let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(60, to), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const send = ctx.createGain(); send.gain.value = space;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if(pan) pan.pan.value = arguments[0].pan || 0;
  src.connect(f).connect(g);
  const outNode = pan ? (g.connect(pan), pan) : g;
  outNode.connect(busDry); outNode.connect(send); send.connect(busWet);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

// a chord built from stacked detuned voices
function chord(freqs, o = {}){
  freqs.forEach((f, i) => {
    voice(Object.assign({ freq:f, dur:1.5, type:'sawtooth', vol:0.028, cut:900, cutTo:4200,
                          delay:(o.delay || 0) + i * (o.stagger ?? 0.06), space:0.8 }, o.v || {}));
    voice(Object.assign({ freq:f, dur:1.5, type:'sawtooth', vol:0.022, detune:-9, cut:900, cutTo:3600,
                          delay:(o.delay || 0) + i * (o.stagger ?? 0.06), space:0.8 }, o.v || {}));
  });
}


// Reverse swell — amplitude climbs then cuts dead, the classic "something is
// about to happen" riser. Real records do this by reversing a cymbal; here the
// envelope shape does the same job.
function reverseSwell({ dur = 2.2, delay = 0, vol = 0.05, from = 600, to = 9000, pan = 0 }){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for(let ch = 0; ch < 2; ch++){
    const d = buf.getChannelData(ch);
    for(let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(i / n, 2.2);
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain(); g.gain.value = vol;
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if(p) p.pan.value = pan;
  src.connect(f).connect(g);
  const out = p ? (g.connect(p), p) : g;
  out.connect(busDry); out.connect(busWet);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

// Modal ring: noise through a bank of very resonant bandpass filters, which is
// how you get glass/metal without a sample.
function metal({ base = 900, partials = [1, 2.76, 5.4, 8.9], dur = 1.6, delay = 0, vol = 0.035, pan = 0 }){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const n = Math.floor(ctx.sampleRate * 0.02);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for(let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if(p) p.pan.value = pan;
  partials.forEach((mult, i) => {
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = base * mult; f.Q.value = 55 - i * 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol / (i + 1), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * (1 - i * 0.14));
    src.connect(f).connect(g);
    const out = p ? (g.connect(p), p) : g;
    out.connect(busDry); out.connect(busWet);
    src.start(t0); src.stop(t0 + dur + 0.1);
  });
}

// Cinematic impact: sub drop + body + noise crack.
function impact({ delay = 0, vol = 0.13 }){
  voice({ freq:150, to:32, dur:1.5, type:'sine', vol:vol, cut:300, delay, space:0.35 });
  voice({ freq:70, to:28, dur:1.9, type:'triangle', vol:vol*0.6, cut:180, delay:delay+0.01, space:0.3 });
  air({ dur:0.5, vol:0.05, from:2200, to:120, q:0.6, delay, space:0.9 });
  metal({ base:420, dur:2.2, delay:delay+0.01, vol:0.03 });
}

// Telemetry chatter — short randomised blips, panned around the field.
function chatter({ count = 22, spread = 1.9, delay = 0, vol = 0.011 }){
  for(let i = 0; i < count; i++){
    const t = delay + Math.random() * spread;
    const f = 1400 + Math.random() * 2600;
    voice({ freq:f, to:f * (0.8 + Math.random() * 0.5), dur:0.03 + Math.random() * 0.04,
            type:'square', vol:vol, cut:7000, q:2, delay:t, space:0.8,
            pan:(Math.random() * 2 - 1) * 0.85 });
  }
}

// Servo whirr, for mechanical presence under the swell.
function servo({ delay = 0, dur = 1.6, vol = 0.022 }){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator(); osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(140, t0);
  osc.frequency.linearRampToValueAtTime(320, t0 + dur * 0.7);
  osc.frequency.linearRampToValueAtTime(180, t0 + dur);
  const lfo = ctx.createOscillator(); lfo.frequency.value = 26;
  const lfoG = ctx.createGain(); lfoG.gain.value = 22;
  lfo.connect(lfoG).connect(osc.frequency);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 3.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(f).connect(g);
  g.connect(busDry); g.connect(busWet);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
  lfo.start(t0); lfo.stop(t0 + dur + 0.05);
}

const SFX = {
  // Composed against the supplied reference, measured frame by frame:
  //   0.00s  impact — sub-dominant (29% of energy below 120Hz)
  //   0.30s  dark rumble, spectral centroid dips to ~1.1kHz
  //   0.82s  secondary onset (measured)
  //   1.00s  riser — centroid climbs 1.6k -> 3.8kHz as mid yields to highs
  //   2.20s  activation burst — onsets at 2.20 / 2.45 / 2.62 / 2.80
  //   2.75s  peak, then decay to silence by ~4.0s
  bootCue(){
    impact({ delay:0, vol:0.12 });
    voice({ freq:62, to:34, dur:0.55, type:'sine', vol:0.12, cut:320, space:0.35 });
    air({ dur:0.14, vol:0.04, from:5200, to:600, q:0.7, space:0.5 });

    voice({ freq:74, to:150, dur:1.05, type:'sawtooth', vol:0.05, delay:0.28, cut:300, cutTo:900, q:5, space:0.5 });
    servo({ delay:0.3, dur:0.9, vol:0.018 });

    impact({ delay:0.82, vol:0.07 });
    air({ dur:0.1, vol:0.022, delay:0.82, from:3000, to:900, q:1.2, space:0.5 });

    reverseSwell({ dur:1.25, delay:1.0, vol:0.05, from:420, to:7400 });
    voice({ freq:130, to:900, dur:1.25, type:'sawtooth', vol:0.038, delay:1.0, cut:800, cutTo:6000, q:7, space:0.7 });
    voice({ freq:260, to:1800, dur:1.2, type:'square', vol:0.016, delay:1.05, cut:1200, cutTo:7000, q:5, space:0.8 });
    chatter({ count:15, spread:1.15, delay:1.05, vol:0.010 });

    [[2.20, 660], [2.45, 880], [2.62, 1046.5], [2.80, 1320]].forEach(([d, f], i) => {
      air({ dur:0.07, vol:0.028, delay:d, from:6500, to:2000, q:1.6, space:0.6, pan:(i % 2 ? 0.35 : -0.35) });
      metal({ base:f, dur:0.65, delay:d, vol:0.024, pan:(i % 2 ? 0.4 : -0.4) });
      voice({ freq:f, dur:0.42, type:'triangle', vol:0.038, delay:d, cut:7000, q:3, space:0.95 });
      impact({ delay:d, vol:0.055 - i * 0.008 });
    });

    chord([261.63, 392, 523.25, 659.25, 783.99],
          { delay:2.75, stagger:0.03, v:{ dur:1.35, vol:0.028, cut:1200, cutTo:5200 } });
    metal({ base:523.25, dur:1.3, delay:2.75, vol:0.022 });
    reverseSwell({ dur:0.5, delay:2.72, vol:0.03, from:2000, to:9000 });
    air({ dur:1.15, vol:0.02, delay:2.9, from:7000, to:2200, q:0.8, space:1 });
  },

  // Prefers the real recording when it is hosted at /hud-boot.mp3; otherwise
  // the synthesised cue above stands in, matched to the same timeline.
  bootStart(){
    if(settings.muted) return;
    bootUsedFile = false;
    try{
      const a = new Audio('/hud-boot.mp3');
      a.volume = 0.8;
      const p = a.play();
      if(p && p.then) p.then(() => { bootUsedFile = true; }).catch(() => SFX.bootCue());
      else bootUsedFile = true;
    }catch(e){ SFX.bootCue(); }
  },

  // Lines ride on top of the cue, so these stay almost subliminal.
  bootTick(i){
    if(bootUsedFile) return;
    voice({ freq:1400 + i * 90, dur:0.03, type:'square', vol:0.008, cut:8000, space:0.5,
            pan:(i % 2 ? 0.3 : -0.3) });
  },
  bootDone(){ /* the peak lives inside the cue / recording */ },

  success(){
    voice({ freq:523.25, to:784, dur:0.24, type:'triangle', vol:0.05, cut:4800, space:0.7 });
    voice({ freq:1046.5, dur:0.5, type:'sine', vol:0.025, delay:0.12, space:1 });
    air({ dur:0.12, vol:0.012, from:3000, to:8000, q:1.4, space:0.6 });
  },
  fail(){
    voice({ freq:220, to:82, dur:0.5, type:'sawtooth', vol:0.055, cut:1600, cutTo:260, q:7, space:0.5 });
    air({ dur:0.3, vol:0.015, from:900, to:180, q:1.1, space:0.5 });
  },
  tick(){
    air({ dur:0.03, vol:0.014, from:3200, to:6000, q:2.5, space:0.25 });
    voice({ freq:1500, dur:0.045, type:'square', vol:0.012, cut:6000, space:0.4 });
  },
  open(){
    voice({ freq:440, to:660, dur:0.14, type:'triangle', vol:0.026, cut:4200, space:0.7 });
  },
  phase(night){
    if(night){
      voice({ freq:340, to:70, dur:2.0, type:'sawtooth', vol:0.05, cut:2200, cutTo:260, q:8, space:0.9 });
      air({ dur:1.6, vol:0.018, from:5000, to:400, q:0.8, space:0.9 });
      chord([196, 233.08, 293.66], { delay:0.5, stagger:0.09, v:{ dur:2.6, vol:0.022, cut:700, cutTo:1800 } });
    } else {
      voice({ freq:80, to:520, dur:1.4, type:'sawtooth', vol:0.045, cut:300, cutTo:5200, q:8, space:0.8 });
      air({ dur:1.2, vol:0.02, from:300, to:8000, q:0.7, space:0.9 });
      chord([261.63, 329.63, 392, 523.25], { delay:0.5, stagger:0.07, v:{ dur:2.2, vol:0.026 } });
    }
  },
};

// ===== Knowledge base ================================================
// Loaded from /kb.json at the site root, with an optional override pasted
// in Settings. Entries are keyword-scored and the best matches are handed
// to the assistant, which must then state how confident it is.
let KB = [];
async function loadKB(){
  const local = localStorage.getItem('agenda-solar-kb');
  if(local){ try{ KB = JSON.parse(local); }catch(e){ KB = []; } }
  if(KB.length) { renderKbStatus(); return; }
  try{
    const r = await fetch('/kb.json', { cache: 'no-cache' });
    if(r.ok) KB = await r.json();
  }catch(e){ KB = []; }
  renderKbStatus();
  renderCustomTheme();
}
function renderKbStatus(){
  const el = document.getElementById('set-kb-status');
  if(el){ el.textContent = KB.length ? KB.length + ' entries loaded' : 'No entries yet'; el.className = KB.length ? 'ok' : ''; }
}
function kbSearch(q, limit = 4){
  if(!KB.length || !q) return [];
  const words = q.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  return KB.map(e => {
    const hay = [e.title, e.content, (e.tags || []).join(' '), (e.keywords || []).join(' ')].join(' ').toLowerCase();
    let score = 0;
    words.forEach(w => { if(hay.includes(w)) score += hay.split(w).length - 1; });
    return { e, score };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, limit).map(x => x.e);
}

// The assistant sees a factual snapshot of the real data. Without this it was
// answering schedule questions from imagination.
function buildAiSystemPrompt(){
  const today = todaysCases();
  const pending = today.filter(c => statusRank(c.status) === 0);
  const done = today.filter(c => statusRank(c.status) === 1);

  const caseLines = pending.length
    ? pending.map(c => `- ${c.titulo}${c.horario ? ' at ' + c.horario : ''}${c.horario_fim ? '-' + c.horario_fim : ''} [${prioLabel(c.prioridade)}, ${blocoLabel(c.bloco)}]${c.ticket ? ' ticket ' + c.ticket : ''}`).join('\n')
    : '(none — the agenda is empty for today)';

  const w = wxSnapshot;
  const wxLine = w
    ? `Weather today — Vinhedo/Campinas region: ${w.tmin}°C to ${w.tmax}°C, `
      + `${w.rain.toFixed(1)} mm rain (${w.prob}% chance), max wind ${Math.round(w.wind)} km/h.`
      + (w.wettest ? ` Heaviest rain in Brazil: ${w.wettest.n} (${w.wettest.v.toFixed(0)} mm). Strongest wind: ${w.windiest.n} (${Math.round(w.windiest.v)} km/h).` : '')
    : 'Weather: not loaded yet.';

  const hits = kbSearch(lastUserQuestion || '');
  const kbBlock = hits.length
    ? 'Knowledge base matches:\n' + hits.map(e => `- [${e.title}] ${e.content}`).join('\n')
    : (KB.length ? 'Knowledge base: no entry matched this question.' : 'Knowledge base: empty.');

  const nbLines = notebooks.length
    ? notebooks.map(nb => `- ${nb.title} (${notes.filter(n => n.notebook_id === nb.id).length} notes)`).join('\n')
    : '(no notebooks yet)';

  return [
    "You are the built-in assistant for Solar Agenda, a support-routine app used by a solar energy support technician.",
    "",
    "=== REAL DATA SNAPSHOT (the ONLY source of truth) ===",
    `Today's date: ${todayStr()}`,
    `Open cases today (${pending.length}):`,
    caseLines,
    `Cases already finished today: ${done.length}`,
    `Notebooks (${notebooks.length}):`,
    nbLines,
    wxLine,
    kbBlock,
    "=== END SNAPSHOT ===",
    "",
    "CRITICAL RULES:",
    "1. NEVER invent, assume or give example cases, notes, clients or appointments. If the snapshot shows the agenda is empty, say plainly that it is empty.",
    "2. Only describe data that literally appears in the snapshot above. If asked about something not in it, say you don't have that record.",
    "3. Use the tools ONLY when the user explicitly asks you to CREATE something concrete. Statements about how the day went are NOT case requests.",
    "   - 'the first hour was not needed' / 'nothing scheduled' => do NOT create a case. Just acknowledge it; the app already shows that state on its own.",
    "   - Never create a case only so it appears in history, and never auto-complete a case you just created.",
    "4. Weather: answer from the weather block above. Vinhedo is the local forecast; Campinas is ~15 km away so the same figures apply — say so rather than refusing.",
    "5. Knowledge base: prefer it for technical questions and name the entry you used.",
    "6. End EVERY answer with a final line exactly like: CONFIDENCE: 85",
    "   Use 90-100 when it comes straight from the snapshot or knowledge base, 50-80 for reasoned answers, under 40 when unsure.",
    "7. Be brief and direct. Plain text, no markdown.",
  ].join('\n');
}

let aiHistory = []; // conversation memory for this panel session
let lastUserQuestion = '';

async function runToolCall(call){
  const name = call.function?.name;
  let args = {};
  try{ args = JSON.parse(call.function?.arguments || '{}'); }catch(e){}

  if(name === 'create_case'){
    const payload = {
      titulo: args.titulo,
      ticket: args.ticket || '',
      horario: args.horario || '',
      horario_fim: args.horario_fim || '',
      case_date: args.case_date || todayStr(),
      prioridade: args.prioridade || 'media',
      bloco: args.bloco || 'manha',
      tags: Array.isArray(args.tags) ? args.tags : [],
      notes_log: args.note ? [{ text: args.note, at: new Date().toISOString() }] : [],
    };
    const created = await createCase(payload);
    cases.push(created);
    render(); renderCalendar(); renderHistory();
    return `Case created: "${created.titulo}" on ${created.case_date}.`;
  }

  if(name === 'create_notebook'){
    const existing = notebooks.find(nb => (nb.title || '').toLowerCase() === (args.title || '').toLowerCase());
    if(existing) return `A notebook named "${existing.title}" already exists.`;
    const nb = await createNotebookApi({ title: args.title });
    notebooks.unshift(nb);
    renderNotebooksGrid();
    return `Notebook created: "${nb.title}".`;
  }

  if(name === 'create_note'){
    let nb = notebooks.find(x => (x.title || '').toLowerCase() === (args.notebook_title || '').toLowerCase());
    if(!nb){
      nb = await createNotebookApi({ title: args.notebook_title });
      notebooks.unshift(nb);
    }
    const created = await createNoteApi({
      notebook_id: nb.id,
      title: args.title,
      content: args.content || '',
      linked_date: args.linked_date || null,
      tags: Array.isArray(args.tags) ? args.tags : [],
    });
    notes.unshift(created);
    renderNotebooksGrid(); renderCalendar();
    return `Note "${created.title}" created in notebook "${nb.title}".`;
  }

  return `Unknown tool: ${name}`;
}

document.getElementById('ai-send').addEventListener('click', sendAiMessage);
document.getElementById('ai-input').addEventListener('keydown', (e) => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendAiMessage(); } });

async function sendAiMessage(){
  const input = document.getElementById('ai-input');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  addAiMessage('user', text);
  const loading = addAiMessage('assistant', '...');

  lastUserQuestion = text;
  aiHistory.push({ role: 'user', content: text });

  try{
    let convo = [{ role: 'system', content: buildAiSystemPrompt() }, ...aiHistory];
    const doneCalls = new Set(); // dedupe identical tool calls within one turn
    let msg = await callAiAgent(convo, AI_TOOLS);

    // Execute any tools it asked for, then let it summarise the result.
    let guard = 0;
    while(msg.tool_calls && msg.tool_calls.length && guard < 4){
      guard++;
      convo.push(msg);
      aiHistory.push(msg);
      for(const call of msg.tool_calls){
        let result;
        const sig = (call.function?.name || '') + '|' + (call.function?.arguments || '');
        if(doneCalls.has(sig)){
          result = 'Already done in this turn — not repeated.';
          convo.push({ role:'tool', tool_call_id: call.id, content: result });
          continue;
        }
        doneCalls.add(sig);
        try{ result = await runToolCall(call); }
        catch(err){ result = 'Failed: ' + err.message; }
        const toolMsg = { role: 'tool', tool_call_id: call.id, content: result };
        convo.push(toolMsg);
        aiHistory.push(toolMsg);
      }
      // No tools on the follow-up turn: with them attached the model kept
      // re-issuing the same create call, which is what duplicated cases.
      msg = await callAiAgent(convo, null);
    }

    let reply = (msg.content || '').trim() || 'Done.';
    // pull the confidence line out and render it as a bar
    let conf = null;
    reply = reply.replace(/\n?\s*CONFIDENCE:\s*(\d{1,3})\s*%?\s*$/i, (_, n) => { conf = Math.max(0, Math.min(100, +n)); return ''; }).trim();
    loading.textContent = reply || 'Done.';
    if(conf !== null){
      const bar = document.createElement('div');
      bar.className = 'conf';
      const tone = conf >= 75 ? 'hi' : conf >= 45 ? 'mid' : 'lo';
      bar.innerHTML = `<span class="conf-lab">confidence</span>
        <span class="conf-track"><span class="conf-fill ${tone}" style="width:${conf}%"></span></span>
        <span class="conf-num ${tone}">${conf}%</span>`;
      loading.appendChild(bar);
    }
    aiHistory.push({ role: 'assistant', content: reply });
    if(aiHistory.length > 24) aiHistory = aiHistory.slice(-24);
  }catch(err){
    loading.textContent = "Couldn't respond right now (" + err.message + ").";
  }
  aiMessages.scrollTop = aiMessages.scrollHeight;
}
document.getElementById('reformular-btn').addEventListener('click', async () => {
  const textarea = document.getElementById('f-notas');
  const original = textarea.value.trim();
  if(!original){ alert('Write a note first, then rephrase it.'); return; }
  const btn = document.getElementById('reformular-btn');
  const originalLabel = btn.textContent;
  btn.textContent = 'Rephrasing...'; btn.disabled = true;
  try{
    textarea.value = (await callAi(original, "You rephrase a solar support technician's quick notes into clear, professional text ready to log in a support ticket. Reply with only the rephrased text, no comments or quotes.")).trim();
  }catch(err){ alert("Couldn't rephrase right now: " + err.message); }
  finally{ btn.textContent = originalLabel; btn.disabled = false; }
});

// Looks at the case's title + note history (and, if available, the gap between
// the planned time and when it actually finished) and asks the AI for a
// tighter time estimate for next time. This is a suggestion only — nothing
// is applied automatically.
document.getElementById('suggest-time-btn').addEventListener('click', async () => {
  if(!editingId) return;
  const titulo = document.getElementById('f-titulo').value.trim();
  const horario = document.getElementById('f-horario').value;
  const horarioFim = document.getElementById('f-horario-fim').value;
  const actualEnd = document.getElementById('f-actual-end').value;
  const notesText = caseNotesLog.map(n => n.text).join('; ');
  const btn = document.getElementById('suggest-time-btn');
  const out = document.getElementById('time-suggestion-text');
  const originalLabel = btn.textContent;
  btn.textContent = 'Thinking...'; btn.disabled = true;
  out.textContent = '';
  try{
    const prompt = `Case: ${titulo}\nPlanned start: ${horario || 'not set'}\nPlanned end: ${horarioFim || 'not set'}\nActual finish: ${actualEnd || 'not set yet'}\nNotes logged while working the case: ${notesText || 'none'}`;
    const reply = await callAi(prompt, "You help a solar support technician plan realistic time blocks. Based on the case details and notes given, suggest a more accurate planned duration or end time for this kind of case in the future. Reply in 1-2 short sentences, plain text, no markdown.");
    out.textContent = reply.trim();
  }catch(err){ out.textContent = "Couldn't get a suggestion right now."; }
  finally{ btn.textContent = originalLabel; btn.disabled = false; }
});

// --- Notebooks (folders) + Notes ---
let notes = [];              // ALL of the user's notes, across every notebook
let activeFolderId = null;   // which notebook folder is currently open (null = top-level grid)
let notebookSearchQuery = '';
let isDraftNote = false;     // true until the current note draft has been saved for the first time

async function loadNotebooks(){
  const resp = await fetch(FN_URL + "/agenda-notebooks", { headers: authHeaders() });
  if(!resp.ok) return;
  notebooks = await resp.json();
  renderNotebooksGrid();
  updateHudStrip();
}
async function createNotebookApi(payload){
  const resp = await fetch(FN_URL + "/agenda-notebooks", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error creating notebook.');
  return resp.json();
}
async function deleteNotebookApi(id){
  const resp = await fetch(FN_URL + "/agenda-notebooks", { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ id }) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error deleting notebook.');
}

async function loadNotes(){
  const resp = await fetch(FN_URL + "/agenda-notes", { headers: authHeaders() });
  if(!resp.ok) return;
  notes = await resp.json();
  renderNotebooksGrid();
  renderCalendar();
}
async function createNoteApi(payload){
  const resp = await fetch(FN_URL + "/agenda-notes", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error creating note.');
  return resp.json();
}
async function updateNoteApi(id, payload){
  const resp = await fetch(FN_URL + "/agenda-notes", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ id, ...payload }) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error saving note.');
  return resp.json();
}
async function deleteNoteApi(id){
  const resp = await fetch(FN_URL + "/agenda-notes", { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ id }) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error deleting note.');
}

// Fuzzy match tuned to avoid over-matching: a real substring always wins,
// and a scattered "subsequence" match only counts if it's reasonably tight
// (span not much longer than the query) — otherwise short queries would
// match almost everything and defeat the point of searching.
function fuzzyScore(query, text){
  if(!query) return 0;
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  if(t.includes(q)) return 1000 - t.indexOf(q);
  if(q.length < 3) return null;
  let ti = 0, score = 0, first = -1;
  for(let qi = 0; qi < q.length; qi++){
    const idx = t.indexOf(q[qi], ti);
    if(idx === -1) return null;
    if(first === -1) first = idx;
    score += 10 - Math.min(idx - ti, 9);
    ti = idx + 1;
  }
  if((ti - first) > q.length * 3) return null; // too scattered to be a real match
  return score;
}
function plainTextPreview(html){
  const d = document.createElement('div');
  d.innerHTML = html || '';
  const im = d.querySelector('img');
  const text = d.textContent.trim().replace(/\s+/g, ' ');
  // carry the actual image out so cards can show a picture, not the word "[image]"
  const thumb = im ? (im.dataset.thumb || im.getAttribute('src') || '') : '';
  return { text: text.slice(0, 140), hasImg: !!im, thumb: thumb.startsWith('data:') ? thumb : '' };
}
function previewBody(text, hasImg, thumb){
  if(thumb) return `<div class="nb-thumb" style="background-image:url('${thumb}')"></div>`
    + (text ? `<div class="nb-thumb-cap">${escapeHtml(text)}</div>` : '');
  return escapeHtml(text) || (hasImg ? '<span class="nb-noimg">image (open to view)</span>' : '');
}

function tagChipsHtml(tags){
  if(!tags || !tags.length) return '';
  return `<div class="nb-grid-card-tags">${tags.map(t => `<span class="chip tag"><span class="tag-hash">#</span>${escapeHtml(t)}</span>`).join('')}</div>`;
}

function renderNotebooksGrid(){
  const grid = document.getElementById('notebooks-grid');
  const crumb = document.getElementById('notebooks-breadcrumb');
  grid.innerHTML = '';

  // --- Search mode: flat list of matching notes, regardless of folder ---
  if(notebookSearchQuery){
    crumb.classList.add('hidden');
    const scored = notes
      .map(n => {
        const preview = plainTextPreview(n.content).text;
        const nbTitle = (notebooks.find(nb => nb.id === n.notebook_id) || {}).title || '';
        const score = fuzzyScore(notebookSearchQuery, [n.title, preview, nbTitle, (n.tags || []).join(' ')].join(' '));
        return { n, nbTitle, score };
      })
      .filter(x => x.score !== null)
      .sort((a,b) => b.score - a.score);

    if(scored.length === 0){
      grid.innerHTML = '<div class="nb-grid-empty">No notes match your search.</div>';
      return;
    }
    scored.forEach(({ n, nbTitle }) => {
      const { text, hasImg, thumb } = plainTextPreview(n.content);
      const card = document.createElement('div');
      card.className = 'nb-grid-card';
      card.innerHTML = `
        <div class="nb-grid-card-top">
          <div class="nb-grid-card-title">${escapeHtml(n.title || 'Untitled')}</div>
          <div class="nb-grid-card-date">${escapeHtml(nbTitle)}${n.linked_date ? ' · ' + n.linked_date : ''}</div>
        </div>
        <div class="nb-grid-card-preview">${previewBody(text, hasImg, thumb)}</div>
        ${tagChipsHtml(n.tags)}
      `;
      card.addEventListener('click', () => { activeFolderId = n.notebook_id; openNote(n.id); });
      grid.appendChild(card);
    });
    return;
  }

  // --- Inside a notebook: grid of its notes ---
  if(activeFolderId){
    const folder = notebooks.find(nb => nb.id === activeFolderId);
    if(!folder){ activeFolderId = null; renderNotebooksGrid(); return; }
    crumb.classList.remove('hidden');
    document.getElementById('notebooks-current-title').textContent = folder.title;

    const folderNotes = notes.filter(n => n.notebook_id === activeFolderId);
    if(folderNotes.length === 0){
      grid.innerHTML = '<div class="nb-grid-empty">No notes in this notebook yet — add one to get started.</div>';
      return;
    }
    folderNotes.forEach(n => {
      const { text, hasImg, thumb } = plainTextPreview(n.content);
      const card = document.createElement('div');
      card.className = 'nb-grid-card';
      card.innerHTML = `
        <div class="nb-grid-card-top">
          <div class="nb-grid-card-title">${escapeHtml(n.title || 'Untitled')}</div>
          ${n.linked_date ? `<div class="nb-grid-card-date">${n.linked_date}</div>` : ''}
        </div>
        <div class="nb-grid-card-preview">${previewBody(text, hasImg, thumb)}</div>
        ${tagChipsHtml(n.tags)}
      `;
      card.addEventListener('click', () => openNote(n.id));
      grid.appendChild(card);
    });
    return;
  }

  // --- Top level: grid of notebook folders ---
  crumb.classList.add('hidden');
  if(notebooks.length === 0){
    grid.innerHTML = '<div class="nb-grid-empty">No notebooks yet — create one to get started.</div>';
    return;
  }
  notebooks.forEach(nb => {
    const nbNotes = notes.filter(n => n.notebook_id === nb.id);
    const latest = nbNotes[0]; // notes are already sorted by updated_at desc
    const { text, hasImg, thumb } = plainTextPreview(latest ? latest.content : '');
    const card = document.createElement('div');
    card.className = 'nb-grid-card';
    card.innerHTML = `
      <div class="nb-grid-card-top">
        <div class="nb-grid-card-title">${escapeHtml(nb.title || 'Untitled')}</div>
        <div class="nb-grid-card-count">${nbNotes.length} note${nbNotes.length === 1 ? '' : 's'}</div>
      </div>
      <div class="nb-grid-card-preview">${latest ? previewBody(text, hasImg, thumb) : 'Empty'}</div>
    `;
    card.addEventListener('click', () => { activeFolderId = nb.id; renderNotebooksGrid(); });
    grid.appendChild(card);
  });
}

document.getElementById('notebook-search').addEventListener('input', (e) => {
  notebookSearchQuery = e.target.value.trim();
  renderNotebooksGrid();
});
document.getElementById('notebooks-back-btn').addEventListener('click', () => { activeFolderId = null; renderNotebooksGrid(); });
document.getElementById('delete-notebook-btn').addEventListener('click', async () => {
  if(!activeFolderId) return;
  const count = notes.filter(n => n.notebook_id === activeFolderId).length;
  if(!confirm(count ? `Delete this notebook and its ${count} note(s)?` : 'Delete this notebook?')) return;
  try{
    await deleteNotebookApi(activeFolderId);
    notebooks = notebooks.filter(nb => nb.id !== activeFolderId);
    notes = notes.filter(n => n.notebook_id !== activeFolderId);
    activeFolderId = null;
    renderNotebooksGrid();
    renderCalendar();
  }catch(err){ alert(err.message); }
});

// --- New notebook (folder) ---
const newNotebookModalBackdrop = document.getElementById('new-notebook-modal-backdrop');
document.getElementById('new-notebook-btn').addEventListener('click', () => {
  document.getElementById('new-notebook-title').value = '';
  newNotebookModalBackdrop.classList.add('open');
  setTimeout(() => document.getElementById('new-notebook-title').focus(), 50);
});
document.getElementById('new-notebook-cancel').addEventListener('click', () => newNotebookModalBackdrop.classList.remove('open'));
newNotebookModalBackdrop.addEventListener('click', (e) => { if(e.target === newNotebookModalBackdrop) newNotebookModalBackdrop.classList.remove('open'); });
document.getElementById('new-notebook-confirm').addEventListener('click', async () => {
  const title = document.getElementById('new-notebook-title').value.trim();
  if(!title){ alert('Give the notebook a name.'); return; }
  const btn = document.getElementById('new-notebook-confirm');
  if(btn.disabled) return; // guard against double-tap creating two notebooks
  btn.disabled = true;
  try{
    const nb = await createNotebookApi({ title });
    notebooks.unshift(nb);
    newNotebookModalBackdrop.classList.remove('open');
    activeFolderId = nb.id;
    renderNotebooksGrid();
  }catch(err){ alert(err.message); }
  finally{ btn.disabled = false; }
});

// --- Note editor (a single note inside the active notebook) ---
const notebookModalBackdrop = document.getElementById('notebook-modal-backdrop');
let activeNoteId = null;

function openNote(id){
  activeNoteId = id;
  isDraftNote = false;
  const n = notes.find(x => x.id === id);
  if(!n) return;
  document.getElementById('nb-title-input').value = n.title || '';
  document.getElementById('nb-date-input').value = n.linked_date || '';
  noteTags.set(n.tags || []);
  document.getElementById('notebook-canvas').innerHTML = n.content || '';
  hydrateMedia(document.getElementById('notebook-canvas'));
  document.getElementById('notebook-status').textContent = 'Saved';
  document.getElementById('nb-delete-btn').style.display = 'inline-block';
  notebookModalBackdrop.classList.add('open');
}

// "+ New note" only opens a blank editor — nothing is created in the backend
// until the user actually types a title or content.
document.getElementById('new-note-btn').addEventListener('click', () => {
  if(!activeFolderId) return;
  activeNoteId = null;
  isDraftNote = true;
  document.getElementById('nb-title-input').value = '';
  document.getElementById('nb-date-input').value = '';
  noteTags.set([]);
  document.getElementById('notebook-canvas').innerHTML = '';
  document.getElementById('notebook-status').textContent = '';
  document.getElementById('nb-delete-btn').style.display = 'none';
  notebookModalBackdrop.classList.add('open');
  setTimeout(() => document.getElementById('nb-title-input').focus(), 50);
});

function closeNotebookModal(){
  notebookModalBackdrop.classList.remove('open');
  activeNoteId = null;
  isDraftNote = false;
}
document.getElementById('notebook-close-btn').addEventListener('click', closeNotebookModal);
notebookModalBackdrop.addEventListener('click', (e) => { if(e.target === notebookModalBackdrop) closeNotebookModal(); });

document.getElementById('nb-delete-btn').addEventListener('click', async () => {
  if(!activeNoteId) return;
  if(!confirm('Delete this note?')) return;
  try{
    await deleteNoteApi(activeNoteId);
    notes = notes.filter(n => n.id !== activeNoteId);
    closeNotebookModal();
    renderNotebooksGrid();
    renderCalendar();
  }catch(err){ alert(err.message); }
});

let nbSaveTimer = null;
function scheduleNotebookSave(){
  const title = document.getElementById('nb-title-input').value.trim();
  const content = document.getElementById('notebook-canvas').innerHTML.trim();
  if(isDraftNote && !title && !content) return; // still empty — don't create anything
  document.getElementById('notebook-status').textContent = 'Saving...';
  clearTimeout(nbSaveTimer);
  nbSaveTimer = setTimeout(saveNote, 800);
}
// Blob URLs are session-only, so we never persist them: each managed image is
// stored back with its lightweight thumbnail and re-hydrated from disk/Drive.
function serialiseCanvas(){
  const clone = document.getElementById('notebook-canvas').cloneNode(true);
  clone.querySelectorAll('img[data-media]').forEach(img => {
    if((img.getAttribute('src') || '').startsWith('blob:')){
      img.setAttribute('src', img.dataset.thumb || '');
    }
    img.classList.remove('pending');
  });
  return clone.innerHTML;
}
async function saveNote(){
  const payload = {
    title: document.getElementById('nb-title-input').value.trim() || 'Untitled',
    linked_date: document.getElementById('nb-date-input').value || null,
    tags: noteTags.get(),
    content: serialiseCanvas(),
  };
  try{
    if(isDraftNote){
      const created = await createNoteApi({ ...payload, notebook_id: activeFolderId });
      notes.unshift(created);
      activeNoteId = created.id;
      isDraftNote = false;
      document.getElementById('nb-delete-btn').style.display = 'inline-block';
    } else if(activeNoteId){
      const updated = await updateNoteApi(activeNoteId, payload);
      const idx = notes.findIndex(n => n.id === activeNoteId);
      notes[idx] = updated;
    }
    document.getElementById('notebook-status').textContent = 'Saved';
    renderNotebooksGrid();
    renderCalendar();
  }catch(err){ document.getElementById('notebook-status').textContent = 'Could not save'; }
}
document.getElementById('nb-title-input').addEventListener('input', scheduleNotebookSave);
document.getElementById('nb-date-input').addEventListener('change', scheduleNotebookSave);
document.getElementById('notebook-canvas').addEventListener('input', scheduleNotebookSave);


// ===== Notion-style block editor =====================================
// contenteditable + execCommand. execCommand is formally deprecated but is
// still the only thing browsers implement natively for rich-text editing;
// the alternative is a full editor library, which this app doesn't need.
const nbCanvas = () => document.getElementById('notebook-canvas');

function nbFocus(){ const el = nbCanvas(); el.focus(); return el; }

function currentBlock(){
  const sel = window.getSelection();
  if(!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  const canvas = nbCanvas();
  if(!canvas.contains(node)) return null;
  while(node && node.parentNode !== canvas){ node = node.parentNode; }
  return node;
}

function makeTodoBlock(text){
  const wrap = document.createElement('div');
  wrap.className = 'todo';
  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.setAttribute('contenteditable', 'false');
  tick.textContent = '✓';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = text || '';
  wrap.appendChild(tick); wrap.appendChild(txt);
  return wrap;
}

function placeCaret(node, atStart){
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(!!atStart);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
}

function applyBlock(kind, seedText){
  nbFocus();
  const canvas = nbCanvas();

  if(kind === 'todo'){
    const block = currentBlock();
    const todo = makeTodoBlock(seedText || '');
    if(block){ block.replaceWith(todo); } else { canvas.appendChild(todo); }
    placeCaret(todo.querySelector('.txt'), false);
    scheduleNotebookSave();
    return;
  }
  if(kind === 'hr'){
    document.execCommand('insertHorizontalRule');
    scheduleNotebookSave();
    return;
  }
  if(kind === 'code'){
    const block = currentBlock();
    const pre = document.createElement('pre');
    pre.textContent = seedText || (block ? block.textContent : '') || '';
    if(block){ block.replaceWith(pre); } else { canvas.appendChild(pre); }
    placeCaret(pre, false);
    scheduleNotebookSave();
    return;
  }
  const map = { h1:'H1', h2:'H2', h3:'H3', p:'P', quote:'BLOCKQUOTE' };
  if(kind === 'ul'){ document.execCommand('insertUnorderedList'); }
  else if(kind === 'ol'){ document.execCommand('insertOrderedList'); }
  else if(map[kind]){ document.execCommand('formatBlock', false, map[kind]); }
  scheduleNotebookSave();
}

// Toolbar
document.getElementById('nb-toolbar').addEventListener('mousedown', (e) => {
  // mousedown (not click) so the editor keeps its selection
  const btn = e.target.closest('button');
  if(!btn) return;
  e.preventDefault();
  if(btn.dataset.cmd){ nbFocus(); document.execCommand(btn.dataset.cmd); scheduleNotebookSave(); }
  else if(btn.dataset.block){ applyBlock(btn.dataset.block); }
  else if(btn.dataset.inline === 'code'){
    nbFocus();
    const sel = window.getSelection();
    if(sel && !sel.isCollapsed){
      const span = document.createElement('code');
      span.className = 'inline-code';
      try{ sel.getRangeAt(0).surroundContents(span); }catch(e){}
      scheduleNotebookSave();
    }
  }
  else if(btn.dataset.hl){
    nbFocus();
    const v = btn.dataset.hl;
    document.execCommand('hiliteColor', false, v === 'none' ? 'transparent' : getComputedStyle(document.documentElement).getPropertyValue(v.replace('var(','').replace(')','')).trim() + '55');
    scheduleNotebookSave();
  }
  else if(btn.dataset.link){
    nbFocus();
    const url = prompt('Link URL:');
    if(url) document.execCommand('createLink', false, url);
    scheduleNotebookSave();
  }
});

// Clicking a checklist tick toggles it
nbCanvas().addEventListener('click', (e) => {
  const tick = e.target.closest('.tick');
  if(!tick) return;
  tick.parentElement.classList.toggle('done');
  scheduleNotebookSave();
});

// ---- Markdown-style shortcuts: "# ", "- ", "1. ", "[] ", "> ", "```" ----
const MD_SHORTCUTS = [
  [/^#\s$/,        'h1'],
  [/^##\s$/,       'h2'],
  [/^###\s$/,      'h3'],
  [/^[-*]\s$/,     'ul'],
  [/^1\.\s$/,      'ol'],
  [/^\[\]\s$/,     'todo'],
  [/^\[\s?\]\s$/,  'todo'],
  [/^>\s$/,        'quote'],
  [/^```$/,        'code'],
  [/^---$/,        'hr'],
];
nbCanvas().addEventListener('input', () => {
  const block = currentBlock();
  if(!block) return;
  const txt = block.textContent || '';
  for(const [re, kind] of MD_SHORTCUTS){
    if(re.test(txt)){
      block.textContent = '';
      applyBlock(kind);
      return;
    }
  }
});

// ---- Slash command menu ----
const SLASH_ITEMS = [
  { key:'h1',    ico:'H1',  label:'Heading 1' },
  { key:'h2',    ico:'H2',  label:'Heading 2' },
  { key:'h3',    ico:'H3',  label:'Heading 3' },
  { key:'p',     ico:'¶',   label:'Body text' },
  { key:'ul',    ico:'•',   label:'Bullet list' },
  { key:'ol',    ico:'1.',  label:'Numbered list' },
  { key:'todo',  ico:'☑',   label:'Checklist' },
  { key:'quote', ico:'❝',   label:'Quote' },
  { key:'code',  ico:'</>', label:'Code block' },
  { key:'hr',    ico:'—',   label:'Divider' },
];
const slashMenu = document.getElementById('slash-menu');
let slashOpen = false, slashIdx = 0, slashFiltered = SLASH_ITEMS;

function renderSlash(){
  slashMenu.innerHTML = '';
  slashFiltered.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === slashIdx ? ' sel' : '');
    row.innerHTML = `<span class="si-ico">${it.ico}</span><span>${it.label}</span>`;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); chooseSlash(it); });
    slashMenu.appendChild(row);
  });
}
function openSlash(){
  const sel = window.getSelection();
  if(!sel || !sel.rangeCount) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  slashFiltered = SLASH_ITEMS; slashIdx = 0;
  renderSlash();
  slashMenu.classList.add('open');
  const top = rect.bottom + 6;
  slashMenu.style.left = Math.min(rect.left, window.innerWidth - 230) + 'px';
  slashMenu.style.top = (top + 270 > window.innerHeight ? rect.top - 276 : top) + 'px';
  slashOpen = true;
}
function closeSlash(){ slashMenu.classList.remove('open'); slashOpen = false; }
function chooseSlash(item){
  // strip the "/query" the user typed before applying the block
  const block = currentBlock();
  if(block){
    const t = block.textContent || '';
    const idx = t.lastIndexOf('/');
    if(idx !== -1) block.textContent = t.slice(0, idx);
  }
  closeSlash();
  applyBlock(item.key);
}

nbCanvas().addEventListener('keydown', (e) => {
  if(slashOpen){
    if(e.key === 'ArrowDown'){ e.preventDefault(); slashIdx = (slashIdx + 1) % slashFiltered.length; renderSlash(); return; }
    if(e.key === 'ArrowUp'){ e.preventDefault(); slashIdx = (slashIdx - 1 + slashFiltered.length) % slashFiltered.length; renderSlash(); return; }
    if(e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); if(slashFiltered[slashIdx]) chooseSlash(slashFiltered[slashIdx]); return; }
    if(e.key === 'Escape'){ e.preventDefault(); closeSlash(); return; }
  }
  if(e.key === '/'){ setTimeout(openSlash, 0); return; }

  // Enter inside a checklist continues the checklist
  if(e.key === 'Enter'){
    const block = currentBlock();
    if(block && block.classList && block.classList.contains('todo')){
      e.preventDefault();
      const txt = block.querySelector('.txt');
      if(txt && !txt.textContent.trim()){
        const p = document.createElement('div');
        p.innerHTML = '<br>';
        block.replaceWith(p);
        placeCaret(p, true);
      } else {
        const next = makeTodoBlock('');
        block.after(next);
        placeCaret(next.querySelector('.txt'), true);
      }
      scheduleNotebookSave();
    }
  }
});
nbCanvas().addEventListener('keyup', (e) => {
  if(!slashOpen) return;
  const block = currentBlock();
  const t = block ? (block.textContent || '') : '';
  const idx = t.lastIndexOf('/');
  if(idx === -1){ closeSlash(); return; }
  const q = t.slice(idx + 1).toLowerCase();
  if(q.includes(' ')){ closeSlash(); return; }
  slashFiltered = SLASH_ITEMS.filter(it => it.label.toLowerCase().includes(q) || it.key.includes(q));
  if(!slashFiltered.length){ closeSlash(); return; }
  slashIdx = Math.min(slashIdx, slashFiltered.length - 1);
  renderSlash();
});
nbCanvas().addEventListener('blur', () => setTimeout(closeSlash, 150));



// ===== Image controls in the note editor =============================
let selectedImg = null;
function showImgBar(img){
  selectedImg = img;
  const bar = document.getElementById('img-bar');
  const r = img.getBoundingClientRect();
  bar.classList.add('open');
  bar.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
  bar.style.top = (r.top - 46 < 8 ? r.bottom + 8 : r.top - 46) + 'px';
  document.querySelectorAll('#notebook-canvas img').forEach(i => i.classList.remove('sel'));
  img.classList.add('sel');
}
function hideImgBar(){
  document.getElementById('img-bar')?.classList.remove('open');
  document.querySelectorAll('#notebook-canvas img').forEach(i => i.classList.remove('sel'));
  selectedImg = null;
}
document.getElementById('notebook-canvas').addEventListener('click', (e) => {
  const img = e.target.closest('img');
  if(img){ showImgBar(img); } else { hideImgBar(); }
});
document.getElementById('img-bar').addEventListener('mousedown', (e) => {
  const b = e.target.closest('button'); if(!b || !selectedImg) return;
  e.preventDefault();
  const w = b.dataset.w, al = b.dataset.align;
  if(w){ selectedImg.style.width = w; selectedImg.style.height = 'auto'; }
  if(al){
    selectedImg.style.marginLeft = al === 'center' ? 'auto' : (al === 'right' ? 'auto' : '0');
    selectedImg.style.marginRight = al === 'center' ? 'auto' : (al === 'left' ? 'auto' : '0');
    selectedImg.style.display = 'block';
  }
  if(b.dataset.del){ selectedImg.remove(); hideImgBar(); }
  scheduleNotebookSave();
});
// drag the bottom-right corner to size it freely
document.getElementById('notebook-canvas').addEventListener('pointerdown', (e) => {
  const img = e.target.closest('img');
  if(!img) return;
  const r = img.getBoundingClientRect();
  if(e.clientX < r.right - 18 || e.clientY < r.bottom - 18) return; // not on the handle
  e.preventDefault();
  const startX = e.clientX, startW = r.width;
  const move = (ev) => {
    const w = Math.max(60, startW + (ev.clientX - startX));
    img.style.width = w + 'px'; img.style.height = 'auto';
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    scheduleNotebookSave();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ===== Media storage: local folder + Google Drive, never Supabase ======
// A pasted image is written to a folder on this machine AND (optionally)
// mirrored to Drive. The note stores only a filename + drive id + a tiny
// thumbnail, so the database stays small no matter how many images you paste.
const SET_KEY = 'agenda-solar-settings';
let settings = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
function saveSettings(){ localStorage.setItem(SET_KEY, JSON.stringify(settings)); }

// --- IndexedDB, because a directory handle can't be JSON-stringified ---
function idb(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('agenda-solar', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v){ const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv','readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function idbGet(k){ const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv','readonly'); const q = t.objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }

let mediaDir = null;          // FileSystemDirectoryHandle
const mediaCache = new Map(); // filename -> object URL (avoids re-reading on every render)

async function restoreMediaDir(){
  if(!window.showDirectoryPicker) return;
  try{
    const h = await idbGet('mediaDir');
    if(!h) return;
    const perm = await h.queryPermission({ mode: 'readwrite' });
    if(perm === 'granted') mediaDir = h;
    else mediaDir = h; // kept; we'll request permission on first use
  }catch(e){}
}
async function ensureDirPermission(){
  if(!mediaDir) return false;
  if(await mediaDir.queryPermission({ mode:'readwrite' }) === 'granted') return true;
  try{ return (await mediaDir.requestPermission({ mode:'readwrite' })) === 'granted'; }
  catch(e){ return false; }
}
async function pickMediaDir(){
  if(!window.showDirectoryPicker){
    alert("This browser can't write to a local folder. Chrome or Edge on desktop is required for the folder option; Google Drive still works everywhere.");
    return;
  }
  try{
    const h = await window.showDirectoryPicker({ mode:'readwrite', startIn:'pictures' });
    mediaDir = h;
    await idbSet('mediaDir', h);
    settings.folderName = h.name; saveSettings();
    renderSettings();
  }catch(e){ /* user cancelled */ }
}
async function writeLocal(name, blob){
  if(!mediaDir || !(await ensureDirPermission())) return false;
  try{
    const fh = await mediaDir.getFileHandle(name, { create:true });
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
    return true;
  }catch(e){ return false; }
}
async function readLocal(name){
  if(!mediaDir || !(await ensureDirPermission())) return null;
  try{
    const fh = await mediaDir.getFileHandle(name);
    return await fh.getFile();
  }catch(e){ return null; }
}

// --- Google Drive (user supplies their own OAuth client id) ---
let driveToken = null, driveTokenClient = null;
function loadGis(){
  return new Promise((res, rej) => {
    if(window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in.'));
    document.head.appendChild(s);
  });
}
async function connectDrive(){
  const cid = (settings.driveClientId || '').trim();
  if(!cid){ alert('Paste your Google OAuth Client ID first.'); return; }
  try{
    await loadGis();
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cid,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp) => {
        if(resp.error){ alert('Drive authorisation failed: ' + resp.error); return; }
        driveToken = resp.access_token;
        settings.driveConnected = true; saveSettings();
        renderSettings();
      },
    });
    driveTokenClient.requestAccessToken({ prompt: driveToken ? '' : 'consent' });
  }catch(e){ alert(e.message); }
}
async function driveUpload(name, blob){
  if(!driveToken) return null;
  const meta = { name, ...(settings.driveFolderId ? { parents:[settings.driveFolderId.trim()] } : {}) };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type:'application/json' }));
  form.append('file', blob);
  try{
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method:'POST', headers:{ Authorization:'Bearer ' + driveToken }, body: form,
    });
    if(!r.ok) return null;
    return (await r.json()).id || null;
  }catch(e){ return null; }
}
async function driveDownload(id){
  if(!driveToken || !id) return null;
  try{
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers:{ Authorization:'Bearer ' + driveToken },
    });
    if(!r.ok) return null;
    return await r.blob();
  }catch(e){ return null; }
}

// --- Thumbnail so a note never looks broken, even with both sources offline ---
function makeThumb(file, max = 260){
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/jpeg', 0.55));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => res('');
    img.src = URL.createObjectURL(file);
  });
}

// Replace stored references with real image data pulled from local disk / Drive.
async function hydrateMedia(root){
  const imgs = root.querySelectorAll('img[data-media]');
  for(const img of imgs){
    const name = img.dataset.media;
    if(!img.dataset.thumb && (img.getAttribute('src') || '').startsWith('data:')) img.dataset.thumb = img.getAttribute('src');
    if(mediaCache.has(name)){ img.src = mediaCache.get(name); img.classList.remove('pending'); continue; }
    let blob = await readLocal(name);
    if(!blob && img.dataset.drive) blob = await driveDownload(img.dataset.drive);
    if(blob){
      const url = URL.createObjectURL(blob);
      mediaCache.set(name, url);
      img.src = url;
      img.classList.remove('pending');
    } else {
      img.classList.add('pending'); // keeps the thumbnail visible
    }
  }
}


// ===== Custom theme ===================================================
const CT_FIELDS = [
  ['bg','Background'],['bg2','Background edge'],['panel','Panel'],['panel2','Panel highlight'],
  ['line','Borders'],['text','Text'],['muted','Muted text'],
  ['amber','Accent 1'],['accent2','Accent 2'],['accent3','Accent 3'],['dusk','Dusk'],
];
function customTheme(){
  return Object.assign({ name:'Custom' }, THEMES.slate, settings.customTheme || {});
}
function renderCustomTheme(){
  const grid = document.getElementById('ct-grid');
  if(!grid || typeof THEMES === 'undefined') return;
  const t = customTheme();
  grid.innerHTML = '';
  CT_FIELDS.forEach(([k, label]) => {
    const row = document.createElement('label');
    row.className = 'ct-row';
    row.innerHTML = `<input type="color" data-k="${k}" value="${t[k]}"><span>${label}</span><code>${t[k]}</code>`;
    row.querySelector('input').addEventListener('input', (e) => {
      const cur = Object.assign({}, customTheme());
      cur[k] = e.target.value;
      settings.customTheme = cur; saveSettings();
      row.querySelector('code').textContent = e.target.value;
      THEMES.custom = customTheme();
      if(localStorage.getItem(THEME_KEY) === 'custom') applyTheme('custom'); // live preview
    });
    grid.appendChild(row);
  });
}
function initCustomThemeUI(){
  THEMES.custom = customTheme();
  renderCustomTheme();
  document.getElementById('ct-save').addEventListener('click', () => {
    THEMES.custom = customTheme(); applyTheme('custom'); SFX.open();
    alert('Custom theme applied. It also appears in the Theme menu.');
  });
  document.getElementById('ct-copy').addEventListener('click', () => {
    const cur = THEMES[localStorage.getItem(THEME_KEY) || 'slate'] || THEMES.slate;
    settings.customTheme = Object.assign({}, cur, { name:'Custom' });
    saveSettings(); THEMES.custom = customTheme(); renderCustomTheme();
  });
  document.getElementById('ct-reset').addEventListener('click', () => {
    delete settings.customTheme; saveSettings();
    THEMES.custom = customTheme(); renderCustomTheme();
  });
}

// ===== Settings screen =====
function renderSettings(){
  const originEl = document.getElementById('set-origin');
  if(originEl) originEl.textContent = location.origin;

  const fs = document.getElementById('set-folder-status');
  const fnote = document.getElementById('set-folder-note');
  if(!window.showDirectoryPicker){
    fs.textContent = 'Not supported in this browser';
    fs.className = '';
    fnote.textContent = 'Writing to a local folder needs Chrome or Edge on desktop. Google Drive works everywhere.';
  } else if(mediaDir){
    fs.textContent = 'Saving to “' + (settings.folderName || mediaDir.name) + '”';
    fs.className = 'ok';
    fnote.textContent = 'Chrome may ask you to re-confirm access after a restart — that is normal.';
  } else {
    fs.textContent = 'Not configured';
    fs.className = '';
    fnote.textContent = 'Until a folder is chosen, pasted images are kept as small previews only.';
  }

  const ds = document.getElementById('set-drive-status');
  ds.textContent = driveToken ? 'Connected' : (settings.driveConnected ? 'Authorised — reconnect to upload' : 'Not connected');
  ds.className = driveToken ? 'ok' : '';
  document.getElementById('set-drive-client').value = settings.driveClientId || '';
  document.getElementById('set-drive-folder').value = settings.driveFolderId || '';
  const sx = document.getElementById('set-sfx-status');
  if(sx) sx.textContent = settings.muted ? 'Muted' : 'On';
  const kbBox = document.getElementById('kb-json');
  if(kbBox && !kbBox.value && KB.length) kbBox.value = JSON.stringify(KB, null, 2);
  renderKbStatus();
}
document.getElementById('set-folder-btn').addEventListener('click', pickMediaDir);
document.getElementById('set-drive-btn').addEventListener('click', connectDrive);
document.getElementById('set-drive-client').addEventListener('change', (e) => { settings.driveClientId = e.target.value.trim(); saveSettings(); });
document.getElementById('set-drive-folder').addEventListener('change', (e) => { settings.driveFolderId = e.target.value.trim(); saveSettings(); });


const KB_TEMPLATE = JSON.stringify([
  { title: "Foxess inverter — error 21", content: "Grid overvoltage. Check AC voltage at the breaker; above 253V the inverter disconnects by regulation. Ask the utility for a tap adjustment if it persists.", tags: ["foxess","inverter","error","grid"] },
  { title: "Deye F58 alarm", content: "Ground fault on the DC side. Inspect string insulation and MC4 connectors for moisture.", tags: ["deye","f58","alarm"] },
  { title: "PAC opening rules", content: "Open a PAC when the fault requires a field visit or manufacturer RMA. Attach photos of the display and the plate.", tags: ["pac","process"] }
], null, 2);
const rainTest = document.getElementById('rain-test');
if(rainTest){
  rainTest.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    const lab = document.getElementById('rain-test-label');
    if(v < 0){
      rainOverride = null;
      lab.textContent = 'Using the live forecast';
    } else {
      rainOverride = v;
      const band = v <= 0.05 ? 'dry' : v < 2 ? 'drizzle' : v < 10 ? 'steady rain' : v < 25 ? 'heavy' : 'downpour';
      lab.textContent = `${v.toFixed(1)} mm — ${band}`;
    }
    setRain(rainMM);
  });
}
document.getElementById('sfx-toggle').addEventListener('click', () => {
  settings.muted = !settings.muted; saveSettings();
  document.getElementById('set-sfx-status').textContent = settings.muted ? 'Muted' : 'On';
  if(!settings.muted) SFX.open();
});
document.getElementById('kb-template').addEventListener('click', () => {
  document.getElementById('kb-json').value = KB_TEMPLATE;
});
document.getElementById('kb-save').addEventListener('click', () => {
  const raw = document.getElementById('kb-json').value.trim();
  if(!raw){ alert('Paste some JSON first.'); return; }
  try{
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) throw new Error('The top level must be an array.');
    KB = parsed;
    localStorage.setItem('agenda-solar-kb', JSON.stringify(parsed));
    renderKbStatus();
    alert('Saved ' + parsed.length + ' entries.');
  }catch(err){ alert('That is not valid JSON: ' + err.message); }
});
document.getElementById('kb-clear').addEventListener('click', () => {
  if(!confirm('Clear the pasted knowledge base?')) return;
  localStorage.removeItem('agenda-solar-kb');
  KB = []; document.getElementById('kb-json').value = ''; renderKbStatus(); loadKB();
});

// ===== Exports =====
function download(filename, content, mime){
  const blob = new Blob(['\ufeff' + content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function stripHtml(h){ const d = document.createElement('div'); d.innerHTML = h || ''; return d.textContent.trim().replace(/\s+/g,' '); }

function buildExportTables(){
  const caseRows = cases.map(c => `<tr>
    <td>${esc(c.case_date)}</td><td>${esc(c.titulo)}</td><td>${esc(prioLabel(c.prioridade))}</td>
    <td>${esc(blocoLabel(c.bloco))}</td><td>${esc(c.status || 'pending')}</td>
    <td>${esc(c.horario || '')}</td><td>${esc(c.horario_fim || '')}</td><td>${esc(c.actual_end || '')}</td>
    <td>${esc(c.ticket || '')}</td><td>${esc((c.tags || []).join(', '))}</td>
    <td>${esc((c.notes_log || []).map(n => n.text).join(' | '))}</td></tr>`).join('');

  const noteRows = notes.map(n => {
    const nb = (notebooks.find(x => x.id === n.notebook_id) || {}).title || '';
    return `<tr><td>${esc(nb)}</td><td>${esc(n.title)}</td><td>${esc(n.linked_date || '')}</td>
      <td>${esc((n.tags || []).join(', '))}</td><td>${esc(stripHtml(n.content))}</td></tr>`;
  }).join('');

  return `
  <h2>Cases (${cases.length})</h2>
  <table border="1" cellspacing="0" cellpadding="4">
    <tr><th>Date</th><th>Client / subject</th><th>Priority</th><th>Block</th><th>Status</th>
        <th>Start</th><th>End</th><th>Actual finish</th><th>Ticket</th><th>Tags</th><th>Notes</th></tr>
    ${caseRows}
  </table>
  <h2>Notes (${notes.length})</h2>
  <table border="1" cellspacing="0" cellpadding="4">
    <tr><th>Notebook</th><th>Title</th><th>Linked date</th><th>Tags</th><th>Content</th></tr>
    ${noteRows}
  </table>`;
}
function exportDoc(kind){
  const stamp = todayStr();
  const body = buildExportTables();
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
    <head><meta charset="utf-8"><title>Solar Agenda export ${stamp}</title>
    <style>body{font-family:Calibri,Arial,sans-serif} table{border-collapse:collapse;font-size:11pt} th{background:#f2a71b;text-align:left}</style>
    </head><body><h1>Solar Agenda — export ${stamp}</h1>${body}</body></html>`;
  if(kind === 'xls') download(`solar-agenda-${stamp}.xls`, html, 'application/vnd.ms-excel');
  else download(`solar-agenda-${stamp}.doc`, html, 'application/msword');
}
document.getElementById('export-xls').addEventListener('click', () => exportDoc('xls'));
document.getElementById('export-doc').addEventListener('click', () => exportDoc('doc'));
document.getElementById('export-json').addEventListener('click', () => {
  download(`solar-agenda-${todayStr()}.json`,
    JSON.stringify({ exported_at: new Date().toISOString(), cases, notebooks, notes }, null, 2),
    'application/json');
});

loadKB();
restoreMediaDir().then(() => { if(document.getElementById('view-settings')) renderSettings(); });

document.getElementById('notebook-canvas').addEventListener('paste', async (e) => {
  const canvas = document.getElementById('notebook-canvas');
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find(it => it.type.startsWith('image/'));
  if(!imageItem) return;
  e.preventDefault();
  const file = imageItem.getAsFile();
  if(!file) return;

  const placeholder = document.createElement('div');
  placeholder.textContent = 'Saving image...';
  placeholder.style.color = 'var(--muted)'; placeholder.style.fontSize = '0.82rem';
  insertAtCursor(canvas, placeholder);

  try{
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg','jpg');
    const name = `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;

    // Thumbnail first: guarantees the note shows something immediately and forever.
    const thumb = await makeThumb(file);

    const wroteLocal = await writeLocal(name, file);
    const driveId = await driveUpload(name, file);

    if(!wroteLocal && !driveId){
      // Nothing configured yet — keep the preview and tell them where to fix it.
      const img = document.createElement('img');
      img.className = 'nb-media'; img.src = thumb; img.alt = name;
      const badge = document.createElement('small');
      badge.className = 'media-badge';
      badge.textContent = 'preview only — set a folder or Drive in Settings to keep the full image';
      placeholder.replaceWith(img);
      img.after(badge);
      scheduleNotebookSave();
      return;
    }

    const img = document.createElement('img');
    img.className = 'nb-media';
    img.dataset.media = name;
    if(driveId) img.dataset.drive = driveId;
    img.dataset.thumb = thumb;
    img.src = thumb;          // saved in the note: a few KB, not megabytes
    img.alt = name;
    placeholder.replaceWith(img);

    // Immediately swap in the full-resolution file from wherever it landed.
    const url = URL.createObjectURL(file);
    mediaCache.set(name, url);
    img.src = url;

    scheduleNotebookSave();
  }catch(err){
    placeholder.textContent = 'Could not save the image: ' + err.message;
  }
});
function insertAtCursor(canvas, node){
  const sel = window.getSelection();
  if(!sel || sel.rangeCount === 0 || !canvas.contains(sel.anchorNode)){ canvas.appendChild(node); return; }
  const range = sel.getRangeAt(0);
  range.collapse(false); range.insertNode(node);
  range.setStartAfter(node); range.setEndAfter(node);
  sel.removeAllRanges(); sel.addRange(range);
}
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
}

// --- Themes ---
// Each theme carries a second accent so gradients, glows and the day wheel
// have somewhere to travel to instead of sitting on one flat hue.
const THEMES = {
  slate:        { name: 'Slate',          bg:'#0d151e', bg2:'#070b11', panel:'#16212c', panel2:'#1e2d3c', line:'#2b3d4f', text:'#eaf1f8', muted:'#8fa3b5', amber:'#f2a71b', accent2:'#4f9fd8', accent3:'#7be0c4', dusk:'#4f6b8f' },
  oceansunset:  { name: 'Ocean Sunset',   bg:'#0e1626', bg2:'#070b14', panel:'#17243a', panel2:'#20304b', line:'#2f4468', text:'#eaf2ff', muted:'#93a8c9', amber:'#ffb340', accent2:'#4aa3e8', accent3:'#a071e8', dusk:'#f2775a' },
  sunset:       { name: 'Sunset',         bg:'#1d1310', bg2:'#0f0806', panel:'#2c1e17', panel2:'#3b281d', line:'#553c2b', text:'#fbeade', muted:'#c9a892', amber:'#ff9f5a', accent2:'#e8556f', accent3:'#ffd76e', dusk:'#c17a52' },
  forestsunset: { name: 'Forest Sunset',  bg:'#111f1a', bg2:'#081210', panel:'#1b2d24', panel2:'#263b2f', line:'#3a5545', text:'#edf7ea', muted:'#9cb69c', amber:'#f0a95c', accent2:'#6fc98a', accent3:'#e5d36a', dusk:'#6f9166' },
  oceanmist:    { name: 'Ocean Mist',     bg:'#0a1a22', bg2:'#050e13', panel:'#132630', panel2:'#1c3644', line:'#2c4f61', text:'#e6f6fb', muted:'#8ab6c4', amber:'#5fd0e0', accent2:'#4f86e0', accent3:'#7ce8b8', dusk:'#3f7d90' },
  lavenderdusk: { name: 'Lavender Dusk',  bg:'#171227', bg2:'#0c0817', panel:'#241c38', panel2:'#33274c', line:'#4b3c6e', text:'#f3ecff', muted:'#ab9acd', amber:'#c39cf5', accent2:'#f58ac4', accent3:'#7ba6f5', dusk:'#7c68a8' },
  peachcream:   { name: 'Peach Cream',    bg:'#231916', bg2:'#140e0c', panel:'#31241f', panel2:'#413029', line:'#5e4740', text:'#fdf1e8', muted:'#c9a894', amber:'#ffbe8f', accent2:'#f2807f', accent3:'#ffe2a3', dusk:'#c78e63' },
  sagegarden:   { name: 'Sage Garden',    bg:'#141d18', bg2:'#0a110d', panel:'#1f2d24', panel2:'#2a3b30', line:'#405745', text:'#eef7ea', muted:'#9db79b', amber:'#aed88c', accent2:'#5fc2ab', accent3:'#e0d98a', dusk:'#6b8a5c' },
  midnightbloom:{ name: 'Midnight Bloom', bg:'#110e21', bg2:'#070514', panel:'#1d1932', panel2:'#2a2345', line:'#413460', text:'#f4ecfb', muted:'#a596c2', amber:'#e29ad8', accent2:'#7a6cf5', accent3:'#63d4e8', dusk:'#8a5e94' },
  rosequartz:   { name: 'Rose Quartz',    bg:'#211217', bg2:'#130a0d', panel:'#301c23', panel2:'#40262f', line:'#5c3a45', text:'#fdeaef', muted:'#c795a1', amber:'#ff92aa', accent2:'#d071e8', accent3:'#ffc98e', dusk:'#c15f74' },
  goldenhour:   { name: 'Golden Hour',    bg:'#1f1810', bg2:'#110d08', panel:'#2e2317', panel2:'#3f301d', line:'#5c482d', text:'#fdf5e2', muted:'#c8ae83', amber:'#ffd15c', accent2:'#f2843c', accent3:'#e0605f', dusk:'#c99a3a' },
};
const THEME_KEY = 'agenda-solar-theme';

// Relative luminance -> choose a legible foreground for accent-filled surfaces.
function readableOn(hex){
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16)/255, g = parseInt(h.slice(2,4),16)/255, b = parseInt(h.slice(4,6),16)/255;
  const lin = (v) => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  const L = 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  // Compare actual contrast both ways rather than guessing a threshold —
  // mid-tone accents (lilac, teal) fooled a fixed cutoff.
  const ratio = (a, b) => (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
  const darkL = 0.0055, lightL = 1.0;
  return ratio(L, darkL) >= ratio(L, lightL) ? '#14100a' : '#ffffff';
}

function applyTheme(key){
  const t = THEMES[key] || THEMES.slate;
  const root = document.documentElement.style;
  root.setProperty('--bg', t.bg);
  root.setProperty('--bg2', t.bg2);
  root.setProperty('--panel', t.panel);
  root.setProperty('--panel-2', t.panel2);
  root.setProperty('--line', t.line);
  root.setProperty('--text', t.text);
  root.setProperty('--muted', t.muted);
  root.setProperty('--amber', t.amber);
  root.setProperty('--amber-soft', t.amber + '33');
  root.setProperty('--accent2', t.accent2);
  root.setProperty('--accent3', t.accent3);
  root.setProperty('--glow', t.amber + '55');
  root.setProperty('--dusk', t.dusk);
  // Pick black-or-white text for anything sitting ON the accent colour, so no
  // theme ends up with dark text on a dark button (or vice versa).
  root.setProperty('--on-accent', readableOn(t.amber));
  localStorage.setItem(THEME_KEY, key);
  renderThemeGrid(key);
}
function renderThemeGrid(activeKey){
  const grid = document.getElementById('theme-grid');
  grid.innerHTML = '';
  Object.entries(THEMES).forEach(([key, t]) => {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch' + (key === activeKey ? ' active' : '');
    btn.innerHTML = `<span class="theme-swatch-dot" style="background:linear-gradient(135deg, ${t.amber} 0%, ${t.accent3} 42%, ${t.accent2} 78%, ${t.panel2} 100%)"></span><span class="theme-swatch-name">${t.name}</span>`;
    btn.addEventListener('click', () => applyTheme(key));
    grid.appendChild(btn);
  });
}
const themeModalBackdrop = document.getElementById('theme-modal-backdrop');
document.getElementById('theme-toggle').addEventListener('click', () => {
  renderThemeGrid(localStorage.getItem(THEME_KEY) || 'slate');
  themeModalBackdrop.classList.add('open');
});
document.getElementById('theme-close-btn').addEventListener('click', () => themeModalBackdrop.classList.remove('open'));
themeModalBackdrop.addEventListener('click', (e) => { if(e.target === themeModalBackdrop) themeModalBackdrop.classList.remove('open'); });
THEMES.custom = Object.assign({ name:'Custom' }, THEMES.slate, (JSON.parse(localStorage.getItem(SET_KEY) || '{}').customTheme) || {});
applyTheme(localStorage.getItem(THEME_KEY) || 'slate');
initCustomThemeUI();

// --- Calendar ---
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
document.getElementById('cal-prev').addEventListener('click', () => { calendarMonth.setMonth(calendarMonth.getMonth()-1); renderCalendar(); });
document.getElementById('cal-next').addEventListener('click', () => { calendarMonth.setMonth(calendarMonth.getMonth()+1); renderCalendar(); });
document.getElementById('cal-today').addEventListener('click', () => { calendarMonth = new Date(); calendarMonth.setDate(1); renderCalendar(); });

function renderCalendar(){
  const wd = document.getElementById('cal-weekdays');
  if(wd.children.length === 0){ WEEKDAYS.forEach(d => { const el = document.createElement('div'); el.className = 'cal-weekday'; el.textContent = d; wd.appendChild(el); }); }

  document.getElementById('cal-month-label').textContent = calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  const casesByDate = {};
  cases.forEach(c => { const d = c.case_date; if(!d) return; (casesByDate[d] = casesByDate[d] || []).push(c); });
  const notebooksByDate = {};
  notes.forEach(n => { if(!n.linked_date) return; (notebooksByDate[n.linked_date] = notebooksByDate[n.linked_date] || []).push(n); });

  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  for(let i = 0; i < totalCells; i++){
    const dayNum = i - startOffset + 1;
    const cellDate = new Date(year, month, dayNum);
    const dateStr = cellDate.toLocaleDateString('en-CA');
    const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
    const cell = document.createElement('div');
    cell.className = 'cal-day' + (inMonth ? '' : ' other-month') + (dateStr === today ? ' today' : '');
    const dayCases = casesByDate[dateStr] || [];
    const dayNotes = notebooksByDate[dateStr] || [];
    const dots = dayCases.slice(0,4).map(c => `<span class="cal-dot" style="background:${prioColor(c.prioridade)}"></span>`).join('');
    const noteDot = dayNotes.length ? '<span class="cal-note-dot"></span>' : '';
    cell.innerHTML = `<span class="cal-daynum">${cellDate.getDate()}</span><div class="cal-dots">${dots}${noteDot}</div>`;
    cell.addEventListener('click', () => openDayModal(dateStr, dayCases, dayNotes));
    grid.appendChild(cell);
  }
}

const dayModalBackdrop = document.getElementById('day-modal-backdrop');
document.getElementById('day-modal-close').addEventListener('click', () => dayModalBackdrop.classList.remove('open'));
dayModalBackdrop.addEventListener('click', (e) => { if(e.target === dayModalBackdrop) dayModalBackdrop.classList.remove('open'); });

function openDayModal(dateStr, dayCases, dayNotes){
  document.getElementById('day-modal-title').textContent = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  const casesEl = document.getElementById('day-modal-cases');
  casesEl.innerHTML = dayCases.length ? '' : '<div class="empty">No cases this day.</div>';
  dayCases.forEach(c => {
    const item = document.createElement('div');
    item.className = 'day-item';
    item.innerHTML = `<strong>${escapeHtml(c.titulo)}</strong> <span class="chip" style="margin-left:6px">${prioLabel(c.prioridade)}</span>`;
    item.addEventListener('click', () => { dayModalBackdrop.classList.remove('open'); openModal(c.id); });
    casesEl.appendChild(item);
  });

  const notesEl = document.getElementById('day-modal-notebooks');
  notesEl.innerHTML = dayNotes.length ? '' : '<div class="empty">No notes linked to this day.</div>';
  dayNotes.forEach(n => {
    const nbTitle = (notebooks.find(nb => nb.id === n.notebook_id) || {}).title || '';
    const item = document.createElement('div');
    item.className = 'day-item';
    item.innerHTML = `${escapeHtml(n.title || 'Untitled')}${nbTitle ? ` <span class="chip" style="margin-left:6px">${escapeHtml(nbTitle)}</span>` : ''}`;
    item.addEventListener('click', () => { dayModalBackdrop.classList.remove('open'); switchView('notebooks'); activeFolderId = n.notebook_id; renderNotebooksGrid(); openNote(n.id); });
    notesEl.appendChild(item);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-ghost';
  addBtn.style.width = '100%';
  addBtn.textContent = '+ New case on this day';
  addBtn.addEventListener('click', () => { dayModalBackdrop.classList.remove('open'); openModal(null, dateStr); });
  casesEl.appendChild(addBtn);

  dayModalBackdrop.classList.add('open');
}



// ===== Rain on the wheel =============================================
// Intensity comes straight from the forecast in mm. Light drizzle is a few
// slow, faint drops; heavy rain is dense, fast and wind-slanted — busier, but
// still low-contrast so it never fights the dial for attention.
let rainCanvas, rainCtx, rainDrops = [], rainRAF = null, rainMM = 0, rainOverride = null;

function rainProfile(mm){
  if(mm <= 0.05) return null;
  const i = Math.min(1, mm / 30);                 // 30mm+ counts as full intensity
  return {
    count: Math.round(14 + i * 150),
    speed: 2.4 + i * 7.5,
    len:   6 + i * 20,
    slant: i * 2.6,
    alpha: 0.10 + i * 0.28,
    width: 0.7 + i * 0.9,
  };
}
function seedRain(){
  const p = rainProfile(rainOverride !== null ? rainOverride : rainMM);
  rainDrops = [];
  if(!p || !rainCanvas) return p;
  const w = rainCanvas.width, h = rainCanvas.height;
  for(let i = 0; i < p.count; i++){
    rainDrops.push({
      x: Math.random() * (w + 120) - 60,
      y: Math.random() * h,
      v: p.speed * (0.65 + Math.random() * 0.7),
      l: p.len * (0.6 + Math.random() * 0.8),
      a: p.alpha * (0.5 + Math.random() * 0.7),
    });
  }
  return p;
}
function sizeRain(){
  if(!rainCanvas) return;
  const wrap = rainCanvas.parentElement;
  rainCanvas.width = wrap.clientWidth;
  rainCanvas.height = wrap.clientHeight;
}
function stepRain(){
  const p = rainProfile(rainOverride !== null ? rainOverride : rainMM);
  if(!p || !rainCtx){ rainRAF = null; if(rainCtx) rainCtx.clearRect(0,0,rainCanvas.width,rainCanvas.height); return; }
  const w = rainCanvas.width, h = rainCanvas.height;
  rainCtx.clearRect(0, 0, w, h);
  const night = curPhase === 'night';
  const col = night ? '160,200,255' : '190,215,245';
  rainCtx.lineCap = 'round';
  rainCtx.lineWidth = p.width;
  rainDrops.forEach(d => {
    rainCtx.strokeStyle = `rgba(${col},${d.a})`;
    rainCtx.beginPath();
    rainCtx.moveTo(d.x, d.y);
    rainCtx.lineTo(d.x + p.slant * (d.l / p.len) * 3, d.y + d.l);
    rainCtx.stroke();
    d.y += d.v; d.x += p.slant;
    if(d.y > h){ d.y = -d.l; d.x = Math.random() * (w + 120) - 60; }
    if(d.x > w + 60) d.x = -60;
  });
  rainRAF = requestAnimationFrame(stepRain);
}
function setRain(mm){
  rainMM = mm || 0;
  if(!rainCanvas){
    rainCanvas = document.getElementById('rain-layer');
    if(!rainCanvas) return;
    rainCtx = rainCanvas.getContext('2d');
    window.addEventListener('resize', () => { sizeRain(); seedRain(); });
  }
  sizeRain();
  const p = seedRain();
  const wrap = rainCanvas.parentElement;
  wrap.classList.toggle('raining', !!p);
  if(p && !rainRAF) rainRAF = requestAnimationFrame(stepRain);
  if(!p && rainRAF){ cancelAnimationFrame(rainRAF); rainRAF = null; rainCtx.clearRect(0,0,rainCanvas.width,rainCanvas.height); }
}
// pause when the tab is hidden so it isn't burning battery in the background
document.addEventListener('visibilitychange', () => {
  if(document.hidden && rainRAF){ cancelAnimationFrame(rainRAF); rainRAF = null; }
  else if(!document.hidden && !rainRAF && rainProfile(rainOverride !== null ? rainOverride : rainMM)) rainRAF = requestAnimationFrame(stepRain);
});

// ===== Weather: Vinhedo + the roughest spot in Brazil today ============
// Open-Meteo needs no key and allows browser calls. Rain + wind only, kept
// deliberately small so it reads as a status line, not a weather widget.
const WX_VINHEDO = { lat: -23.0300, lon: -46.9750 };
const WX_BRAZIL = [
  ['Manaus',-3.10,-60.02],['Belém',-1.46,-48.50],['Recife',-8.05,-34.90],
  ['Salvador',-12.97,-38.51],['Fortaleza',-3.73,-38.53],['Brasília',-15.78,-47.93],
  ['São Paulo',-23.55,-46.63],['Rio de Janeiro',-22.91,-43.17],['Curitiba',-25.43,-49.27],
  ['Porto Alegre',-30.03,-51.23],['Florianópolis',-27.60,-48.55],['Cuiabá',-15.60,-56.10],
  ['Campo Grande',-20.44,-54.65],['Belo Horizonte',-19.92,-43.94],['São Luís',-2.53,-44.30],
];
const ICO_RAIN = '<svg class="wx-ico" viewBox="0 0 24 24"><path d="M7 16a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 16z"/><path d="M8 19v2M12 19v2M16 19v2"/></svg>';
const ICO_WIND = '<svg class="wx-ico" viewBox="0 0 24 24"><path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h14a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>';

function wxStat(cls, ico, label, value, unit, alert){
  return `<span class="wx-stat ${cls}${alert ? ' wx-alert' : ''}">${ico}<b>${value}${unit}</b> <small>${label}</small></span>`;
}

let wxSnapshot = null;
async function loadWeather(){
  const localEl = document.getElementById('wx-local');
  const brEl = document.getElementById('wx-brazil');
  if(!localEl) return;
  try{
    // --- Vinhedo ---
    const u1 = `https://api.open-meteo.com/v1/forecast?latitude=${WX_VINHEDO.lat}&longitude=${WX_VINHEDO.lon}`
      + `&daily=precipitation_sum,precipitation_probability_max,wind_speed_10m_max,temperature_2m_max,temperature_2m_min`
      + `&timezone=America%2FSao_Paulo&forecast_days=1`;
    const d = (await (await fetch(u1)).json()).daily;
    const rain = d.precipitation_sum?.[0] ?? 0;
    const prob = d.precipitation_probability_max?.[0] ?? 0;
    const wind = d.wind_speed_10m_max?.[0] ?? 0;
    document.getElementById('wx-temp').textContent =
      Math.round(d.temperature_2m_min?.[0]) + '° / ' + Math.round(d.temperature_2m_max?.[0]) + '°';
    setRain(rain);
    wxSnapshot = { rain, prob, wind,
      tmin: Math.round(d.temperature_2m_min?.[0]), tmax: Math.round(d.temperature_2m_max?.[0]) };
    localEl.innerHTML =
      wxStat('rain', ICO_RAIN, `rain · ${prob}% chance`, rain.toFixed(1), ' mm', rain >= 20) +
      wxStat('wind', ICO_WIND, 'max wind', Math.round(wind), ' km/h', wind >= 45);

    // --- worst in the country (one batched request) ---
    const lats = WX_BRAZIL.map(c => c[1]).join(',');
    const lons = WX_BRAZIL.map(c => c[2]).join(',');
    const u2 = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
      + `&daily=precipitation_sum,wind_speed_10m_max&timezone=America%2FSao_Paulo&forecast_days=1`;
    let arr = await (await fetch(u2)).json();
    if(!Array.isArray(arr)) arr = [arr];
    let wettest = { v: -1, n: '—' }, windiest = { v: -1, n: '—' };
    arr.forEach((r, i) => {
      const name = WX_BRAZIL[i]?.[0] || '';
      const p = r?.daily?.precipitation_sum?.[0] ?? 0;
      const w = r?.daily?.wind_speed_10m_max?.[0] ?? 0;
      if(p > wettest.v) wettest = { v: p, n: name };
      if(w > windiest.v) windiest = { v: w, n: name };
    });
    if(wxSnapshot){ wxSnapshot.wettest = wettest; wxSnapshot.windiest = windiest; }
    brEl.innerHTML =
      wxStat('rain', ICO_RAIN, wettest.n, wettest.v.toFixed(0), ' mm', wettest.v >= 40) +
      wxStat('wind', ICO_WIND, windiest.n, Math.round(windiest.v), ' km/h', windiest.v >= 60);
  }catch(err){
    localEl.innerHTML = '<span class="wx-load">Forecast unavailable right now.</span>';
    if(brEl) brEl.innerHTML = '';
  }
}
setInterval(loadWeather, 30 * 60 * 1000); // refresh twice an hour

// --- Boot ---
if(session){ showApp(); loadCases(); loadNotebooks(); loadNotes(); loadWeather(); }
else { showLogin(); }
syncPhase();
detectHud();