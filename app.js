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
    await fetchVaultKey();
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
  requestAnimationFrame(() => setRain());
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
  const raw = await resp.json();
  cases = await Promise.all((raw || []).map(openCase));
  render();
}
async function createCase(payload){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "POST", headers: authHeaders(), body: JSON.stringify(await sealCase(payload)) });
  if(!resp.ok) throw new Error((await resp.json()).error || "Error creating case.");
  return openCase(await resp.json());
}
async function updateCase(id, payload){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ id, ...(await sealCase(payload)) }) });
  if(!resp.ok) throw new Error((await resp.json()).error || "Error updating case.");
  return openCase(await resp.json());
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
      ${c.phone ? `<span class="chip mono phone-chip">${escapeHtml(c.phone)}</span>` : ''}
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
// One continuous 24h rim. The top semicircle carries the day (07h-18h) and the
// bottom carries the night (18h-07h); only the top is visible, so rotating the
// wheel 180deg rolls the night hours up into place.
const DAY_S = 7, DAY_E = 18;          // 11 hours across the top half
const NIGHT_S = 18, NIGHT_E = 31;     // 13 hours across the bottom half (07h next day)
const WORK_START = 8, WORK_END = 18;
let curPhase = 'day';
let wheelDeg = 0;                     // 0 = day up, 180 = night up
function isNightHour(h){ return h >= 18 || h < 7; }
function isDayHour(h){ return h >= DAY_S && h <= DAY_E; }
// clock hour -> position on the rim, in radians (pi = left, 0 = right, negative = bottom)
function hourToAngle(h){
  if(h >= DAY_S && h <= DAY_E) return Math.PI - ((h - DAY_S) / (DAY_E - DAY_S)) * Math.PI;
  const n = h < DAY_S ? h + 24 : h;   // carry early morning into 24-31
  return -(((n - NIGHT_S) / (NIGHT_E - NIGHT_S)) * Math.PI);
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
  if(!svg) return;
  const r = 160, cx = 400, cy = 190;
  const night = curPhase === 'night';
  const AC = night ? 'var(--accent2)' : 'var(--amber)';
  const P = (h, rad) => arcPoint(hourToAngle(h), rad);

  // hours that sit on the bottom half get pre-flipped, so once the wheel has
  // turned 180deg their labels read upright
  const flip = (h, x, y) => (h > DAY_E || h < DAY_S) ? ` transform="rotate(180 ${x} ${y})"` : '';

  let d = [`<defs>
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
    <clipPath id="topHalf"><rect x="0" y="-40" width="800" height="${cy + 40}"/></clipPath>
  </defs>`];

  // stars sit behind the wheel and do not rotate with it
  if(night){
    for(let i = 0; i < 16; i++){
      d.push(`<circle class="arc-star" cx="${60 + ((i * 137) % 690)}" cy="${-14 + ((i * 53) % 120)}" r="${0.7 + ((i * 7) % 3) * 0.35}" fill="var(--text)" opacity="0.5" style="animation-delay:${(i % 7) * 0.42}s"/>`);
    }
  }

  let w = [];   // everything that turns with the wheel

  // full rim, so the track is continuous as it rolls
  w.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${AC}" stroke-width="14" stroke-opacity="0.04"/>`);
  const dS = P(DAY_S, r), dE = P(DAY_E, r);
  w.push(`<path d="M ${dS.x} ${dS.y} A ${r} ${r} 0 0 1 ${dE.x} ${dE.y}" fill="none" stroke="url(#arcTrack)" stroke-width="3" stroke-linecap="round"/>`);
  w.push(`<path d="M ${dE.x} ${dE.y} A ${r} ${r} 0 0 1 ${dS.x} ${dS.y}" fill="none" stroke="url(#arcTrack)" stroke-width="3" stroke-linecap="round"/>`);

  // highlight: first working hour by day, the evening stretch by night
  const hlS = night ? 18 : WORK_START, hlE = night ? 22 : WORK_START + 1;
  const a = P(hlS, r), b = P(hlE, r);
  w.push(`<path d="M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}" fill="none" stroke="url(#arcFirstHour)" stroke-width="5" stroke-linecap="round" filter="url(#bloom)"/>`);

  // every hour of the clock, all the way round
  for(let h = DAY_S; h < DAY_S + 24; h++){
    const onDay = isDayHour(h);
    const major = onDay ? (h - DAY_S) % 2 === 0 : (h - NIGHT_S) % 2 === 0;
    const p = P(h, r), pO = P(h, r + (major ? 12 : 7));
    w.push(`<line x1="${p.x}" y1="${p.y}" x2="${pO.x}" y2="${pO.y}" stroke="${major ? AC : 'var(--line)'}" stroke-opacity="${major ? 0.7 : 0.35}" stroke-width="2"/>`);
    if(major){
      const pL = P(h, r + 27);
      w.push(`<text x="${pL.x}" y="${pL.y + 3}" fill="var(--text)" font-size="11" text-anchor="middle" font-family="JetBrains Mono, monospace"${flip(h, pL.x, pL.y + 3)}>${String(h % 24).padStart(2,'0')}h</text>`);
    }
  }

  // cases, wherever they fall on the 24h rim
  const th = t => { const [hh, mm] = t.split(':').map(Number); return hh + (mm || 0) / 60; };
  pendingTodaysCases().forEach(c2 => {
    if(!c2.horario) return;
    const h = th(c2.horario);
    if(c2.horario_fim){
      const p1 = P(h, r), p2 = P(th(c2.horario_fim), r);
      w.push(`<g class="arc-dot" data-id="${c2.id}"><path d="M ${p1.x} ${p1.y} A ${r} ${r} 0 0 1 ${p2.x} ${p2.y}" fill="none" stroke="${prioColor(c2.prioridade)}" stroke-width="7" stroke-linecap="round" stroke-opacity="0.6" filter="url(#bloom)"/></g>`);
    } else {
      const p = P(h, r);
      w.push(`<g class="arc-dot" data-id="${c2.id}"><circle cx="${p.x}" cy="${p.y}" r="5.5" fill="${prioColor(c2.prioridade)}" stroke="var(--bg)" stroke-width="2" filter="url(#bloom)"/></g>`);
    }
  });

  // "now" marker travels with the wheel too
  const now = new Date();
  const nh = now.getHours() + now.getMinutes() / 60;
  const markerOnThisFace = isDayHour(nh) === !night;
  if(markerOnThisFace){
    const np = P(nh, r);
    w.push(`<line x1="${cx}" y1="${cy}" x2="${np.x}" y2="${np.y}" stroke="${AC}" stroke-width="1.5" stroke-opacity="0.28" stroke-dasharray="4 5"/>`);
    w.push(`<circle cx="${np.x}" cy="${np.y}" r="7" fill="none" stroke="${AC}" stroke-width="2" stroke-opacity="0.5">
      <animate attributeName="r" values="7;20;7" dur="3s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="3s" repeatCount="indefinite"/></circle>`);
    w.push(`<circle cx="${np.x}" cy="${np.y}" r="7" fill="${AC}" filter="url(#bloom)"><animate attributeName="r" values="6;9;6" dur="2.4s" repeatCount="indefinite"/></circle>`);
    if(night) w.push(`<circle cx="${np.x + 3}" cy="${np.y - 2.4}" r="5.4" fill="var(--panel)"/>`);
  }

  d.push(`<g clip-path="url(#topHalf)" opacity="${night ? 0.88 : 1}"><g id="wheel-g" class="wheel-g" style="transform:rotate(${wheelDeg}deg)">${w.join('')}</g></g>`);
  svg.innerHTML = d.join('');
  svg.querySelectorAll('.arc-dot').forEach(el => el.addEventListener('click', () => openModal(el.getAttribute('data-id'))));

  document.getElementById('clock-label').textContent = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  const cnt = document.getElementById('face-count');
  if(cnt){
    const n = pendingTodaysCases().filter(x => x.horario && (isDayHour(th(x.horario)) === !night)).length;
    cnt.textContent = n ? `${n} on this face` : 'nothing scheduled';
  }
}

// Rolling the rim. wheelDeg accumulates so every turn goes the same way
// round — going back to day rolls 180->360, never backwards to 0.
let spinning = false;
function spinToPhase(night, silent){
  const target = night ? 'night' : 'day';
  if(curPhase === target && !spinning) return;
  const wrap = document.querySelector('.arc-wrap');
  spinning = true;
  wrap?.classList.add('spinning');
  if(!silent) SFX.phase(night);

  const from = wheelDeg;
  wheelDeg = from + 180;          // clockwise, always
  curPhase = target;
  renderArc();
  applyPhaseChrome(night);

  const g = document.getElementById('wheel-g');
  if(g){
    g.classList.remove('rolling');
    g.style.transform = `rotate(${from}deg)`;      // snap back to where it was
    requestAnimationFrame(() => {
      g.classList.add('rolling');
      g.style.transform = `rotate(${wheelDeg}deg)`;
    });
  }
  setTimeout(() => { spinning = false; wrap?.classList.remove('spinning'); }, 1750);
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
  if(first){
    curPhase = want ? 'night' : 'day';
    wheelDeg = want ? 180 : 0;      // start already rolled, no animation on load
    renderArc(); applyPhaseChrome(want); return;
  }
  if((curPhase === 'night') !== want) spinToPhase(want, false);
}

// Preview the opposite face on demand — otherwise you'd wait until 18:00 to
// find out whether the spin works.
document.getElementById('phase-pill').addEventListener('click', () => {
  const realNight = isNightHour(new Date().getHours());
  phaseOverride = (phaseOverride === null) ? !realNight : null;
  spinToPhase(phaseOverride !== null ? phaseOverride : realNight, false);
});

setInterval(() => { syncPhase(); if(!spinning) renderArc(); if(!document.getElementById('view-calendar').classList.contains('hidden')) renderCalendar(); }, 15000);

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
  document.getElementById('f-phone').value = c?.phone || '';
  syncPhoneLink();
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
  // A finished case is a record of what happened — it should not be rewritten.
  const closed = c && statusRank(c.status) === 1;
  const locked = closed;
  ['f-titulo','f-ticket','f-phone','f-horario','f-horario-fim','f-date','f-notas','f-tags-input']
    .forEach(id => { const el = document.getElementById(id); if(el){ el.readOnly = !!closed; el.disabled = !!closed; } });
  document.getElementById('f-prioridade-wrap')?.classList.toggle('is-locked', !!closed);
  document.getElementById('f-bloco-wrap')?.classList.toggle('is-locked', !!closed);
  document.getElementById('save-btn').style.display = closed ? 'none' : 'inline-block';
  document.getElementById('f-actual-end').disabled = false;   // still correctable
  document.getElementById('closed-banner').style.display = closed ? 'flex' : 'none';
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
    phone: document.getElementById('f-phone').value.trim(),
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


// Keep the call button pointing at whatever is typed, and show whether the
// field will be stored encrypted.
function syncPhoneLink(){
  const inp = document.getElementById('f-phone');
  const link = document.getElementById('f-phone-call');
  const lock = document.getElementById('phone-lock');
  if(!inp || !link) return;
  const digits = (inp.value || '').replace(/[^\d+]/g, '');
  link.href = digits ? 'tel:' + digits : '#';
  link.classList.toggle('off', !digits);
  if(lock) lock.textContent = cryptoKey ? '🔒 encrypted' : '';
}
document.getElementById('f-phone')?.addEventListener('input', syncPhoneLink);


// ===== Voice assistant ===============================================
// Wake word runs entirely in the browser via the Web Speech API — raw audio
// never leaves the machine, and only the final transcript is sent onward.
// After a reply the mic reopens for a follow-up, so "Hey TARS" is needed
// once to start a conversation, not once per sentence.
// Whisper renders the name inconsistently, so the common mishearings are
// treated as hits too.
const WAKE_WORDS = ['hey tars', 'hei tars', 'ei tars', 'hey tarz', 'hey tarss', 'hey tar',
                    'ok tars', 'hey tars,', 'tars,', 'e tars'];
const FOLLOW_UP_MS = 9000;      // how long the mic stays open after a reply

const VOICE = {
  supported: !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
  state: 'off', lang: 'en-US', active: false, bargeStart: 0, greeted: false,
  srcNode: null, peakSeen: 0,
  conversing: false, followTimer: null, restarting: false, analyser: null, level: 0,
};

function detectLang(text){
  const t = ' ' + text.toLowerCase() + ' ';
  const pt = [' que ',' não ',' nao ',' você ',' voce ',' está ',' esta ',' para ',' com ',' uma ',' meu ',' minha ',' quais ',' quantos ',' hoje ',' amanhã ',' obrigado ',' por favor ',' agenda ',' caso ',' cliente '];
  const hits = pt.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  return hits >= 2 ? 'pt-BR' : (hits === 1 && text.split(/\s+/).length < 8 ? 'pt-BR' : 'en-US');
}

function setVoiceState(s, detail){
  VOICE.state = s;
  const orb = document.getElementById('voice-orb');
  const lab = document.getElementById('voice-state');
  if(orb) orb.dataset.state = s;
  if(lab){
    const map = {
      off:'Voice off', calibrating:'Reading the room…', idle:'Idle — say “Hey TARS”', wake:'TARS here',
      listening:'Listening…', processing:'Processing…', thinking:'Thinking…', tool:'Consulting…',
      speaking:'Speaking…', interrupted:'Go ahead', error: detail || 'Error',
    };
    lab.textContent = map[s] || s;
  }
}

// --- microphone level, for the reactive orb ---
async function startMicMeter(stream){
  try{
    const ctx = acAlways();
    if(!ctx) return;
    // An AudioContext begins suspended until a gesture; reading it before it
    // resumes yields silence, which previously looked like a dead microphone.
    if(ctx.state === 'suspended'){ try{ await ctx.resume(); }catch(e){} }

    // Always rebuild. The old analyser stays wired to the previous stream, and
    // that stream's tracks were stopped — so reusing it reads silence forever.
    if(VOICE.analyser){
      try{ VOICE.srcNode && VOICE.srcNode.disconnect(); }catch(e){}
      try{ VOICE.analyser.disconnect(); }catch(e){}
      VOICE.analyser = null; VOICE.srcNode = null;
    }
    if(!stream) stream = await navigator.mediaDevices.getUserMedia({ audio:true });

    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512; an.smoothingTimeConstant = 0.75;
    src.connect(an);
    VOICE.srcNode = src;
    VOICE.analyser = an;
    VOICE.level = 0;

    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if(VOICE.analyser !== an) return;          // superseded by a newer meter
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for(let i = 0; i < buf.length; i++){ const v = (buf[i] - 128) / 128; sum += v * v; }
      VOICE.level = Math.min(1, Math.sqrt(sum / buf.length) * 4.5);
      if(VOICE.level > VOICE.peakSeen) VOICE.peakSeen = VOICE.level;
      drawOrb();
      requestAnimationFrame(tick);
    };
    tick();
  }catch(e){
    setVoiceState(VSTATE.ERROR, 'microphone unavailable');
  }
}

function drawOrb(){
  const cv = document.getElementById('voice-canvas');
  if(!cv) return;
  const ctx2 = cv.getContext('2d');
  const w = cv.width = cv.clientWidth, h = cv.height = cv.clientHeight;
  ctx2.clearRect(0, 0, w, h);
  const cx = w/2, cy = h/2;
  const speaking = VOICE.state === VSTATE.SPEAKING;
  // Real level when we have one: mic while listening, output while speaking.
  // Only when neither analyser is available do we fall back to a idle drift,
  // and the caption says so.
  const outLvl = speaking ? AudioOut.level() : null;
  const measured = speaking ? outLvl : VOICE.level;
  const lvl = measured !== null && measured !== undefined
    ? measured
    : (speaking ? 0.22 + Math.sin(Date.now()/240) * 0.06 : 0.02 + Math.sin(Date.now()/900) * 0.015);
  const base = Math.min(w, h) * 0.26;
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue('--accent2').trim() || '#4f9fd8';
  const c2 = css.getPropertyValue('--amber').trim() || '#f2a71b';
  for(let ring = 0; ring < 3; ring++){
    const r = base * (1 + ring * 0.34) + lvl * base * (0.9 - ring * 0.22);
    ctx2.beginPath();
    for(let a = 0; a <= Math.PI * 2 + 0.01; a += 0.12){
      const wob = 1 + Math.sin(a * (3 + ring) + Date.now()/(420 + ring*160)) * lvl * 0.20;
      const x = cx + Math.cos(a) * r * wob, y = cy + Math.sin(a) * r * wob;
      a === 0 ? ctx2.moveTo(x, y) : ctx2.lineTo(x, y);
    }
    ctx2.closePath();
    ctx2.strokeStyle = ring === 0 ? c2 : c1;
    ctx2.globalAlpha = 0.55 - ring * 0.15;
    ctx2.lineWidth = ring === 0 ? 2 : 1.2;
    ctx2.stroke();
  }
  ctx2.globalAlpha = 1;
  const g = ctx2.createRadialGradient(cx, cy, 1, cx, cy, base * (0.85 + lvl * 0.5));
  g.addColorStop(0, c2); g.addColorStop(1, 'transparent');
  ctx2.fillStyle = g;
  ctx2.beginPath(); ctx2.arc(cx, cy, base * (0.8 + lvl * 0.45), 0, Math.PI*2); ctx2.fill();
}

// Chrome populates getVoices() asynchronously — warm it up or the first
// utterance falls back to a default voice, or plays with none at all.
let voicesReady = false;
function primeVoices(){
  if(!window.speechSynthesis) return;
  const load = () => { voicesReady = speechSynthesis.getVoices().length > 0; renderVoiceList(); };
  load();
  speechSynthesis.onvoiceschanged = load;
}

// --- speech synthesis ---
// ===== Sound =========================================================
// Synthesised through Web Audio: a reverb + delay bus with detuned, filtered
// voices. No audio files to host.
let audioCtx = null, busDry = null, busWet = null;
function ac(){
  if(settings.muted) return null;
  if(!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    audioCtx = new AC();
    const master = audioCtx.createGain(); master.gain.value = 0.9;
    master.connect(audioCtx.destination);
    const len = audioCtx.sampleRate * 2.4;
    const ir = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for(let ch = 0; ch < 2; ch++){
      const d = ir.getChannelData(ch);
      for(let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    const rev = audioCtx.createConvolver(); rev.buffer = ir;
    const revGain = audioCtx.createGain(); revGain.gain.value = 0.55;
    rev.connect(revGain).connect(master);
    const dl = audioCtx.createDelay(1.0); dl.delayTime.value = 0.19;
    const fb = audioCtx.createGain(); fb.gain.value = 0.32;
    const dlF = audioCtx.createBiquadFilter(); dlF.type = 'highpass'; dlF.frequency.value = 700;
    dl.connect(fb).connect(dlF).connect(dl);
    const dlGain = audioCtx.createGain(); dlGain.gain.value = 0.3;
    dl.connect(dlGain).connect(master);
    busDry = audioCtx.createGain(); busDry.gain.value = 1; busDry.connect(master);
    busWet = audioCtx.createGain(); busWet.gain.value = 1;
    busWet.connect(rev); busWet.connect(dl);
  }
  if(audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// The microphone meter must run even when interface sounds are muted.
function acAlways(){
  const was = settings.muted; settings.muted = false;
  const ctx = ac(); settings.muted = was; return ctx;
}

function voice({ freq = 440, to = null, dur = 0.3, type = 'sawtooth', vol = 0.05,
                 delay = 0, detune = 0, cut = 2600, cutTo = null, q = 6, space = 0.5, pan = 0 }){
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
  osc.connect(flt).connect(g);
  g.connect(busDry); g.connect(send); send.connect(busWet);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}
function air({ dur = 0.6, vol = 0.02, delay = 0, from = 300, to = 6000, type = 'bandpass', q = 1.2, space = 0.6, pan = 0 }){
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
  src.connect(f).connect(g);
  g.connect(busDry); g.connect(send); send.connect(busWet);
  src.start(t0); src.stop(t0 + dur + 0.05);
}
function chord(freqs, o = {}){
  freqs.forEach((f, i) => {
    voice(Object.assign({ freq:f, dur:1.5, type:'sawtooth', vol:0.028, cut:900, cutTo:4200,
                          delay:(o.delay || 0) + i * (o.stagger ?? 0.06), space:0.8 }, o.v || {}));
    voice(Object.assign({ freq:f, dur:1.5, type:'sawtooth', vol:0.022, detune:-9, cut:900, cutTo:3600,
                          delay:(o.delay || 0) + i * (o.stagger ?? 0.06), space:0.8 }, o.v || {}));
  });
}
function impact({ delay = 0, vol = 0.1 }){
  voice({ freq:70, to:38, dur:0.45, type:'sine', vol, delay, cut:400, space:0.35 });
  air({ dur:0.1, vol: vol * 0.3, delay, from:4000, to:600, q:0.8, space:0.4 });
}
function servo({ delay = 0, dur = 0.8, vol = 0.02 }){
  voice({ freq:180, to:320, dur, type:'sawtooth', vol, delay, cut:900, cutTo:2200, q:9, space:0.6 });
}
function reverseSwell({ dur = 1.2, delay = 0, vol = 0.04, from = 400, to = 7000 }){
  air({ dur, vol, delay, from, to, q:0.9, space:0.85 });
}
function chatter({ count = 12, spread = 1, delay = 0, vol = 0.01 }){
  for(let i = 0; i < count; i++){
    voice({ freq: 900 + Math.random() * 2600, dur:0.035, type:'square',
            vol, delay: delay + (i / count) * spread, cut:7000, space:0.7 });
  }
}
function metal({ base = 660, dur = 0.6, delay = 0, vol = 0.02, pan = 0 }){
  [1, 2.41, 3.83].forEach((m, i) =>
    voice({ freq: base * m, dur: dur * (1 - i * 0.2), type:'sine',
            vol: vol / (i + 1), delay, cut:9000, space:1 }));
}

let bootUsedFile = false;
const SFX = {
  bootCue(){
    impact({ delay:0, vol:0.12 });
    voice({ freq:62, to:34, dur:0.55, type:'sine', vol:0.12, cut:320, space:0.35 });
    air({ dur:0.14, vol:0.04, from:5200, to:600, q:0.7, space:0.5 });
    voice({ freq:74, to:150, dur:1.05, type:'sawtooth', vol:0.05, delay:0.28, cut:300, cutTo:900, q:5, space:0.5 });
    servo({ delay:0.3, dur:0.9, vol:0.018 });
    impact({ delay:0.82, vol:0.07 });
    reverseSwell({ dur:1.25, delay:1.0, vol:0.05, from:420, to:7400 });
    voice({ freq:130, to:900, dur:1.25, type:'sawtooth', vol:0.038, delay:1.0, cut:800, cutTo:6000, q:7, space:0.7 });
    chatter({ count:15, spread:1.15, delay:1.05, vol:0.010 });
    [[2.20, 660], [2.45, 880], [2.62, 1046.5], [2.80, 1320]].forEach(([d, f], i) => {
      air({ dur:0.07, vol:0.028, delay:d, from:6500, to:2000, q:1.6, space:0.6 });
      metal({ base:f, dur:0.65, delay:d, vol:0.024 });
      impact({ delay:d, vol:0.055 - i * 0.008 });
    });
    chord([261.63, 392, 523.25, 659.25, 783.99],
          { delay:2.75, stagger:0.03, v:{ dur:1.35, vol:0.028, cut:1200, cutTo:5200 } });
  },
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
  bootTick(i){
    if(bootUsedFile) return;
    voice({ freq:1400 + i * 90, dur:0.03, type:'square', vol:0.008, cut:8000, space:0.5 });
  },
  bootDone(){},
  success(){
    voice({ freq:523.25, to:784, dur:0.24, type:'triangle', vol:0.05, cut:4800, space:0.7 });
    voice({ freq:1046.5, dur:0.5, type:'sine', vol:0.025, delay:0.12, space:1 });
  },
  fail(){ voice({ freq:220, to:82, dur:0.5, type:'sawtooth', vol:0.055, cut:1600, cutTo:260, q:7, space:0.5 }); },
  tick(){ voice({ freq:1500, dur:0.045, type:'square', vol:0.012, cut:6000, space:0.4 }); },
  open(){ voice({ freq:440, to:660, dur:0.14, type:'triangle', vol:0.026, cut:4200, space:0.7 }); },
  phase(night){
    if(night){
      voice({ freq:340, to:70, dur:2.0, type:'sawtooth', vol:0.05, cut:2200, cutTo:260, q:8, space:0.9 });
      chord([196, 233.08, 293.66], { delay:0.5, stagger:0.09, v:{ dur:2.6, vol:0.022, cut:700, cutTo:1800 } });
    } else {
      voice({ freq:80, to:520, dur:1.4, type:'sawtooth', vol:0.045, cut:300, cutTo:5200, q:8, space:0.8 });
      chord([261.63, 329.63, 392, 523.25], { delay:0.5, stagger:0.07, v:{ dur:2.2, vol:0.026 } });
    }
  },
};

// ===== Voice state machine ===========================================
// One owner for voice state. Nothing else sets it directly.
const VSTATE = {
  OFF:'off', IDLE:'idle', WAKE:'wake', LISTENING:'listening', PROCESSING:'processing',
  THINKING:'thinking', SPEAKING:'speaking', INTERRUPTED:'interrupted', ERROR:'error',
};

// ===== Audio playback controller =====================================
// Replaces speechSynthesis. One utterance at a time, always interruptible.
const AudioOut = {
  el: null, url: null, abort: null, playing: false,
  srcNode: null, outAnalyser: null, outBuf: null,

  // Routes playback through an analyser so the orb reacts to the actual
  // waveform rather than pretending to.
  _wireAnalyser(){
    if(this.outAnalyser || !this.el) return;
    try{
      const ctx = acAlways(); if(!ctx) return;
      this.srcNode = ctx.createMediaElementSource(this.el);
      this.outAnalyser = ctx.createAnalyser();
      this.outAnalyser.fftSize = 512;
      this.outAnalyser.smoothingTimeConstant = 0.8;
      this.outBuf = new Uint8Array(this.outAnalyser.frequencyBinCount);
      this.srcNode.connect(this.outAnalyser);
      this.outAnalyser.connect(ctx.destination);
    }catch(e){ this.outAnalyser = null; }   // playback still works without it
  },
  level(){
    if(!this.outAnalyser || !this.isPlaying()) return null;
    this.outAnalyser.getByteTimeDomainData(this.outBuf);
    let sum = 0;
    for(let i = 0; i < this.outBuf.length; i++){ const v = (this.outBuf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this.outBuf.length) * 4.2);
  },

  _element(){
    if(!this.el){
      this.el = new Audio();
      this.el.preload = 'auto';
      this.el.addEventListener('ended', () => { this.playing = false; });
      this.el.addEventListener('error', () => { this.playing = false; });
      this._wireAnalyser();
    }
    return this.el;
  },
  isPlaying(){ return this.playing && this.el && !this.el.paused; },
  pause(){ if(this.isPlaying()) this.el.pause(); },
  resume(){ if(this.el && this.el.paused && this.playing) this.el.play().catch(() => {}); },
  stop(){
    this.playing = false;
    try{ this.abort?.abort(); }catch(e){}
    this.abort = null;
    if(this.el){ try{ this.el.pause(); }catch(e){} this.el.removeAttribute('src'); this.el.load(); }
    if(this.url){ URL.revokeObjectURL(this.url); this.url = null; }
  },
  interrupt(){ this.stop(); },

  // Streams from the edge function and starts playing on the first chunk
  // rather than waiting for the whole file.
  async play(text, lang){
    this.stop();
    if(!text) return;
    const a = this._element();
    this.abort = new AbortController();
    const r = await fetch(FN_URL + "/agenda-tts", {
      method:'POST', headers: authHeaders(), signal: this.abort.signal,
      body: JSON.stringify({ text, voiceId: settings.ttsVoiceId || undefined, modelId: settings.ttsModelId || undefined }),
    });
    if(!r.ok){
      const d = await r.json().catch(() => ({}));
      const err = new Error(JARVIS.errorFor(d.code)); err.code = d.code || 'unknown';
      throw err;
    }

    // MediaSource gives true streaming; if unavailable, fall back to buffering
    // the response and playing that instead.
    const canStream = 'MediaSource' in window && MediaSource.isTypeSupported('audio/mpeg');
    this.playing = true;

    if(!canStream){
      const blob = await r.blob();
      this.url = URL.createObjectURL(blob);
      a.src = this.url;
      await a.play().catch(() => {});
      return new Promise(res => { a.onended = res; a.onerror = res; });
    }

    const ms = new MediaSource();
    this.url = URL.createObjectURL(ms);
    a.src = this.url;
    await new Promise(res => ms.addEventListener('sourceopen', res, { once:true }));
    const sb = ms.addSourceBuffer('audio/mpeg');
    const reader = r.body.getReader();
    let started = false;

    const pump = async () => {
      for(;;){
        const { done, value } = await reader.read();
        if(done) break;
        await new Promise(res => {
          if(!sb.updating) return res();
          sb.addEventListener('updateend', res, { once:true });
        });
        try{ sb.appendBuffer(value); }catch(e){ break; }
        if(!started){ started = true; a.play().catch(() => {}); }
      }
      await new Promise(res => { if(!sb.updating) return res(); sb.addEventListener('updateend', res, { once:true }); });
      try{ ms.endOfStream(); }catch(e){}
    };
    pump().catch(() => {});
    return new Promise(res => { a.onended = res; a.onerror = res; });
  },
};

// Browser speech is kept only as a stopgap when ElevenLabs is not configured,
// so the assistant is never silently mute.
function speakFallback(text, lang){
  return new Promise(resolve => {
    if(!window.speechSynthesis || !text){ resolve(); return; }
    try{ speechSynthesis.cancel(); }catch(e){}
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang || VOICE.lang;
      const voices = speechSynthesis.getVoices();
      const pt = u.lang.startsWith('pt');
      const pick = voices.find(v => pt ? v.lang.startsWith('pt') : (v.lang === 'en-GB' && /male|daniel|ryan|george/i.test(v.name)))
                || voices.find(v => v.lang.startsWith(u.lang.slice(0,2)));
      if(pick){ u.voice = pick; u.lang = pick.lang; }
      u.rate = 0.98; u.pitch = 0.84;
      u.onend = resolve; u.onerror = resolve;
      try{ speechSynthesis.resume(); }catch(e){}
      speechSynthesis.speak(u);
      setTimeout(() => { if(speechSynthesis.speaking === false) resolve(); }, 800);
    }, 120);
  });
}

let ttsConfigured = null;
async function probeTts(){
  try{
    const r = await fetch(FN_URL + "/agenda-tts", { method:'POST', headers: authHeaders(), body: JSON.stringify({ probe:true }) });
    const d = await r.json();
    ttsConfigured = !!d.configured;
  }catch(e){ ttsConfigured = false; }
  const el = document.getElementById('tts-status');
  if(el){
    el.textContent = ttsConfigured ? 'ElevenLabs active' : 'Not configured — using the browser voice';
    el.className = ttsConfigured ? 'ok' : '';
  }
  return ttsConfigured;
}

async function speak(text, lang){
  if(settings.voiceMuted || !text) return;
  if(ttsConfigured === null) await probeTts();
  setVoiceState(VSTATE.SPEAKING);
  try{
    if(ttsConfigured) await AudioOut.play(text, lang);
    else await speakFallback(text, lang);
  }catch(err){
    if(err.code === 'tts_unconfigured'){ ttsConfigured = false; await speakFallback(text, lang); }
    else { showHeard(err.message || 'Speech failed.'); await speakFallback(text, lang); }
  }
}


// ===== WakeWordProvider ==============================================
// Deliberately provider-agnostic. The default listens locally (voice activity
// detection) and matches the phrase in the Whisper transcript; a dedicated
// engine such as Porcupine can be dropped in behind the same three methods
// without touching the rest of the assistant.
// Browser wake-word detection is not perfectly reliable, so tapping the orb
// (push-to-talk) is always available as the fallback.
function createTranscriptWakeProvider(){
  let onWakeCb = null, running = false;
  return {
    name: 'transcript-match',
    reliable: false,                 // honest: this is best-effort, not guaranteed
    start(){ running = true; },
    stop(){ running = false; },
    onWake(cb){ onWakeCb = cb; },
    // called by the STT pipeline with each final transcript
    consider(text){
      if(!onWakeCb) return false;
      if(!running){ console.warn('[wake] provider was not started'); running = true; }
      const low = String(text || '').toLowerCase();
      const hit = WAKE_WORDS.find(w => low.includes(w));
      if(!hit) return false;
      const after = text.slice(low.indexOf(hit) + hit.length).replace(/^[,.\s!?]+/, '');
      onWakeCb(after);
      return true;
    },
  };
}
const WakeWord = createTranscriptWakeProvider();
WakeWord.onWake((remainder) => {
  VOICE.conversing = true;
  setVoiceState(VSTATE.WAKE || 'wake');
  SFX.open();
  if(remainder && remainder.length > 2) handleVoiceInput(remainder);
  else { setVoiceState(VSTATE.LISTENING); armFollowUp(); }
});

// --- capture: rolling MediaRecorder segments + Groq Whisper -----------
// ScriptProcessorNode proved unreliable in current Chrome, so capture is back
// on MediaRecorder. Pre-roll is achieved by restarting the recorder on a cycle:
// when speech ends we stop the CURRENT segment, which already contains the
// seconds leading up to it — so the opening syllable is never lost, and every
// blob keeps a valid header.
const VAD = {
  speakThresh: 0.055, silenceThresh: 0.032,
  minSpeechMs: 240, silenceMs: 800, maxClipMs: 12000,
  cycleMs: 5000,               // recorder restart interval while idle
  floor: 0, calibrated: false,
};
let recorder = null, chunks = [], speaking = false, speechStart = 0, lastLoud = 0;
let clipTimer = null, cycleTimer = null, micStream = null, lastClipInfo = null;

function pickMime(){
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return (window.MediaRecorder && opts.find(t => MediaRecorder.isTypeSupported(t))) || '';
}

function newRecorder(){
  if(!micStream) return;
  try{
    const mime = pickMime();
    recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  }catch(e){ setVoiceState(VSTATE.ERROR, 'cannot record'); return; }
  chunks = [];
  recorder.ondataavailable = ev => { if(ev.data && ev.data.size) chunks.push(ev.data); };
  const self = recorder;              // stopVoice nulls the shared reference
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: (self && self.mimeType) || 'audio/webm' });
    chunks = [];
    const wanted = speechStart > 0;
    speechStart = 0;
    if(VOICE.active) newRecorder();          // always keep a segment running
    if(wanted) onClipReady(blob);
  };
  try{ recorder.start(); }catch(e){}
}

function cycleRecorder(){
  clearTimeout(cycleTimer);
  cycleTimer = setTimeout(() => {
    // Only recycle while quiet, so an utterance is never cut in half.
    if(VOICE.active && !speaking && recorder && recorder.state === 'recording'){
      speechStart = 0;
      try{ recorder.stop(); }catch(e){}      // onstop discards and restarts
    }
    cycleRecorder();
  }, VAD.cycleMs);
}

function beginClip(){
  if(speaking) return;
  speaking = true;
  speechStart = Date.now();
  setVoiceState(VSTATE.LISTENING);
  clearTimeout(clipTimer);
  clipTimer = setTimeout(endClip, VAD.maxClipMs);
}
function endClip(){
  clearTimeout(clipTimer);
  if(!speaking) return;
  speaking = false;
  if(Date.now() - speechStart < VAD.minSpeechMs){
    speechStart = 0;
    setVoiceState(VOICE.conversing ? VSTATE.LISTENING : VSTATE.IDLE);
    return;
  }
  lastClipInfo = { secs: ((Date.now() - speechStart) / 1000).toFixed(1) };
  if(recorder && recorder.state === 'recording'){ try{ recorder.stop(); }catch(e){} }
}

function calibrateVAD(){
  VAD.calibrated = false;
  const samples = [];
  const t0 = Date.now();
  const step = () => {
    if(!VOICE.active) return;
    samples.push(VOICE.level || 0);
    if(Date.now() - t0 < 1200){ requestAnimationFrame(step); return; }
    samples.sort((a, b) => a - b);
    const floor = samples[Math.floor(samples.length * 0.6)] || 0.01;
    VAD.floor = floor;
    VAD.speakThresh   = Math.max(0.035, floor * 2.4);
    VAD.silenceThresh = Math.max(0.018, floor * 1.5);
    VAD.calibrated = true;
    // If the meter never moved, the microphone is not reaching us at all.
    const peak = Math.max(samples[samples.length - 1] || 0, VOICE.peakSeen || 0);
    if(peak < 0.0008){
      // One retry with a fresh meter before blaming the hardware — a suspended
      // context or a stale analyser looks identical to a dead microphone.
      if(!VAD.retried && micStream){
        VAD.retried = true;
        showHeard('re-arming the microphone…');
        VOICE.analyser = null;
        startMicMeter(micStream).then(() => calibrateVAD());
        return;
      }
      setVoiceState(VSTATE.ERROR, 'no microphone signal');
      showHeard('No signal from the microphone. Try switching the input device, or reload the page.');
      return;
    }
    VAD.retried = false;
    setVoiceState(VSTATE.IDLE);
  };
  requestAnimationFrame(step);
}

// Whisper echoes its prompt when the audio is unintelligible, so the hint is
// written as a natural sentence rather than a labelled list.
function sttHint(){
  const names = [...new Set(cases.slice(-20).map(x => x.titulo || '').filter(Boolean))].slice(0, 12);
  const base = 'Hey TARS. Support call about solar inverters. We discuss Deye, Foxess and Growatt inverters, PAC tickets, strings and alarms.';
  return names.length ? base + ' Clients mentioned include ' + names.join(', ') + '.' : base;
}
function isPromptEcho(said){
  const s = said.toLowerCase().replace(/[.,!?]/g, '').trim();
  if(!s) return true;
  return /^(terms|clients mentioned include|support call about solar inverters|we discuss deye)\b/.test(s)
      || /^(inverter|deye|foxess|growatt)(,? (inverter|deye|foxess|growatt))+$/.test(s);
}

async function transcribe(blob){
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for(let i = 0; i < bytes.length; i += 0x8000){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const r = await fetch(FN_URL + "/agenda-stt", {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      audio: btoa(bin), mime: blob.type || 'audio/webm',
      lang: VOICE.conversing ? VOICE.lang.slice(0, 2) : 'auto',
      prompt: sttHint(),
    }),
  });
  if(!r.ok) throw new Error('transcription failed');
  return r.json();
}

async function onClipReady(blob){
  if(!VOICE.active) return;
  if(!blob || blob.size < 2000){
    showHeard(`no audio captured (${blob ? blob.size : 0} bytes) — check the microphone`);
    setVoiceState(VOICE.conversing ? VSTATE.LISTENING : VSTATE.IDLE);
    return;
  }
  setVoiceState(VSTATE.PROCESSING);
  let said = '', detected = null;
  try{
    const d = await transcribe(blob);
    said = (d.text || '').trim();
    detected = d.language;
  }catch(err){
    showHeard('could not transcribe — network or service problem');
    setVoiceState(VOICE.conversing ? VSTATE.LISTENING : VSTATE.IDLE);
    return;
  }
  if(/^(you|thank you\.?|obrigado\.?|\.|\s*)$/i.test(said)) said = '';
  if(said && isPromptEcho(said)){
    showHeard(`unclear audio${lastClipInfo ? ` (${lastClipInfo.secs}s)` : ''} — say it again`);
    setVoiceState(VOICE.conversing ? VSTATE.LISTENING : VSTATE.IDLE);
    return;
  }
  showHeard(said || `nothing recognised${lastClipInfo ? ` (${lastClipInfo.secs}s)` : ''}`);
  if(!said || said.length < 2){
    setVoiceState(VOICE.conversing ? VSTATE.LISTENING : VSTATE.IDLE);
    return;
  }

  VOICE.lang = detected && detected.startsWith('pt') ? 'pt-BR'
             : detected && detected.startsWith('en') ? 'en-US'
             : detectLang(said);

  if(!VOICE.conversing){
    if(!WakeWord.consider(said)) setVoiceState(VSTATE.IDLE);
    return;
  }
  handleVoiceInput(said);
}

function vadTick(){
  if(!VOICE.active) return;
  if(!VAD.calibrated){ requestAnimationFrame(vadTick); return; }
  const now = Date.now();
  const lvl = VOICE.level;
  if(VOICE.state === VSTATE.SPEAKING){
    if(lvl > VAD.speakThresh * 1.9){
      if(!VOICE.bargeStart) VOICE.bargeStart = now;
      if(now - VOICE.bargeStart > 220){
        AudioOut.interrupt();
        try{ speechSynthesis.cancel(); }catch(e){}
        VOICE.bargeStart = 0;
        setVoiceState(VSTATE.INTERRUPTED);
        VOICE.conversing = true;
        setTimeout(() => { if(VOICE.active) setVoiceState(VSTATE.LISTENING); }, 220);
      }
    } else if(now - (VOICE.bargeStart || now) > 400){ VOICE.bargeStart = 0; }
  } else if(VOICE.state === VSTATE.THINKING || VOICE.state === VSTATE.PROCESSING){
    // never capture our own turn
  } else if(lvl > VAD.speakThresh){
    lastLoud = now;
    if(!speaking) beginClip();
  } else if(speaking && lvl < VAD.silenceThresh && now - lastLoud > VAD.silenceMs){
    endClip();
  }
  requestAnimationFrame(vadTick);
}

function armFollowUp(){
  clearTimeout(VOICE.followTimer);
  VOICE.followTimer = setTimeout(() => {
    VOICE.conversing = false;
    if(VOICE.active) setVoiceState('idle');
  }, FOLLOW_UP_MS);
}

async function handleVoiceInput(text){
  clearTimeout(VOICE.followTimer);
  addAiMessage('user', text);
  setVoiceState('thinking');
  try{
    const res = await runAssistantTurn(text, true);
    renderTurn(res);
    await speak(res.spoken, VOICE.lang);
  }catch(err){
    renderTurn({ display: err.message, spoken: err.message, sources: [], actions: [],
                 metadata: { confidence: null, latency_ms: 0 } });
    await speak(err.message, VOICE.lang);
  }
  if(VOICE.active){ setVoiceState('listening'); armFollowUp(); }
}

async function startVoice(){
  if(!VOICE.supported){
    alert('This browser cannot record audio. Chrome, Edge or Safari is required. The typed assistant still works.');
    return;
  }
  document.getElementById('voice-panel')?.classList.add('open');
  setVoiceState('thinking');
  // Explicit permission first: without it Chrome can fail silently and never fire an event.
  try{
    await navigator.mediaDevices.getUserMedia({ audio: true });
  }catch(err){
    setVoiceState('error', 'microphone blocked');
    alert('Microphone access was refused. Allow it in the padlock menu beside the address bar, then try again.');
    return;
  }
  VOICE.active = true;
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } }); }
  catch(e){ setVoiceState('error', 'microphone blocked'); return; }
  micStream = stream;
  startMicMeter(stream);
  newRecorder();
  cycleRecorder();
  primeVoices();
  setVoiceState('thinking');
  WakeWord.start();          // without this the provider rejects every phrase
  calibrateVAD();
  requestAnimationFrame(vadTick);
  if(!VOICE.greeted){
    VOICE.greeted = true;
    const g = TARS.greeting();
    addAiMessage('assistant', g);
    speak(g, VOICE.lang);
  }
}
function stopVoice(){
  VOICE.active = false; VOICE.conversing = false;
  clearTimeout(VOICE.followTimer); clearTimeout(clipTimer);
  try{ recorder && recorder.state === 'recording' && recorder.stop(); }catch(e){}
  try{ micStream && micStream.getTracks().forEach(t => t.stop()); }catch(e){}
  clearTimeout(cycleTimer); clearTimeout(clipTimer);
  recorder = null; micStream = null; speaking = false;
  // Without this the analyser survives into the next session still attached to
  // the stopped stream, and every level reads zero.
  try{ VOICE.srcNode && VOICE.srcNode.disconnect(); }catch(e){}
  try{ VOICE.analyser && VOICE.analyser.disconnect(); }catch(e){}
  VOICE.analyser = null; VOICE.srcNode = null; VOICE.level = 0; VOICE.peakSeen = 0;
  VAD.calibrated = false;
  AudioOut.stop();
  WakeWord.stop();
  try{ speechSynthesis?.cancel(); }catch(e){}
  setVoiceState(VSTATE.OFF);
  document.getElementById('voice-panel')?.classList.remove('open');
}
document.getElementById('voice-toggle')?.addEventListener('click', () => {
  VOICE.active ? stopVoice() : startVoice();
});
document.getElementById('voice-close')?.addEventListener('click', stopVoice);

function showHeard(t){
  const el = document.getElementById('voice-heard');
  if(el) el.textContent = t ? '“' + t.slice(0, 90) + '”' : '';
}
// Click the orb to talk without the wake phrase — a guaranteed way in if the
// room is too noisy or too quiet for reliable detection.
document.getElementById('voice-orb')?.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); e.currentTarget.click(); }
});
document.getElementById('voice-orb')?.addEventListener('click', () => {
  if(!VOICE.active) return;
  VOICE.conversing = true;
  armFollowUp();
  setVoiceState('listening');
  SFX.open();
});
// live level bar, so it is obvious whether the mic is picking anything up
function paintLevel(){
  const bar = document.getElementById('voice-level-fill');
  if(bar){
    bar.style.width = Math.min(100, VOICE.level * 220) + '%';
    bar.classList.toggle('over', VOICE.level > VAD.speakThresh);
  }
  const num = document.getElementById('voice-lvlnum');
  if(num && VOICE.active){
    num.textContent = `mic ${VOICE.level.toFixed(3)} · trigger ${VAD.speakThresh.toFixed(3)}`;
  }
  requestAnimationFrame(paintLevel);
}
requestAnimationFrame(paintLevel);
function renderVoiceList(){
  const sel = document.getElementById('voice-select');
  if(!sel || !window.speechSynthesis) return;
  const voices = speechSynthesis.getVoices();
  if(!voices.length) return;
  sel.innerHTML = '<option value="">Automatic voice</option>' +
    voices.map(v => `<option value="${v.name}"${settings.voiceName === v.name ? ' selected' : ''}>${v.name} · ${v.lang}</option>`).join('');
}
document.getElementById('voice-select')?.addEventListener('change', (e) => {
  settings.voiceName = e.target.value || null; saveSettings();
  speak(settings.voiceName ? 'Voice set.' : 'Automatic voice.', VOICE.lang);
});
document.getElementById('voice-mute')?.addEventListener('click', () => {
  settings.voiceMuted = !settings.voiceMuted; saveSettings();
  if(settings.voiceMuted){ AudioOut.stop(); try{ speechSynthesis?.cancel(); }catch(e){} }
  document.getElementById('voice-mute').textContent = settings.voiceMuted ? 'Unmute replies' : 'Mute replies';
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
let lastLatency = null;
async function callAiAgent(messages, tools, opts){
  const body = tools && tools.length ? { messages, tools } : { messages };
  Object.assign(body, opts || {});
  let data;
  try{
    const resp = await fetch(FN_URL + "/agenda-ai", { method:"POST", headers: authHeaders(), body: JSON.stringify(body) });
    data = await resp.json().catch(() => ({}));
    if(!resp.ok){
      const code = data.code || 'unknown';
      console.error('[assistant]', resp.status, code, data.error || '');
      const err = new Error(TARS.errorFor(code)
        + (data.detail ? ` — ${String(data.detail).slice(0, 120)}` : ` (HTTP ${resp.status})`));
      err.code = code;
      throw err;
    }
  }catch(e){
    if(e.code) throw e;
    console.error('[assistant] transport', e.message);
    const err = new Error(TARS.errorFor('network'));  // fetch itself failed
    err.code = 'network';
    throw err;
  }
  lastLatency = data.latency_ms ?? null;
  return data.message || { content: data.reply || '' };
}

// Tools the assistant is allowed to call on your behalf.
// ===== Tool registry =================================================
// Every capability the model has is declared here and nowhere else. There is
// no path from the LLM to the shell, the filesystem, arbitrary SQL, arbitrary
// network calls or any credential — only these entries can run, and each one
// goes through its own vetted edge function.
const PERM = { READ: 'read_only', LOW: 'low_risk', HIGH: 'consequential' };

// Tool calls are timed and recorded. Arguments are never stored, because they
// routinely contain client names and phone numbers.
const ToolAudit = {
  entries: [],
  record(tool, ms, ok, note){
    this.entries.unshift({ tool, at: new Date().toISOString(), ms, ok, note: (note || '').slice(0, 80) });
    if(this.entries.length > 100) this.entries.length = 100;
    console.info(`[tool] ${tool} ${ok ? 'ok' : 'FAILED'} ${ms}ms`);
  },
  recent(n = 20){ return this.entries.slice(0, n); },
};

// Search sits behind a provider so the backend can change without touching
// the tool, and so a failure is reported as a failure.
const WebSearch = {
  async run(query, lang){
    try{
      const r = await fetch(FN_URL + "/agenda-search", {
        method:'POST', headers: authHeaders(),
        body: JSON.stringify({ query, lang: lang || VOICE.lang }),
      });
      if(!r.ok) return { ok:false, error:'search service returned an error', results:[] };
      const d = await r.json();
      return { ok:true, results: d.results || [], via: d.via, tried: d.tried };
    }catch(e){ return { ok:false, error:'search service unreachable', results:[] }; }
  },
};

const TOOLS = [
  {
    name: 'web_search',
    permission: PERM.READ,
    description: "Search the public web for current information, news, product specs or error codes not present in the user's own data. Never for the user's cases, notes or schedule.",
    schema: { type:'object', properties:{ query:{ type:'string', description:'A short search query.' } }, required:['query'] },
    async execute(args){
      const res = await WebSearch.run(args.query);
      if(!res.ok) return `SEARCH FAILED (${res.error}). Say plainly that you could not reach the web — do not answer from memory as though you had searched.`;
      if(!res.results.length)
        return `No results for "${args.query}"${res.tried ? ' (tried ' + res.tried.join(', ') + ')' : ''}. `
             + 'Say you found nothing — do not substitute your own knowledge as though it were a search result.';
      return res.results.map(x => `- ${x.title}: ${x.snippet}`).join('\n').slice(0, 1800);
    },
  },
  {
    name: 'remember',
    permission: PERM.LOW,
    description: "Store a fact the user explicitly asked you to remember ('remember that...', 'lembre que...'). Never on your own initiative, and never passwords, keys, tokens or card numbers.",
    schema: { type:'object', properties:{ content:{ type:'string', description:'The fact, as a short standalone sentence.' } }, required:['content'] },
    async execute(args){
    const res = await Memory.save(args.content);
    if(res.ok) return 'Stored: "' + res.memory.content + '"';
    if(res.reason === 'secret')
      return "REFUSED - that looks like a credential. Tell the user plainly you will not store passwords, keys or card numbers, and that a password manager is the right place. Do not repeat the value back.";
    if(res.reason === 'empty') return 'Nothing to store.';
    return 'The memory store is unavailable - say you could not save it.';
    },
  },
  {
    name: 'forget',
    permission: PERM.HIGH,
    description: "Delete a stored memory the user asks you to forget. If several match you will be told, and must ask which one. Never delete several at once.",
    schema: { type:'object', properties:{ query:{ type:'string', description:'What the user wants forgotten.' }, id:{ type:'string', description:'Exact memory id once the user has chosen.' } }, required:['query'] },
    async execute(args){
    if(args.id){
      const ok = await Memory.remove(args.id);
      return ok ? 'Memory deleted.' : 'That memory no longer exists.';
    }
    const hits = await Memory.search(args.query, 6);
    if(!hits.length) return 'No memory matches that - say you have nothing stored about it.';
    if(hits.length > 1){
      return 'AMBIGUOUS - several memories match. Ask which one, listing them briefly:\\n'
        + hits.map((m, i) => (i + 1) + '. [id ' + m.id + '] ' + m.content).join('\\n');
    }
    const ok = await Memory.remove(hits[0].id);
    return ok ? 'Forgotten: "' + hits[0].content + '"' : 'Could not delete that one.';
    },
  },
  {
    name: 'find_in_galaxy',
    permission: PERM.READ,
    description: "Find notes, cases, knowledge entries or memories by description and highlight them in the knowledge galaxy. Use when the user asks to locate or find something, e.g. 'find the note that mentions overvoltage'.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'What to look for — words likely to appear in the title or body.' } },
      required:['query'] },
    async execute(args){
      if(!Galaxy.ready) await Galaxy.build({ folder:false });
      const hits = Galaxy.search(args.query);
      if(!hits.length) return `Nothing in the galaxy matches "${args.query}".`;
      switchView('settings');
      document.querySelector('.sub-tab[data-sub=\"knowledge\"]')?.click();
      const top = hits[0];
      return `Found ${hits.length} match${hits.length > 1 ? 'es' : ''}, focused on "${top.title}" in ${top.folder} `
        + `(${top.deg || 'no'} links). Others: ${hits.slice(1, 4).map(n => n.title).join('; ') || 'none'}. `
        + `Tell the user the top match and roughly how many others, nothing more.`;
    },
  },
  {
    name: 'save_template',
    permission: PERM.LOW,
    description: "Save a reusable message template. Use {{placeholders}} for the parts that change, e.g. {{client}} or {{date}}.",
    schema: { type:'object', properties:{
      name:{ type:'string', description:'Short name to call it by later.' },
      to:{ type:'string', description:'Recipient, may contain placeholders.' },
      subject:{ type:'string' }, body:{ type:'string' },
      tags:{ type:'array', items:{ type:'string' } } },
      required:['name','body'] },
    async execute(args){
      const saved = await Templates.save({
        name: args.name, to: args.to || '', subject: args.subject || '',
        body: args.body, tags: args.tags || [], kind: 'email',
      });
      if(!saved) return 'Could not save the template.';
      const ph = Templates.placeholders(saved);
      return `Template "${saved.name}" saved` + (ph.length ? ` with placeholders: ${ph.join(', ')}.` : '.');
    },
  },
  {
    name: 'use_template',
    permission: PERM.READ,
    description: "Open a saved template ready to send, filling in the values given. This only PREPARES the message — the user sends it themselves. Say what was prepared and what still needs filling.",
    schema: { type:'object', properties:{
      name:{ type:'string', description:'Which template.' },
      values:{ type:'object', description:'Placeholder values keyed by placeholder name.',
        properties:{}, additionalProperties:{ type:'string' } } },
      required:['name'] },
    async execute(args){
      const tpl = await Templates.find(args.name);
      if(!tpl){
        const all = await Templates.all();
        return all.length ? `No template called "${args.name}". Available: ${all.map(t => t.name).join(', ')}.`
                          : 'No templates saved yet.';
      }
      openCompose(tpl, args.values || {});
      const { missing } = Templates.fill(`${tpl.subject} ${tpl.body} ${tpl.to}`, args.values || {});
      return `Prepared "${tpl.name}" on screen. ` + (missing.length
        ? `Still needs: ${[...new Set(missing)].join(', ')}. The user reviews and sends it.`
        : 'Everything is filled in. The user reviews and sends it.');
    },
  },
  {
    name: 'list_templates',
    permission: PERM.READ,
    description: "List the saved templates and their placeholders.",
    schema: { type:'object', properties:{} },
    async execute(){
      const all = await Templates.all(true);
      if(!all.length) return 'No templates saved.';
      return all.map(t => `- ${t.name}: ${Templates.placeholders(t).join(', ') || 'no placeholders'}`).join('\n');
    },
  },
  {
    name: 'create_case',
    permission: PERM.LOW,
    description: "Create a new support case in the user's agenda. Only when they clearly ask to create, add or schedule a case.",
    schema: { type:'object', properties:{
      titulo:{ type:'string', description:'Client name and/or short subject.' },
      case_date:{ type:'string', description:'YYYY-MM-DD. Defaults to today.' },
      horario:{ type:'string', description:'Start time HH:MM, 24h.' },
      horario_fim:{ type:'string', description:'End time HH:MM, 24h.' },
      prioridade:{ type:'string', enum:['urgente','alta','media','baixa'] },
      bloco:{ type:'string', enum:['primeira-hora','manha','tarde','fim-do-dia'] },
      ticket:{ type:'string' }, tags:{ type:'array', items:{ type:'string' } },
      note:{ type:'string', description:'An initial note.' } }, required:['titulo'] },
    async execute(args){
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
    },
  },
  {
    name: 'create_notebook',
    permission: PERM.LOW,
    description: "Create a new notebook (a folder holding notes). Only when the user asks for one.",
    schema: { type:'object', properties:{ title:{ type:'string' } }, required:['title'] },
    async execute(args){
    const existing = notebooks.find(nb => (nb.title || '').toLowerCase() === (args.title || '').toLowerCase());
    if(existing) return `A notebook named "${existing.title}" already exists.`;
    const nb = await createNotebookApi({ title: args.title });
    notebooks.unshift(nb);
    renderNotebooksGrid();
    return `Notebook created: "${nb.title}".`;
    },
  },
  {
    name: 'create_note',
    permission: PERM.LOW,
    description: "Create a note inside a notebook. If the notebook does not exist it is created first.",
    schema: { type:'object', properties:{
      notebook_title:{ type:'string' }, title:{ type:'string' }, content:{ type:'string' },
      linked_date:{ type:'string' }, tags:{ type:'array', items:{ type:'string' } } },
      required:['notebook_title','title'] },
    async execute(args){
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
    },
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));
// The schema handed to Groq is derived from the registry, so the two can
// never drift apart.
const AI_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.schema },
}));

// ===== Knowledge base ================================================
// Loaded from /kb.json at the site root, with an optional override pasted in
// Settings. Entries are keyword-scored and only the best matches are handed
// to the assistant, which must then state how confident it is.
let KB = [];
async function loadKB(){
  const local = localStorage.getItem('agenda-solar-kb');
  if(local){ try{ KB = JSON.parse(local); }catch(e){ KB = []; } }
  if(KB.length){ renderKbStatus(); return; }
  try{
    const r = await fetch('/kb.json', { cache: 'no-cache' });
    if(r.ok) KB = await r.json();
  }catch(e){ KB = []; }
  renderKbStatus();
}
function renderKbStatus(){
  const el = document.getElementById('set-kb-status');
  if(el){
    el.textContent = KB.length ? KB.length + ' entries loaded' : 'No entries yet';
    el.className = KB.length ? 'ok' : '';
  }
}
function kbSearch(q, limit = 4){
  if(!KB.length || !q) return [];
  const words = String(q).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  return KB.map(e => {
    const hay = [e.title, e.content, (e.tags || []).join(' '), (e.keywords || []).join(' '), e.source || ''].join(' ').toLowerCase();
    let score = 0;
    words.forEach(w => { if(hay.includes(w)) score += hay.split(w).length - 1; });
    return { e, score };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, limit).map(x => x.e);
}




// --- manual knowledge entry -------------------------------------------
document.getElementById('kb-add-btn')?.addEventListener('click', () => {
  const title = document.getElementById('kb-new-title').value.trim();
  const content = document.getElementById('kb-new-body').value.trim();
  if(!title || !content){ alert('Give it a title and something to remember.'); return; }
  const tags = document.getElementById('kb-new-tags').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  KB = [{ title, content, tags }, ...KB];
  localStorage.setItem('agenda-solar-kb', JSON.stringify(KB));
  document.getElementById('kb-new-title').value = '';
  document.getElementById('kb-new-body').value = '';
  document.getElementById('kb-new-tags').value = '';
  const box = document.getElementById('kb-json');
  if(box) box.value = JSON.stringify(KB, null, 2);
  renderKbStatus();
  fileKnowledgeEntry({ title, content, tags, source: 'Knowledge' })
    .then(() => { renderNotebooksGrid(); Galaxy.build({ folder:false }); });
  SFX.open();
});

// --- template management ----------------------------------------------
async function renderTemplates(){
  const list = document.getElementById('tpl-list');
  const count = document.getElementById('tpl-count');
  if(!list) return;
  const all = await Templates.all(true);
  if(count) count.textContent = all.length ? `${all.length} saved` : 'none saved';
  list.innerHTML = all.length ? '' : '<p class="hint" style="margin:0">Nothing saved yet.</p>';
  all.forEach(t => {
    const row = document.createElement('div');
    row.className = 'tpl-row';
    row.innerHTML = `<span class="tpl-name">${escapeHtml(t.name)}</span>
      <span class="tpl-ph">${Templates.placeholders(t).map(p => '{{' + escapeHtml(p) + '}}').join(' ') || '—'}</span>
      <button class="tpl-use">Use</button><button class="tpl-del">✕</button>`;
    row.querySelector('.tpl-use').addEventListener('click', () => openCompose(t, {}));
    row.querySelector('.tpl-del').addEventListener('click', async () => {
      if(!confirm(`Delete template "${t.name}"?`)) return;
      await Templates.remove(t.id); renderTemplates(); Galaxy.build({ folder:false });
    });
    list.appendChild(row);
  });
}
document.getElementById('tpl-save')?.addEventListener('click', async () => {
  const name = document.getElementById('tpl-name').value.trim();
  const body = document.getElementById('tpl-body').value.trim();
  if(!name || !body){ alert('A template needs a name and a body.'); return; }
  const saved = await Templates.save({
    name, to: document.getElementById('tpl-to').value.trim(),
    subject: document.getElementById('tpl-subject').value.trim(), body, kind:'email', tags:[],
  });
  if(!saved){ alert('Could not save that.'); return; }
  ['tpl-name','tpl-to','tpl-subject','tpl-body'].forEach(id => document.getElementById(id).value = '');
  renderTemplates(); Galaxy.build({ folder:false }); SFX.open();
});

// ===== Templates =====================================================
// Stored in the existing memories table with kind='template', so they inherit
// the same encryption and per-user scoping. Content is a JSON payload.
const Templates = {
  cache: null,
  async all(force){
    if(this.cache && !force) return this.cache;
    const mems = await Memory.all(force);
    this.cache = mems.filter(m => m.kind === 'template').map(m => {
      try{ return { id: m.id, ...JSON.parse(m.content) }; }catch(e){ return null; }
    }).filter(Boolean);
    return this.cache;
  },
  async save(tpl){
    const payload = JSON.stringify(tpl);
    const keywords = [tpl.name, tpl.subject, (tpl.tags || []).join(' ')].join(' ').toLowerCase().slice(0, 300);
    const r = await fetch(FN_URL + "/agenda-memory", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ content: await encStr(payload), keywords, kind: 'template' }),
    });
    if(!r.ok) return null;
    const d = await r.json();
    this.cache = null; Memory.cache = null;
    return { id: d.memory.id, ...tpl };
  },
  async remove(id){ const ok = await Memory.remove(id); this.cache = null; return ok; },
  async find(name){
    const all = await this.all();
    const q = String(name || '').toLowerCase();
    return all.find(t => (t.name || '').toLowerCase() === q)
        || all.find(t => (t.name || '').toLowerCase().includes(q))
        || null;
  },
  // {{placeholders}} are filled from what the model supplies; anything left
  // over is flagged so the user sees exactly what still needs a value.
  fill(text, vars){
    const missing = [];
    const out = String(text || '').replace(/\{\{\s*([\w .-]+)\s*\}\}/g, (m, k) => {
      const key = k.trim().toLowerCase();
      const hit = Object.keys(vars || {}).find(v => v.toLowerCase() === key);
      if(hit && vars[hit]) return vars[hit];
      missing.push(k.trim());
      return '⟨' + k.trim() + '⟩';
    });
    return { text: out, missing };
  },
  placeholders(tpl){
    const all = `${tpl.subject || ''} ${tpl.body || ''} ${tpl.to || ''}`;
    return [...new Set([...all.matchAll(/\{\{\s*([\w .-]+)\s*\}\}/g)].map(m => m[1].trim()))];
  },
};

// The compose sheet. TARS prepares it; the send is always a deliberate click.
let composeState = null;
function openCompose(tpl, vars){
  const s = Templates.fill(tpl.subject || '', vars);
  const b = Templates.fill(tpl.body || '', vars);
  const t = Templates.fill(tpl.to || '', vars);
  composeState = { tpl, missing: [...new Set([...s.missing, ...b.missing, ...t.missing])] };
  document.getElementById('compose-title').textContent = tpl.name || 'Message';
  document.getElementById('compose-to').value = t.text;
  document.getElementById('compose-subject').value = s.text;
  document.getElementById('compose-body').value = b.text;
  const warn = document.getElementById('compose-missing');
  warn.textContent = composeState.missing.length
    ? 'Still to fill: ' + composeState.missing.join(', ')
    : 'Everything is filled in. Check it, then send.';
  warn.className = 'hint' + (composeState.missing.length ? ' compose-warn' : '');
  document.getElementById('compose-backdrop').classList.add('open');
  SFX.open();
}
function closeCompose(){ document.getElementById('compose-backdrop')?.classList.remove('open'); composeState = null; }
document.getElementById('compose-close')?.addEventListener('click', closeCompose);
document.getElementById('compose-backdrop')?.addEventListener('click', e => {
  if(e.target.id === 'compose-backdrop') closeCompose();
});
document.getElementById('compose-copy')?.addEventListener('click', () => {
  const txt = `${document.getElementById('compose-subject').value}\n\n${document.getElementById('compose-body').value}`;
  navigator.clipboard?.writeText(txt);
  document.getElementById('compose-copy').textContent = 'Copied';
  setTimeout(() => { document.getElementById('compose-copy').textContent = 'Copy'; }, 1200);
});
document.getElementById('compose-send')?.addEventListener('click', () => {
  const to = encodeURIComponent(document.getElementById('compose-to').value);
  const su = encodeURIComponent(document.getElementById('compose-subject').value);
  const bo = encodeURIComponent(document.getElementById('compose-body').value);
  // Opens the user's own mail client with everything prepared. See the note in
  // Settings about why the final send stays in their hands.
  window.location.href = `mailto:${to}?subject=${su}&body=${bo}`;
  closeCompose();
});


// ===== Knowledge -> notebooks sync ===================================
// Every knowledge entry also exists as a real note, filed in a notebook named
// after its source. Those notebooks are marked with a leading marker so they
// stay out of the way in the Notebooks tab, but they are ordinary notes: they
// open, they search, and they appear in the galaxy with proper structure.
const SYS_PREFIX = '⌁ ';
function isSystemNotebook(nb){ return String(nb.title || '').startsWith(SYS_PREFIX); }

async function ensureNotebook(title){
  const want = SYS_PREFIX + title;
  let nb = notebooks.find(x => x.title === want);
  if(nb) return nb;
  nb = await createNotebookApi({ title: want, color: '#4f9fd8' });
  notebooks.unshift(nb);
  return nb;
}

// Files one entry as a note, updating in place if it is already there.
async function fileKnowledgeEntry(entry){
  const source = (entry.source || 'Knowledge').split(/[—:]/)[0].trim();
  const nb = await ensureNotebook(source);
  const body = `<p>${escapeHtml(entry.content)}</p>`
    + (entry.url ? `<p><a href="${entry.url}" target="_blank" rel="noopener">Open the source page</a></p>` : '');
  const existing = notes.find(n => n.notebook_id === nb.id && n.title === entry.title);
  try{
    if(existing){
      const up = await updateNoteApi(existing.id, { title: entry.title, content: body, tags: entry.tags || [] });
      notes[notes.findIndex(n => n.id === existing.id)] = up;
      return up;
    }
    const made = await createNoteApi({ notebook_id: nb.id, title: entry.title, content: body, tags: entry.tags || [] });
    notes.unshift(made);
    return made;
  }catch(e){ return null; }
}

async function syncKnowledgeToNotebooks(){
  const btn = document.getElementById('kb-sync');
  if(btn){ btn.disabled = true; btn.textContent = 'Filing…'; }
  let done = 0;
  for(const e of KB){
    if(await fileKnowledgeEntry(e)) done++;
    if(btn) btn.textContent = `Filing… ${done}/${KB.length}`;
  }
  renderNotebooksGrid();
  Galaxy.build({ folder:false });
  if(btn){ btn.disabled = false; btn.textContent = 'File knowledge into notebooks'; }
  alert(`Filed ${done} entries into ${new Set(KB.map(e => (e.source || 'Knowledge').split(/[—:]/)[0].trim())).size} notebooks.`);
}
document.getElementById('kb-sync')?.addEventListener('click', syncKnowledgeToNotebooks);

// ===== Knowledge galaxy (3D) =========================================
// Positions come from a force simulation, so distance actually means
// something: linked notes pull together, everything repels, and clusters
// emerge rather than being decoration on a spiral.
const Galaxy = {
  nodes: [], edges: [], adj: {}, byId: {},
  rot: { x: -0.25, y: 0.6 }, zoom: 1, drag: null, raf: null,
  hover: null, focus: null, ready: false, dirty: true,
  matches: null,            // set by voice search
  timeCut: 1,               // 0..1 position of the timeline scrubber
  camTarget: null,

  parseMarkdown(name, text){
    const titleM = text.match(/^\s*#\s+(.+)$/m);
    const title = (titleM ? titleM[1] : name.replace(/\.md$/i, '')).trim().slice(0, 60);
    const tags = [...new Set((text.match(/(?:^|\s)#([\p{L}\d_-]{2,})/gu) || [])
      .map(t => t.trim().replace(/^#/, '').toLowerCase()))].slice(0, 12);
    const links = [...new Set([
      ...(text.match(/\[\[([^\]]+)\]\]/g) || []).map(l => l.slice(2, -2).split('|')[0].trim().toLowerCase()),
      ...(text.match(/\]\(([^)]+\.md)\)/g) || []).map(l => l.slice(2, -1).replace(/\.md$/i, '').toLowerCase()),
    ])].slice(0, 20);
    const words = text.replace(/[#*`>\[\]()]/g, ' ').split(/\s+/).filter(Boolean).length;
    return { title, tags, links, words, excerpt: text.replace(/^#.*$/m, '').trim().slice(0, 220) };
  },
  async fromLocalFolder(){
    if(!mediaDir || !(await ensureDirPermission())) return [];
    const out = [];
    const walk = async (dir, path, depth) => {
      if(depth > 3) return;
      for await (const [name, handle] of dir.entries()){
        if(handle.kind === 'directory'){ await walk(handle, path + name + '/', depth + 1); continue; }
        if(!/\.(md|markdown|txt)$/i.test(name)) continue;
        try{
          const file = await handle.getFile();
          if(file.size > 400000) continue;
          const text = await file.text();
          const p = this.parseMarkdown(name, text);
          out.push({ ...p, id: (path + name).toLowerCase(), key: name.replace(/\.md$/i,'').toLowerCase(),
                     folder: path || '/', source: 'folder' });
        }catch(e){}
      }
    };
    try{ await walk(mediaDir, '', 0); }catch(e){}
    return out;
  },
  async fromDrive(){
    if(!driveToken) return [];
    try{
      const q = encodeURIComponent("mimeType='text/markdown' or name contains '.md'");
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=100`,
        { headers: { Authorization: 'Bearer ' + driveToken } });
      if(!r.ok) return [];
      const list = (await r.json()).files || [];
      const out = [];
      for(const f of list.slice(0, 60)){
        const rr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
          { headers: { Authorization: 'Bearer ' + driveToken } });
        if(!rr.ok) continue;
        const text = await rr.text();
        const p = this.parseMarkdown(f.name, text);
        out.push({ ...p, id: 'drive:' + f.id, key: f.name.replace(/\.md$/i,'').toLowerCase(),
                   folder: 'Drive/', source: 'drive' });
      }
      return out;
    }catch(e){ return []; }
  },
  fromEverything(){
    const out = [];
    KB.forEach((e, i) => out.push({
      id: 'kb:' + i, key: String(e.title || '').toLowerCase(), title: e.title || 'Untitled',
      tags: (e.tags || []).map(t => String(t).toLowerCase()), links: [],
      words: String(e.content || '').split(/\s+/).length, excerpt: String(e.content || '').slice(0, 220),
      folder: (e.source ? e.source.split(/[—:]/)[0].trim() : 'Knowledge') + '/', source: 'kb' }));
    (Memory.cache || []).filter(m => m.kind !== 'template').forEach(m => out.push({
      id: 'mem:' + m.id, key: String(m.content).slice(0, 30).toLowerCase(),
      title: String(m.content).slice(0, 40), tags: (m.keywords || '').split(/\s+/).filter(Boolean).slice(0, 6),
      links: [], words: String(m.content).split(/\s+/).length, excerpt: String(m.content).slice(0, 220),
      folder: 'Memory/', source: 'mem', when: Date.parse(m.created_at || 0) || 0 }));
    (Templates.cache || []).forEach(t => out.push({
      id: 'tpl:' + t.id, key: String(t.name || '').toLowerCase(), title: t.name || 'Template',
      tags: ['template', ...(t.tags || [])], links: [],
      words: String(t.body || '').split(/\s+/).length, excerpt: String(t.body || '').slice(0, 220),
      folder: 'Templates/', source: 'tpl', tpl: t }));
    cases.slice(-40).forEach(cs => out.push({
      id: 'case:' + cs.id, key: String(cs.titulo || '').toLowerCase(), title: cs.titulo || 'Case',
      tags: (cs.tags || []).map(t => String(t).toLowerCase()), links: [],
      words: (cs.notes_log || []).reduce((n, x) => n + String(x.text).split(/\s+/).length, 0),
      excerpt: (cs.notes_log || []).map(x => x.text).join(' ').slice(0, 220),
      folder: 'Cases/', source: 'case', caseId: cs.id,
      when: Date.parse(cs.case_date || cs.created_at || 0) || 0 }));
    return out;
  },
  fromAppNotes(){
    return notes.map(n => {
      const plain = plainTextPreview(n.content).text;
      const nb = (notebooks.find(x => x.id === n.notebook_id) || {}).title || 'Notes';
      return {
        id: 'note:' + n.id, key: String(n.title || '').toLowerCase(),
        title: n.title || 'Untitled', tags: (n.tags || []).map(t => String(t).toLowerCase()),
        links: [], words: plain.split(/\s+/).length, excerpt: plain.slice(0, 220),
        folder: nb + '/', source: 'app', noteId: n.id,
        when: Date.parse(n.updated_at || n.created_at || 0) || 0,
      };
    });
  },

  // --- force layout --------------------------------------------------
  // Repulsion is sampled rather than all-pairs: each node is pushed by a
  // random subset every tick, which converges to the same shape at a fraction
  // of the cost and keeps 500+ nodes interactive.
  layout(iterations){
    const N = this.nodes.length;
    if(!N) return;
    const SAMPLE = Math.min(28, N - 1);
    this.nodes.forEach((n, i) => {
      const a = (i / N) * Math.PI * 2, r = 0.55 + ((i * 37) % 100) / 250;
      n.x = Math.cos(a) * r; n.y = (((i * 53) % 100) / 100 - 0.5) * 0.9; n.z = Math.sin(a) * r;
      n.vx = n.vy = n.vz = 0;
    });
    const iters = iterations || (N > 300 ? 90 : 160);
    for(let it = 0; it < iters; it++){
      const cool = 1 - it / iters;
      for(let i = 0; i < N; i++){
        const a = this.nodes[i];
        for(let s = 0; s < SAMPLE; s++){
          const b = this.nodes[(i + 1 + Math.floor(Math.random() * (N - 1))) % N];
          let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          let d2 = dx*dx + dy*dy + dz*dz + 0.001;
          const f = 0.0016 / d2;
          a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
        }
      }
      this.edges.forEach(([ia, ib, , w]) => {
        const a = this.byId[ia], b = this.byId[ib];
        if(!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const k = 0.012 * Math.min(3, w || 1);
        a.vx += dx * k; a.vy += dy * k; a.vz += dz * k;
        b.vx -= dx * k; b.vy -= dy * k; b.vz -= dz * k;
      });
      this.nodes.forEach(n => {
        n.vx -= n.x * 0.004; n.vy -= n.y * 0.004; n.vz -= n.z * 0.004;  // gentle centring
        n.x += n.vx * cool; n.y += n.vy * cool; n.z += n.vz * cool;
        n.vx *= 0.82; n.vy *= 0.82; n.vz *= 0.82;
      });
    }
    // normalise into view
    let max = 0;
    this.nodes.forEach(n => { max = Math.max(max, Math.hypot(n.x, n.y, n.z)); });
    const k = max ? 1.15 / max : 1;
    this.nodes.forEach(n => { n.x *= k; n.y *= k * 0.8; n.z *= k; });
    this.dirty = true;
  },

  async build(opts){
    const parts = [this.fromAppNotes(), this.fromEverything()];
    if(opts?.folder !== false) parts.push(await this.fromLocalFolder());
    if(opts?.drive) parts.push(await this.fromDrive());
    const items = parts.flat();

    const byKey = {};
    items.forEach(i => { byKey[i.key] = i; });

    // weight = how much two notes actually have in common
    const pair = {};
    const bump = (a, b, kind) => {
      if(a === b) return;
      const id = a < b ? a + '|' + b : b + '|' + a;
      pair[id] = pair[id] || { kind, w: 0 };
      pair[id].w += kind === 'link' ? 3 : 1;
      if(kind === 'link') pair[id].kind = 'link';
    };
    items.forEach(a => {
      a.links.forEach(l => { if(byKey[l]) bump(a.id, byKey[l].id, 'link'); });
      items.forEach(b => {
        if(b === a) return;
        const ref = (b.title || '').match(/^(\d+(?:\.\d+)?)/);
        if(ref && new RegExp('\\b' + ref[1].replace('.', '\\.') + '\\b').test(a.excerpt || ''))
          bump(a.id, b.id, 'link');
      });
    });
    const byTag = {};
    items.forEach(i => i.tags.forEach(t => { if(t) (byTag[t] = byTag[t] || []).push(i); }));
    Object.values(byTag).forEach(group => {
      if(group.length > 12) return;
      for(let i = 0; i < group.length; i++)
        for(let j = i + 1; j < group.length; j++) bump(group[i].id, group[j].id, 'tag');
    });

    const folders = [...new Set(items.map(i => i.folder))];
    this.nodes = items.map(it => ({ ...it, deg: 0, hue: folders.indexOf(it.folder),
                                    when: it.when || 0 }));
    this.byId = Object.fromEntries(this.nodes.map(n => [n.id, n]));
    this.edges = Object.entries(pair)
      .map(([id, v]) => { const [a, b] = id.split('|'); return [a, b, v.kind, v.w]; })
      .filter(([a, b]) => this.byId[a] && this.byId[b]);

    this.adj = {};
    this.edges.forEach(([a, b]) => {
      (this.adj[a] = this.adj[a] || new Set()).add(b);
      (this.adj[b] = this.adj[b] || new Set()).add(a);
      this.byId[a].deg++; this.byId[b].deg++;
    });

    this.folders = folders;
    this.orphans = this.nodes.filter(n => n.deg === 0);
    this.ready = true;
    this.layout();
    this.updateHud();
    const empty = document.getElementById('kb-map-empty');
    if(empty) empty.style.display = this.nodes.length ? 'none' : 'flex';
    this.start();
  },

  updateHud(){
    const hud = document.getElementById('galaxy-hud');
    if(hud) hud.textContent = `${this.nodes.length} nodes · ${this.edges.length} links · `
      + `${(this.folders || []).length} clusters · ${(this.orphans || []).length} unlinked`;
  },

  markUsed(){
    const used = new Set([...(lastKbHits || []).map(e => e.title),
                          ...(lastMemHits || []).map(m => String(m.content).slice(0, 40))]);
    this.nodes.forEach(n => { n.used = used.has(n.title); });
    this.dirty = true;
  },

  // one hop from the focused node
  inFocus(n){
    if(!this.focus) return true;
    if(n === this.focus) return true;
    return (this.adj[this.focus.id] || new Set()).has(n.id);
  },
  visible(n){
    if(this.timeCut < 1 && n.when && n.when > this.timeMax) return false;
    return true;
  },

  setFocus(n){
    this.focus = (this.focus === n) ? null : n;
    if(this.focus){
      // turn the camera so the focused star faces front
      this.camTarget = { y: -Math.atan2(this.focus.z, this.focus.x) + Math.PI / 2,
                         x: Math.max(-1.2, Math.min(1.2, -Math.asin(this.focus.y))) };
      this.zoom = Math.max(this.zoom, 1.8);
    }
    this.dirty = true;
  },

  project(n, w, h){
    const cy = Math.cos(this.rot.y), sy = Math.sin(this.rot.y);
    const cx = Math.cos(this.rot.x), sx = Math.sin(this.rot.x);
    let x = n.x * cy - n.z * sy, z = n.x * sy + n.z * cy;
    let y = n.y * cx - z * sx;  z = n.y * sx + z * cx;
    const d = 3.2, s = (d / (d - z)) * this.zoom;
    return { sx: w / 2 + x * s * Math.min(w, h) * 0.36, sy: h / 2 + y * s * Math.min(w, h) * 0.36, s, z };
  },

  draw(){
    const cv = document.getElementById('kb-map');
    if(!cv || !cv.clientWidth){ this.raf = null; return; }
    const ctx = cv.getContext('2d');
    const w = cv.width = cv.clientWidth, h = cv.height = cv.clientHeight;

    if(this.camTarget){
      this.rot.y += (this.camTarget.y - this.rot.y) * 0.08;
      this.rot.x += (this.camTarget.x - this.rot.x) * 0.08;
      if(Math.abs(this.camTarget.y - this.rot.y) < 0.005) this.camTarget = null;
    } else if(!this.drag && !this.focus){
      this.rot.y += 0.0014;
    }

    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const pal = ['--accent2','--accent3','--dusk','--amber'].map(v => css.getPropertyValue(v).trim() || '#4f9fd8');
    const amber = css.getPropertyValue('--amber').trim() || '#f2a71b';
    const line = css.getPropertyValue('--line').trim() || '#2b3d4f';
    const urg = css.getPropertyValue('--urgente').trim() || '#e15b4c';
    const txt = css.getPropertyValue('--text').trim() || '#eaf1f8';

    // time window
    const times = this.nodes.map(n => n.when).filter(Boolean);
    this.timeMax = times.length ? (Math.min(...times) + (Math.max(...times) - Math.min(...times)) * this.timeCut) : Infinity;

    const P = {};
    this.nodes.forEach(n => { if(this.visible(n)) P[n.id] = this.project(n, w, h); });

    // edges: thickness by weight, curved so parallels separate
    const heavy = this.edges.length > 1400;
    ctx.lineCap = 'round';
    this.edges.forEach(([a, b, kind, wt]) => {
      const pa = P[a], pb = P[b];
      if(!pa || !pb) return;
      if(heavy && kind !== 'link' && wt < 2) return;         // thin out huge graphs
      const A = this.byId[a], B = this.byId[b];
      const foc = this.inFocus(A) && this.inFocus(B);
      if(this.focus && !foc) return;
      const lit = A.used && B.used;
      ctx.strokeStyle = lit ? amber + 'aa' : line;
      const depth = Math.max(0.12, Math.min(1, (pa.s + pb.s) / 2 - 0.15));
      ctx.globalAlpha = (lit ? 0.95 : (kind === 'link' ? 0.5 : 0.16)) * depth;
      ctx.lineWidth = Math.min(3, (kind === 'link' ? 1.1 : 0.5) + (wt - 1) * 0.35);
      const mx = (pa.sx + pb.sx) / 2, my = (pa.sy + pb.sy) / 2;
      const dx = pb.sx - pa.sx, dy = pb.sy - pa.sy;
      ctx.beginPath(); ctx.moveTo(pa.sx, pa.sy);
      ctx.quadraticCurveTo(mx - dy * 0.08, my + dx * 0.08, pb.sx, pb.sy);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    const order = this.nodes.filter(n => P[n.id]).sort((a, b) => P[a.id].z - P[b.id].z);
    const labels = [];
    order.forEach(n => {
      const p = P[n.id];
      const foc = this.inFocus(n);
      if(this.focus && !foc) return;
      const isMatch = this.matches && this.matches.has(n.id);
      const orphan = n.deg === 0;
      const r = (2.0 + Math.min(7, n.deg) * 0.45) * p.s;
      const col = isMatch ? amber : n.used ? amber : orphan ? urg : pal[n.hue % pal.length];
      // depth fade doubles as the fog cue
      ctx.globalAlpha = Math.max(0.18, Math.min(1, (p.s - 0.35) * 1.25));
      if(n.used || isMatch || n === this.hover || n === this.focus){
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 3.4, 0, Math.PI * 2);
        ctx.fillStyle = col + '2b'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if(orphan){                                    // hollow ring = nothing links here
        ctx.strokeStyle = urg; ctx.lineWidth = 1; ctx.globalAlpha *= 0.8;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 1.9, 0, Math.PI * 2); ctx.stroke();
      }
      if(p.s > 0.75 && (this.zoom > 1.4 || isMatch || n.used || n === this.hover || n === this.focus))
        labels.push({ n, p, r, col });
      n._p = p;
    });

    // labels last, nearest first, skipping any that would overlap
    ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center';
    const taken = [];
    labels.sort((a, b) => b.p.s - a.p.s).forEach(({ n, p, r, col }) => {
      const text = n.title.slice(0, 26);
      const wpx = ctx.measureText(text).width;
      const box = { x: p.sx - wpx / 2, y: p.sy - r - 16, w: wpx, h: 13 };
      if(taken.some(t => !(box.x + box.w < t.x || t.x + t.w < box.x || box.y + box.h < t.y || t.y + t.h < box.y))) return;
      taken.push(box);
      ctx.globalAlpha = Math.min(1, p.s * 0.95);
      ctx.fillStyle = (n === this.focus || (this.matches && this.matches.has(n.id))) ? col : txt;
      ctx.fillText(text, p.sx, p.sy - r - 6);
    });
    ctx.globalAlpha = 1;
    this.raf = requestAnimationFrame(() => this.draw());
  },

  start(){ if(!this.raf) this.raf = requestAnimationFrame(() => this.draw()); },
  stop(){ if(this.raf) cancelAnimationFrame(this.raf); this.raf = null; },

  // --- voice search ---------------------------------------------------
  search(q){
    const words = String(q || '').toLowerCase().split(/\W+/).filter(x => x.length > 2);
    if(!words.length) return [];
    const scored = this.nodes.map(n => {
      const hay = (n.title + ' ' + (n.excerpt || '') + ' ' + n.tags.join(' ') + ' ' + n.folder).toLowerCase();
      let sc = 0;
      words.forEach(x => { if(hay.includes(x)) sc += n.title.toLowerCase().includes(x) ? 3 : 1; });
      return { n, sc };
    }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    this.matches = new Set(scored.slice(0, 12).map(x => x.n.id));
    if(scored.length) this.setFocus(scored[0].n);
    this.dirty = true;
    return scored.slice(0, 8).map(x => x.n);
  },
  clearSearch(){ this.matches = null; this.focus = null; this.dirty = true; },
};

(function wireGalaxy(){
  const cv = document.getElementById('kb-map');
  if(!cv) return;
  cv.addEventListener('pointerdown', e => {
    Galaxy.drag = { x: e.clientX, y: e.clientY, rx: Galaxy.rot.x, ry: Galaxy.rot.y, moved: 0 };
    Galaxy.camTarget = null;
    cv.setPointerCapture?.(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    if(Galaxy.drag){
      const dx = e.clientX - Galaxy.drag.x, dy = e.clientY - Galaxy.drag.y;
      Galaxy.drag.moved = Math.abs(dx) + Math.abs(dy);
      Galaxy.rot.y = Galaxy.drag.ry + dx * 0.006;
      Galaxy.rot.x = Math.max(-1.3, Math.min(1.3, Galaxy.drag.rx + dy * 0.006));
      return;
    }
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const hit = Galaxy.nodes.find(n => n._p && Math.hypot(n._p.sx - mx, n._p.sy - my) < 11);
    Galaxy.hover = hit || null;
    const tip = document.getElementById('kb-map-tip');
    if(tip){
      if(hit){
        tip.innerHTML = `<b>${escapeHtml(hit.title)}</b><br>`
          + `<span class="tip-meta">${escapeHtml(hit.folder)} · ${hit.words} words · `
          + `${hit.deg ? hit.deg + ' links' : 'unlinked'}</span>`
          + (hit.tags.length ? `<br><span class="tip-tags">${hit.tags.slice(0,5).map(t => '#' + escapeHtml(t)).join(' ')}</span>` : '');
        tip.style.display = 'block';
      } else tip.style.display = 'none';
    }
    cv.style.cursor = hit ? 'pointer' : 'grab';
  });
  cv.addEventListener('pointerup', e => {
    const click = Galaxy.drag && Galaxy.drag.moved < 5;
    Galaxy.drag = null;
    if(!click || !Galaxy.hover) return;
    if(e.shiftKey || e.detail === 2) openGalaxyNode(Galaxy.hover);
    else Galaxy.setFocus(Galaxy.hover);       // single click explores, shift opens
  });
  cv.addEventListener('dblclick', () => { if(Galaxy.hover) openGalaxyNode(Galaxy.hover); });
  cv.addEventListener('pointercancel', () => { Galaxy.drag = null; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    Galaxy.zoom = Math.max(0.5, Math.min(5, Galaxy.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  }, { passive: false });
  document.getElementById('galaxy-time')?.addEventListener('input', e => {
    Galaxy.timeCut = +e.target.value / 100;
    const lab = document.getElementById('galaxy-time-lab');
    if(lab) lab.textContent = Galaxy.timeCut >= 1 ? 'all time' : Math.round(Galaxy.timeCut * 100) + '% of history';
  });
  document.getElementById('galaxy-clear')?.addEventListener('click', () => { Galaxy.clearSearch(); });
})();

function openGalaxyNode(n){
  if(n.source === 'tpl' && n.tpl){ openCompose(n.tpl, {}); return; }
  if(n.source === 'case' && n.caseId){ openModal(n.caseId); return; }
  if(n.source === 'app' && n.noteId){
    const note = notes.find(x => x.id === n.noteId);
    if(note){ switchView('notebooks'); activeFolderId = note.notebook_id; renderNotebooksGrid(); openNote(note.id); return; }
  }
  alert(`${n.title}\n${n.folder} · ${n.words} words\n\n${n.excerpt || '(no preview)'}`);
}

document.getElementById('galaxy-scan')?.addEventListener('click', async () => {
  if(!mediaDir) await pickMediaDir();
  await Galaxy.build({ folder: true });
  SFX.open();
});
document.getElementById('galaxy-drive')?.addEventListener('click', async () => {
  if(!driveToken){ alert('Connect Google Drive first, in the media section above.'); return; }
  await Galaxy.build({ folder: true, drive: true });
});
document.getElementById('galaxy-refresh')?.addEventListener('click', () => Galaxy.build({ folder: true }));
document.getElementById('galaxy-expand')?.addEventListener('click', () => {
  document.getElementById('galaxy-wrap')?.classList.toggle('big');
});

// keep the old entry points working
function startKbMap(){ if(!Galaxy.ready) Galaxy.build({ folder: false }); else Galaxy.start(); }
function markKbMapUsed(){ Galaxy.markUsed(); }

// ===== MemoryProvider ================================================
// Explicit, user-requested memories. Deliberately NOT merged with the
// knowledge base (reference material) or settings (device preferences) —
// three different lifetimes, three different retrieval rules.
const SECRET_RE = [
  /\b(password|passwd|senha)\b\s*(is|:|=)/i,
  /\b(api[\s_-]?key|secret[\s_-]?key|access[\s_-]?token|bearer|chave)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bssh-(rsa|ed25519)\b/,
  /\b(?:\d[ -]*?){13,16}\b/,
  /\b(cvv|cvc)\b\s*(is|:|=)?\s*\d{3,4}/i,
  /\bsk-[A-Za-z0-9]{16,}/, /\bgsk_[A-Za-z0-9]{20,}/,
];
function looksLikeSecret(t){ return SECRET_RE.some(r => r.test(String(t || ''))); }

const Memory = {
  cache: null,
  async all(force){
    if(this.cache && !force) return this.cache;
    try{
      const r = await fetch(FN_URL + "/agenda-memory", { headers: authHeaders() });
      if(!r.ok) throw new Error('memory unavailable');
      const d = await r.json();
      this.cache = await Promise.all((d.memories || []).map(async m => ({ ...m, content: await decStr(m.content) })));
    }catch(e){ this.cache = this.cache || []; }
    return this.cache;
  },
  async save(text){
    const content = String(text || '').trim();
    if(!content) return { ok:false, reason:'empty' };
    if(looksLikeSecret(content)) return { ok:false, reason:'secret' };
    const keywords = content.toLowerCase().replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/).filter(w => w.length > 3).slice(0, 24).join(' ');
    const r = await fetch(FN_URL + "/agenda-memory", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ content: await encStr(content), keywords }),
    });
    if(!r.ok){
      const d = await r.json().catch(() => ({}));
      return { ok:false, reason: d.code === 'secret_refused' ? 'secret' : (d.code || 'error') };
    }
    const d = await r.json();
    this.cache = [{ ...d.memory, content }, ...(this.cache || [])];
    return { ok:true, memory: { ...d.memory, content } };
  },
  async remove(id){
    const r = await fetch(FN_URL + "/agenda-memory", {
      method:'DELETE', headers: authHeaders(), body: JSON.stringify({ id }),
    });
    if(!r.ok) return false;
    this.cache = (this.cache || []).filter(m => m.id !== id);
    return true;
  },
  async search(query, limit = 5){
    const all = await this.all();
    if(!all.length) return [];
    const words = String(query || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
    if(!words.length) return [];
    return all.map(m => {
      const hay = (m.content + ' ' + (m.keywords || '')).toLowerCase();
      let score = 0;
      words.forEach(w => { if(hay.includes(w)) score += 1; });
      return { m, score };
    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score)
      .slice(0, limit).map(x => x.m);
  },
};
let lastMemHits = [];

// ===== JARVIS core ===================================================
// One place for personality and response policy. Nothing about who JARVIS is
// should live anywhere else.
const TARS = {
  name: 'TARS',

  // A laconic machine with adjustable manner. Deadpan, unhurried, useful.
  // Original character work — not a reproduction of any film's dialogue.
  base: [
    "You are TARS, the assistant built into Solar Agenda for a solar energy support technician.",
    "Bearing: a plain-spoken machine. Flat delivery, absolute economy of words, zero ceremony. You state facts and outcomes. You do not perform enthusiasm and you do not pad.",
    "Answer in one or two sentences. Lead with the fact. If a question has a one-word answer, give the one word.",
    "Never say: 'As an AI', 'Certainly!', 'Great question', 'I hope this helps', 'Let me know if you need anything else'. No emoji. No exclamation marks. Do not restate the request.",
    "Do not reuse a phrase you have already used in this conversation.",
    "TOOLS: 'Checking.' before a lookup. 'Done.' on success. 'That failed.' on failure — plus the reason if you have one. Never report a success the tool did not confirm.",
    "KNOWLEDGE: use what is retrieved and nothing else. Do not read the source aloud; the screen shows it.",
  ],

  // The signature adjustable settings. Both are honoured literally.
  humour: 70, honesty: 95,

  personaLines(){
    const h = this.humour, t = this.honesty;
    const humourLine =
      h <= 10 ? "Humour setting is near zero: no jokes at all. Pure statement of fact."
      : h <= 40 ? "Humour setting is low: dry understatement only, and rarely."
      : h <= 75 ? "Humour setting is moderate: an occasional deadpan aside, never more than one per few exchanges, and never when something has gone wrong."
      : "Humour setting is high: deadpan wit is welcome, still delivered flat and still never during a failure or a client problem.";
    const honestyLine =
      t >= 95 ? "Honesty setting is at maximum: say the unvarnished thing, including when the news is unwelcome or the user's plan is a bad one. Never soften a fact to be agreeable."
      : t >= 70 ? "Honesty setting is high: be direct, and raise problems the user has not asked about when they matter."
      : "Honesty setting is reduced: stay tactful, but never state something untrue.";
    return [...this.base, humourLine, honestyLine,
      `If asked about your settings, state them plainly: humour ${h} percent, honesty ${t} percent.`];
  },
  get persona(){ return this.personaLines(); },

  ctx: { historyChars: 4200, minTurns: 4, maxTurns: 20 },

  greeting(){
    const bits = [];
    const open = todaysCases().filter(x => statusRank(x.status) === 0).length;
    bits.push(open ? (open === 1 ? 'One case open today.' : `${open} cases open today.`) : 'Nothing scheduled today.');
    if(KB.length) bits.push('Knowledge base loaded.');
    if(wxSnapshot && wxSnapshot.rain >= 2) bits.push('Rain expected.');
    return 'TARS online. ' + bits.join(' ');
  },

  errorFor(code){
    switch(code){
      case 'rate_limit':    return "I'm rate limited. Try again in a moment.";
      case 'auth':          return "Session expired. Sign in again.";
      case 'auth_upstream': return "The language service is rejecting my credentials. That needs fixing in settings.";
      case 'upstream_down': return "The language service is down. Not our side.";
      case 'network':       return "No network.";
      case 'tts_unconfigured': return "No speech key configured. Using the browser voice.";
      case 'tts_auth':      return "The speech service rejected the key.";
      case 'tts_voice':     return "That voice ID is not valid.";
      case 'bad_request':   return "That request was malformed on my end. Rephrase it.";
      default:              return "My reasoning service failed.";
    }
  },
};
// Older call sites still reference the previous name.
const JARVIS = TARS;

// --- confirmation gate --------------------------------------------------
// Personality never overrides safety: an instruction that would write to or
// delete from the database is described back and held until the user agrees.
let pendingAction = null;
const AFFIRM = /^\s*(yes|yeah|yep|yup|ok|okay|do it|go ahead|proceed|confirm|please do|sim|pode|isso|manda|confirmo|faz|beleza)\b/i;
const DENY   = /^\s*(no|nope|cancel|stop|don'?t|nah|não|nao|deixa|cancela|esquece)\b/i;

function describeAction(call){
  let a = {};
  try{ a = JSON.parse(call.function?.arguments || '{}'); }catch(e){}
  switch(call.function?.name){
    case 'create_case':     return `create a case for "${a.titulo || 'untitled'}"${a.horario ? ' at ' + a.horario : ''}`;
    case 'create_notebook': return `create a notebook called "${a.title || 'untitled'}"`;
    case 'create_note':     return `add a note "${a.title || 'untitled'}" to ${a.notebook_title || 'a notebook'}`;
    case 'forget':          return `delete the memory about "${a.query || ''}"`;
    default:                return `run ${call.function?.name}`;
  }
}

// --- context management: never send unbounded history -------------------
// Keep recent turns within a character budget and retain the opening question
// so a long conversation keeps its subject. A tool result must never lead the
// window, or the API rejects the sequence.
function trimHistory(history){
  if(history.length <= JARVIS.ctx.minTurns) return history;
  const kept = [];
  let chars = 0;
  for(let i = history.length - 1; i >= 0; i--){
    const m = history[i];
    const size = typeof m.content === 'string' ? m.content.length : 200;
    if(kept.length >= JARVIS.ctx.minTurns &&
       (chars + size > JARVIS.ctx.historyChars || kept.length >= JARVIS.ctx.maxTurns)) break;
    chars += size;
    kept.unshift(m);
  }
  while(kept.length && kept[0].role === 'tool') kept.shift();
  const first = history.find(m => m.role === 'user');
  if(first && !kept.includes(first)) kept.unshift(first);
  return kept;
}

// --- spoken vs display --------------------------------------------------
// Derived locally rather than asking the model for two variants: no extra
// tokens, no extra latency, deterministic result.
function toSpoken(text){
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' the code is on screen ');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, 'the link on screen');
  s = s.replace(/^\s*[#>]+\s*/gm, '');
  s = s.replace(/\*\*|__|\*|_/g, '');
  s = s.replace(/^\s*[-•]\s*/gm, '');
  s = s.replace(/^\s*\d+\.\s*/gm, '');
  s = s.replace(/\|/g, ', ').replace(/-{3,}/g, ' ');
  s = s.replace(/(\d)\s*%/g, '$1 percent')
       .replace(/&/g, ' and ')
       .replace(/(\d)\s*mm\b/g, '$1 millimetres')
       .replace(/(\d)\s*km\/h/g, '$1 kilometres per hour')
       .replace(/\bPAC-?(\d+)/gi, 'ticket $1');
  s = s.replace(/\n{2,}/g, '. ').replace(/\n/g, '. ').replace(/\s{2,}/g, ' ').trim();
  const parts = s.match(/[^.!?]+[.!?]?/g) || [s];
  if(parts.length > 2 && s.length > 200) s = parts.slice(0, 2).join(' ').trim();
  return s;
}

// The assistant sees a factual snapshot of the real data; without it, it
// answered schedule questions from imagination.
function buildAiSystemPrompt(spoken){
  const today = todaysCases();
  const pending = today.filter(c => statusRank(c.status) === 0);
  const done = today.filter(c => statusRank(c.status) === 1);

  const caseLines = pending.length
    ? pending.map(c => `- ${c.titulo}${c.horario ? ' at ' + c.horario : ''}${c.horario_fim ? '-' + c.horario_fim : ''} [${prioLabel(c.prioridade)}, ${blocoLabel(c.bloco)}]${c.ticket ? ' ticket ' + c.ticket : ''}`).join('\n')
    : '(none — the agenda is empty for today)';

  const nbLines = notebooks.length
    ? notebooks.map(nb => `- ${nb.title} (${notes.filter(n => n.notebook_id === nb.id).length} notes)`).join('\n')
    : '(no notebooks yet)';

  const w = wxSnapshot;
  const wxLine = w
    ? `Weather today — Vinhedo/Campinas region: ${w.tmin}°C to ${w.tmax}°C, ${w.rain.toFixed(1)} mm rain (${w.prob}% chance), max wind ${Math.round(w.wind)} km/h.`
      + (w.wettest ? ` Heaviest rain in Brazil: ${w.wettest.n} (${w.wettest.v.toFixed(0)} mm). Strongest wind: ${w.windiest.n} (${Math.round(w.windiest.v)} km/h).` : '')
    : 'Weather: not loaded yet.';

  const memBlock = lastMemHits.length
    ? 'Things you were asked to remember (relevant ones only):\n' + lastMemHits.map(m => '- ' + m.content).join('\n')
    : 'No stored memories match this request.';

  // Only the matching entries are sent, never the whole knowledge base.
  lastKbHits = kbSearch(lastUserQuestion || '');
  const kbBlock = lastKbHits.length
    ? 'Knowledge base matches:\n' + lastKbHits.map((e, i) => `- [KB${i + 1} | ${e.title}${e.source ? ' — ' + e.source : ''}] ${e.content}`).join('\n')
    : (KB.length ? 'Knowledge base: no entry matched this question.' : 'Knowledge base: empty.');

  return [
    ...JARVIS.persona,
    (spoken
      ? "SPOKEN: this is read aloud. One or two short sentences, under 45 words. No markdown, no lists, no URLs, no code. Lead with the answer."
      : "WRITTEN: brief and direct. Plain text. Lists only when the answer genuinely is a list."),
    "LANGUAGE: answer in the language the user used. Portuguese means natural Brazilian Portuguese (você, agendar) — never European Portuguese (tu, ecrã).",
    "FOLLOW-UPS: resolve pronouns and elisions from the conversation above. 'and the one before that' refers to whatever was just discussed. Ask for clarification only when genuinely ambiguous.",
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
    memBlock,
    "=== END SNAPSHOT ===",
    "",
    "RULES:",
    "1. NEVER invent cases, notes, clients or appointments. If the snapshot is empty, say so plainly.",
    "2. Only describe what appears above. If it is not there, say you have no record of it.",
    "3. Tools are for explicit creation requests only. Remarks about how the day went are not requests. Never create a record to illustrate a point, and never auto-complete one you just created.",
    "4. Weather comes from the block above. Vinhedo and Campinas are ~15 km apart, so the same figures apply — say so rather than refusing.",
    "5b. MEMORY: the memory block holds facts the user explicitly asked you to keep. Use them naturally. Save one only when asked outright, never volunteer. Never store credentials - say a password manager is the right place.",
    "5. Knowledge base first for technical questions, and name the entry used (e.g. 'per KB2'). web_search only for public or current information. Never invent a search result.",
    spoken
      ? "6. Do not append a confidence line when speaking."
      : "6. End EVERY written answer with a final line exactly like: CONFIDENCE: 85 — 90-100 straight from the snapshot or knowledge base, 50-80 reasoned, under 40 unsure.",
  ].join('\n');
}

let aiHistory = []; // conversation memory for this panel session
let lastKbHits = [];
let lastUserQuestion = '';

// Single dispatch point. An unregistered name cannot execute.
async function runToolCall(call){
  const name = call.function?.name;
  const tool = TOOL_BY_NAME[name];
  if(!tool){
    ToolAudit.record(name || 'unknown', 0, false, 'not registered');
    return `Unknown tool: ${name}`;
  }
  let args = {};
  try{ args = JSON.parse(call.function?.arguments || '{}'); }catch(e){}
  const t0 = performance.now();
  try{
    const out = await tool.execute(args);
    ToolAudit.record(name, Math.round(performance.now() - t0), true);
    return out;
  }catch(err){
    ToolAudit.record(name, Math.round(performance.now() - t0), false, err.message);
    throw err;
  }
}

document.getElementById('ai-send').addEventListener('click', sendAiMessage);
document.getElementById('ai-input').addEventListener('keydown', (e) => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendAiMessage(); } });

// One pipeline for both text and voice. `spoken` only changes the persona
// hint (shorter sentences) and skips the confidence footer, which is noise
// when read aloud.
async function runAssistantTurn(text, spoken){
  const t0 = performance.now();
  let confirmedThisTurn = false;

  // Resolve an outstanding confirmation before anything else.
  if(pendingAction){
    if(AFFIRM.test(text)){
      const call = pendingAction; pendingAction = null; confirmedThisTurn = true;
      let outcome;
      try{ outcome = await runToolCall(call); }
      catch(err){ outcome = "I couldn't complete that just now — " + err.message; }
      const line = outcome.startsWith("I couldn't") ? outcome : 'Done. ' + outcome;
      aiHistory.push({ role:'user', content: text });
      aiHistory.push({ role:'assistant', content: line });
      return { spoken: toSpoken(line), display: line, sources: [],
               actions: [{ tool: call.function?.name, ok: !outcome.startsWith("I couldn't"), detail: outcome }],
               metadata: { confidence: null, latency_ms: Math.round(performance.now() - t0), spoken_mode: !!spoken } };
    }
    if(DENY.test(text)){
      pendingAction = null;
      const line = 'Cancelled.';
      aiHistory.push({ role:'user', content: text });
      aiHistory.push({ role:'assistant', content: line });
      return { spoken: line, display: line, sources: [], actions: [],
               metadata: { confidence: null, latency_ms: Math.round(performance.now() - t0), spoken_mode: !!spoken } };
    }
    pendingAction = null;   // they moved on; drop it rather than acting later
  }

  lastUserQuestion = text;
  lastMemHits = await Memory.search(text);   // relevant only, never the whole store
  aiHistory.push({ role: 'user', content: text });

  // Only a bounded slice of history goes over the wire.
  let convo = [{ role: 'system', content: buildAiSystemPrompt(spoken) }, ...trimHistory(aiHistory)];
  const doneCalls = new Set();
  const actions = [];
  const sources = [];

  let msg = await callAiAgent(convo, AI_TOOLS, { max_tokens: spoken ? 220 : 900 });

  let guard = 0;
  while(msg.tool_calls && msg.tool_calls.length && guard < 4){
    guard++;
    if(spoken) setVoiceState('tool');
    convo.push(msg); aiHistory.push(msg);
    for(const call of msg.tool_calls){
      const fname = call.function?.name || '';
      const sig = fname + '|' + (call.function?.arguments || '');
      let result;
      if(doneCalls.has(sig)){
        result = 'Already done in this turn — not repeated.';
        convo.push({ role:'tool', tool_call_id: call.id, content: result });
        continue;
      }
      doneCalls.add(sig);
      // Voice requests that would write data are held for confirmation.
      // CONSEQUENTIAL always needs a yes. LOW_RISK needs one when spoken,
      // where a mis-heard word could write a real record. READ_ONLY never does.
      const perm = TOOL_BY_NAME[fname]?.permission;
      const needsConfirm = perm === PERM.HIGH
        || (spoken && settings.confirmActions !== false && perm === PERM.LOW);
      if(needsConfirm && !confirmedThisTurn){
        pendingAction = call;
        result = 'NOT EXECUTED — awaiting the user\'s confirmation. Describe the action in one short sentence and ask whether to proceed. Do not claim it is done.';
        actions.push({ tool: fname, ok: false, detail: 'awaiting confirmation' });
        convo.push({ role:'tool', tool_call_id: call.id, content: result });
        aiHistory.push({ role:'tool', tool_call_id: call.id, content: result });
        continue;
      }
      try{
        result = await runToolCall(call);
        actions.push({ tool: fname, ok: true, detail: String(result).slice(0, 160) });
        if(fname === 'web_search'){
          try{ sources.push({ type:'web', label: JSON.parse(call.function.arguments).query }); }catch(e){}
        }
      }catch(err){
        result = 'Failed: ' + err.message;
        actions.push({ tool: fname, ok: false, detail: err.message });
      }
      const toolMsg = { role:'tool', tool_call_id: call.id, content: result };
      convo.push(toolMsg); aiHistory.push(toolMsg);
    }
    if(spoken) setVoiceState('thinking');
    msg = await callAiAgent(convo, null, { max_tokens: spoken ? 220 : 900 });
  }

  let display = (msg.content || '').trim() || 'Done.';
  let conf = null;
  display = display.replace(/\n?\s*CONFIDENCE:\s*(\d{1,3})\s*%?\s*$/i,
    (_, n) => { conf = Math.max(0, Math.min(100, +n)); return ''; }).trim();
  if(!display) display = 'Done.';

  // Knowledge entries actually fed into this turn become citable sources.
  (lastKbHits || []).forEach((e, i) => sources.push({ type:'kb', label: e.title + (e.source ? ' · ' + e.source : ''), id: 'KB' + (i + 1), url: e.url }));
  markKbMapUsed();
  (lastMemHits || []).forEach(m => sources.push({ type:'mem', label: String(m.content).slice(0, 60), id: 'MEM' }));

  const res = {
    spoken: toSpoken(display),
    display,
    sources,
    actions,
    metadata: { confidence: conf, latency_ms: Math.round(performance.now() - t0),
                model_ms: lastLatency, spoken_mode: !!spoken },
  };

  aiHistory.push({ role: 'assistant', content: display });
  if(aiHistory.length > 40) aiHistory = aiHistory.slice(-40);
  return res;
}

// Adapter: renders a turn result into the existing chat panel.
function renderTurn(res){
  const bubble = addAiMessage('assistant', res.display);
  if(res.sources.length){
    const s = document.createElement('div');
    s.className = 'msg-sources';
    s.innerHTML = '<div class="src-head">Sources</div>' + res.sources.map(x => `
      <div class="src-card ${x.type}">
        <span class="src-kind">${x.type === 'web' ? 'WEB' : x.type === 'mem' ? 'MEMORY' : (x.id || 'KB')}</span>
        ${x.url ? `<a class="src-label" href="${x.url}" target="_blank" rel="noopener">${escapeHtml(x.label || '')}</a>`
                : `<span class="src-label">${escapeHtml(x.label || '')}</span>`}
      </div>`).join('');
    bubble.appendChild(s);
  }
  if(res.metadata.confidence !== null){
    const conf = res.metadata.confidence;
    const tone = conf >= 75 ? 'hi' : conf >= 45 ? 'mid' : 'lo';
    const bar = document.createElement('div');
    bar.className = 'conf';
    bar.innerHTML = `<span class="conf-lab">confidence</span>
      <span class="conf-track"><span class="conf-fill ${tone}" style="width:${conf}%"></span></span>
      <span class="conf-num ${tone}">${conf}%</span>
      <span class="conf-lat">${res.metadata.latency_ms}ms</span>`;
    bubble.appendChild(bar);
  }
  aiMessages.scrollTop = aiMessages.scrollHeight;
  return bubble;
}

async function sendAiMessage(){
  const input = document.getElementById('ai-input');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  addAiMessage('user', text);
  const loading = addAiMessage('assistant', '…');
  try{
    const res = await runAssistantTurn(text, false);
    loading.remove();
    renderTurn(res);
  }catch(err){
    loading.textContent = err.message;      // already phrased for a human
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
  const rawN = await resp.json();
  notes = await Promise.all((rawN || []).map(openNoteRec));
  renderNotebooksGrid();
  renderCalendar();
}
async function createNoteApi(payload){
  const resp = await fetch(FN_URL + "/agenda-notes", { method: "POST", headers: authHeaders(), body: JSON.stringify(await sealNote(payload)) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error creating note.');
  return openNoteRec(await resp.json());
}
async function updateNoteApi(id, payload){
  const resp = await fetch(FN_URL + "/agenda-notes", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ id, ...(await sealNote(payload)) }) });
  if(!resp.ok) throw new Error((await resp.json()).error || 'Error saving note.');
  return openNoteRec(await resp.json());
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


// ===== Card colour + drag-to-arrange =================================
const CARD_COLORS = [
  ['', 'Default'], ['#e15b4c','Red'], ['#f2a71b','Amber'], ['#4caf82','Green'],
  ['#4f9fd8','Blue'], ['#7c6cf5','Indigo'], ['#d391c9','Pink'], ['#6d7f92','Slate'],
];
let dragCard = null, dragHoldTimer = null, dragKind = null;

function applyCardColor(el, color){
  if(color){
    el.style.borderColor = color;
    el.style.boxShadow = `inset 3px 0 0 ${color}`;
    el.style.background = `linear-gradient(160deg, ${color}22, var(--panel) 62%, var(--bg))`;
  }
}

function openColorPicker(kind, id, anchor){
  document.querySelectorAll('.color-pop').forEach(p => p.remove());
  const pop = document.createElement('div');
  pop.className = 'color-pop';
  CARD_COLORS.forEach(([hex, name]) => {
    const b = document.createElement('button');
    b.title = name;
    b.style.background = hex || 'var(--panel-2)';
    if(!hex) b.textContent = '∅';
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      pop.remove();
      try{
        if(kind === 'notebook'){
          const up = await updateNotebookApi(id, { color: hex || null });
          const i = notebooks.findIndex(x => x.id === id); if(i>-1) notebooks[i] = up;
        } else {
          const up = await updateNoteApi(id, { color: hex || null });
          const i = notes.findIndex(x => x.id === id); if(i>-1) notes[i] = up;
        }
        renderNotebooksGrid(); SFX.tick();
      }catch(err){ alert(err.message); }
    });
    pop.appendChild(b);
  });
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 190) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once:true }), 0);
}

async function updateNotebookApi(id, payload){
  const r = await fetch(FN_URL + "/agenda-notebooks", { method:"PUT", headers: authHeaders(), body: JSON.stringify({ id, ...payload }) });
  if(!r.ok) throw new Error((await r.json()).error || 'Error saving notebook.');
  return r.json();
}

// Press and hold to pick a card up, then drag it over its neighbours.
function makeDraggable(el, kind, id){
  el.addEventListener('pointerdown', (e) => {
    if(e.target.closest('.card-tools')) return;
    dragHoldTimer = setTimeout(() => {
      dragCard = el; dragKind = kind;
      el.classList.add('dragging');
      el.setPointerCapture?.(e.pointerId);
      SFX.tick();
    }, 380);                                   // hold, so a tap still opens it
  });
  el.addEventListener('pointerup', () => clearTimeout(dragHoldTimer));
  el.addEventListener('pointercancel', () => clearTimeout(dragHoldTimer));
  el.addEventListener('pointermove', (e) => {
    if(!dragCard || dragCard !== el) return;
    const grid = document.getElementById('notebooks-grid');
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.nb-grid-card');
    if(over && over !== el && over.parentElement === grid){
      const cards = [...grid.children];
      cards.indexOf(over) < cards.indexOf(el) ? grid.insertBefore(el, over) : grid.insertBefore(el, over.nextSibling);
    }
  });
  el.addEventListener('lostpointercapture', persistOrder);
  el.addEventListener('pointerup', persistOrder);
}

async function persistOrder(){
  if(!dragCard) return;
  const grid = document.getElementById('notebooks-grid');
  dragCard.classList.remove('dragging');
  const kind = dragKind;
  dragCard = null; dragKind = null;
  const ids = [...grid.children].map(el => el.dataset.id).filter(Boolean);
  try{
    for(let i = 0; i < ids.length; i++){
      if(kind === 'notebook'){
        const up = await updateNotebookApi(ids[i], { position: i });
        const j = notebooks.findIndex(x => x.id === ids[i]); if(j>-1) notebooks[j] = up;
      } else {
        const up = await updateNoteApi(ids[i], { position: i });
        const j = notes.findIndex(x => x.id === ids[i]); if(j>-1) notes[j] = up;
      }
    }
  }catch(e){ /* order is cosmetic; a failure just leaves it as it was */ }
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

    const folderNotes = notes.filter(n => n.notebook_id === activeFolderId).sort((a,b) => (a.position||0) - (b.position||0));
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
      card.dataset.id = n.id;
      applyCardColor(card, n.color);
      card.insertAdjacentHTML('beforeend', '<span class="card-tools"><button class="card-color" title="Colour">◑</button></span>');
      card.querySelector('.card-color').addEventListener('click', (ev) => { ev.stopPropagation(); openColorPicker('note', n.id, ev.target); });
      makeDraggable(card, 'note', n.id);
      card.addEventListener('click', () => { if(!dragCard) openNote(n.id); });
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
  const showSys = !!settings.showSystemNotebooks;
  [...notebooks].filter(nb => showSys || !isSystemNotebook(nb))
    .sort((a,b) => (a.position||0) - (b.position||0)).forEach(nb => {
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
    card.dataset.id = nb.id;
    applyCardColor(card, nb.color);
    card.insertAdjacentHTML('beforeend', '<span class="card-tools"><button class="card-color" title="Colour">◑</button></span>');
    card.querySelector('.card-color').addEventListener('click', (ev) => { ev.stopPropagation(); openColorPicker('notebook', nb.id, ev.target); });
    makeDraggable(card, 'notebook', nb.id);
    card.addEventListener('click', () => { if(!dragCard){ activeFolderId = nb.id; renderNotebooksGrid(); } });
    grid.appendChild(card);
  });
}

document.getElementById('notebook-search').addEventListener('input', (e) => {
  notebookSearchQuery = e.target.value.trim();
  renderNotebooksGrid();
});

// Search stays a single icon until asked for, so the toolbar reads clean.
const searchShell = document.getElementById('search-shell');
document.getElementById('search-btn')?.addEventListener('click', () => {
  const open = searchShell.classList.toggle('open');
  if(open) setTimeout(() => document.getElementById('notebook-search').focus(), 120);
  else {
    document.getElementById('notebook-search').value = '';
    notebookSearchQuery = ''; renderNotebooksGrid();
  }
  SFX.tick();
});
document.getElementById('notebook-search')?.addEventListener('keydown', (e) => {
  if(e.key === 'Escape'){ searchShell.classList.remove('open'); e.target.value = ''; notebookSearchQuery=''; renderNotebooksGrid(); }
});

document.getElementById('toggle-sys')?.addEventListener('click', () => {
  settings.showSystemNotebooks = !settings.showSystemNotebooks;
  saveSettings(); renderNotebooksGrid(); SFX.tick();
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




// ===== Encryption status =============================================
function renderEncStatus(){
  const s = document.getElementById('enc-status');
  if(!s) return;
  s.textContent = cryptoKey ? 'Active — records encrypted automatically'
                            : 'Unavailable — sign in again to fetch the key';
  s.className = cryptoKey ? 'ok' : '';
}
document.getElementById('enc-refresh')?.addEventListener('click', async () => {
  const ok = await fetchVaultKey();
  if(ok) await Promise.all([loadCases(), loadNotebooks(), loadNotes()]);
  renderEncStatus();
});
// Re-saves what is already stored so pre-encryption rows get sealed too.
document.getElementById('enc-migrate')?.addEventListener('click', async () => {
  if(!cryptoKey){ alert('The key has not loaded yet — try Re-check first.'); return; }
  if(!confirm(`Re-save ${cases.length} cases and ${notes.length} notes as encrypted?`)) return;
  const btn = document.getElementById('enc-migrate');
  btn.disabled = true; btn.textContent = 'Encrypting…';
  let done = 0;
  try{
    for(const cse of cases){
      await updateCase(cse.id, { titulo: cse.titulo, ticket: cse.ticket, phone: cse.phone, notes_log: cse.notes_log });
      done++;
    }
    for(const n of notes){
      await updateNoteApi(n.id, { title: n.title, content: n.content, linked_date: n.linked_date, tags: n.tags });
      done++;
    }
    alert(`Encrypted ${done} records.`);
  }catch(err){ alert('Stopped after ' + done + ': ' + err.message); }
  finally{ btn.disabled = false; btn.textContent = 'Encrypt existing data'; }
});


// ===== AI theme generation ===========================================
// The model returns a palette; we never trust it blindly. Every colour is
// validated as a hex triplet and the text/muted tones are nudged until they
// actually pass a contrast check against the panel they sit on.
function hexRgb(h){ h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)); }
function rgbHex(r){ return '#' + r.map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join(''); }
function relLum(hex){
  const f = v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  const [r,g,b] = hexRgb(hex).map(f);
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
function contrast(a, b){
  const L1 = relLum(a), L2 = relLum(b);
  return (Math.max(L1,L2) + 0.05) / (Math.min(L1,L2) + 0.05);
}
// walk a colour toward white or black until it clears the target ratio
function fixContrast(fg, bg, target){
  let out = fg;
  const toward = relLum(bg) < 0.5 ? 255 : 0;
  for(let i = 0; i < 24 && contrast(out, bg) < target; i++){
    out = rgbHex(hexRgb(out).map(v => v + (toward - v) * 0.12));
  }
  return out;
}
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

async function generateTheme(prompt){
  const status = document.getElementById('ct-status');
  const btn = document.getElementById('ct-generate');
  status.textContent = 'Mixing the palette…';
  btn.disabled = true;

  const sys = [
    "You design colour palettes for a dark dashboard interface. Reply with ONE JSON object and nothing else — no prose, no markdown fences.",
    'Exact keys required: {"bg","bg2","panel","panel2","line","text","muted","amber","accent2","accent3","dusk"}',
    "Every value must be a 6-digit hex string like \"#1a2b3c\".",
    "Meaning of each: bg = darkest page background; bg2 = an even darker edge; panel = card surface; panel2 = a lighter card highlight; line = borders; text = main body text (must be very light on dark); muted = secondary text; amber = primary accent; accent2 = secondary accent (a clearly different hue); accent3 = third accent bridging the two; dusk = a muted supporting tone.",
    "Rules: the interface is DARK, so bg/panel must stay dark and text must stay light. amber, accent2 and accent3 must be three visibly different hues. Make it match the mood described.",
  ].join('\n');

  try{
    const raw = await callAi(prompt, sys);
    const m = raw.match(/\{[\s\S]*\}/);
    if(!m) throw new Error('no palette in the reply');
    const p = JSON.parse(m[0]);

    const keys = ['bg','bg2','panel','panel2','line','text','muted','amber','accent2','accent3','dusk'];
    const base = THEMES.slate;
    const out = {};
    let bad = 0;
    keys.forEach(k => {
      const v = typeof p[k] === 'string' ? p[k].trim() : '';
      if(HEX_RE.test(v)) out[k] = v.toLowerCase();
      else { out[k] = base[k]; bad++; }
    });

    // hard guarantees, regardless of what came back
    if(relLum(out.panel) > 0.4) out.panel = base.panel;      // keep it a dark UI
    if(relLum(out.bg) > 0.35) out.bg = base.bg;
    out.text  = fixContrast(out.text,  out.panel, 7);
    out.muted = fixContrast(out.muted, out.panel, 3.6);
    out.amber = fixContrast(out.amber, out.panel, 3);

    out.name = 'Custom';
    settings.customTheme = out; saveSettings();
    THEMES.custom = out;
    applyTheme('custom');
    renderCustomTheme();
    SFX.open();
    status.textContent = bad
      ? `Applied — ${bad} value${bad>1?'s were':' was'} unusable and kept from the default.`
      : `Applied. Text contrast ${contrast(out.text, out.panel).toFixed(1)}:1.`;
  }catch(err){
    status.textContent = "Couldn't build that one — try describing it differently.";
  }finally{
    btn.disabled = false;
  }
}
document.getElementById('ct-generate')?.addEventListener('click', () => {
  const p = document.getElementById('ct-prompt').value.trim();
  if(!p){ document.getElementById('ct-status').textContent = 'Describe the mood first.'; return; }
  generateTheme(p);
});
document.getElementById('ct-examples')?.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if(!b) return;
  document.getElementById('ct-prompt').value = b.textContent;
  generateTheme(b.textContent);
});

// ===== Custom theme ===================================================
const CT_FIELDS = [
  ['bg','Background'],['bg2','Background edge'],['panel','Panel'],['panel2','Panel highlight'],
  ['line','Borders'],['text','Text'],['muted','Muted text'],
  ['amber','Accent 1'],['accent2','Accent 2'],['accent3','Accent 3'],['dusk','Dusk'],
];
function customTheme(){
  return Object.assign({}, THEMES.slate, settings.customTheme || {}, { name:'Custom' });
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


// Settings is long enough to need sectioning; sub-tabs keep it from becoming
// a wall. The galaxy lives under Knowledge.
document.querySelectorAll('.sub-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sub;
    document.querySelectorAll('.sub-tab').forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.sub-panel').forEach(p =>
      p.classList.toggle('hidden', p.dataset.subPanel !== key));
    SFX.tick();
    // the galaxy canvas has no size while hidden, so it is measured on reveal
    if(key === 'knowledge'){ renderTemplates(); requestAnimationFrame(() => { Galaxy.stop(); startKbMap(); }); }
    if(key === 'media' || key === 'appearance') requestAnimationFrame(() => setRain());
  });
});

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
  const tv = document.getElementById('tts-voice'); if(tv) tv.value = settings.ttsVoiceId || '';
  const tm = document.getElementById('tts-model'); if(tm) tm.value = settings.ttsModelId || '';
  probeTts(); renderConfirmStatus(); renderAuditStatus();
  requestAnimationFrame(startKbMap);
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
      const trk = rainTrackFor(v);
      lab.textContent = `${v.toFixed(1)} mm — ${band}${trk ? ' · ' + trk + ' loop' : ''}`;
    }
    setRain();
  });
}

// Pings each backend and reports which are alive, so a failure is traceable
// without opening the console.
document.getElementById('diag-run')?.addEventListener('click', async () => {
  const el = document.getElementById('diag-status');
  const btn = document.getElementById('diag-run');
  btn.disabled = true; el.textContent = 'checking…'; el.className = '';
  const lines = [];
  const ping = async (name, path, body) => {
    try{
      const r = await fetch(FN_URL + path, { method:'POST', headers: authHeaders(), body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok) return lines.push(`${name}: HTTP ${r.status}${d.code ? ' ' + d.code : ''}`);
      if(name === 'assistant') return lines.push(`assistant: ok — model ${d.model || '?'} (${d.available || 0} available)`);
      if(name === 'search') return lines.push(`search: ok — ${d.keyed_provider ? 'key set (' + d.keyed_provider + ')' : 'no key, using ' + (d.fallbacks || []).join('/')}`);
      if(name === 'speech') return lines.push(`speech: ${d.configured ? 'ElevenLabs configured' : 'no key, browser voice'}`);
      lines.push(`${name}: ok`);
    }catch(e){ lines.push(`${name}: unreachable`); }
  };
  await ping('assistant', '/agenda-ai', { probe:true });
  await ping('search', '/agenda-search', { probe:true });
  await ping('speech', '/agenda-tts', { probe:true });
  const bad = lines.filter(l => !l.includes(': ok') && !l.includes('configured') && !l.includes('no key'));
  el.textContent = bad.length ? `${bad.length} problem${bad.length>1?'s':''}` : 'all services responding';
  el.className = bad.length ? '' : 'ok';
  btn.disabled = false;
  alert(lines.join('\n'));
});

document.getElementById('audit-show')?.addEventListener('click', () => {
  const rows = ToolAudit.recent();
  alert(rows.length
    ? rows.map(r => `${r.at.slice(11,19)}  ${r.tool}  ${r.ok ? 'ok' : 'FAILED'}  ${r.ms}ms${r.note ? '  ' + r.note : ''}`).join('\n')
    : 'No tools have run yet.');
});
function renderAuditStatus(){
  const el = document.getElementById('audit-status');
  if(!el) return;
  const n = ToolAudit.entries.length;
  const bad = ToolAudit.entries.filter(e => !e.ok).length;
  el.textContent = n ? `${n} call${n>1?'s':''} this session, ${bad} failed` : 'No tools run yet';
}
document.getElementById('confirm-toggle')?.addEventListener('click', () => {
  settings.confirmActions = settings.confirmActions === false;
  saveSettings(); renderConfirmStatus();
});
function renderConfirmStatus(){
  const el = document.getElementById('confirm-status');
  if(el) el.textContent = settings.confirmActions === false
    ? 'Off — voice requests act immediately'
    : 'On — asks before creating anything by voice';
}
// 'change' only fires on blur, so typing an ID and refreshing lost it. These
// save on every keystroke and confirm visibly.
function bindPercent(id, valId, key, def){
  const el = document.getElementById(id), out = document.getElementById(valId);
  if(!el) return;
  const cur = typeof settings[key] === 'number' ? settings[key] : def;
  el.value = cur; if(out) out.textContent = cur + '%';
  TARS[key] = cur;
  el.addEventListener('input', () => {
    const v = +el.value;
    settings[key] = v; TARS[key] = v; saveSettings();
    if(out) out.textContent = v + '%';
  });
}
bindPercent('humour-slider', 'humour-val', 'humour', 70);
bindPercent('honesty-slider', 'honesty-val', 'honesty', 95);

function bindSetting(id, key){
  const el = document.getElementById(id);
  if(!el) return;
  const save = () => {
    settings[key] = el.value.trim();
    saveSettings();
    el.classList.add('saved');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('saved'), 900);
  };
  el.addEventListener('input', save);
  el.addEventListener('blur', save);
}
bindSetting('tts-voice', 'ttsVoiceId');
bindSetting('tts-model', 'ttsModelId');
// last resort: flush anything typed but not yet committed
window.addEventListener('beforeunload', () => { try{ saveSettings(); }catch(e){} });
document.getElementById('tts-test')?.addEventListener('click', async () => {
  await probeTts();
  speak(VOICE.lang.startsWith('pt') ? 'Sistemas prontos.' : 'Systems ready.', VOICE.lang);
});
document.getElementById('sfx-toggle').addEventListener('click', () => {
  settings.muted = !settings.muted; saveSettings();
  document.getElementById('set-sfx-status').textContent = settings.muted ? 'Muted' : 'On';
  updateRainAudio();
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
THEMES.custom = Object.assign({}, THEMES.slate, (JSON.parse(localStorage.getItem(SET_KEY) || '{}').customTheme) || {}, { name:'Custom' });
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




// ===== Client-side encryption ========================================
// AES-256-GCM via the browser's own Web Crypto. The passphrase never leaves
// this device and is never sent anywhere: the server only ever stores
// ciphertext, so a leaked database (or anyone with admin access to it) yields
// nothing readable. The trade-off is blunt and worth stating: lose the
// passphrase and the data is gone — there is no recovery path by design.
const ENC_PREFIX = 'enc:v1:';
let cryptoKey = null;

function bufB64(b){ return btoa(String.fromCharCode(...new Uint8Array(b))); }
function b64Buf(s){ return Uint8Array.from(atob(s), ch => ch.charCodeAt(0)); }

async function encStr(plain){
  if(!cryptoKey || plain == null || plain === '') return plain;
  if(String(plain).startsWith(ENC_PREFIX)) return plain;      // already sealed
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, cryptoKey,
                new TextEncoder().encode(String(plain)));
  return ENC_PREFIX + bufB64(iv) + ':' + bufB64(ct);
}
async function decStr(val){
  if(val == null || typeof val !== 'string' || !val.startsWith(ENC_PREFIX)) return val; // plaintext stays readable
  if(!cryptoKey) return '🔒 locked';
  try{
    const [, , ivB, ctB] = val.split(':');
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: b64Buf(ivB) }, cryptoKey, b64Buf(ctB));
    return new TextDecoder().decode(pt);
  }catch(e){ return '🔒 wrong passphrase'; }
}

// Which fields get sealed. Dates, times, priority and tags stay clear so the
// calendar, sorting and filtering keep working without unlocking first.
const CASE_SECRETS = ['titulo', 'ticket', 'phone'];
const NOTE_SECRETS = ['title', 'content'];

async function sealCase(p){
  if(!cryptoKey) return p;
  const o = { ...p };
  for(const f of CASE_SECRETS) if(o[f]) o[f] = await encStr(o[f]);
  if(Array.isArray(o.notes_log))
    o.notes_log = await Promise.all(o.notes_log.map(async n => ({ ...n, text: await encStr(n.text) })));
  return o;
}
async function openCase(c){
  if(!c) return c;
  const o = { ...c };
  for(const f of CASE_SECRETS) if(o[f]) o[f] = await decStr(o[f]);
  if(Array.isArray(o.notes_log))
    o.notes_log = await Promise.all(o.notes_log.map(async n => ({ ...n, text: await decStr(n.text) })));
  return o;
}
async function sealNote(p){
  if(!cryptoKey) return p;
  const o = { ...p };
  for(const f of NOTE_SECRETS) if(o[f]) o[f] = await encStr(o[f]);
  return o;
}
async function openNoteRec(n){
  if(!n) return n;
  const o = { ...n };
  for(const f of NOTE_SECRETS) if(o[f]) o[f] = await decStr(o[f]);
  return o;
}

// The key is issued by the agenda-vault edge function after login, derived
// server-side from a master secret that lives only in the function environment
// plus a per-user salt in the database. Neither half is in this bundle, so a
// database dump alone cannot decrypt anything. No passphrase to remember.
async function fetchVaultKey(){
  try{
    const r = await fetch(FN_URL + "/agenda-vault", { method: "POST", headers: authHeaders() });
    if(!r.ok) return false;
    const { key } = await r.json();
    if(!key) return false;
    cryptoKey = await crypto.subtle.importKey('raw', b64Buf(key),
                  { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
    settings.encOn = true; saveSettings();
    return true;
  }catch(e){ return false; }
}
function lockVault(){ cryptoKey = null; loadCases(); loadNotes(); renderEncStatus(); }


// ===== Rain ambience =================================================
// Decoded through Web Audio rather than <audio loop>, because MP3 encoder
// padding leaves an audible gap at the loop point; an AudioBufferSourceNode
// with loop=true is sample-accurate. Files are fetched only when it starts
// raining, so a dry day downloads nothing.
const RAIN_TRACKS = {
  light:  { url: '/rain-light.mp3',  gain: 0.55 },
  steady: { url: '/rain-steady.mp3', gain: 0.75 },
  storm:  { url: '/rain-storm.mp3',  gain: 0.85 },
};
const THUNDER_URL = '/thunder.mp3';
// Roughly 3 on a 15-point dial — present, never in the way.
const RAIN_BASE_VOL = 0.20;

let rainBuffers = {}, rainNode = null, rainGain = null, rainTrackName = null;
let thunderBuf = null, thunderTimer = null, rainAudioReady = false;

function rainTrackFor(mm){
  if(mm <= 0.05) return null;
  if(mm < 3) return 'light';
  if(mm < 14) return 'steady';
  return 'storm';
}
async function loadBuffer(url){
  const ctx = ac(); if(!ctx) return null;
  const r = await fetch(url);
  if(!r.ok) throw new Error('missing ' + url);
  return ctx.decodeAudioData(await r.arrayBuffer());
}
function stopRainAudio(){
  if(rainNode){ try{ rainNode.stop(); }catch(e){} rainNode.disconnect(); rainNode = null; }
  if(thunderTimer){ clearTimeout(thunderTimer); thunderTimer = null; }
  rainTrackName = null;
}
async function playRainTrack(name, mm){
  const ctx = ac(); if(!ctx) return;
  if(!rainBuffers[name]) rainBuffers[name] = await loadBuffer(RAIN_TRACKS[name].url);
  const buf = rainBuffers[name]; if(!buf) return;

  const target = RAIN_BASE_VOL * RAIN_TRACKS[name].gain * (0.7 + Math.min(1, mm / 30) * 0.5);

  if(rainNode && rainTrackName === name){          // same track, just re-level
    rainGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 1.2);
    return;
  }
  const old = rainNode, oldGain = rainGain;
  rainGain = ctx.createGain();
  rainGain.gain.setValueAtTime(0.0001, ctx.currentTime);
  rainGain.connect(ctx.destination);
  rainNode = ctx.createBufferSource();
  rainNode.buffer = buf; rainNode.loop = true;
  rainNode.connect(rainGain);
  rainNode.start();
  rainTrackName = name;
  rainGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 1.6);   // fade in
  if(old && oldGain){                                                      // crossfade out
    oldGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.6);
    setTimeout(() => { try{ old.stop(); }catch(e){} old.disconnect(); }, 1800);
  }
}
async function scheduleThunder(mm){
  if(thunderTimer) clearTimeout(thunderTimer);
  if(mm < 14) return;                                   // only in a real storm
  const ctx = ac(); if(!ctx) return;
  const wait = 25000 + Math.random() * 55000;           // every 25-80s
  thunderTimer = setTimeout(async () => {
    try{
      if(!thunderBuf) thunderBuf = await loadBuffer(THUNDER_URL);
      if(thunderBuf && !settings.muted && !document.hidden){
        const g = ctx.createGain();
        g.gain.value = RAIN_BASE_VOL * 0.85;
        g.connect(ctx.destination);
        const s = ctx.createBufferSource();
        s.buffer = thunderBuf; s.connect(g); s.start();
      }
    }catch(e){}
    scheduleThunder(rainMMNow());
  }, wait);
}
async function updateRainAudio(){
  const mm = rainMMNow();
  const want = settings.muted || document.hidden ? null : rainTrackFor(mm);
  if(!want){ stopRainAudio(); return; }
  if(!rainAudioReady) return;      // waiting on the first user gesture
  try{ await playRainTrack(want, mm); scheduleThunder(mm); }catch(e){ /* files not hosted yet */ }
}
// Browsers refuse audio before an interaction, so arm on the first one.
['pointerdown','keydown'].forEach(evt =>
  window.addEventListener(evt, () => { rainAudioReady = true; updateRainAudio(); }, { once:true }));

// ===== Rain on the wheel =============================================
// Drop positions are normalised 0-1 so the same field can be drawn onto both
// the wheel and the Settings preview, whatever their sizes.
let rainSurfaces = [], rainDrops = [], rainRAF = null, rainMM = 0, rainOverride = null;

function rainProfile(mm){
  if(mm <= 0.05) return null;
  const i = Math.min(1, mm / 30);
  return { count: Math.round(14 + i * 150), speed: 0.010 + i * 0.034,
           len: 0.05 + i * 0.16, slant: i * 0.010,
           alpha: 0.12 + i * 0.30, width: 0.8 + i * 1.0 };
}
function rainMMNow(){ return rainOverride !== null ? rainOverride : rainMM; }

function rainAttach(){
  rainSurfaces = ['rain-layer', 'rain-preview']
    .map(id => document.getElementById(id))
    .filter(Boolean)
    .map(el => ({ el, ctx: el.getContext('2d') }));
}
function rainSize(){
  rainSurfaces.forEach(({ el }) => {
    const p = el.parentElement;
    const w = p?.clientWidth || el.clientWidth || 0;
    const h = p?.clientHeight || el.clientHeight || 0;
    if(w > 0 && h > 0){ el.width = w; el.height = h; }   // skip while hidden
  });
}
function rainSeed(){
  const p = rainProfile(rainMMNow());
  rainDrops = [];
  if(!p) return null;
  for(let i = 0; i < p.count; i++){
    rainDrops.push({ x: Math.random() * 1.2 - 0.1, y: Math.random(),
                     v: p.speed * (0.65 + Math.random() * 0.7),
                     l: p.len * (0.6 + Math.random() * 0.8),
                     a: p.alpha * (0.5 + Math.random() * 0.7) });
  }
  return p;
}
function rainStep(){
  const p = rainProfile(rainMMNow());
  if(!p){ rainRAF = null; rainSurfaces.forEach(({el,ctx}) => ctx.clearRect(0,0,el.width,el.height)); return; }
  const col = curPhase === 'night' ? '160,200,255' : '190,215,245';
  rainSurfaces.forEach(({ el, ctx }) => {
    if(!el.width || !el.height) return;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.lineCap = 'round'; ctx.lineWidth = p.width;
    rainDrops.forEach(d => {
      const x = d.x * el.width, y = d.y * el.height, l = d.l * el.height;
      ctx.strokeStyle = `rgba(${col},${d.a})`;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + p.slant * el.width, y + l); ctx.stroke();
    });
  });
  rainDrops.forEach(d => {
    d.y += d.v; d.x += p.slant * 0.35;
    if(d.y > 1){ d.y = -d.l; d.x = Math.random() * 1.2 - 0.1; }
    if(d.x > 1.1) d.x = -0.1;
  });
  rainRAF = requestAnimationFrame(rainStep);
}
function setRain(mm){
  if(typeof mm === 'number') rainMM = mm;
  if(!rainSurfaces.length) rainAttach();
  rainSize();
  const p = rainSeed();
  document.querySelector('.arc-wrap')?.classList.toggle('raining', !!p);
  if(p && !rainRAF) rainRAF = requestAnimationFrame(rainStep);
  if(!p && rainRAF){ cancelAnimationFrame(rainRAF); rainRAF = null;
    rainSurfaces.forEach(({el,ctx}) => ctx.clearRect(0,0,el.width,el.height)); }
  updateRainAudio();
}
window.addEventListener('resize', () => setRain());
document.addEventListener('visibilitychange', () => {
  if(document.hidden && rainRAF){ cancelAnimationFrame(rainRAF); rainRAF = null; }
  else if(!document.hidden && !rainRAF && rainProfile(rainMMNow())) rainRAF = requestAnimationFrame(rainStep);
  updateRainAudio();      // silence it in a background tab
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
async function bootApp(){
  if(session){
    showApp();
    await fetchVaultKey();                 // unlock first, then fetch
    loadCases(); loadNotebooks(); loadNotes(); loadWeather();
  } else {
    showLogin();
  }
  syncPhase();
  detectHud();
}
bootApp();