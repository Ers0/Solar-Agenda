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
// toISOString() is UTC, so after 21:00 in Brazil it returns tomorrow — which
// silently pushed evening reminders onto the next day and off today's wheel.
function dateStr(d){ return (d || new Date()).toLocaleDateString('en-CA'); }
function addDays(n){ const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); }
// Blocks follow the clock rather than being assumed.
function blocoForTime(hhmm){
  const h = parseInt(String(hhmm || '').split(':')[0], 10);
  if(isNaN(h)) return 'manha';
  if(h < 9) return 'primeira-hora';
  if(h < 12) return 'manha';
  if(h < 18) return 'tarde';
  return 'fim-do-dia';
}

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
  TarsContext.page = view;
  ["agenda","history","calendar","notebooks","galaxy","settings"].forEach(v => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== view);
    document.getElementById("tab-" + v)?.classList.toggle("active", v === view);
  });
  // keep the mobile bottom bar in sync with the desktop pill tabs
  document.querySelectorAll('.bn-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  try{ renderViewHead(view); }catch(e){};
  // The canvas has no size until its view is visible, so the engine is
  // mounted on first show rather than at load.
  if(view === 'galaxy') requestAnimationFrame(() => { showGalaxy(); });
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
  const out = await readJson(resp);
  if(!out.ok) throw new Error(out.json.error || "Error creating case.");
  return openCase(out.json);
}
async function updateCase(id, payload){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ id, ...(await sealCase(payload)) }) });
  const out = await readJson(resp);
  if(!out.ok) throw new Error(out.json.error || "Error updating case.");
  return openCase(out.json);
}
async function deleteCaseApi(id){
  const resp = await fetch(FN_URL + "/agenda-cases", { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ id }) });
  if(!resp.ok) throw new Error((await resp.json()).error || "Error deleting case.");
}

function prioLabel(p){ return {urgente:'Urgent', alta:'High', media:'Medium', baixa:'Low'}[p] || p; }
function statusRank(s){ return s === 'pending' || !s ? 0 : 1; }
function prioColor(p){ return {urgente:'#e15b4c', alta:'#f2a71b', media:'#4fa3a0', baixa:'#6d7f92'}[p] || '#6d7f92'; }
function blocoLabel(b){ return {'primeira-hora':'First hour', manha:'Morning', tarde:'Afternoon', 'fim-do-dia':'End of day'}[b] || b; }

function render(){ renderFirstHour(); renderBlocks(); renderArc(); try{ Suggest.render(); }catch(e){} updateHudStrip(); }

function todaysCases(){ const t = todayStr(); return cases.filter(c => (c.case_date || t) === t); }
// Anything mis-filed under an old default is placed by its clock time instead,
// so the first-hour panel does not collect the whole day.
function effectiveBloco(c){
  if(c.horario) return blocoForTime(c.horario);
  return c.bloco || 'manha';
}
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
        try{ await updateCase(c.id, { status: 'success', actual_end: nowTime });
          // The record of what happened is captured; any lesson from it is
          // only stored when the user actually states one.
          Learn.addEpisode({ summary: `${c.titulo}${c.ticket ? ' (' + c.ticket + ')' : ''} — resolved. `
            + (c.notes_log || []).map(n => n.text).join(' ').slice(0, 500),
            kind:'case', caseId: c.id, outcome:'resolved' }); c.status = 'success'; c.actual_end = nowTime; }catch(err){ alert(err.message); }
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
  const items = pendingTodaysCases().filter(c => effectiveBloco(c) === 'primeira-hora' || c.prioridade === 'urgente')
                      .sort((a,b) => (a.horario || '').localeCompare(b.horario || ''));
  if(items.length === 0){ list.innerHTML = '<div class="empty">No urgent cases right now. Use the first hour to plan your day.</div>'; return; }
  items.forEach(c => list.appendChild(makeCaseCard(c)));
}
function renderBlocks(){
  const container = document.getElementById('blocks-container');
  container.innerHTML = '';
  const today = pendingTodaysCases();
  ['manha', 'tarde', 'fim-do-dia'].forEach(b => {
    const items = today.filter(c => effectiveBloco(c) === b).sort((a,b2) => (a.horario||'').localeCompare(b2.horario||''));
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
  // The redesign's ring replaces the shallow arc. If it throws for any reason
  // the original renderer below still runs, so the day is never left blank.
  if(settings.dialRing !== false){
    try{ Dial.render(); return; }catch(e){ console.warn('[dial] falling back to the arc', e); }
  }
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
      const isRem = (c2.tags || []).includes('follow-up');
      w.push(`<g class="arc-dot" data-id="${c2.id}">`
        + `<circle cx="${p.x}" cy="${p.y}" r="${isRem ? 6.5 : 5.5}" fill="${isRem ? 'var(--accent3)' : prioColor(c2.prioridade)}" stroke="var(--bg)" stroke-width="2" filter="url(#bloom)"/>`
        // A reminder gets a ring, so it reads differently from a scheduled case.
        + (isRem ? `<circle cx="${p.x}" cy="${p.y}" r="10" fill="none" stroke="var(--accent3)" stroke-width="1.5" stroke-opacity="0.55"/>` : '')
        + `</g>`);
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
  if(id) TarsContext.selectedCaseId = id;
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
  state: 'off', lang: 'en-US', langStreak: 0, active: false, vadTimer: null, sampleTimer: null, bargeStart: 0, greeted: false,
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
  const dock = document.getElementById('tars-dock');
  if(dock && s !== 'off') dock.dataset.state =
    (s === 'idle' ? 'standby' : s === 'wake' ? 'listening' : s);
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

    // Sampling must not depend on requestAnimationFrame: rAF is suspended
    // entirely in a background tab, which silently killed wake-word detection
    // the moment the window lost focus. A timer keeps running when hidden.
    const sample = () => {
      if(VOICE.analyser !== an) return;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for(let i = 0; i < buf.length; i++){ const v = (buf[i] - 128) / 128; sum += v * v; }
      VOICE.level = Math.min(1, Math.sqrt(sum / buf.length) * 4.5);
      if(VOICE.level > VOICE.peakSeen) VOICE.peakSeen = VOICE.level;
      if(!speaking && VOICE.state !== VSTATE.SPEAKING && VOICE.level < VAD.speakThresh){
        VAD.hist.push(VOICE.level);
        if(VAD.hist.length > 240) VAD.hist.shift();
        if(VAD.hist.length % 60 === 0) VAD.recalc();
      }
    };
    clearInterval(VOICE.sampleTimer);
    VOICE.sampleTimer = setInterval(sample, 60);

    // Drawing stays on rAF, since there is nothing to draw when hidden.
    const paint = () => {
      if(VOICE.analyser !== an) return;
      drawOrb();
      requestAnimationFrame(paint);
    };
    paint();
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





// Bare hours are ambiguous. At 18:00, "eight o'clock" almost always means
// 20:00, not tomorrow morning — so an hour that has already passed today is
// read as the PM one when a PM reading exists.
function resolveHour(raw, spokenAt){
  const s = String(raw || '').trim();
  if(!s) return s;
  const now = spokenAt instanceof Date ? spokenAt : new Date();
  const clock = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

  // Relative phrasing. The model routinely passes "5 minutes from now" rather
  // than a clock time; that used to be stored verbatim, which produced a case
  // with an unparseable time that no timer could ever match.
  const rel = s.toLowerCase()
    .match(/(?:in|em|daqui a|dentro de)?\s*(\d+)\s*(min|mins|minute|minutes|minuto|minutos|h|hr|hrs|hour|hours|hora|horas)\b/);
  if(rel && /(from now|now|agora|in |em |daqui|dentro|^\d+\s*(min|h))/i.test(s)){
    const n = parseInt(rel[1], 10);
    const isHour = /^h/.test(rel[2]);
    const d = new Date(now.getTime() + n * (isHour ? 3600000 : 60000));
    return clock(d);
  }
  if(/^(agora|now)$/i.test(s)) return clock(now);
  if(/meia hora|half an hour/i.test(s)) return clock(new Date(now.getTime() + 30 * 60000));

  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?$/i);
  if(!m) return '';                 // unparseable: report failure, never store it
  let h = parseInt(m[1], 10);
  const min = m[2] || '00';
  const suffix = (m[3] || '').toLowerCase();
  if(suffix === 'am') return `${String(h % 12).padStart(2,'0')}:${min}`;
  if(suffix === 'pm') return `${String(h % 12 + 12).padStart(2,'0')}:${min}`;
  if(h > 23) return '';
  if(h > 12) return `${String(h).padStart(2,'0')}:${min}`;
  const nowH = now.getHours() + now.getMinutes() / 60;
  if(h < 12 && h + 12 >= nowH && h < nowH) h += 12;
  return `${String(h).padStart(2,'0')}:${min}`;
}

// Anything stored as a case time must be HH:MM, or the timers cannot see it.
function isClock(t){ return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')); }

// ===== Learning ======================================================
// Episodes are what happened; rules are what was concluded. Kept apart so a
// rule can always be traced to the events behind it, and so a wrong rule can
// be retired without losing the record.
const Learn = {
  rules: [], episodes: [], loaded: false,

  async load(force){
    if(this.loaded && !force) return;
    try{
      const [r1, r2] = await Promise.all([
        fetch(FN_URL + "/agenda-learn?what=rules", { headers: authHeaders() }),
        fetch(FN_URL + "/agenda-learn?what=episodes", { headers: authHeaders() }),
      ]);
      if(r1.ok){
        const d = await r1.json();
        this.rules = await Promise.all((d.rules || []).map(async x => ({ ...x, statement: await decStr(x.statement) })));
      }
      if(r2.ok){
        const d = await r2.json();
        this.episodes = await Promise.all((d.episodes || []).map(async x => ({ ...x, summary: await decStr(x.summary) })));
      }
      this.loaded = true;
      renderLearnStats();
    }catch(e){}
  },

  kw(text){
    return relevantWords(text).slice(0, 20).join(' ');
  },

  async addEpisode({ summary, kind, caseId, outcome, detail }){
    const r = await fetch(FN_URL + "/agenda-learn", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ type:'episode', kind: kind || 'case', case_id: caseId || null,
        summary: await encStr(summary), keywords: this.kw(summary),
        outcome: outcome || null, detail: detail || {} }),
    });
    if(!r.ok) return null;
    const d = await r.json();
    this.loaded = false;
    return d.episode;
  },

  // A new rule that contradicts an existing one is surfaced, not merged.
  findConflict(statement){
    const words = new Set(relevantWords(statement));
    if(!words.size) return null;
    return this.rules.find(r => {
      if(r.status === 'retired') return false;
      const rw = new Set(relevantWords(r.statement));
      const shared = [...words].filter(w => rw.has(w)).length;
      const overlap = shared / Math.max(1, Math.min(words.size, rw.size));
      if(overlap < 0.5) return false;
      // strong topical overlap but opposite polarity reads as a contradiction
      const neg = s => /\b(not|never|n[ãa]o|nunca|isn'?t|does ?n'?t|without|sem)\b/i.test(s);
      return neg(statement) !== neg(r.statement);
    }) || null;
  },

  async addRule({ statement, source, confidence, episodeIds, supersedes, conflictsWith }){
    const r = await fetch(FN_URL + "/agenda-learn", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ statement: await encStr(statement), keywords: this.kw(statement),
        source: source || 'correction', confidence: confidence ?? 60,
        episode_ids: episodeIds || [], supersedes: supersedes || null,
        conflicts_with: conflictsWith || null }),
    });
    if(!r.ok) return null;
    const d = await r.json();
    await this.load(true);
    return d.rule;
  },

  async adjust(id, how){
    const body = { id };
    if(how === 'confirm') body.confirm = true;
    if(how === 'contradict') body.contradict = true;
    if(how === 'retire') body.status = 'retired';
    const r = await fetch(FN_URL + "/agenda-learn", { method:'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    if(r.ok) await this.load(true);
    return r.ok;
  },

  // Only rules relevant to the question, ranked by confidence.
  search(q, limit = 5){
    const words = relevantWords(q);
    if(!words.length || !this.rules.length) return [];
    return this.rules.map(r => {
      const hay = (r.statement + ' ' + (r.keywords || '')).toLowerCase();
      let hits = 0;
      words.forEach(w => { if(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(hay)) hits++; });
      return { r, cov: hits / words.length, score: hits * 10 + r.confidence / 10 };
    }).filter(x => x.cov >= 0.34)
      .sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.r);
  },

  // Similar past cases, for "have I seen this before?".
  similar(q, limit = 3){
    const words = relevantWords(q);
    if(!words.length) return [];
    return this.episodes.map(e => {
      const hay = (e.summary + ' ' + (e.keywords || '')).toLowerCase();
      let hits = 0;
      words.forEach(w => { if(hay.includes(w)) hits++; });
      return { e, cov: hits / words.length };
    }).filter(x => x.cov >= 0.4)
      .sort((a, b) => b.cov - a.cov).slice(0, limit).map(x => x.e);
  },

  brief(q){
    const rs = this.search(q);
    const conflicted = this.rules.filter(r => r.status === 'conflicted');
    const parts = [];
    if(rs.length) parts.push('Learned rules that apply:\n' + rs.map(r =>
      `- ${r.statement} [${r.confidence}% confident, from ${r.source}${r.times_confirmed > 1 ? `, confirmed ${r.times_confirmed}×` : ''}]`).join('\n'));
    if(conflicted.length) parts.push(`${conflicted.length} rule(s) are marked as conflicting and need the user to decide.`);
    const sim = this.similar(q);
    if(sim.length) parts.push('Similar past cases:\n' + sim.map(e =>
      `- ${e.summary.slice(0, 160)}${e.outcome ? ` (${e.outcome})` : ''}`).join('\n'));
    return parts.length ? parts.join('\n') : 'No learned rules match this.';
  },
};
let lastRuleHits = [];

function renderLearnStats(){
  const el = document.getElementById('learn-status');
  if(!el) return;
  const conf = Learn.rules.filter(r => r.status === 'conflicted').length;
  el.textContent = `${Learn.rules.length} rules · ${Learn.episodes.length} episodes`
    + (conf ? ` · ${conf} conflicting` : '');
  el.className = conf ? '' : 'ok';
}



// ===== Self-model ====================================================
// What TARS actually has to work with, computed from real counts rather than
// claimed. Used both to ground confidence and to answer "what do you know?"
// honestly — including the parts it does not.
const SelfModel = {
  // Domains it can genuinely speak to, derived from the knowledge base.
  domains(){
    const tally = {};
    (KB || []).forEach(e => (e.tags || []).forEach(t => {
      const k = String(t).toLowerCase();
      tally[k] = (tally[k] || 0) + 1;
    }));
    return Object.entries(tally).sort((a, b) => b[1] - a[1]);
  },

  coverage(){
    const d = this.domains();
    return {
      kbEntries: (KB || []).length,
      rules: (Learn.rules || []).length,
      conflicted: (Learn.rules || []).filter(r => r.status === 'conflicted').length,
      episodes: (Learn.episodes || []).length,
      memories: (Memory.cache || []).length,
      cases: (cases || []).length,
      strong: d.filter(([, n]) => n >= 3).map(([t]) => t).slice(0, 8),
      thin: d.filter(([, n]) => n === 1).map(([t]) => t).slice(0, 8),
      sources: [...new Set((KB || []).map(e => (e.source || 'manual').split(/[—:]/)[0].trim()))],
    };
  },

  // Honest grounding for a given question: what is actually available, and
  // what is missing. This is what stops confident answers from thin air.
  assess(question){
    const kbHits = kbSearch(question, 4);
    const ruleHits = Learn.search(question, 4);
    const past = Learn.similar(question, 2);
    const words = relevantWords(question);
    let basis = 'none';
    if(kbHits.length) basis = 'knowledge base';
    else if(ruleHits.length) basis = 'learned experience';
    else if(past.length) basis = 'a similar past case';
    const ceiling = kbHits.length ? 92
      : ruleHits.length ? Math.min(85, Math.max(...ruleHits.map(r => r.confidence)))
      : past.length ? 60 : 40;
    return { basis, ceiling, kb: kbHits.length, rules: ruleHits.length, past: past.length, words };
  },

  brief(question){
    const a = this.assess(question);
    const c = this.coverage();
    const bits = [
      `Grounding for this question: ${a.basis}`
        + (a.kb ? ` (${a.kb} knowledge entries` : '')
        + (a.rules ? `${a.kb ? ', ' : ' ('}${a.rules} learned rules` : '')
        + (a.past ? `${a.kb || a.rules ? ', ' : ' ('}${a.past} similar cases` : '')
        + (a.kb || a.rules || a.past ? ')' : '') + '.',
      `Do not claim more than ${a.ceiling}% confidence on this.`,
    ];
    if(a.basis === 'none')
      bits.push('You have NOTHING stored on this. Say so plainly and answer from general reasoning, clearly labelled as such — or offer to search the web.');
    if(c.conflicted) bits.push(`${c.conflicted} learned rule(s) are in conflict.`);
    return bits.join(' ');
  },

  // Straight answer to "what do you know / what are you unsure about".
  report(){
    const c = this.coverage();
    return [
      `Knowledge: ${c.kbEntries} entries from ${c.sources.length} source(s) — ${c.sources.slice(0, 4).join(', ')}.`,
      `Learned: ${c.rules} rules${c.conflicted ? ` (${c.conflicted} conflicting)` : ''}, ${c.episodes} recorded episodes.`,
      `Personal: ${c.memories} remembered facts. History: ${c.cases} cases.`,
      c.strong.length ? `Strongest on: ${c.strong.join(', ')}.` : 'No topic has enough entries to be a strength yet.',
      c.thin.length ? `Thin on: ${c.thin.join(', ')} — one entry each.` : null,
    ].filter(Boolean).join(' ');
  },
};
let lastAssessment = null;

// ===== Reflection ====================================================
// Periodically inspects its own knowledge and proposes improvements. It
// never edits anything itself: every proposal waits for a decision.
const Reflect_ = {
  proposals: [],
  lastRun: 0,

  async run(){
    this.lastRun = Date.now();
    const p = [];
    const c = SelfModel.coverage();

    // 1. Conflicting rules need a human decision, not a guess.
    (Learn.rules || []).filter(r => r.status === 'conflicted').forEach(r => {
      p.push({ kind:'conflict', text:`Rule in conflict: "${r.statement}"`,
               action:'Decide which version holds.', ref:r.id });
    });

    // 2. Rules that have never been reconfirmed since being learned.
    (Learn.rules || []).filter(r => r.times_confirmed <= 1 && r.confidence < 70
      && Date.now() - Date.parse(r.created_at) > 14 * 86400000).forEach(r => {
      p.push({ kind:'stale', text:`"${r.statement}" was learned once and never confirmed since.`,
               action:'Confirm or retire it.', ref:r.id });
    });

    // 3. Repeated case subjects with no knowledge entry behind them.
    const subj = {};
    (cases || []).forEach(x => {
      const k = String(x.titulo || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/).filter(w => w.length > 4).slice(0, 2).join(' ');
      if(k) subj[k] = (subj[k] || 0) + 1;
    });
    Object.entries(subj).filter(([, n]) => n >= 3).forEach(([k, n]) => {
      if(!kbSearch(k, 1).length)
        p.push({ kind:'gap', text:`"${k}" has come up in ${n} cases but has no knowledge entry.`,
                 action:'Worth writing one.' });
    });

    // 4. Knowledge that connects to nothing.
    if(Galaxy.ready && (Galaxy.orphans || []).length >= 5){
      p.push({ kind:'orphan', text:`${Galaxy.orphans.length} entries are unlinked.`,
               action:'Tagging them would make retrieval better.' });
    }

    // 5. Outcomes recorded but never turned into a rule.
    const unlearned = (Learn.episodes || []).filter(e => e.outcome === 'resolved').length
                    - (Learn.rules || []).filter(r => r.source === 'observation').length;
    if(unlearned >= 5)
      p.push({ kind:'unlearned', text:`${unlearned} resolved cases have not produced any rule.`,
               action:'Tell me what the pattern was and I will store it.' });

    this.proposals = p;
    renderReflection();
    return p;
  },

  brief(){
    if(!this.proposals.length) return 'Nothing to propose.';
    return this.proposals.slice(0, 6).map(x => `- ${x.text} ${x.action}`).join('\n');
  },
};

function renderReflection(){
  const el = document.getElementById('reflect-status');
  if(!el) return;
  const n = Reflect_.proposals.length;
  el.textContent = n ? `${n} suggestion${n > 1 ? 's' : ''}` : 'nothing to suggest';
  el.className = n ? '' : 'ok';
}


// ===== Background findings ===========================================
// A scheduled scan runs server-side twice a day, so things are noticed while
// the app is closed. It works only on unencrypted fields — dates, times,
// priority — because case titles are encrypted and the server genuinely
// cannot read them. Names are resolved here, on the client, at render time.
const Background = {
  items: [],

  async load(scanNow){
    try{
      const r = await fetch(FN_URL + "/agenda-cron", {
        method:'POST', headers: authHeaders(),
        body: JSON.stringify(scanNow ? { scanNow:true } : {}),
      });
      if(!r.ok) return [];
      const d = await r.json();
      this.items = d.notifications || [];
      return this.items;
    }catch(e){ return []; }
  },

  async ack(){
    this.items = [];
    try{ await fetch(FN_URL + "/agenda-cron", { method:'POST', headers: authHeaders(), body: JSON.stringify({ ack:true }) }); }catch(e){}
  },

  // Turn a server finding into a sentence, filling in the name locally.
  describe(n){
    const p = n.payload || {};
    const nameOf = id => {
      const cse = cases.find(x => x.id === id);
      return cse ? `"${cse.titulo}"` : 'a case';
    };
    switch(n.kind){
      case 'carried_urgent':
        return `${nameOf(p.case_id)} has been urgent and open since ${p.since}.`;
      case 'backlog':
        return `${p.count} cases are still open from earlier days, the oldest from ${p.oldest}.`;
      case 'day_ahead':
        return `${p.count} case${p.count > 1 ? 's' : ''} today${p.urgent ? `, ${p.urgent} urgent` : ''}`
             + `, first at ${p.first_at}${p.first_id ? ` — ${nameOf(p.first_id)}` : ''}.`;
      case 'stalled_focus': {
        const f = (Focus.all || []).find(x => x.id === p.focus_id);
        return `${f ? f.label : 'A thread'} has been waiting ${p.days} days`
             + (f?.waiting_on ? ` on ${f.waiting_on}` : '') + '.';
      }
      case 'rule_conflict':
        return `${p.count} learned rule${p.count > 1 ? 's' : ''} still contradict each other.`;
      default: return null;
    }
  },

  // Fold them into the proactive queue rather than inventing a second channel.
  feed(){
    this.items.forEach(n => {
      const text = this.describe(n);
      if(!text) return;
      Proactive.raise({ type:'bg_' + n.kind, ref:n.ref, level: Math.min(LEVEL.GENTLE, n.level), text });
    });
  },
};


// Notification usefulness. A kind the user always ignores drifts down a level;
// one they act on drifts up. Bounded, so it can never silence something
// urgent entirely or turn a footnote into an interruption.
const NoteLearn = {
  get stats(){ return settings.noteStats || (settings.noteStats = {}); },
  seen(kind){
    const s = this.stats[kind] || (this.stats[kind] = { shown:0, acted:0 });
    s.shown++; saveSettings();
  },
  acted(kind){
    const s = this.stats[kind] || (this.stats[kind] = { shown:0, acted:0 });
    s.acted++; saveSettings();
  },
  // -1 quieter, 0 unchanged, +1 louder
  bias(kind){
    const s = this.stats[kind];
    if(!s || s.shown < 5) return 0;              // not enough evidence yet
    const rate = s.acted / s.shown;
    if(rate <= 0.1) return -1;
    if(rate >= 0.5) return 1;
    return 0;
  },
  report(){
    const rows = Object.entries(this.stats).filter(([, s]) => s.shown >= 3);
    if(!rows.length) return 'Not enough history yet to judge which alerts are useful.';
    return rows.map(([k, s]) =>
      `${k}: shown ${s.shown}, acted on ${s.acted} (${Math.round(s.acted / s.shown * 100)}%)`).join('\n');
  },
};


// ===== Due-soon watch ================================================
// The ten-minute scan is far too coarse for a reminder, and it only ever
// looked backwards — nothing detected an approaching item, so a reminder set
// for five minutes' time could never fire. This runs every 20 seconds and
// looks forward.
const DueWatch = {
  timer: null,
  fired: new Set(),          // key per item per day, so it speaks once

  minutesUntil(c){
    if(!c.horario || c.case_date !== todayStr()) return null;
    const [h, m] = c.horario.split(':').map(Number);
    if(isNaN(h)) return null;
    const now = new Date();
    return (h * 60 + (m || 0)) - (now.getHours() * 60 + now.getMinutes());
  },

  check(){
    if(!session || settings.proactiveLevel === 'off') return;
    const today = todayStr();
    todaysCases().filter(c => statusRank(c.status) === 0).forEach(c => {
      const mins = this.minutesUntil(c);
      if(mins === null) return;
      const lead = typeof c.lead_minutes === 'number' ? c.lead_minutes
                 : (c.tags || []).includes('follow-up') ? 10 : 15;
      const key = c.id + ':' + today;

      // Fire once as it enters the lead window, and once if it goes past.
      if(mins <= lead && mins >= -1 && !this.fired.has(key)){
        this.fired.add(key);
        const isReminder = (c.tags || []).includes('follow-up');
        const when = mins <= 0 ? 'now' : `in ${mins} minute${mins === 1 ? '' : 's'}`;
        Proactive.raise({
          type: isReminder ? 'reminder' : 'due_soon',
          ref: c.id,
          level: c.prioridade === 'urgente' ? LEVEL.URGENT : LEVEL.ACTIVE,
          text: `${isReminder ? 'Reminder' : 'Coming up'} ${when}: ${c.titulo}`
              + (c.horario ? ` at ${c.horario}.` : '.'),
        });
      }
      const lateKey = key + ':late';
      // Proactive.scan has its own overdue rule; without this the same case
      // was announced twice in slightly different words.
      Proactive.seen.add(`overdue:${c.id}:${new Date().toDateString()}`);
      if(mins < -20 && !this.fired.has(lateKey)){
        this.fired.add(lateKey);
        Proactive.raise({ type:'overdue_now', ref:c.id, level: LEVEL.GENTLE,
          text: `${c.titulo} was due at ${c.horario} and is still open.` });
      }
    });
  },

  start(){
    // With the orbital engine mounted, the old loop would clear its frames.
    if(typeof GalaxyView !== 'undefined' && GalaxyView.api) return;
    if(this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), 20000);
  },
  stop(){ clearInterval(this.timer); this.timer = null; },
};

// ===== Proactive engine ==============================================
// Detects things worth saying, then decides how loudly to say them. The
// interruption level is deliberately conservative: most findings wait until
// asked, because an assistant that interrupts constantly gets muted.
const LEVEL = { SILENT:0, AMBIENT:1, GENTLE:2, ACTIVE:3, URGENT:4 };

const Proactive = {
  seen: new Set(),          // event keys already raised
  queue: [],                // findings not yet surfaced
  timer: null,
  lastRunAt: 0,

  key(e){ return `${e.type}:${e.ref || ''}:${new Date().toDateString()}`; },

  // --- detection ------------------------------------------------------
  // Every rule reads real data. Nothing here invents a reason to speak.
  scan(){
    const out = [];
    const now = new Date();
    const hh = now.getHours() + now.getMinutes() / 60;
    const today = todayStr();

    // 1. Urgent case still open late in the working day.
    pendingTodaysCases().filter(c => c.prioridade === 'urgente').forEach(c => {
      if(hh >= 16) out.push({
        type:'urgent_open', ref:c.id, level:LEVEL.ACTIVE,
        text:`"${c.titulo}" is still urgent and still open, and it is past four.`,
        action:{ tool:'open_case', args:{ query: c.ticket || c.titulo } },
      });
    });

    // 2. A scheduled case whose start time has passed.
    pendingTodaysCases().filter(c => c.horario).forEach(c => {
      const [h, m] = c.horario.split(':').map(Number);
      const due = h + (m || 0) / 60;
      if(hh > due + 0.5) out.push({
        type:'overdue', ref:c.id, level:LEVEL.GENTLE,
        text:`"${c.titulo}" was set for ${c.horario} and has not been closed.`,
        action:{ tool:'open_case', args:{ query: c.ticket || c.titulo } },
      });
    });

    // 3. A focus parked on someone else for too long.
    (Focus.all || []).filter(f => f.status === 'waiting' && f.waiting_on).forEach(f => {
      const days = (Date.now() - Date.parse(f.updated_at)) / 86400000;
      if(days >= 2) out.push({
        type:'stalled', ref:f.id, level:LEVEL.GENTLE,
        text:`${f.label} has been waiting on ${f.waiting_on} for ${Math.floor(days)} days.`,
      });
    });

    // 4. The same client recurring — a pattern worth naming.
    const byClient = {};
    cases.forEach(c => {
      const k = String(c.titulo || '').toLowerCase().split(/[—-]/)[0].trim().slice(0, 24);
      if(k.length > 3) (byClient[k] = byClient[k] || []).push(c);
    });
    // One representative pattern is enough; the rest are noise.
    Object.entries(byClient).sort((a, b) => b[1].length - a[1].length).slice(0, 1).forEach(([k, list]) => {
      const recent = list.filter(c => (Date.now() - Date.parse(c.case_date || 0)) < 30 * 86400000);
      if(recent.length >= 3) out.push({
        type:'repeat_client', ref:k, level:LEVEL.AMBIENT,
        text:`${recent.length} cases for "${k}" in the last month — possibly one underlying fault rather than three.`,
      });
    });

    // 5. Weather that affects a site visit.
    if(wxSnapshot && wxSnapshot.rain >= 10 && pendingTodaysCases().length){
      out.push({ type:'weather', ref:today, level:LEVEL.AMBIENT,
        text:`${wxSnapshot.rain.toFixed(0)} mm of rain forecast today — worth checking before any roof work.` });
    }

    // 6. Knowledge that never got connected to anything.
    if(Galaxy.ready && (Galaxy.orphans || []).length >= 8){
      out.push({ type:'orphans', ref:'kb', level:LEVEL.AMBIENT,
        text:`${Galaxy.orphans.length} knowledge entries are unlinked to anything else.` });
    }

    // 7b. Reflection findings, held at ambient so they never interrupt.
    if(Reflect_.proposals.length >= 3) out.push({
      type:'reflection', ref:'kb', level:LEVEL.AMBIENT,
      text:`${Reflect_.proposals.length} improvements to the knowledge base are worth a look.`,
      action:{ tool:'reflect', args:{} },
    });

    // 7. Rules that disagree and need a decision.
    const conflicted = (Learn.rules || []).filter(r => r.status === 'conflicted');
    if(conflicted.length) out.push({
      type:'rule_conflict', ref:'rules', level:LEVEL.GENTLE,
      text:`${conflicted.length} learned rule${conflicted.length > 1 ? 's' : ''} contradict each other and need your decision.`,
      action:{ tool:'review_rules', args:{ only_conflicts:true } },
    });

    return out.filter(e => !this.seen.has(this.key(e)));
  },

  // --- surfacing ------------------------------------------------------
  raise(e){
    this.seen.add(this.key(e));
    const pref = settings.proactiveLevel || 'normal';
    if(pref === 'off') return;
    // The setting can only ever lower the volume, never raise it above what
    // the finding itself justifies.
    if(pref === 'quiet' && e.level < LEVEL.ACTIVE) e.level = LEVEL.AMBIENT;
    if(pref === 'high' && e.level === LEVEL.AMBIENT) e.level = LEVEL.GENTLE;
    // Evidence from past behaviour nudges the level within safe bounds.
    const bias = NoteLearn.bias(e.type);
    if(bias < 0 && e.level > LEVEL.AMBIENT) e.level -= 1;
    if(bias > 0 && e.level < LEVEL.ACTIVE) e.level += 1;
    NoteLearn.seen(e.type);
    if(e.level <= LEVEL.SILENT) return;

    if(e.level === LEVEL.AMBIENT){
      // Held until asked, or shown in the morning brief.
      this.queue.push(e);
      renderProactiveDot();
      return;
    }
    if(e.level === LEVEL.GENTLE){
      this.queue.push(e);
      TarsPresence.notify(e.text, 'silent');
      renderProactiveDot();
      return;
    }
    if(e.level === LEVEL.ACTIVE){
      TarsPresence.notify(e.text, 'speak');
      return;
    }
    TarsPresence.notify(e.text, 'urgent');
  },

  run(){
    if(!session) return;
    this.lastRunAt = Date.now();
    const found = this.scan();
    // At most one spoken interruption per cycle, highest level first.
    found.sort((a, b) => b.level - a.level);
    let spoke = false;
    found.forEach(e => {
      if(e.level >= LEVEL.ACTIVE && spoke){ e.level = LEVEL.GENTLE; }
      if(e.level >= LEVEL.ACTIVE) spoke = true;
      this.raise(e);
    });
  },

  start(){
    if(this.timer || settings.proactive === false) return;
    // A first pass shortly after load, then every ten minutes.
    setTimeout(() => this.run(), 20000);
    this.timer = setInterval(() => this.run(), 10 * 60 * 1000);
  },
  stop(){ clearInterval(this.timer); this.timer = null; },

  pending(){ return this.queue.slice(); },
  clear(){ this.queue = []; renderProactiveDot(); },

  // Everything held back, as one summary.
  brief(){
    if(!this.queue.length) return 'Nothing outstanding.';
    return this.queue.map(e => '- ' + e.text).join('\n');
  },
};

function renderProactiveDot(){
  const b = document.getElementById('tars-badge');
  if(!b) return;
  const n = Proactive.queue.length;
  b.hidden = n === 0;
  b.textContent = n > 9 ? '9+' : String(n);
}

// ===== Focus mode ====================================================
// Structured working state rather than conversation history. Survives a
// reload, so unfinished work can be resumed rather than re-explained.
const Focus = {
  current: null,
  all: [],

  async load(){
    try{
      const r = await fetch(FN_URL + "/agenda-focus", { headers: authHeaders() });
      if(!r.ok) return;
      const d = await r.json();
      // Labels and objectives can name clients, so they travel encrypted.
      this.all = await Promise.all((d.focuses || []).map(async f => ({
        ...f,
        label: await decStr(f.label),
        objective: f.objective ? await decStr(f.objective) : null,
      })));
      this.current = this.all.find(f => f.status === 'active') || null;
      renderFocusBar();
    }catch(e){}
  },

  async start(label, opts){
    const payload = {
      label: await encStr(label),
      objective: opts?.objective ? await encStr(opts.objective) : null,
      case_id: opts?.caseId || null,
      subtasks: opts?.subtasks || [],
      facts: opts?.facts || {},
    };
    const r = await fetch(FN_URL + "/agenda-focus", {
      method:'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    if(!r.ok) return null;
    const d = await r.json();
    await this.load();
    return this.current;
  },

  async update(patch){
    if(!this.current) return null;
    const body = { id: this.current.id, ...patch };
    if(body.label) body.label = await encStr(body.label);
    if(body.objective) body.objective = await encStr(body.objective);
    const r = await fetch(FN_URL + "/agenda-focus", {
      method:'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    if(!r.ok) return null;
    await this.load();
    return this.current;
  },

  async tick(text, done){
    if(!this.current) return false;
    const subs = (this.current.subtasks || []).slice();
    const i = subs.findIndex(s => s.text.toLowerCase().includes(String(text).toLowerCase()));
    if(i === -1) return false;
    subs[i] = { ...subs[i], done: done !== false, at: new Date().toISOString() };
    await this.update({ subtasks: subs });
    return true;
  },

  // Compact enough to sit in every prompt without eating the budget.
  brief(){
    const f = this.current;
    if(!f) return 'No active focus.';
    const subs = (f.subtasks || []);
    const doneN = subs.filter(s => s.done).length;
    const next = subs.find(s => !s.done);
    return [
      `ACTIVE FOCUS: ${f.label}`,
      f.objective ? `Objective: ${f.objective}` : null,
      subs.length ? `Progress: ${doneN}/${subs.length}. ` +
        subs.map(s => `${s.done ? '[x]' : '[ ]'} ${s.text}`).join(' · ') : null,
      next ? `Next step: ${next.text}` : (subs.length ? 'All steps done.' : null),
      f.waiting_on ? `Waiting on: ${f.waiting_on}` : null,
      f.due_at ? `Due: ${new Date(f.due_at).toLocaleString('en-GB')}` : null,
      Object.keys(f.facts || {}).length ? `Known: ${JSON.stringify(f.facts).slice(0, 300)}` : null,
    ].filter(Boolean).join('\n');
  },

  // Anything parked and still open, for the resumption line at startup.
  pending(){
    return this.all.filter(f => f.status === 'waiting' ||
      (f.status === 'active' && (f.subtasks || []).some(s => !s.done)));
  },
};

function renderFocusBar(){
  const bar = document.getElementById('focus-bar');
  if(!bar) return;
  const f = Focus.current;
  if(!f){ bar.classList.add('hidden'); return; }
  const subs = f.subtasks || [];
  const doneN = subs.filter(s => s.done).length;
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="fb-tag">FOCUS</span>
    <span class="fb-label">${escapeHtml(f.label)}</span>
    ${subs.length ? `<span class="fb-prog"><span style="width:${Math.round(doneN/subs.length*100)}%"></span></span>
      <span class="fb-count">${doneN}/${subs.length}</span>` : ''}
    ${f.waiting_on ? `<span class="fb-wait">waiting: ${escapeHtml(f.waiting_on)}</span>` : ''}
    <button class="fb-open" id="fb-open" title="Show steps">▾</button>
    <button class="fb-end" id="fb-end" title="End focus">✕</button>`;
  bar.querySelector('#fb-end').addEventListener('click', async () => {
    await Focus.update({ status:'done' }); Focus.current = null; renderFocusBar(); SFX.tick();
  });
  bar.querySelector('#fb-open').addEventListener('click', () => {
    const f2 = Focus.current; if(!f2) return;
    alert([f2.label, f2.objective ? '\nObjective: ' + f2.objective : '',
      '\n' + (f2.subtasks || []).map(s => `${s.done ? '✓' : '○'} ${s.text}`).join('\n')].join(''));
  });
}


// Chrome throttles timers in hidden tabs to roughly once a minute after five
// minutes — far too slow for voice detection. A tab that is producing audio is
// exempt, so voice mode holds an effectively inaudible tone open. It is a
// deliberate trade: the tab shows the small "playing audio" icon while TARS is
// listening. Stopped as soon as voice mode is switched off.
let keepAliveNode = null, keepAliveGain = null;
function startKeepAlive(){
  const ctx = acAlways();
  if(!ctx || keepAliveNode) return;
  try{
    keepAliveNode = ctx.createOscillator();
    keepAliveGain = ctx.createGain();
    keepAliveNode.frequency.value = 30;      // below normal hearing at this level
    keepAliveGain.gain.value = 0.0008;       // audible to the browser, not to you
    keepAliveNode.connect(keepAliveGain).connect(ctx.destination);
    keepAliveNode.start();
  }catch(e){ keepAliveNode = null; }
}
function stopKeepAlive(){
  try{ keepAliveNode && keepAliveNode.stop(); }catch(e){}
  try{ keepAliveNode && keepAliveNode.disconnect(); keepAliveGain && keepAliveGain.disconnect(); }catch(e){}
  keepAliveNode = null; keepAliveGain = null;
}

// ===== Persistent TARS ===============================================
// TARS starts with the application and sits in a passive state. The wake word
// is matched locally on short transcripts; the full pipeline only engages
// after it fires, so audio is never streamed continuously to a paid service.
const TarsPresence = {
  autostart: true,
  started: false,

  async init(){
    if(this.started || !session) return;
    this.started = true;
    const dock = document.getElementById('tars-dock');
    if(dock) dock.dataset.state = 'standby';
    // Browsers require a gesture before microphone access, so passive
    // listening arms on the first interaction rather than failing silently.
    if(settings.tarsAutoListen === false) return;
    const arm = async () => {
      if(VOICE.active) return;
      try{ await startVoice({ quiet: true }); }catch(e){}
    };
    ['pointerdown','keydown'].forEach(ev =>
      window.addEventListener(ev, arm, { once: true }));
  },

  setState(s){
    const dock = document.getElementById('tars-dock');
    if(dock) dock.dataset.state = s;
  },

  // Proactive surface: TARS initiated this, and the dock says so.
  notify(text, level){
    const badge = document.getElementById('tars-badge');
    if(badge){ badge.hidden = false; badge.textContent = '!'; }
    this.setState('alert');
    addProactiveMessage(text);
    if(level === 'speak' || level === 'urgent') speak(text, VOICE.lang);
    if(level === 'urgent') document.getElementById('voice-panel')?.classList.add('open');
  },
  clearBadge(){
    const b = document.getElementById('tars-badge');
    if(b) b.hidden = true;
    if(VOICE.active) this.setState(VOICE.conversing ? 'listening' : 'standby');
  },
};
// The dock shares the bottom-right corner with both panels' controls, so it
// steps aside whenever either is open. :has() covers most browsers; this keeps
// the rest correct.
function syncDockVisibility(){
  const open = document.getElementById('ai-panel')?.classList.contains('open')
            || document.getElementById('voice-panel')?.classList.contains('open');
  const dock = document.getElementById('tars-dock');
  if(dock){ dock.style.opacity = open ? '0' : ''; dock.style.pointerEvents = open ? 'none' : ''; }
}
setInterval(syncDockVisibility, 400);
document.getElementById('tars-dock')?.addEventListener('click', async () => {
  const panel = document.getElementById('voice-panel');
  TarsPresence.clearBadge();
  const held = Proactive.pending();
  if(held.length){
    held.forEach(e => NoteLearn.acted(e.type));
    // Dumping a dozen findings at once is worse than saying nothing; show the
    // few that matter and summarise the rest.
    const top = held.slice(0, 3);
    const rest = held.length - top.length;
    addProactiveMessage(top.map(e => e.text).join('\n')
      + (rest > 0 ? `\n…and ${rest} more. Ask for a briefing to hear them.` : ''));
    Proactive.clear();
  }
  if(!VOICE.active) await startVoice();
  panel?.classList.toggle('open');
});

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
      const out = await readJson(r);
      const err = new Error(TARS.errorFor(out.json.code)); err.code = out.json.code || 'unknown';
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
// Distinguishes three states rather than two: configured, not configured, and
// unknown. A transient network failure used to latch this to "not configured"
// for the rest of the session, which meant the browser voice permanently.
let ttsProbedAt = 0;
async function probeTts(force){
  if(!force && ttsConfigured !== null && Date.now() - ttsProbedAt < 120000) return ttsConfigured;
  try{
    const r = await fetch(FN_URL + "/agenda-tts", { method:'POST', headers: authHeaders(), body: JSON.stringify({ probe:true }) });
    const out = await readJson(r);
    if(!out.ok) throw new Error('probe failed');
    ttsConfigured = !!out.json.configured;
    ttsServerVoice = out.json.voice || null;
    ttsServerModel = out.json.model || null;
    ttsProbedAt = Date.now();
  }catch(e){
    // Unknown, not false — the next attempt tries ElevenLabs again.
    if(ttsConfigured === null) ttsConfigured = null;
  }
  renderTtsStatus();
  return ttsConfigured;
}
let ttsServerVoice = null, ttsServerModel = null, ttsLastEngine = '—', ttsLastError = '';


// Voice has many independent ways to be silent — muted, no permission, a
// suspended audio context, no key, a browser without the API. Guessing between
// them from "nothing happens" is hopeless, so it reports on all of them.
async function voiceDiagnostics(){
  const lines = [];
  lines.push('Recording supported: ' + (VOICE.supported ? 'yes' : 'NO — needs Chrome, Edge or Safari'));
  lines.push('Voice mode: ' + (VOICE.active ? 'running' : 'not started'));
  lines.push('Replies muted: ' + (settings.voiceMuted ? 'YES — this alone makes it silent' : 'no'));

  // Microphone permission, without prompting if the browser can tell us.
  let mic = 'unknown';
  try{
    if(navigator.permissions?.query){
      const st = await navigator.permissions.query({ name:'microphone' });
      mic = st.state;
    }
  }catch(e){}
  lines.push('Microphone permission: ' + mic + (mic === 'denied' ? ' — blocked in the address bar' : ''));

  // A suspended context plays nothing and reads silence from the mic.
  let ctxState = 'not created';
  try{
    const ctx = acAlways();
    if(ctx){
      ctxState = ctx.state;
      if(ctx.state === 'suspended'){
        await ctx.resume();
        ctxState = ctx.state + ' -> ' + ctx.state;
      }
    }
  }catch(e){ ctxState = 'error: ' + (e.name || e); }
  lines.push('Audio engine: ' + ctxState);

  await probeTts(true);
  lines.push('ElevenLabs key: ' + (ttsConfigured === false ? 'not set (browser voice used)'
    : ttsConfigured ? 'set' : 'unknown'));
  lines.push('Last spoke via: ' + (ttsLastEngine || 'nothing yet'));

  const voices = (() => { try{ return speechSynthesis.getVoices().length; }catch(e){ return 0; } })();
  lines.push('Browser voices available: ' + voices + (voices ? '' : ' — the fallback is silent too'));

  const warn = ttsFieldWarning();
  if(warn.length) lines.push('\nField problems:\n- ' + warn.join('\n- '));
  return lines.join('\n');
}

function renderTtsStatus(){
  const el = document.getElementById('tts-status');
  if(!el) return;
  el.textContent = ttsConfigured === null ? 'checking…'
    : ttsConfigured ? `ElevenLabs · last spoke: ${ttsLastEngine}${ttsLastError ? ' · ' + ttsLastError : ''}`
    : 'No key set — using the browser voice';
  el.className = ttsConfigured ? 'ok' : '';
}

// Voice IDs and model IDs are easy to put in the wrong box, and the result is
// a 422 and a fallback voice with no explanation.
function ttsFieldWarning(){
  const v = (settings.ttsVoiceId || '').trim();
  const m = (settings.ttsModelId || '').trim();
  const problems = [];
  if(v && /^eleven_/i.test(v)) problems.push('The voice field holds a model ID (it starts with "eleven_"). Swap the two fields.');
  if(m && !/^eleven_/i.test(m)) problems.push('The model field should start with "eleven_" — e.g. eleven_turbo_v2_5. A voice ID does not belong here.');
  if(v && !/^[A-Za-z0-9]{15,}$/.test(v)) problems.push('That voice ID does not look like an ElevenLabs ID (usually ~20 letters and digits).');
  return problems;
}

async function speak(text, lang){
  if(!text) return;
  if(settings.voiceMuted){
    // Returning silently here is indistinguishable from broken audio, which
    // is exactly how "completely silent" gets reported as a bug.
    ttsLastEngine = 'muted';
    renderTtsStatus();
    console.info('[tts] replies are muted — unmute in the voice panel');
    return;
  }
  if(ttsConfigured === null) await probeTts();
  setVoiceState(VSTATE.SPEAKING);

  // With no key at all, the browser voice is the intended behaviour.
  if(ttsConfigured === false){
    ttsLastEngine = 'browser (no key)';
    renderTtsStatus();
    await speakFallback(text, lang);
    return;
  }

  // A context created before any gesture starts suspended and stays that way,
  // which produces perfect silence with no error anywhere.
  try{ const ctx = acAlways(); if(ctx && ctx.state === 'suspended') await ctx.resume(); }catch(e){}

  try{
    await AudioOut.play(text, lang);
    ttsLastEngine = 'ElevenLabs';
    ttsLastError = '';
    renderTtsStatus();
    return;
  }catch(err){
    const code = err.code || 'unknown';
    // One retry: most failures here are a transient 429 or a dropped stream,
    // and switching voice mid-conversation is worse than a short pause.
    if(code === 'rate_limit' || code === 'unknown' || code === 'network'){
      await new Promise(r => setTimeout(r, 900));
      try{
        await AudioOut.play(text, lang);
        ttsLastEngine = 'ElevenLabs (retried)';
        ttsLastError = '';
        renderTtsStatus();
        return;
      }catch(e2){ /* fall through and report honestly */ }
    }
    // Falling back means a different voice, so say why rather than let it look
    // like the configured voice changed on its own.
    ttsLastError = code === 'tts_auth' ? 'key rejected'
                 : code === 'tts_voice' ? 'voice or model ID invalid'
                 : code === 'rate_limit' ? 'quota or rate limit'
                 : code === 'tts_unconfigured' ? 'no key' : code;
    ttsLastEngine = 'browser (fallback)';
    if(code === 'tts_unconfigured') ttsConfigured = false;
    renderTtsStatus();
    showHeard(`ElevenLabs unavailable (${ttsLastError}) — using the browser voice.`);
    console.error('[tts]', code, err.message);
    await speakFallback(text, lang);
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


// A clip that ends mid-thought is almost always a pause, not a finished
// sentence. Rather than guess from the audio, judge the transcript: hold an
// incomplete utterance briefly and stitch the next one onto it.
const TRAILING = new RegExp(
  '^(' +
  // English conjunctions, prepositions, articles
  'and|or|but|so|because|that|which|who|if|when|while|with|without|for|to|of|in|on|at|by|from|' +
  'the|a|an|my|your|our|is|are|was|were|do|does|did|can|could|would|should|about|into|over|' +
  // Portuguese equivalents
  'e|ou|mas|porque|que|qual|quando|enquanto|com|sem|para|pra|de|do|da|dos|das|em|no|na|por|' +
  'o|os|as|um|uma|meu|minha|seu|sua|é|são|foi|era|pode|deve|sobre'
  + ')$', 'i');

function looksIncomplete(text){
  const t = String(text || '').trim();
  if(!t) return false;
  if(/[.!?…]$/.test(t)) return false;          // clearly terminated
  if(/[,;:]$/.test(t)) return true;            // clearly mid-clause
  const words = t.split(/\s+/);
  const last = words[words.length - 1].replace(/[^\p{L}\p{N}]/gu, '');
  if(TRAILING.test(last)) return true;
  // A lone fragment with no punctuation is usually the start of something.
  if(words.length <= 2 && !/^(yes|no|sim|não|nao|ok|okay|stop|cancel|para)$/i.test(t)) return true;
  return false;
}

let pendingSpeech = '', pendingTimer = null;
const CONTINUE_MS = 3500;      // how long to wait for the rest of a sentence

function flushPending(){
  clearTimeout(pendingTimer); pendingTimer = null;
  const t = pendingSpeech.trim();
  pendingSpeech = '';
  if(t) handleVoiceInput(t);
  else if(VOICE.active) setVoiceState(VOICE.conversing ? VSTATE.LISTENING : VSTATE.IDLE);
}

// Returns true when the text was held back rather than acted on.
function holdIfIncomplete(said){
  const joined = (pendingSpeech ? pendingSpeech + ' ' : '') + said;
  if(looksIncomplete(joined)){
    pendingSpeech = joined;
    showHeard(joined + ' …');
    clearTimeout(pendingTimer);
    // If nothing more arrives, send what there is rather than losing it.
    pendingTimer = setTimeout(flushPending, CONTINUE_MS);
    if(VOICE.active) setVoiceState(VSTATE.LISTENING);
    return true;
  }
  clearTimeout(pendingTimer); pendingTimer = null;
  pendingSpeech = '';
  return false;
}

// --- capture: rolling MediaRecorder segments + Groq Whisper -----------
// ScriptProcessorNode proved unreliable in current Chrome, so capture is back
// on MediaRecorder. Pre-roll is achieved by restarting the recorder on a cycle:
// when speech ends we stop the CURRENT segment, which already contains the
// seconds leading up to it — so the opening syllable is never lost, and every
// blob keeps a valid header.
const VAD = {
  speakThresh: 0.055, silenceThresh: 0.032,
  minSpeechMs: 240, silenceMs: 1300, maxClipMs: 20000,
  // A pause early in a sentence is usually thinking, not finishing, so the
  // window starts generous and tightens once enough has been said.
  silenceEarlyMs: 2000, earlyUntilMs: 2500,
  cycleMs: 5000,
  floor: 0, calibrated: false,
  // A single calibration at startup cannot cope with a room that gets louder.
  // The floor is re-estimated continuously from quiet moments only, and the
  // trigger sits a configurable multiple above it.
  hist: [], sustainMs: 180, loudSince: 0,
  sensitivity: 1,              // 0.6 = forgiving, 1.6 = very sensitive
  recalc(){
    if(this.hist.length < 40) return;
    const q = this.hist.slice().sort((a, b) => a - b);
    const floor = q[Math.floor(q.length * 0.5)] || 0.01;
    this.floor = floor;
    const mult = 4.2 / Math.max(0.5, this.sensitivity);
    this.speakThresh   = Math.max(0.045, floor * mult);
    this.silenceThresh = Math.max(0.024, floor * mult * 0.62);
  },
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
    if(Date.now() - t0 < 1200){ setTimeout(step, 60); return; }
    samples.sort((a, b) => a - b);
    const floor = samples[Math.floor(samples.length * 0.6)] || 0.01;
    VAD.floor = floor;
    VAD.hist = samples.slice();
    VAD.recalc();
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
  setTimeout(step, 60);
}

// Whisper echoes its prompt when the audio is unintelligible, so the hint is
// written as a natural sentence rather than a labelled list.
function sttHint(){
  const names = [...new Set(cases.slice(-20).map(x => x.titulo || '').filter(Boolean))].slice(0, 12);
  // Whisper leans on the prompt for proper nouns, so it carries the terms in
  // both languages the user actually mixes.
  // Whisper hears "Deye" as "D-E" unless the word is in its prompt. The list
  // below is built from what this account actually works with — knowledge base
  // tags, case titles, and anything the user has added by hand — so it grows
  // with the vocabulary rather than being a fixed guess.
  const learned = Vocab.line();
  const base = (learned ? learned + ' ' : '')
    + 'Hey TARS. Suporte técnico de energia solar. Falamos de inversores Deye, Foxess, '
    + 'Growatt, Solis, Hoymiles e Huawei, chamados PAC, garantia, RMA, strings, alarmes, '
    + 'sobretensão, datalogger e monitoramento. Support call about solar inverters, warranty and tickets.';
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
      // Forcing the language locked a conversation into whatever the first
      // utterance detected — so a Portuguese sentence in an English session
      // came back mangled. Whisper only gets a fixed language once two
      // consecutive utterances have agreed on it.
      lang: VOICE.langStreak >= 2 ? VOICE.lang.slice(0, 2) : 'auto',
      prompt: sttHint(),
    }),
  });
  if(!r.ok) throw new Error('transcription failed');
  return r.json();
}

// A one-shot recorder for calibration. The live pipeline streams continuously
// and is driven by voice activity, which is the wrong shape for "say this word
// now", so calibration gets its own short capture.
async function recordClip(ms){
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: type });
  const parts = [];
  rec.ondataavailable = e => { if(e.data && e.data.size) parts.push(e.data); };
  const done = new Promise(res => { rec.onstop = () => res(new Blob(parts, { type })); });
  rec.start();
  await new Promise(r => setTimeout(r, ms || 1800));
  try{ rec.stop(); }catch(e){}
  const blob = await done;
  stream.getTracks().forEach(t => t.stop());
  return blob;
}

async function transcribeClip(blob){
  if(!blob || blob.size < 1200) return '';
  try{
    const d = await transcribe(blob);
    // Raw, deliberately: calibration must see what was actually heard, not a
    // version already corrected by the aliases it is trying to learn.
    return (d.text || '').trim();
  }catch(e){ return ''; }
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
    // Known mishearings are put right before anything acts on the words.
    said = Vocab.correct((d.text || '').trim());
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

  const guess = detected && detected.startsWith('pt') ? 'pt-BR'
              : detected && detected.startsWith('en') ? 'en-US'
              : detectLang(said);
  VOICE.langStreak = (guess === VOICE.lang) ? (VOICE.langStreak || 0) + 1 : 1;
  VOICE.lang = guess;

  if(!VOICE.conversing){
    if(!WakeWord.consider(said)) setVoiceState(VSTATE.IDLE);
    return;
  }
  // Stitch a paused sentence back together before acting on it.
  if(holdIfIncomplete(said)) return;
  handleVoiceInput(pendingSpeech ? pendingSpeech + ' ' + said : said);
}

function vadTick(){
  if(!VOICE.active) return;
  if(!VAD.calibrated) return;   // the interval keeps calling; no rAF needed
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
    // A door slam or a cough is a spike; speech stays up. Requiring the level
    // to hold prevents a noisy room from constantly opening the recorder.
    if(!VAD.loudSince) VAD.loudSince = now;
    if(!speaking && now - VAD.loudSince >= VAD.sustainMs) beginClip();
  } else {
    if(now - lastLoud > 250) VAD.loudSince = 0;
    // Short utterances get the longer window; by the time someone has spoken
    // for a couple of seconds, a pause more often means they are done.
    const spokenFor = now - speechStart;
    const window = spokenFor < VAD.earlyUntilMs ? VAD.silenceEarlyMs : VAD.silenceMs;
    if(speaking && lvl < VAD.silenceThresh && now - lastLoud > window) endClip();
  }
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

async function startVoice(opts){
  if(!VOICE.supported){
    alert('This browser cannot record audio. Chrome, Edge or Safari is required. The typed assistant still works.');
    return;
  }
  if(!opts?.quiet) document.getElementById('voice-panel')?.classList.add('open');
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
  // Holds the tab "audible" so background timers are not throttled to a crawl.
  if(settings.bgListen !== false) startKeepAlive();
  calibrateVAD();
  clearInterval(VOICE.vadTimer);
  VOICE.vadTimer = setInterval(vadTick, 80);
  if(!VOICE.greeted && !opts?.quiet){
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
  // Timers and the keep-alive tone must be released, or a stopped voice mode
  // keeps sampling the microphone and holding the tab audible.
  stopKeepAlive();
  clearTimeout(pendingTimer); pendingTimer = null; pendingSpeech = '';
  clearInterval(VOICE.vadTimer); VOICE.vadTimer = null;
  clearInterval(VOICE.sampleTimer); VOICE.sampleTimer = null;
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
// TARS starting the conversation on its own. Marked so it cannot be mistaken
// for a reply to whatever the user last said.
function addProactiveMessage(text){
  const div = document.createElement('div');
  div.className = 'ai-msg assistant proactive';
  div.innerHTML = `<span class="pro-tag">TARS noticed</span>${escapeHtml(text)}`;
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

// --- request sizing ---------------------------------------------------
// Groq bills tokens per minute, and the tools payload alone was ~2500 tokens
// on every message. Sending only the tools a request could plausibly need
// cuts the common case by roughly two thirds.
const TOOL_HINTS = {
  web_search:      /\b(search|google|look ?up|web|news|current|latest|price|spec|pesquis|busca|procur na web)\b/i,
  find_in_galaxy:  /\b(find|locate|where is|which note|show me the note|encontr|localiz|ach[ae])\b/i,
  remember:        /\b(remember|note that|keep in mind|don'?t forget|lembr|anota que|guarda)\b/i,
  forget:          /\b(forget|delete the memory|esquec|apaga)\b/i,
  look_at_screen:  /\b(screen|look at|see this|what does .* say|read (this|the)|tela|olha|vê isso|ler)\b/i,
  search_email:    /\b(email|mail|reply|replied|inbox|said|wrote|responded|respondeu|e-?mail|caixa)\b/i,
  analyse_email:   /\b(what did .* say|analyse|analyze|response|reply|resposta|o que .* disse)\b/i,
  create_reminder: /\b(remind|reminder|follow.?up|chase|lembr|cobrar|acompanhar)\b/i,
  save_template:   /\b(template|model[oe]|boilerplate|standard (email|message))\b/i,
  use_template:    /\b(send|email|message|template|envi|mandar|manda)\b/i,
  list_templates:  /\b(templates?|model[oe]s)\b/i,
  delete_case:     /\b(delete|remove|erase|apagar?|excluir|deletar|remover)\b/i,
  update_case:     /\b(change|move|reschedule|update|set .* to|mudar?|alterar|remarcar)\b/i,
  add_knowledge:   /\b(save|store|note down|knowledge|remember .*(error|code|fault)|salvar|guardar|anotar|erro)\b/i,
  create_case:     /\b(case|ticket|schedule|appointment|caso|agend|chamado|abrir)\b/i,
  draw_diagram:    /\b(diagram|flow ?chart|draw|sketch|visuali[sz]e|map out|desenh|fluxograma)\b/i,
  read_page:       /\b(this page|summari[sz]e|what.*here|whats on (this|the) page|resum|esta p[aá]gina)\b/i,
  cleanup_page:    /\b(clean ?up|tidy|organi[sz]e|checklist|turn (these|this) into|organiz|limpar)\b/i,
  read_diagram:    /\b(diagram|flow|chart|connect|arrows?|fluxo|diagrama)\b/i,
  search_notes:    /\b(where did I|find (where|the note)|which note|wrote about|anota[çc][ãa]o|onde escrevi|procur)\b/i,
  open_note:       /\b(open (it|that|the note)|show me the note|abre? a nota)\b/i,
  create_notebook: /\b(notebook|folder|caderno|pasta)\b/i,
  create_note:     /\b(note|write down|jot|nota|anota)\b/i,
  check_background: /\b(miss|missed|overnight|while I was|catch me up|happen|perdi|enquanto)\b/i,
  self_report:     /\b(what do you know|how confident|unsure|uncertain|do you know|your knowledge|sabe|confian)\b/i,
  reflect:         /\b(improve|review your|gaps?|reflect|what should we|melhorar|revisar)\b/i,
  get_briefing:    /\b(brief|briefing|plan|good morning|what'?s (up|new|today)|anything I should|resumo|bom dia|novidade)\b/i,
  set_proactivity: /\b(interrupt|proactive|quiet|notify|notifications?|leave me alone|interromp|avisar)\b/i,
  learn_rule:      /\b(wrong|incorrect|not right|isn'?t right|actually|no,|remember that|note that|keep in mind|bear in mind|always|never|correction|it'?s not|rather than|errado|errada|na verdade|sempre|nunca|lembre|anote que|corrig)\b/i,
  recall_experience: /\b(before|similar|last time|usually|typically|seen this|j[aá] vi|parecido|normalmente)\b/i,
  record_outcome:  /\b(resolved|fixed|solved|closed|turned out|resolvi|resolvido|foi o)\b/i,
  review_rules:    /\b(rules?|learned|conflict|regras?|aprendeu)\b/i,
  start_focus:     /\b(working on|work on|focus|let'?s do|start(ing)? (on|with)|trabalhando|foco)\b/i,
  update_focus:    /\b(done|finished|completed|next|missing|waiting|remaining|step|falta|pronto|conclu)\b/i,
  get_focus:       /\b(missing|where were we|status|progress|what'?s left|falta|onde par|andamento)\b/i,
  navigate:        /\b(open|show|go to|take me|navigate|abre|abrir|mostra|v[aá] para)\b/i,
  open_case:       /\b(case|ticket|caso|chamado|open the|abre o|working on|trabalhando)\b/i,
  get_context:     /\b(this|these|it|current|on screen|here|isso|esse|essa|aqui|atual)\b/i,
  set_personality: /\b(humou?r|humor|funny|joke|honest|blunt|settings?|personality|serious|piada|s[eé]rio)\b/i,
  switch_provider: /\b(switch|change|use|running|model|provider|gemini|groq|openai|deepseek|openrouter|reasoning|troca|muda|modelo)\b/i,
};
// Tool selection must consider the conversation, not just the latest line.
// Matching on one message alone meant "create a diagram" offered the tool, and
// the very next reply — "the first one" — took it away again, so TARS
// truthfully reported having no tool halfway through the task.
let recentToolText = [];
let lastOfferedTools = [];
function rememberForTools(text){
  recentToolText.push(String(text || ''));
  if(recentToolText.length > 3) recentToolText.shift();
}

// Some tools must always be reachable. Gating memory and learning behind
// keywords meant a plain correction — "that's not right, it's AC not DC" —
// never reached learn_rule, so TARS answered, accurately, that it could not
// learn from the conversation. The cost of always sending these is small
// against being unable to teach it anything.
const CORE_TOOLS = ['learn_rule', 'remember', 'recall_experience', 'get_context'];

function toolsFor(text){
  // The last few turns count, so a tool stays available while a task is in
  // progress rather than only on the sentence that first named it.
  const t = [String(text || ''), ...recentToolText].join(' \n ');
  const picked = AI_TOOLS.filter(x => {
    const re = TOOL_HINTS[x.function.name];
    return !re || re.test(t);
  });
  // A short follow-up ("yes", "the first one", "try again") carries no
  // keywords but is nearly always continuing the previous request, so the
  // previous turn's tools are kept rather than withdrawn mid-task.
  const brief = String(text || '').trim().split(/\s+/).length <= 6;
  if(!picked.length && brief && lastOfferedTools.length) return lastOfferedTools;

  // Fold in the core set, without duplicating anything already chosen.
  const names = new Set(picked.map(x => x.function.name));
  CORE_TOOLS.forEach(n => {
    if(names.has(n)) return;
    const t = AI_TOOLS.find(x => x.function.name === n);
    if(t) picked.push(t);
  });

  if(picked.length) lastOfferedTools = picked;
  return picked.length ? picked : null;
}

// Rough token estimate. Four characters per token is close enough for a guard.
function estimateTokens(messages, tools){
  const body = JSON.stringify(messages || []).length + JSON.stringify(tools || []).length;
  return Math.ceil(body / 4);
}
const TOKEN_CEILING = 5200;   // well under Groq's per-minute allowance


// A Response body can only be read once; a second read throws "body already
// consumed", which then masks whatever actually went wrong. Every response is
// reduced to a plain object immediately, so the mistake is impossible rather
// than merely avoided.

// An error can arrive as a string, as {message}, or as a database error
// object. `new Error(object)` stringifies to "[object Object]", which tells the
// user nothing — so every error is reduced to readable text here.
function errText(x, fallback){
  if(!x) return fallback || 'Something went wrong.';
  if(typeof x === 'string') return x;
  if(typeof x.message === 'string' && x.message) return x.message;
  if(typeof x.error === 'string') return x.error;
  if(x.error && typeof x.error.message === 'string') return x.error.message;
  try{ return JSON.stringify(x).slice(0, 240); }catch(e){ return fallback || 'Something went wrong.'; }
}

async function readJson(resp){
  let text = '';
  try{ text = await resp.text(); }catch(e){}
  let json = null;
  try{ json = JSON.parse(text); }catch(e){}
  return { ok: resp.ok, status: resp.status, json: json || {}, text };
}

let lastLatency = null, lastModel = null, lastReasoner = false;

// Groq's free tier is per-minute and per-model. A burst of tool calls can
// exhaust it in seconds, so requests are spaced locally rather than being
// fired and rejected — a rejected call costs the same quota as a good one.
const RateGuard = {
  times: [], MAX_PER_MIN: 20, MIN_GAP: 900,
  async wait(){
    const now = Date.now();
    this.times = this.times.filter(t => now - t < 60000);
    if(this.times.length >= this.MAX_PER_MIN){
      const oldest = this.times[0];
      const pause = 60000 - (now - oldest) + 250;
      showHeard(`Pacing requests — ${Math.ceil(pause / 1000)}s`);
      await new Promise(r => setTimeout(r, pause));
      return this.wait();
    }
    const last = this.times[this.times.length - 1];
    if(last && now - last < this.MIN_GAP){
      await new Promise(r => setTimeout(r, this.MIN_GAP - (now - last)));
    }
    this.times.push(Date.now());
  },
  remaining(){
    const now = Date.now();
    this.times = this.times.filter(t => now - t < 60000);
    return Math.max(0, this.MAX_PER_MIN - this.times.length);
  },
};

async function callAiAgent(messages, tools, opts){
  const body = tools && tools.length ? { messages, tools } : { messages };
  Object.assign(body, opts || {});
  let data;
  try{
    await RateGuard.wait();
    const resp = await fetch(FN_URL + "/agenda-ai", { method:"POST", headers: authHeaders(), body: JSON.stringify(body) });
    const out = await readJson(resp);
    data = out.json;
    if(!out.ok){
      const code = data.code || 'unknown';
      console.error('[assistant]', out.status, code, data.error || '', data.detail || '');
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
  lastModel = data.model || null;
  lastReasoner = !!data.reasoner;
  if(data.recovered) console.info('[assistant] recovered:', data.recovered);
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
      const out = await readJson(r);
      if(!out.ok) return { ok:false, error: out.json.error || 'search service returned an error', results:[] };
      return { ok:true, results: out.json.results || [], via: out.json.via, tried: out.json.tried };
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
    name: 'set_personality',
    permission: PERM.LOW,
    description: "Read or change your humour and honesty settings, e.g. 'set your humour to 20 percent', 'what are your settings'. Omit both to just report them.",
    schema: { type:'object', properties:{
      humour:{ type:'number', description:'0 to 100.' },
      honesty:{ type:'number', description:'40 to 100.' } } },
    async execute(args){
      const clamp = (v, lo) => Math.max(lo, Math.min(100, Math.round(v)));
      const changed = [];
      if(typeof args.humour === 'number'){ TARS.humour = settings.humour = clamp(args.humour, 0); changed.push(`humour ${TARS.humour}`); }
      if(typeof args.honesty === 'number'){ TARS.honesty = settings.honesty = clamp(args.honesty, 40); changed.push(`honesty ${TARS.honesty}`); }
      if(!changed.length) return `Humour is ${TARS.humour} percent, honesty ${TARS.honesty} percent.`;
      saveSettings();
      const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
      const lab = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v + '%'; };
      set('humour-slider', TARS.humour); lab('humour-val', TARS.humour);
      set('honesty-slider', TARS.honesty); lab('honesty-val', TARS.honesty);
      return `Set: ${changed.join(', ')} percent. Takes effect from the next message. Acknowledge in one short line.`;
    },
  },
  {
    name: 'switch_provider',
    permission: PERM.LOW,
    description: "Change which AI service does the reasoning, e.g. 'switch to Gemini', 'use Groq again'. Accepted: groq, gemini, openai, deepseek, openrouter. Also use it when the user asks which model you are running.",
    schema: { type:'object', properties:{
      provider:{ type:'string', description:'groq | gemini | openai | deepseek | openrouter. Omit to just report the current one.' },
      model:{ type:'string', description:'Optional specific model id.' } } },
    async execute(args){
      if(!args.provider){
        const cur = await providerStatus(true);
        return `Currently on ${cur.label} using ${cur.model}. Available: `
             + (cur.providers || []).map(p => p.label).join(', ')
             + ((cur.unconfigured || []).length ? `. Not configured: ${cur.unconfigured.map(p => p.label).join(', ')}.` : '');
      }
      const r = await fetch(FN_URL + "/agenda-ai", {
        method:'POST', headers: authHeaders(),
        body: JSON.stringify({ setProvider: args.provider, model: args.model }),
      });
      const out = await readJson(r);
      const d = out.json;
      if(!out.ok){
        if(d.code === 'provider_unconfigured')
          return `${args.provider} has no API key set. Tell the user to add ${d.keyEnv} in Supabase Edge Function secrets. Do not claim the switch happened.`;
        return `Could not switch: ${d.error || 'unknown error'}. Do not claim the switch happened.`;
      }
      providerCache = null;
      renderProviderStatus();
      return `Switched to ${d.label}, model ${d.model}. This takes effect from the next message.`;
    },
  },
  {
    name: 'check_background',
    permission: PERM.READ,
    description: "Check what was noticed while the app was closed — overnight backlog, carried-over urgent work, stalled threads. Use for 'anything happen', 'what did I miss', 'catch me up'.",
    schema: { type:'object', properties:{} },
    async execute(){
      const items = await Background.load(true);
      if(!items.length) return 'Nothing was flagged while you were away.';
      items.forEach(n => NoteLearn.acted('bg_' + n.kind));
      const lines = items.map(n => Background.describe(n)).filter(Boolean);
      await Background.ack();
      return lines.join('\n') + '\nSummarise in two sentences at most.';
    },
  },
  {
    name: 'self_report',
    permission: PERM.READ,
    description: "Report honestly what TARS knows, where it is weak, and what it is uncertain about. Use for 'what do you know', 'how confident are you', 'what are you unsure about'.",
    schema: { type:'object', properties:{
      about:{ type:'string', description:'Optional topic to assess specifically.' } } },
    async execute(args){
      await Learn.load();
      if(args.about){
        const a = SelfModel.assess(args.about);
        return `On "${args.about}": grounded in ${a.basis}. `
          + `${a.kb} knowledge entries, ${a.rules} learned rules, ${a.past} similar past cases. `
          + `Confidence ceiling ${a.ceiling}%. `
          + (a.basis === 'none' ? 'Say plainly that you have nothing stored on this.' : '');
      }
      return SelfModel.report() + ' Summarise this in two or three sentences, and do not overstate it.';
    },
  },
  {
    name: 'reflect',
    permission: PERM.READ,
    description: "Review the knowledge base and learned rules for gaps, conflicts and stale entries, and propose improvements. Use for 'what should we improve', 'review your knowledge'.",
    schema: { type:'object', properties:{} },
    async execute(){
      await Learn.load();
      const p = await Reflect_.run();
      if(!p.length) return 'Nothing to propose — no conflicts, gaps or stale rules found.';
      return `${p.length} suggestion(s):\n` + Reflect_.brief()
        + '\nPresent the two most useful ones only, and ask before changing anything.';
    },
  },
  {
    name: 'get_briefing',
    permission: PERM.READ,
    description: "Give the day's briefing, or report anything TARS noticed but held back. Use for 'what's the plan', 'anything I should know', 'brief me', 'good morning'.",
    schema: { type:'object', properties:{} },
    async execute(){
      const open = pendingTodaysCases();
      const urgent = open.filter(c => c.prioridade === 'urgente');
      const next = open.filter(c => c.horario).sort((a, b) => a.horario.localeCompare(b.horario))[0];
      const parts = [
        open.length ? `${open.length} case${open.length > 1 ? 's' : ''} open today, ${urgent.length} urgent.` : 'Nothing scheduled today.',
        next ? `Next at ${next.horario}: ${next.titulo}.` : null,
        wxSnapshot ? `Weather ${wxSnapshot.tmin}-${wxSnapshot.tmax}°C, ${wxSnapshot.rain.toFixed(1)} mm rain.` : null,
        Focus.current ? `Still in focus: ${Focus.current.label}.` : null,
      ].filter(Boolean);
      const held = Proactive.brief();
      Proactive.clear();
      return parts.join(' ') + (held !== 'Nothing outstanding.' ? `\nAlso noticed:\n${held}` : '')
        + '\nSummarise this in two short sentences; do not read it as a list.';
    },
  },
  {
    name: 'set_proactivity',
    permission: PERM.LOW,
    description: "Change how much TARS interrupts, e.g. 'stop interrupting', 'tell me about urgent things only', 'be more proactive'.",
    schema: { type:'object', properties:{
      level:{ type:'string', enum:['off','quiet','normal','high'], description:'off = never interrupt; quiet = urgent only; normal = default; high = surface everything.' } },
      required:['level'] },
    async execute(args){
      settings.proactiveLevel = args.level;
      settings.proactive = args.level !== 'off';
      saveSettings();
      renderProactiveStatus();
      if(args.level === 'off'){ Proactive.stop(); DueWatch.stop(); } else { Proactive.start(); DueWatch.start(); }
      return `Interruptions set to ${args.level}. Acknowledge in one line.`;
    },
  },
  {
    name: 'learn_rule',
    permission: PERM.LOW,
    description: "Record a correction or a lesson as a durable rule, e.g. when the user says you got something wrong, or 'always do X for Y'. Only when they actually correct or instruct you — never from your own reasoning.",
    schema: { type:'object', properties:{
      statement:{ type:'string', description:'The rule, as one standalone sentence.' },
      source:{ type:'string', enum:['correction','observation','manual'], description:'correction when the user corrected you.' },
      confidence:{ type:'number', description:'0-100. A direct correction is 85+.' } },
      required:['statement'] },
    async execute(args){
      await Learn.load();
      const clash = Learn.findConflict(args.statement);
      const rule = await Learn.addRule({
        statement: args.statement, source: args.source || 'correction',
        confidence: args.confidence ?? (args.source === 'correction' ? 85 : 60),
        conflictsWith: clash?.id || null,
      });
      if(!rule) return 'Could not store that rule.';
      if(clash)
        return `Stored, but it contradicts an existing rule: "${clash.statement}". Both are now flagged as conflicting. `
             + 'Tell the user plainly that the two disagree and ask which one holds — do not choose for them.';
      return `Rule stored at ${rule.confidence}% confidence. Acknowledge briefly.`;
    },
  },
  {
    name: 'recall_experience',
    permission: PERM.READ,
    description: "Look up learned rules and similar past cases before answering a technical question, or when asked 'have we seen this before?'.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'The problem or topic.' } },
      required:['query'] },
    async execute(args){
      await Learn.load();
      const out = Learn.brief(args.query);
      lastRuleHits = Learn.search(args.query);
      return out;
    },
  },
  {
    name: 'record_outcome',
    permission: PERM.LOW,
    description: "Record how a case turned out once it is resolved or closed, so it can inform later work. Use when the user says what fixed it.",
    schema: { type:'object', properties:{
      summary:{ type:'string', description:'What the problem was and what resolved it.' },
      outcome:{ type:'string', enum:['resolved','failed','unknown'] },
      case_query:{ type:'string', description:'Ticket or client, to link the case.' } },
      required:['summary'] },
    async execute(args){
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const q = norm(args.case_query || '');
      const hit = q ? (cases.find(c => c.ticket && norm(c.ticket).includes(q)) || cases.find(c => norm(c.titulo).includes(q))) : null;
      const ep = await Learn.addEpisode({ summary: args.summary, kind:'outcome',
        caseId: hit?.id || Focus.current?.case_id || null, outcome: args.outcome || 'unknown' });
      if(!ep) return 'Could not record that.';
      return `Recorded${hit ? ` against "${hit.titulo}"` : ''}. It will surface on similar problems later.`;
    },
  },
  {
    name: 'review_rules',
    permission: PERM.READ,
    description: "List learned rules, or the ones that conflict, so the user can resolve or retire them.",
    schema: { type:'object', properties:{
      only_conflicts:{ type:'boolean' } } },
    async execute(args){
      await Learn.load(true);
      const list = args.only_conflicts ? Learn.rules.filter(r => r.status === 'conflicted') : Learn.rules;
      if(!list.length) return args.only_conflicts ? 'No conflicting rules.' : 'No rules learned yet.';
      return list.slice(0, 15).map(r =>
        `- [${r.confidence}%${r.status === 'conflicted' ? ', CONFLICTED' : ''}] ${r.statement}`).join('\n');
    },
  },
  {
    name: 'start_focus',
    permission: PERM.LOW,
    description: "Begin working on something, e.g. 'I'm working on case 18372'. Creates a structured working context with an objective and steps, which later commands resolve against.",
    schema: { type:'object', properties:{
      label:{ type:'string', description:'What is being worked on, e.g. the case name or ticket.' },
      objective:{ type:'string', description:'What finishing looks like.' },
      subtasks:{ type:'array', items:{ type:'string' }, description:'Steps needed, in order.' },
      case_query:{ type:'string', description:'Ticket or client name, to link an existing case.' } },
      required:['label'] },
    async execute(args){
      let caseId = null, facts = {};
      if(args.case_query || args.label){
        const q = String(args.case_query || args.label).toLowerCase().replace(/[^a-z0-9]/g, '');
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const hit = cases.find(c => c.ticket && norm(c.ticket).includes(q)) || cases.find(c => norm(c.titulo).includes(q));
        if(hit){
          caseId = hit.id;
          TarsContext.selectedCaseId = hit.id;
          const snap = TarsContext.snapshot().focusedCase;
          facts = { ticket: hit.ticket || null, status: hit.status || 'pending',
                    serials: snap?.serials || [], evidence: snap?.evidence || [] };
        }
      }
      const subs = (args.subtasks || []).map(t => ({ text: t, done: false }));
      const f = await Focus.start(args.label, { objective: args.objective, subtasks: subs, caseId, facts });
      if(!f) return 'Could not start a focus — the store is unavailable.';
      return `Focus set: "${args.label}"` + (subs.length ? ` with ${subs.length} steps.` : '.')
           + (caseId ? ' Linked to the matching case.' : ' No matching case found, so it is standalone.');
    },
  },
  {
    name: 'update_focus',
    permission: PERM.LOW,
    description: "Update the active focus: tick a step, add steps, set what it is waiting on, or finish it.",
    schema: { type:'object', properties:{
      complete_step:{ type:'string', description:'Text of a step to mark done.' },
      add_steps:{ type:'array', items:{ type:'string' } },
      waiting_on:{ type:'string', description:"e.g. 'Deye response'." },
      objective:{ type:'string' },
      finish:{ type:'boolean', description:'True when the work is complete.' } } },
    async execute(args){
      if(!Focus.current) return 'Nothing is in focus right now. Say what you are working on first.';
      const notes = [];
      if(args.complete_step){
        const ok = await Focus.tick(args.complete_step, true);
        notes.push(ok ? `Ticked "${args.complete_step}".` : `No step matches "${args.complete_step}".`);
      }
      if(Array.isArray(args.add_steps) && args.add_steps.length){
        const subs = (Focus.current.subtasks || []).concat(args.add_steps.map(t => ({ text:t, done:false })));
        await Focus.update({ subtasks: subs });
        notes.push(`Added ${args.add_steps.length} step(s).`);
      }
      if(args.waiting_on){ await Focus.update({ waiting_on: args.waiting_on, status:'waiting' }); notes.push(`Waiting on ${args.waiting_on}.`); }
      if(args.objective){ await Focus.update({ objective: args.objective }); notes.push('Objective updated.'); }
      if(args.finish){ await Focus.update({ status:'done' }); Focus.current = null; renderFocusBar(); notes.push('Focus closed.'); }
      return notes.join(' ') || 'Nothing changed.';
    },
  },
  {
    name: 'get_focus',
    permission: PERM.READ,
    description: "Read the active focus and what remains, e.g. for 'what's missing?' or 'where were we?'.",
    schema: { type:'object', properties:{} },
    async execute(){
      const cur = Focus.brief();
      const pend = Focus.pending().filter(f => f.id !== Focus.current?.id);
      return cur + (pend.length ? `\nAlso open: ${pend.map(f => f.label).join('; ')}.` : '');
    },
  },
  {
    name: 'navigate',
    permission: PERM.READ,
    description: "Move the user to a screen: agenda, history, calendar, notebooks or settings. Use when they ask to open or show a section.",
    schema: { type:'object', properties:{
      screen:{ type:'string', enum:['agenda','history','calendar','notebooks','settings'] },
      section:{ type:'string', description:'Optional settings sub-tab: assistant, knowledge, media, appearance, data.' } },
      required:['screen'] },
    async execute(args){
      switchView(args.screen);
      if(args.screen === 'settings' && args.section){
        const b = document.querySelector(`.sub-tab[data-sub="${args.section}"]`);
        if(b) b.click();
      }
      return `Now showing ${args.screen}${args.section ? ' / ' + args.section : ''}.`;
    },
  },
  {
    name: 'open_case',
    permission: PERM.READ,
    description: "Open a specific case by ticket number or by name, and make it the focused case for later commands.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'Ticket number, client name or subject.' } },
      required:['query'] },
    async execute(args){
      const q = String(args.query || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const hit = cases.find(c => c.ticket && norm(c.ticket).includes(q))
               || cases.find(c => norm(c.titulo).includes(q))
               || cases.find(c => norm(c.titulo).split(' ').some(w => q.includes(w)));
      if(!hit) return `No case matches "${args.query}". Say so — do not invent one.`;
      TarsContext.selectedCaseId = hit.id;
      switchView(statusRank(hit.status) === 1 ? 'history' : 'agenda');
      openModal(hit.id);
      return `Opened "${hit.titulo}" (${hit.status || 'pending'}${hit.ticket ? ', ticket ' + hit.ticket : ''}). It is now the focused case.`;
    },
  },
  {
    name: 'get_context',
    permission: PERM.READ,
    description: "Read what is currently on screen: the focused case, its serial numbers, evidence links, notes and the visible records. Use before acting on 'this', 'these' or 'it'.",
    schema: { type:'object', properties:{} },
    async execute(){
      const s = TarsContext.snapshot();
      if(!s.focusedCase && !s.visibleRecords.length) return `Screen: ${s.page}. Nothing selected and no records visible.`;
      return JSON.stringify(s).slice(0, 1600);
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
    name: 'look_at_screen',
    permission: PERM.READ,
    description: "Read what is on a window the user shares — a manufacturer portal, an inverter dashboard, an error dialog. Use for 'look at my screen', 'what does this say', 'read the fault code'. The user picks the window; a single frame is read and discarded.",
    schema: { type:'object', properties:{
      question:{ type:'string', description:'What to look for, e.g. "what fault code is shown" or "read the serial numbers".' } } },
    async execute(args){
      const q = args.question
        || 'Read this screen. First say in one sentence what it is. Then report the key content: '
         + 'fault codes, serial numbers, error text, readings and status values, quoted exactly. '
         + 'If it is an article or a document, summarise the substance in three or four sentences.';
      const res = await Screen_.ask(q);
      if(!res.ok){
        if(res.error === 'no screen shared' || res.error === 'no frame'){
          showSharePrompt();
          return 'NO IMAGE WAS CAPTURED — no window is being shared, and the browser only allows sharing to start from a click. '
               + 'Tell the user to press the Share screen button that has just appeared, then ask again. '
               + 'You must NOT describe the screen from app data — you have not seen it.';
        }
        if(res.error === 'cooling')
          return `The vision model is cooling down after a rate limit — about ${res.detail} left. `
               + 'Tell the user the number and to ask again then. Do not describe the screen meanwhile.';
        if(res.error === 'rate_limit')
          return 'The vision model hit its per-minute limit. It frees up within a minute — say that plainly '
               + 'and do not guess at what was on the screen.';
        if(res.error === 'no_model')
          return `No vision model is usable on this Groq account. Details: ${res.detail || 'none'}. `
               + 'If it says "needs terms accepted", tell the user to accept the model terms at console.groq.com. '
               + 'Never invent what was on the screen.';
        if(res.error === 'auth_upstream')
          return 'The Groq key was rejected for vision. Say so — never invent what was on the screen.';
        return `Could not read the screen (${res.error}${res.detail ? ': ' + res.detail : ''}). `
             + 'Say so plainly — never invent what was on it.';
      }
      return `Read from the shared ${Screen_.surface === 'monitor' ? 'screen' : 'window'}`
        + `${Screen_.surfaceLabel ? ' (' + Screen_.surfaceLabel + ')' : ''}:\n${res.reply}\n\n`
        + (Screen_.surface === 'monitor'
            ? 'This is a whole-screen capture, so it shows whatever was in front. If the user expected a different program, '
              + 'tell them to share that program\'s window instead — window capture works even when it is behind.\n'
            : '')
        + 'Answer the user from this. If a value looks cut off or unreadable, say so rather than filling it in.';
    },
  },
  {
    name: 'search_email',
    permission: PERM.READ,
    description: "Search the local Thunderbird mailbox, e.g. 'what did Deye say', 'any reply from the manufacturer'. Reads mail already on this machine — it does not connect to any mail server.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'Sender, subject words, ticket number or client.' } },
      required:['query'] },
    async execute(args){
      if(!Mail.messages.length){
        const r = await Mail.scan();
        if(!r.ok) return 'No Thunderbird folder is set up. Tell the user to choose their Thunderbird profile mail folder in Settings, under Knowledge.';
      }
      const hits = Mail.search(args.query, 5);
      if(!hits.length) return `Nothing in the mailbox matches "${args.query}". Say so — do not invent a reply.`;
      return hits.map(m => {
        const cse = Mail.matchCase(m);
        return `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}`
             + (cse ? `\nRelates to case: ${cse.titulo}` : '')
             + `\n${m.body.slice(0, 700)}`;
      }).join('\n---\n').slice(0, 3000);
    },
  },
  {
    name: 'analyse_email',
    permission: PERM.READ,
    description: "Read the most relevant email and work out what it asks for: approval, rejection, or a request for more documents. Use after finding a manufacturer reply.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'Which email — sender, subject or ticket.' } },
      required:['query'] },
    async execute(args){
      if(!Mail.messages.length) await Mail.scan();
      const hits = Mail.search(args.query, 1);
      if(!hits.length) return `No email matches "${args.query}".`;
      const m = hits[0];
      const cse = Mail.matchCase(m);
      return `Analyse this reply and state plainly what it requires.\n\n`
        + `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n`
        + (cse ? `Linked case: ${cse.titulo}${cse.ticket ? ' (' + cse.ticket + ')' : ''}\n` : 'No matching case found.\n')
        + `\n${m.body.slice(0, 2200)}\n\n`
        + `Say: the outcome (approved, rejected, more information needed), exactly what is being asked for, and the next action. `
        + `If it reports a rejection or a missing document, offer to record that as a lesson with record_outcome — do not store it yourself.`
        + (() => {
            const cand = Outcomes.propose(m, cse);
            if(!cand) return '';
            return `\n\nDetected outcome: ${cand.verdict}`
              + (cand.wanted.length ? `, asking for: ${cand.wanted.join(', ')}` : '')
              + (cand.rule ? `\nSuggested lesson (ASK before storing): "${cand.rule}"` : '');
          })();
    },
  },
  {
    name: 'create_reminder',
    permission: PERM.LOW,
    description: "Set a reminder or follow-up. For 'remind me in 5 minutes' pass minutes_from_now: 5. For a clock time pass time as HH:MM. Never put a phrase like 'in 5 minutes' into the time field.",
    schema: { type:'object', properties:{
      what:{ type:'string', description:'What to be reminded about.' },
      date:{ type:'string', description:'YYYY-MM-DD. Defaults to today if a time is given, otherwise tomorrow.' },
      time:{ type:'string', description:'HH:MM. A bare hour resolves to its next occurrence.' },
      minutes_before:{ type:'number', description:'Lead time before the anchored case, e.g. 5.' },
      minutes_from_now:{ type:'number', description:'Use this for "remind me in N minutes" rather than putting a phrase in time.' },
      case_query:{ type:'string', description:'Ticket or client, to anchor the reminder to a case.' } },
      required:['what'] },
    async execute(args){
      let date = args.date, time = args.time ? resolveHour(args.time) : null;

      // "in N minutes" is the common case and must land on a real clock time.
      if(typeof args.minutes_from_now === 'number' && args.minutes_from_now > 0){
        const t = new Date(Date.now() + args.minutes_from_now * 60000);
        time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
        date = dateStr(t);
      }

      // Anchored to a case: work the time backwards from it.
      if(args.case_query || typeof args.minutes_before === 'number'){
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const q = norm(args.case_query || args.what);
        const hit = cases.find(x => x.ticket && norm(x.ticket).includes(q))
                 || cases.find(x => norm(x.titulo).includes(q));
        if(hit && hit.horario){
          const [hh, mm] = hit.horario.split(':').map(Number);
          const total = hh * 60 + (mm || 0) - (args.minutes_before || 5);
          if(total < 0) return 'That would fall before midnight — give an explicit time instead.';
          time = `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
          date = date || hit.case_date;
        } else if(args.case_query){
          return `No case matches "${args.case_query}", so there is nothing to anchor to. Ask for an explicit time.`;
        }
      }

      if(args.time && !time)
        return `"${args.time}" is not a time I can use. Ask for a clock time, or pass minutes_from_now. Do NOT claim the reminder was set.`;
      if(!date) date = time ? todayStr() : addDays(1);
      time = time || '09:00';
      if(!isClock(time))
        return 'That time could not be resolved, so nothing was saved. Say so plainly.';
      // A reminder for later today must not be pushed to tomorrow.
      if(date === todayStr() && time < new Date().toTimeString().slice(0, 5) && !args.date)
        date = addDays(1);

      try{
        const made = await createCase({
          titulo: 'Reminder: ' + args.what,
          case_date: date, horario: time,
          prioridade: 'media', bloco: blocoForTime(time), tags: ['follow-up'],
          notes_log: [{ text: 'Set by TARS.', at: new Date().toISOString() }],
        });
        cases.push(made);
        render();
        DueWatch.check();          // in case it is already inside the lead window
        const mins = DueWatch.minutesUntil(made);
        return `Reminder set for ${date} at ${time}`
             + (mins !== null && mins > 0 && mins < 120 ? ` — that is ${mins} minutes from now.` : '.')
             + ' I will speak up then.';
      }catch(err){ return `Could NOT set the reminder: ${err.message}.`; }
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
    name: 'delete_case',
    permission: PERM.HIGH,
    description: "Permanently delete a case. Always requires the user's confirmation first.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'Ticket, client or subject identifying the case.' } },
      required:['query'] },
    async execute(args){
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const q = norm(args.query);
      const matches = cases.filter(x => (x.ticket && norm(x.ticket).includes(q)) || norm(x.titulo).includes(q));
      if(!matches.length) return `No case matches "${args.query}". Say so — do not claim anything was deleted.`;
      if(matches.length > 1)
        return `${matches.length} cases match "${args.query}": ${matches.map(m => m.titulo).join('; ')}. `
             + 'Ask which one — do not delete several.';
      const hit = matches[0];
      try{
        await deleteCaseApi(hit.id);
        cases = cases.filter(x => x.id !== hit.id);
        if(TarsContext.selectedCaseId === hit.id) TarsContext.selectedCaseId = null;
        render();
        return `Deleted "${hit.titulo}".`;
      }catch(err){
        return `Deletion FAILED: ${err.message}. Tell the user it was not deleted.`;
      }
    },
  },
  {
    name: 'update_case',
    permission: PERM.LOW,
    description: "Change a field on an existing case: time, priority, block, ticket, phone or title.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'Which case.' },
      horario:{ type:'string' }, horario_fim:{ type:'string' },
      prioridade:{ type:'string', enum:['urgente','alta','media','baixa'] },
      bloco:{ type:'string', enum:['primeira-hora','manha','tarde','fim-do-dia'] },
      ticket:{ type:'string' }, phone:{ type:'string' }, titulo:{ type:'string' } },
      required:['query'] },
    async execute(args){
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const q = norm(args.query);
      const hit = cases.find(x => (x.ticket && norm(x.ticket).includes(q))) || cases.find(x => norm(x.titulo).includes(q));
      if(!hit) return `No case matches "${args.query}". Do not claim anything changed.`;
      if(statusRank(hit.status) === 1) return `"${hit.titulo}" is closed and cannot be edited.`;
      const patch = {};
      ['prioridade','bloco','ticket','phone','titulo'].forEach(k => { if(args[k]) patch[k] = args[k]; });
      if(args.horario){
        const t = resolveHour(args.horario);
        if(!isClock(t)) return `"${args.horario}" is not a usable time — nothing was changed.`;
        patch.horario = t;
      }
      if(args.horario_fim) patch.horario_fim = resolveHour(args.horario_fim);
      if(!Object.keys(patch).length) return 'Nothing to change was given.';
      try{
        const up = await updateCase(hit.id, patch);
        const i = cases.findIndex(x => x.id === hit.id);
        if(i > -1) cases[i] = up;
        render();
        return `Updated "${hit.titulo}": ${Object.entries(patch).map(([k, v]) => `${k} → ${v}`).join(', ')}.`;
      }catch(err){ return `Update FAILED: ${err.message}. Tell the user nothing changed.`; }
    },
  },
  {
    name: 'add_knowledge',
    permission: PERM.LOW,
    description: "Add a technical fact, procedure or fault code to the knowledge base, e.g. 'save error 303 Hoymiles as a firmware update needing the manufacturer'. Use whenever the user tells you to remember something technical for future reference.",
    schema: { type:'object', properties:{
      title:{ type:'string', description:'Short identifying title, e.g. "Hoymiles 303 — firmware".' },
      content:{ type:'string', description:'The full explanation, as you would tell a colleague.' },
      tags:{ type:'array', items:{ type:'string' }, description:'Manufacturer, code, category.' } },
      required:['title','content'] },
    async execute(args){
      const entry = { title: args.title, content: args.content,
                      tags: (args.tags || []).map(t => String(t).toLowerCase()), source: 'Voice' };
      // Shared, so every profile gets it. Say so — the user should know this
      // is not private to them.
      const saved = await SharedKB.add(entry);
      if(!saved){
        return 'Could NOT save to the shared knowledge base. Tell the user it was not stored.';
      }
      renderKbStatus();
      const box = document.getElementById('kb-json');
      if(box) box.value = JSON.stringify(KB, null, 2);
      // Filed as a note too, in this profile's own notebooks.
      let filed = false;
      try{ filed = !!(await fileKnowledgeEntry(entry)); }catch(e){}
      renderNotebooksGrid();
      Galaxy.build({ folder:false });
      return `Saved "${args.title}" to the shared knowledge base — every profile can see it`
           + (filed ? ', and filed a copy in your own notebooks.' : '.');
    },
  },
  {
    name: 'create_case',
    permission: PERM.LOW,
    description: "Create a new support case in the user's agenda. Only when they clearly ask to create, add or schedule a case.",
    schema: { type:'object', properties:{
      titulo:{ type:'string', description:'Client name and/or short subject.' },
      case_date:{ type:'string', description:'YYYY-MM-DD. Defaults to today.' },
      horario:{ type:'string', description:'Start time as HH:MM (24h). Relative phrasing like "in 30 minutes" is also accepted.' },
      minutes_from_now:{ type:'number', description:'Use for "in N minutes" when you would rather not compute the clock time.' },
      horario_fim:{ type:'string', description:'End time HH:MM, 24h.' },
      prioridade:{ type:'string', enum:['urgente','alta','media','baixa'] },
      bloco:{ type:'string', enum:['primeira-hora','manha','tarde','fim-do-dia'] },
      ticket:{ type:'string' }, tags:{ type:'array', items:{ type:'string' } },
      note:{ type:'string', description:'An initial note.' },
      remind_minutes_before:{ type:'number', description:'Also set a reminder this many minutes before the case starts.' } },
      required:['titulo'] },
    async execute(args){
    const payload = {
      titulo: args.titulo,
      ticket: args.ticket || '',
      horario: (typeof args.minutes_from_now === 'number' && args.minutes_from_now > 0
        ? (() => { const t = new Date(Date.now() + args.minutes_from_now * 60000);
                   return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`; })()
        : resolveHour(args.horario)) || '',
      horario_fim: resolveHour(args.horario_fim) || '',
      case_date: args.case_date || todayStr(),
      prioridade: args.prioridade || 'media',
      bloco: args.bloco || blocoForTime(resolveHour(args.horario)),
      tags: Array.isArray(args.tags) ? args.tags : [],
      notes_log: args.note ? [{ text: args.note, at: new Date().toISOString() }] : [],
    };
    const created = await createCase(payload);
    cases.push(created);
    render(); renderCalendar(); renderHistory();

    // One request often means both a case and its reminder; chaining them here
    // saves a second round trip and keeps the two consistent.
    let extra = '';
    if(typeof args.remind_minutes_before === 'number' && args.remind_minutes_before > 0 && created.horario){
      const [hh, mm] = created.horario.split(':').map(Number);
      const total = hh * 60 + (mm || 0) - args.remind_minutes_before;
      if(total >= 0){
        const rt = `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
        try{
          const rem = await createCase({
            titulo: 'Reminder: ' + created.titulo,
            case_date: created.case_date, horario: rt,
            prioridade: 'media', bloco: blocoForTime(rt), tags: ['follow-up'],
            notes_log: [{ text: 'Set by TARS.', at: new Date().toISOString() }],
          });
          cases.push(rem); render();
          DueWatch.check();
          extra = ` Reminder set for ${rt}.`;
        }catch(e){ extra = ' The reminder could NOT be set — say so.'; }
      } else extra = ' The reminder would fall before midnight, so it was not set.';
    }
    return `Case created: "${created.titulo}" on ${created.case_date}`
      + (created.horario ? ` at ${created.horario}.` : '.') + extra;
    },
  },
  {
    name: 'draw_diagram',
    permission: PERM.LOW,
    description: "Draw a flow diagram on the open note from a description — a triage flow, a decision tree, a procedure. Give the boxes and how they connect; the app decides where everything goes. Ask the user at most three clarifying questions first, then draw a draft they can correct.",
    schema: { type:'object', properties:{
      title:{ type:'string', description:'What the diagram is about.' },
      note:{ type:'string', description:'Which note to draw on. Omit to use the open note, or the most recent one.' },
      nodes:{ type:'array', description:'The boxes. Each needs a short id and a label of a few words.',
        items:{ type:'object', properties:{
          id:{ type:'string' },
          label:{ type:'string' },
          kind:{ type:'string', enum:['step','decision'], description:'decision draws as an ellipse.' } },
          required:['id','label'] } },
      edges:{ type:'array', description:'Which box leads to which.',
        items:{ type:'object', properties:{
          from:{ type:'string' }, to:{ type:'string' } },
          required:['from','to'] } } },
      required:['nodes'] },
    async execute(args){
      // Requiring an already-open note made TARS ask which note to use even
      // when one was on screen. It now opens the named note itself, or the
      // most recent one, rather than interrogating the user.
      if(!activeNoteId){
        let target = null;
        if(args.note){
          const q = String(args.note).toLowerCase();
          target = (notes || []).find(x => String(x.title || '').toLowerCase().includes(q));
        }
        if(!target && activeFolderId)
          target = (notes || []).filter(x => x.notebook_id === activeFolderId)
            .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0];
        if(!target) return 'There is no note to draw on. Ask the user to create one — do not claim a diagram was drawn.';
        await openNote(target.id);
      }
      const nodes = (args.nodes || []).filter(n => n && n.id && n.label);
      if(!nodes.length) return 'No usable boxes were given, so nothing was drawn.';
      if(nodes.length > 24) return 'That is too many boxes for one readable diagram. Suggest splitting it.';
      const ids = new Set(nodes.map(n => n.id));
      // Silently dropping a bad edge would produce a diagram missing a link
      // the user asked for, so they are counted and reported.
      const all = (args.edges || []).filter(e => e && e.from && e.to);
      const edges = all.filter(e => ids.has(e.from) && ids.has(e.to));
      const dropped = all.length - edges.length;

      const res = Ink.buildDiagram({ title: args.title, nodes, edges });
      if(!res.ok) return `The diagram could not be drawn (${res.reason}). Say so plainly.`;
      return `Drew ${res.nodes} boxes and ${res.edges} arrows on the page.`
        + (dropped ? ` ${dropped} connection(s) referenced boxes that do not exist and were skipped — mention this.` : '')
        + ' Tell the user they can drag any box and the arrows will follow, and offer to change it.';
    },
  },
  {
    name: 'read_page',
    permission: PERM.READ,
    description: "Read the open notebook page: typed text, recognised handwriting, shapes and how they connect. Use for 'summarise this page', 'what does this diagram say', 'what have I got here'.",
    schema: { type:'object', properties:{} },
    async execute(){
      const ctx = NotePage.context();
      if(!ctx) return 'No note is open. Ask the user to open one first — do not describe a page you cannot see.';
      return ctx + '\n\nAnswer from this only. If strokes are unrecognised, say they need recognising first.';
    },
  },
  {
    name: 'cleanup_page',
    permission: PERM.LOW,
    description: "Tidy the open page into a clean structured version — a checklist, actions, or organised notes. Creates a SEPARATE note and never alters the original.",
    schema: { type:'object', properties:{
      style:{ type:'string', enum:['checklist','actions','summary','tidy'],
              description:'checklist = tick boxes; actions = what to do next; summary = prose; tidy = same content, organised.' } } },
    async execute(args){
      const ctx = NotePage.context();
      if(!ctx) return 'No note is open, so there is nothing to tidy.';
      const style = args.style || 'tidy';
      const sys = [
        'You reorganise a support technician\'s rough notes. Output clean HTML only: <h3>, <p>, <ul>, <li>. No markdown, no commentary.',
        'Rules: keep every fact. Do not invent details, dates, serial numbers or conclusions.',
        'Expand obvious shorthand but never change a serial number, model or fault code.',
        'Keep the original language of each line — do not translate.',
        style === 'checklist' ? 'Produce a checklist of concrete items, one action each.'
        : style === 'actions' ? 'Produce a short list of next actions, most urgent first.'
        : style === 'summary' ? 'Produce two or three short paragraphs.'
        : 'Keep the same content, grouped under clear headings.',
      ].join('\n');
      let html;
      try{
        html = await callAi(ctx, sys);
      }catch(err){ return `The tidy-up failed: ${errText(err)}. Nothing was changed.`; }
      if(!html || !html.trim()) return 'Nothing usable came back. The original page is untouched.';

      // A derived note, never a rewrite: the original page keeps its ink.
      const srcTitle = document.getElementById('nb-title-input')?.value || 'Untitled';
      try{
        const made = await createNoteApi({
          notebook_id: activeFolderId,
          title: `${srcTitle} — cleaned`,
          content: `<p><em>Tidied from "${escapeHtml(srcTitle)}". The original, with its handwriting, is unchanged.</em></p>`
                   + String(html).replace(/```html?|```/g, '').trim(),
          tags: ['cleaned'],
        });
        notes.unshift(made);
  GalaxyLife.touch(made.title);
  GalaxyFeed.push('kb', 'note — ' + (made.title || 'untitled'));
        renderNotebooksGrid();
        return `Created "${made.title}" as a separate note. The original page is untouched — say so.`;
      }catch(err){ return `Could NOT save the tidied note: ${errText(err)}.`; }
    },
  },
  {
    name: 'read_diagram',
    permission: PERM.READ,
    description: "Describe how the shapes and arrows on the open page connect, e.g. 'what does this flow say'. Works from the drawn objects, not an image.",
    schema: { type:'object', properties:{} },
    async execute(){
      if(!activeNoteId) return 'No note is open.';
      const g = NotePage.graph();
      if(!g.nodes.length) return 'There are no recognised shapes on this page. Smart Ink must recognise them first — do not guess.';
      const desc = NotePage.describeGraph();
      return (desc || `${g.nodes.length} shapes, none connected by arrows.`)
        + '\n\nDescribe the flow in plain words. Do not add steps that are not connected.';
    },
  },
  {
    name: 'search_notes',
    permission: PERM.READ,
    description: "Search every notebook — typed text, tags and recognised handwriting — for something the user wrote. Use for 'find where I wrote about Deye firmware', 'which note mentions that serial'.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'What to look for.' } },
      required:['query'] },
    async execute(args){
      const hits = NoteSearch.search(args.query, 5);
      if(!hits.length) return `Nothing in the notebooks matches "${args.query}". Say so — do not guess at what might be written.`;
      const lines = hits.map(h => {
        const it = h.it;
        return `- ${it.notebookTitle ? it.notebookTitle + ' / ' : ''}${it.noteTitle}`
          + ` [${it.kind}${it.where ? `, at ${Math.round(it.where.x)},${Math.round(it.where.y)} on the page` : ''}]`
          + `: ${NoteSearch.snippet(it.content, args.query, 120)}`;
      });
      // Remember the top hit so "open it" works as a follow-up.
      lastNoteHit = hits[0].it;
      return lines.join('\n')
        + '\nName the notebook and note. If the match came from handwriting, say so. Offer to open it.';
    },
  },
  {
    name: 'open_note',
    permission: PERM.READ,
    description: "Open a note found by search, scrolling to the handwriting if the match came from ink. Use after search_notes when the user says 'open it' or names one.",
    schema: { type:'object', properties:{
      query:{ type:'string', description:'Note title or what it is about. Omit to open the last search result.' } },
      required:[] },
    async execute(args){
      let hit = null;
      if(args.query){
        const hits = NoteSearch.search(args.query, 1);
        hit = hits.length ? hits[0].it : null;
      } else if(lastNoteHit) hit = lastNoteHit;
      if(!hit) return 'No matching note. Do not claim one was opened.';
      const ok = await NoteSearch.goTo(hit);
      return ok ? `Opened "${hit.noteTitle}"${hit.where ? ' at the handwriting.' : '.'}`
                : 'That note could not be opened.';
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
  // Shared store first; the bundled file is only a starting point for a brand
  // new deployment.
  if(session && await SharedKB.load()) return;
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
const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','your','with','this','that','have','has','had',
  'was','were','will','can','could','would','should','from','they','them','their','what','when',
  'where','which','who','why','how','all','any','some','one','two','get','got','put','set','see',
  'now','out','off','its','please','thanks','hello','okay',
  'que','nao','não','com','uma','para','por','dos','das','isso','esse','essa','meu','minha',
  'seu','sua','tem','ter','foi','ser','esta','está','mais','mas','como','pelo',
  'today','tonight','tomorrow','morning','night','oclock','clock','meeting','schedule','about',
  'urgent','due','actually','really','just','also','very','much','more','make','made','need','want',
]);
// Words shorter than four characters were matching inside unrelated words —
// "for" inside "formação", "at" inside "cusat" — which is how irrelevant
// entries were being cited.
function relevantWords(q){
  return [...new Set(String(q || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w)))];
}
// Word-boundary matching, plus a floor: citing a weak match is worse than
// citing nothing, because it makes every source card untrustworthy.
function kbSearch(q, limit = 4){
  const words = relevantWords(q);
  if(!KB.length || !words.length) return [];
  const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scored = KB.map(e => {
    const title = String(e.title || '').toLowerCase();
    const tags = (e.tags || []).map(t => String(t).toLowerCase());
    const body = String(e.content || '').toLowerCase();
    let score = 0, matched = 0;
    words.forEach(w => {
      const re = new RegExp('\\b' + esc(w), 'i');
      let hit = 0;
      if(tags.some(t => t === w || t.includes(w))) hit += 6;
      if(re.test(title)) hit += 4;
      else if(re.test(body)) hit += 1;
      if(hit) matched++;
      score += hit;
    });
    return { e, score, coverage: matched / words.length, matched };
  }).filter(x => x.matched > 0);
  const best = Math.max(0, ...scored.map(x => x.score));
  return scored
    .filter(x => x.score >= 4 && x.coverage >= 0.34 && x.score >= best * 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.e);
}




// --- manual knowledge entry -------------------------------------------
document.getElementById('vision-test')?.addEventListener('click', async () => {
  try{
    const r = await fetch(FN_URL + "/agenda-vision", {
      method:'POST', headers: authHeaders(), body: JSON.stringify({ probe:true }),
    });
    const out = await readJson(r);
    if(!out.ok){ alert('Vision check failed: ' + (out.json.error || r.status)); return; }
    const d = out.json;
    alert(d.candidates?.length
      ? `Vision models available:\n\n${d.candidates.join('\n')}`
        + (d.extra?.length ? `\n\nAlso possible:\n${d.extra.join('\n')}` : '')
      : `No vision model on this account (${d.total} models visible).\n\n`
        + 'Accept the Llama 4 model terms at console.groq.com, then try again.');
  }catch(e){ alert('Could not reach the vision service.'); }
});
document.getElementById('profile-new')?.addEventListener('click', async () => {
  const name = prompt('New profile name (letters, numbers, dot, dash or underscore):');
  if(!name) return;
  const pw = prompt(`Password for "${name}" (at least 6 characters):`);
  if(!pw) return;
  try{
    const r = await fetch(FN_URL + "/agenda-login", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ action:'register', name, password: pw }),
    });
    const out = await readJson(r);
    alert(out.ok
      ? `Profile "${out.json.user.name}" created.\n\nIt starts empty: its own cases, notebooks and notes, `
        + 'with the shared knowledge base already available.'
      : 'Could not create it: ' + (out.json.error || r.status));
  }catch(e){ alert('Could not reach the sign-in service.'); }
});

document.getElementById('kb-seed')?.addEventListener('click', async () => {
  if(!KB.length){ alert('There is nothing loaded to publish.'); return; }
  if(!confirm(`Publish ${KB.length} entries to the shared knowledge base?\n\n`
    + 'Every profile will be able to read them. Do not publish anything containing client names.')) return;
  const res = await SharedKB.seed(KB);
  if(res.code === 'already_seeded'){
    if(!confirm(`The shared base already has ${res.count} entries.\n\nAdd these on top anyway?`)) return;
    const again = await SharedKB.seed(KB, true);
    alert(again.ok ? `Added ${again.added} entries.` : 'Failed: ' + (again.error || 'unknown'));
  } else {
    alert(res.ok ? `Published ${res.added} entries.` : 'Failed: ' + (res.error || 'unknown'));
  }
  await SharedKB.load();
  renderKbShare();
});

function renderKbShare(){
  const el = document.getElementById('kb-share-status');
  if(!el) return;
  el.textContent = SharedKB.loaded
    ? `${KB.length} entries, shared with all profiles`
    : `${KB.length} entries, local only — press Publish`;
  el.className = SharedKB.loaded ? 'ok' : '';
}
document.getElementById('screen-share')?.addEventListener('click', async () => {
  if(Screen_.stream && Screen_.stream.active){ Screen_.close(); return; }
  const ok = await Screen_.open();
  if(!ok) alert(Screen_.lastReason || 'Screen sharing was refused or is unsupported. Chrome or Edge on desktop is required.');
});
document.getElementById('screen-keep')?.addEventListener('click', () => {
  Screen_.keepOpen = !Screen_.keepOpen;
  settings.screenKeep = Screen_.keepOpen; saveSettings();
  renderScreenKeep(); renderScreenStatus(); renderKbShare();
  const ps = document.getElementById('profile-status');
  if(ps) ps.textContent = `signed in as ${session?.name || '—'}`;
});
function renderScreenKeep(){
  // Defaults to on: a one-shot share would need a fresh click every time,
  // which makes voice-triggered reading impossible.
  Screen_.keepOpen = settings.screenKeep !== false;
  const el = document.getElementById('screen-keep-status');
  if(el) el.textContent = Screen_.keepOpen
    ? 'On — stays shared until you stop it'
    : 'Off — needs a fresh click each time';
}
document.getElementById('mail-files')?.addEventListener('click', () =>
  document.getElementById('mail-file-input')?.click());
document.getElementById('mail-file-input')?.addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  if(!files.length) return;
  const r = await Mail.addFiles(files);
  e.target.value = '';
  alert(r.added
    ? `Loaded ${r.added} message${r.added > 1 ? 's' : ''}.`
      + (r.skipped ? ` ${r.skipped} file(s) were not readable mail.` : '')
      + '\n\nThese stay for this session only — re-add them after a reload.'
    : 'None of those files contained readable mail. Export from Thunderbird with File → Save As, which produces .eml files.');
});
document.getElementById('mail-pick')?.addEventListener('click', async () => {
  if(!window.showDirectoryPicker){
    alert('This browser cannot open folders. Use Chrome or Edge on desktop, or load .eml files with "Add mail files".');
    return;
  }
  if(await Mail.pickFolder()){
    renderMailStatus();
    const r = await Mail.scan();
    alert(r.ok && r.count ? `Folder set. Read ${r.count} messages.`
      : 'Folder set, but no mail was found in it. Open it and check for a file named INBOX with no extension.');
    renderMailStatus();
  } else {
    alert(Mail.lastReason || 'No folder was chosen.');
  }
});
document.getElementById('mail-forget')?.addEventListener('click', async () => {
  await Mail.forget();
  alert('Forgotten. Press "Choose folder" to pick a different one.');
});
document.getElementById('mail-scan')?.addEventListener('click', async () => {
  const btn = document.getElementById('mail-scan');
  btn.disabled = true; btn.textContent = 'Scanning…';
  const r = await Mail.scan();
  btn.disabled = false; btn.textContent = 'Scan mailbox';
  if(!r.ok){
    alert('Could not read that folder.\n\n' + (r.reason === 'no folder'
      ? 'No folder is selected yet — press "Choose folder" first.'
      : 'The browser refused to read it. On Windows, Chrome blocks AppData; see the note under this section.'));
  } else if(!r.count){
    const s = r.seen || {};
    alert(`No mail found.\n\nLooked through ${s.dirs || 0} folders and ${s.files || 0} files.\n`
      + `${s.mbox || 0} looked like mailbox files, ${s.skipped || 0} were skipped, ${s.empty || 0} were empty.\n\n`
      + (s.files === 0
        ? 'The folder appears empty to the browser. That usually means Chrome blocked it — pick a copy outside AppData.'
        : s.mbox === 0
        ? 'Files were found but none are mbox mailboxes. Pick the account folder inside Mail\\ or ImapMail\\ — the one holding a file named INBOX with no extension.'
        : 'Mailbox files were found but held no messages. For IMAP accounts, enable "Keep messages in this folder on this computer" in Thunderbird so bodies are stored locally.'));
  } else {
    const s = r.seen || {};
    alert(`Read ${r.count} messages from ${s.mbox} mailbox file(s).`
      + (s.names?.length ? `\n\n${s.names.join('\n')}` : ''));
  }
  renderMailStatus();
});
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



// ===== Outcome learning ==============================================
// An outcome only becomes a candidate lesson; it is never written as a rule
// on its own. The user confirms, because a wrong rule learned automatically
// is worse than no rule at all.
const Outcomes = {
  pending: [],

  // Reads a manufacturer reply for its verdict without asking the model.
  classify(text){
    const t = String(text || '').toLowerCase();
    // Portuguese inflects, so stems must allow a suffix — a trailing \b after
    // "aprovad" can never match "aprovada".
    if(/\b(aprovad\w*|aprova[çc][ãa]o|approved?|autoriza\w*|deferid\w*|procedente)\b/.test(t)) return 'approved';
    if(/\b(rejeitad\w*|rejei[çc][ãa]o|negad\w*|recusad\w*|rejected?|denied|improcedente|indeferid\w*)\b/.test(t)) return 'rejected';
    if(/\b(falta\w*|pendente\w*|enviar|anexar|necess[aá]ri\w*|missing|require[ds]?|provide|send us|aguardando)\b/.test(t)) return 'needs_more';
    return 'unclear';
  },

  // What was asked for, so the lesson is specific rather than "add documents".
  wanted(text){
    const t = String(text || '');
    const hits = [];
    [[/nota fiscal|invoice/i, 'invoice'], [/n[uú]mero de s[eé]rie|serial/i, 'serial number'],
     [/foto|photo|imagem|image/i, 'photos'], [/laudo|report|relat[oó]rio/i, 'technical report'],
     [/data ?logger|log/i, 'logs'], [/projeto|diagram|esquema/i, 'diagram'],
     [/garantia|warranty certificate|certificad/i, 'warranty certificate']]
      .forEach(([re, label]) => { if(re.test(t)) hits.push(label); });
    return [...new Set(hits)];
  },

  propose(email, cse){
    const verdict = this.classify(email.body);
    if(verdict === 'unclear') return null;
    const wanted = this.wanted(email.body);
    const who = (email.from.match(/@([\w.-]+)/) || [])[1] || email.from;
    const maker = (who.split('.')[0] || who).replace(/^(mail|smtp|no-?reply)$/i, '');
    const candidate = {
      verdict, wanted, maker,
      email: { subject: email.subject, from: email.from, date: email.date },
      caseId: cse?.id || null,
      rule: verdict === 'needs_more' && wanted.length
        ? `${maker} warranty claims also require: ${wanted.join(', ')}.`
        : verdict === 'rejected' && wanted.length
        ? `${maker} rejects claims missing: ${wanted.join(', ')}.`
        : null,
    };
    this.pending.push(candidate);
    return candidate;
  },
};



// Knowledge is shared across every profile: a fault code learned once should
// help whoever picks up the next case. Cases, notebooks, notes and memories
// stay per-profile and encrypted — only this table is common.
const SharedKB = {
  loaded: false,

  async load(){
    try{
      const r = await fetch(FN_URL + "/agenda-kb", { headers: authHeaders() });
      const out = await readJson(r);
      if(!out.ok) return false;
      const rows = out.json.entries || [];
      if(rows.length){
        KB = rows.map(e => ({ id: e.id, title: e.title, content: e.content,
                              tags: e.tags || [], source: e.source || null, url: e.url || null }));
        this.loaded = true;
        renderKbStatus();
        return true;
      }
      return false;   // empty: the caller seeds it
    }catch(e){ return false; }
  },

  async add(entry){
    const r = await fetch(FN_URL + "/agenda-kb", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ title: entry.title, content: entry.content,
                             tags: entry.tags || [], source: entry.source, url: entry.url }),
    });
    const out = await readJson(r);
    if(!out.ok) return null;
    KB = [{ ...entry, id: out.json.entry.id }, ...KB];
    renderKbStatus();
    return out.json.entry;
  },

  // One-time migration of a local base into the shared one.
  async seed(entries, force){
    const r = await fetch(FN_URL + "/agenda-kb", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ entries, force: !!force }),
    });
    const out = await readJson(r);
    return out.ok ? out.json : { error: out.json.error, code: out.json.code, count: out.json.count };
  },

  async removeSource(source){
    const r = await fetch(FN_URL + "/agenda-kb", {
      method:'DELETE', headers: authHeaders(), body: JSON.stringify({ source }),
    });
    return (await readJson(r)).ok;
  },
};


// ===== Ink canvas (Phase 1) ==========================================
// A vector ink layer for the note editor. Deliberate constraints:
//   - strokes are structured data, never a bitmap: they survive zoom, and
//     later phases can recognise them without losing the original
//   - nothing in the pointer path touches the network; rendering is local
//   - pressure is used where the device reports it, ignored where it does not
//
// Document shape (v1), stored encrypted in notes.ink:
//   { v:1, strokes:[{ id, tool, color, width, points:[[x,y,p],…], t }],
//     objects:[],            // reserved: shapes (Phase 2), text (Phase 3)
//     view:{ zoom, panX, panY } }
// `objects` exists now so later phases add to the model rather than change it.
const Ink = {
  doc: { v:1, strokes: [], objects: [], view: { zoom:1, panX:0, panY:0 } },
  cv: null, ctx: null, dpr: 1,
  active: false,                 // is the ink layer showing
  tool: 'pen',                   // pen | highlighter | eraser
  colour: null,                  // null = follow the theme text colour
  palette: ['', '#e6584c', '#f2a71b', '#48b26b', '#4f9fd8', '#a86fd6', '#111111'],
  width: 2.4,
  smoothing: 0.35,               // 0 = raw, 0.8 = heavily stabilised
  pressureOn: true,
  undoStack: [], redoStack: [],
  drawing: false, cur: null, last: null,
  panning: false, panFrom: null,
  dirty: false,

  // --- setup --------------------------------------------------------
  mount(){
    this.cv = document.getElementById('ink-canvas');
    if(!this.cv) return;
    this.ctx = this.cv.getContext('2d');
    this.resize();
    if(this._bound) return;
    this._bound = true;

    // Pointer Events cover pen, mouse and touch in one path, and carry
    // pressure and pointerType where the hardware provides them.
    this.cv.addEventListener('pointerdown', e => this.down(e));
    this.cv.addEventListener('pointermove', e => this.move(e));
    // Only a real release ends a stroke. 'pointerleave' also fires when a fast
    // pen crosses the canvas edge or the cursor briefly exits, which split one
    // stroke into many — the dashed, gappy line.
    ['pointerup','pointercancel'].forEach(ev =>
      this.cv.addEventListener(ev, e => this.up(e)));
    // A pen lifted outside the canvas still has to finish the stroke.
    window.addEventListener('pointerup', e => { if(this.drawing || this.panning || this.selecting) this.up(e); });
    // Stop the browser scrolling or selecting while a pen is down.
    this.cv.style.touchAction = 'none';
    this.cv.addEventListener('contextmenu', e => e.preventDefault());

    this.cv.addEventListener('wheel', e => {
      if(!this.active) return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.zoomAt(e.offsetX, e.offsetY, f);
    }, { passive:false });

    window.addEventListener('resize', () => { if(this.active) this.resize(); });
  },

  resize(){
    if(!this.cv) return;
    const r = this.cv.getBoundingClientRect();
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.redraw();
  },

  // --- coordinate space ---------------------------------------------
  // Points are stored in document space, so zoom and pan never alter the data.
  toDoc(e){
    const v = this.doc.view;
    return { x: (e.offsetX - v.panX) / v.zoom, y: (e.offsetY - v.panY) / v.zoom };
  },

  zoomAt(px, py, factor){
    const v = this.doc.view;
    const next = Math.max(0.25, Math.min(6, v.zoom * factor));
    // Keep the point under the cursor fixed while zooming.
    v.panX = px - (px - v.panX) * (next / v.zoom);
    v.panY = py - (py - v.panY) * (next / v.zoom);
    v.zoom = next;
    this.cacheDirty = true;
    this.redraw(); this.status();
  },
  resetView(){ this.doc.view = { zoom:1, panX:0, panY:0 }; this.redraw(); this.status(); },

  // --- input --------------------------------------------------------
  pressureOf(e){
    if(!this.pressureOn) return 0.5;
    // A mouse reports 0.5 or 0; only trust pressure from a real pen.
    if(e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
    return 0.5;
  },

  down(e){
    if(!this.active) return;
    this.cv.setPointerCapture?.(e.pointerId);

    // Middle button, space, or two fingers pans instead of drawing.
    if(e.button === 1 || e.altKey || this.tool === 'pan'){
      this.panning = true;
      this.panFrom = { x:e.offsetX, y:e.offsetY, panX:this.doc.view.panX, panY:this.doc.view.panY };
      return;
    }
    // A stylus barrel button erases, which is the tablet convention.
    if(this.tool === 'select'){
      const p = this.toDoc(e);
      // A handle sits on top of whatever it belongs to, so it is tested first.
      const hd = this.handleAt(p);
      if(hd){
        this.resizing = { handle: hd };
        this.pushUndo();
        this.rebuildCache();
        return;
      }
      const hitEl = this.elementAt(p);
      if(hitEl){
        // Shift adds to the selection; a plain click on something already
        // selected keeps the group so a multi-drag is possible.
        if(e.shiftKey) this.sel.has(hitEl.id) ? this.sel.delete(hitEl.id) : this.sel.add(hitEl.id);
        else if(!this.sel.has(hitEl.id)) this.sel = new Set([hitEl.id]);
        this.dragging = { from: p, moved: false };
        this.cacheDirty = true;
        this.redraw(); this.status();
        return;
      }
      if(!e.shiftKey) this.sel.clear();
      this.selecting = true;
      this.marquee = { x0:p.x, y0:p.y, x1:p.x, y1:p.y };
      this.selection = { x0:p.x, y0:p.y, x1:p.x, y1:p.y };
      this.redraw();
      return;
    }
    const erasing = this.tool === 'eraser' || e.button === 5 || (e.buttons & 32) ||
                    e.pointerType === 'pen' && e.button === 2;
    if(erasing){ this.drawing = 'erase'; this.eraseAt(this.toDoc(e)); return; }

    const p = this.toDoc(e);
    this.pushUndo();
    this.cur = {
      id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      tool: this.tool, colour: this.colour, width: this.width,
      points: [[+p.x.toFixed(2), +p.y.toFixed(2), +this.pressureOf(e).toFixed(3)]],
      t: Date.now(),
    };
    this.last = p;
    this.drawing = true;
  },

  move(e){
    if(!this.active) return;
    if(this.panning && this.panFrom){
      this.doc.view.panX = this.panFrom.panX + (e.offsetX - this.panFrom.x);
      this.doc.view.panY = this.panFrom.panY + (e.offsetY - this.panFrom.y);
      this.cacheDirty = true;
      this.redraw();
      return;
    }
    if(this.resizing){
      this.applyResize(this.resizing.handle, this.toDoc(e));
      this.redraw();
      return;
    }
    if(this.dragging){
      const p = this.toDoc(e);
      const dx = p.x - this.dragging.from.x, dy = p.y - this.dragging.from.y;
      if(!this.dragging.moved && Math.hypot(dx, dy) > 1.5){
        this.dragging.moved = true;
        this.pushUndo();                       // only once a real move begins
        this.rebuildCache();
      }
      if(this.dragging.moved){
        this.cv?.classList.add('grabbing');
        const els = this.selectedElements();
        els.forEach(o => Geo.move(o, dx, dy));
        // Nudge into alignment with nearby edges and centres.
        const snap = e.altKey ? { dx:0, dy:0 } : this.snapDelta(els);
        if(snap.dx || snap.dy) els.forEach(o => Geo.move(o, snap.dx, snap.dy));
        els.forEach(o => this.moveBoundText(o));
        this.refreshBindings(els.map(o => o.id));
        this.dragging.from = { x: p.x + snap.dx, y: p.y + snap.dy };
        this.redraw();
      }
      return;
    }
    if(this.selecting && this.marquee){
      const p = this.toDoc(e);
      this.marquee.x1 = p.x; this.marquee.y1 = p.y;
      this.selection.x1 = p.x; this.selection.y1 = p.y;
      this.redraw();
      return;
    }
    if(!this.drawing) return;
    if(this.drawing === 'erase'){ this.eraseAt(this.toDoc(e)); return; }

    // Coalesced events give every sample the tablet reported, not just the
    // ones that survived to a frame — this is what makes fast strokes smooth.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for(const ev of events){
      const raw = this.toDoc(ev);
      // Exponential smoothing: the higher the setting, the more the new point
      // is pulled toward the previous one. Applied to input, not to rendering,
      // so it costs nothing per frame.
      const a = 1 - this.smoothing;
      const p = this.last
        ? { x: this.last.x + (raw.x - this.last.x) * a, y: this.last.y + (raw.y - this.last.y) * a }
        : raw;
      // Drop points too close to matter; keeps the document small.
      // Thinning helps file size but must not starve the curve; at heavy
      // smoothing consecutive points barely move, so the threshold scales down.
      const minGap = 0.15 + (1 - this.smoothing) * 0.35;
      if(this.last && Math.hypot(p.x - this.last.x, p.y - this.last.y) < minGap) continue;
      this.cur.points.push([+p.x.toFixed(2), +p.y.toFixed(2), +this.pressureOf(ev).toFixed(3)]);
      this.last = p;
    }
    // Redraw the live stroke from its start: cheap for one stroke, and it
    // cannot leave gaps the way a guessed start index could.
    this.drawStroke(this.cur, 1);
  },

  up(e){
    if(this.panning){ this.panning = false; this.panFrom = null; return; }
    if(this.resizing){
      this.resizing = null;
      this.cacheDirty = true;
      this.markDirty();
      this.redraw(); this.status();
      return;
    }
    if(this.dragging){
      const moved = this.dragging.moved;
      // An arrow dropped onto a shape binds to it.
      if(moved) this.selectedElements().forEach(o => {
        if(o.kind === 'arrow' || o.kind === 'line') this.bindArrow(o);
      });
      this.dragging = null;
      this.cv?.classList.remove('grabbing');
      this.cacheDirty = true;
      if(moved) this.markDirty();
      else this.undoStack.pop();               // a click is not an edit
      this.redraw(); this.status();
      return;
    }
    if(this.selecting){
      this.selecting = false;
      const m = this.marquee;
      this.marquee = null;
      if(m){
        const r = { x0:Math.min(m.x0,m.x1), y0:Math.min(m.y0,m.y1),
                    x1:Math.max(m.x0,m.x1), y1:Math.max(m.y0,m.y1) };
        if(r.x1 - r.x0 > 4 || r.y1 - r.y0 > 4){
          (this.doc.objects || []).forEach(o => { if(Geo.within(o, r)) this.sel.add(o.id); });
        }
      }
      const s = this.selection;
      // Normalise, and treat a tap as clearing the selection.
      if(s){
        this.selection = { x0:Math.min(s.x0,s.x1), y0:Math.min(s.y0,s.y1),
                           x1:Math.max(s.x0,s.x1), y1:Math.max(s.y0,s.y1) };
        if(this.selection.x1 - this.selection.x0 < 4) this.selection = null;
      }
      this.redraw(); this.updateHandBar();
      return;
    }
    if(!this.drawing) return;
    if(this.drawing === 'erase'){ this.drawing = false; this.markDirty(); return; }
    this.drawing = false;
    if(this.cur && this.cur.points.length > 1){
      this.doc.strokes.push(this.cur);
      this.markDirty();
      // Recognition happens only once the stroke is finished, and after a
      // pause, so it never interferes with a multi-stroke drawing in progress.
      if(this.smartInk && this.tool !== 'highlighter') this.scheduleRecognise(this.cur);
    } else {
      this.undoStack.pop();          // a stray tap should not cost an undo
    }
    this.cur = null; this.last = null;
    this.redraw(); this.status();
  },

  // --- erasing ------------------------------------------------------
  // Whole-stroke erase: simpler to reason about than splitting, and it keeps
  // the document a clean list of strokes for later recognition.
  eraseAt(p){
    const r = Math.max(6, this.width * 3);
    const before = this.doc.strokes.length;
    const kept = this.doc.strokes.filter(s =>
      s.hidden || !s.points.some(pt => Math.hypot(pt[0] - p.x, pt[1] - p.y) < r));
    // Erasing over a shape removes the shape and frees its original ink.
    const objBefore = this.doc.objects.length;
    this.doc.objects = this.doc.objects.filter(o => {
      const src = this.doc.strokes.find(x => x.id === o.fromStroke);
      const near = src && src.points.some(pt => Math.hypot(pt[0]-p.x, pt[1]-p.y) < r);
      if(near && src) src.hidden = true;      // stays hidden; the shape goes
      return !near;
    });
    if(kept.length !== before || this.doc.objects.length !== objBefore){
      if(this.undoStack[this.undoStack.length - 1] !== 'erasing'){ /* already pushed */ }
      this.doc.strokes = kept;
      this.redraw(); this.status();
    }
  },

  // --- rendering ----------------------------------------------------
  themeColour(){
    return getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eef4';
  },

  drawStroke(s, fromIndex){
    const ctx = this.ctx, v = this.doc.view;
    if(!ctx || !s || s.points.length < 2) return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = s.colour || this.themeColour();
    if(s.tool === 'highlighter'){
      ctx.globalAlpha = 0.28;
      ctx.globalCompositeOperation = 'source-over';
    }
    const start = Math.max(1, fromIndex | 0);
    for(let i = start; i < s.points.length; i++){
      const a = s.points[i - 1], b = s.points[i];
      // Width follows pressure, so a pen produces a natural taper.
      const press = this.pressureOn ? (a[2] + b[2]) / 2 : 0.5;
      ctx.lineWidth = s.width * (s.tool === 'highlighter' ? 4 : 1) * (0.45 + press * 1.1);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      // Quadratic through the midpoint removes the polyline look.
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      ctx.quadraticCurveTo(a[0], a[1], mx, my);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();
  },

  redraw(){
    if(!this.ctx || !this.cv) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.cv.width, this.cv.height);

    if(this.dragging){
      // Mid-drag: blit the cached page, then paint only what is moving.
      if(this.cacheDirty || !this.cache) this.rebuildCache();
      this.ctx.drawImage(this.cache, 0, 0);
      this.selectedElements().forEach(o => this.drawObject(o));
    } else {
      // A stroke replaced by a shape is hidden, never deleted.
      this.doc.strokes.forEach(s => { if(!s.hidden) this.drawStroke(s, 1); });
      this.doc.objects.forEach(o => this.drawObject(o));
      this.cacheDirty = true;
    }
    if(this.pending) this.drawObject(this.pending.shape, true);
    if(this.cur) this.drawStroke(this.cur, 1);
    if(this.selection) this.drawSelection();
    this.drawSelectionUI();
  },


  // Text objects were only ever data before; a diagram needs them drawn.
  drawTextObject(o){
    const ctx = this.ctx, v = this.doc.view;
    if(!ctx || !o.content) return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);
    ctx.fillStyle = o.colour || this.themeColour();
    const size = Math.max(11, o.fontSize || 14);
    ctx.font = `500 ${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const cx = o.x + (o.width || 0) / 2, cy = o.y + (o.height || 0) / 2;
    // Wrap to the width it was given rather than spilling out of its box.
    const words = String(o.content).split(/\s+/);
    const maxW = Math.max(24, o.width || 120);
    const lines = [];
    let line = '';
    words.forEach(w => {
      const t = line ? line + ' ' + w : w;
      if(ctx.measureText(t).width > maxW && line){ lines.push(line); line = w; }
      else line = t;
    });
    if(line) lines.push(line);
    ctx.textAlign = 'center';
    const lh = size * 1.25;
    const top = cy - (lines.length - 1) * lh / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, cx, top + i * lh));
    ctx.restore();
  },

  // Clean geometry from a recognised shape. Drawn in the same ink colour so
  // the page still reads as one hand.
  drawObject(o, preview){
    const ctx = this.ctx, v = this.doc.view;
    if(!ctx || !o) return;
    if(o.type === 'text'){ this.drawTextObject(o); return; }
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = preview ? (getComputedStyle(document.documentElement)
                                  .getPropertyValue('--amber').trim() || '#f2a71b')
                              : (o.colour || this.themeColour());
    ctx.lineWidth = (o.width || this.width) * 1.05;
    if(preview){ ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.9; }
    const g = o.geom || {};
    ctx.beginPath();
    switch(o.kind){
      case 'line':
        ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); break;
      case 'arrow': {
        ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2);
        const a = Math.atan2(g.y2-g.y1, g.x2-g.x1);
        const hl = Math.max(10, Math.hypot(g.x2-g.x1, g.y2-g.y1) * 0.13);
        ctx.moveTo(g.x2, g.y2);
        ctx.lineTo(g.x2 - Math.cos(a-0.42)*hl, g.y2 - Math.sin(a-0.42)*hl);
        ctx.moveTo(g.x2, g.y2);
        ctx.lineTo(g.x2 - Math.cos(a+0.42)*hl, g.y2 - Math.sin(a+0.42)*hl);
        break;
      }
      case 'circle':
        ctx.arc(g.cx, g.cy, Math.abs(g.r), 0, Math.PI*2); break;
      case 'ellipse':
        ctx.ellipse(g.cx, g.cy, Math.abs(g.rx), Math.abs(g.ry), 0, 0, Math.PI*2); break;
      case 'square':
      case 'rectangle':
        ctx.rect(g.x, g.y, g.w, g.h); break;
      case 'triangle':
        if(g.points?.length === 3){
          ctx.moveTo(g.points[0][0], g.points[0][1]);
          ctx.lineTo(g.points[1][0], g.points[1][1]);
          ctx.lineTo(g.points[2][0], g.points[2][1]);
          ctx.closePath();
        }
        break;
    }
    ctx.stroke();
    ctx.restore();
  },

  drawSelection(){
    const ctx = this.ctx, v = this.doc.view, s = this.selection;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() || '#f2a71b';
    ctx.lineWidth = 1 / v.zoom;
    ctx.setLineDash([5 / v.zoom, 4 / v.zoom]);
    ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
    ctx.restore();
  },

  // --- history ------------------------------------------------------
  // A snapshot must cover objects as well as strokes. Storing only strokes
  // meant moving, deleting or recognising a shape could not be undone at all.
  snapshot(){
    return JSON.stringify({ s: this.doc.strokes, o: this.doc.objects });
  },
  restore(json){
    const d = JSON.parse(json);
    this.doc.strokes = d.s || [];
    this.doc.objects = d.o || [];
    // Anything that vanished cannot stay selected.
    const live = new Set(this.doc.objects.map(o => o.id));
    this.sel = new Set([...this.sel].filter(id => live.has(id)));
    this.cacheDirty = true;
  },
  pushUndo(){
    this.undoStack.push(this.snapshot());
    if(this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  },
  undo(){
    if(!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    this.redraw(); this.markDirty(); this.status();
  },
  redo(){
    if(!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    this.redraw(); this.markDirty(); this.status();
  },
  clear(){
    if(!this.doc.strokes.length && !this.doc.objects.length) return;
    if(!confirm('Erase all ink and shapes on this note? The typed text is not affected.')) return;
    this.pushUndo();
    this.doc.strokes = [];
    this.doc.objects = [];
    this.sel.clear();
    this.redraw(); this.markDirty(); this.status();
  },


  // --- Smart Ink ------------------------------------------------------
  smartInk: true,      // shapes tidy on release unless switched off
  pending: null,          // a medium-confidence shape awaiting a decision
  recTimer: null,

  scheduleRecognise(stroke){
    clearTimeout(this.recTimer);
    const id = stroke.id;
    this.recTimer = setTimeout(() => this.recogniseStroke(id), 220);
  },

  recogniseStroke(strokeId){
    const s = this.doc.strokes.find(x => x.id === strokeId);
    if(!s || s.hidden || s.recognisedAs) return;
    const res = ShapeRec.recognise(s.points);
    if(!res) return;

    const shape = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      type: 'shape', kind: res.kind, geom: res.geom,
      colour: s.colour, width: s.width,
      fromStroke: s.id, confidence: +res.confidence.toFixed(3), t: Date.now(),
    };

    if(res.confidence >= ShapeRec.HIGH){
      this.commitShape(shape);                 // clear enough to just do it
    } else if(res.confidence >= ShapeRec.MED){
      this.pending = { shape, strokeId: s.id };  // offer it, do not impose it
      this.showShapePrompt(res.kind, res.confidence);
      this.redraw();
    }
    // Below medium: the original stroke stands, silently.
  },

  commitShape(shape){
    this.pushUndo();
    const s = this.doc.strokes.find(x => x.id === shape.fromStroke);
    if(s){ s.hidden = true; s.recognisedAs = shape.id; }   // kept, not deleted
    this.doc.objects.push(shape);
    this.pending = null;
    this.hideShapePrompt();
    this.redraw(); this.markDirty(); this.status();
  },

  rejectShape(){
    this.pending = null;
    this.hideShapePrompt();
    this.redraw();
  },

  // Turn a recognised shape back into the ink it came from.
  revertShape(objectId){
    const i = this.doc.objects.findIndex(o => o.id === objectId);
    if(i < 0) return;
    this.pushUndo();
    const o = this.doc.objects[i];
    const s = this.doc.strokes.find(x => x.id === o.fromStroke);
    if(s){ delete s.hidden; delete s.recognisedAs; }
    this.doc.objects.splice(i, 1);
    this.redraw(); this.markDirty(); this.status();
  },

  // Undo the most recent recognition, which is what a user reaches for.
  revertLast(){
    const last = this.doc.objects[this.doc.objects.length - 1];
    if(!last){ return false; }
    this.revertShape(last.id);
    return true;
  },

  showShapePrompt(kind, confidence){
    const el = document.getElementById('ink-prompt');
    if(!el) return;
    el.innerHTML = `<span>Make this a ${escapeHtml(kind)}? <b>${Math.round(confidence*100)}%</b></span>`
      + `<button class="ink-yes" id="ink-accept">Yes</button>`
      + `<button class="ink-no" id="ink-decline">Keep ink</button>`;
    el.style.display = 'flex';
    el.querySelector('#ink-accept').addEventListener('click', () => {
      if(this.pending) this.commitShape(this.pending.shape);
    });
    el.querySelector('#ink-decline').addEventListener('click', () => this.rejectShape());
    clearTimeout(this._promptTimer);
    // If it is ignored, the original ink simply stays.
    this._promptTimer = setTimeout(() => this.rejectShape(), 6000);
  },
  hideShapePrompt(){
    clearTimeout(this._promptTimer);
    const el = document.getElementById('ink-prompt');
    if(el){ el.style.display = 'none'; el.innerHTML = ''; }
  },







  // --- Building a diagram (Phase 3) -----------------------------------
  // Everything a diagram produces is an ordinary element. There is no special
  // "TARS diagram" object, which is precisely why the result is editable:
  // Phase 1 selects and moves it, Phase 2 keeps its arrows attached.
  buildDiagram(spec){
    const laid = Layout.flow(spec, this.viewOrigin());
    if(!laid.boxes.length) return { ok:false, reason:'no nodes' };
    this.pushUndo();

    const nid = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const made = [], byNode = {};

    laid.boxes.forEach(b => {
      const shape = {
        id: nid(), type:'shape',
        // A decision reads better as an ellipse; everything else is a box.
        kind: b.kind === 'decision' ? 'ellipse' : 'rectangle',
        geom: b.kind === 'decision'
          ? { cx:b.x + b.w/2, cy:b.y + b.h/2, rx:b.w/2, ry:b.h/2 }
          : { x:b.x, y:b.y, w:b.w, h:b.h },
        colour: this.colour, width: this.width, source:'diagram', t: Date.now(),
      };
      const label = {
        id: nid(), type:'text', content: b.label,
        x: b.x + 8, y: b.y + b.h/2 - 9,
        width: b.w - 16, height: 18,
        containerId: shape.id, source:'diagram', t: Date.now(),
      };
      this.doc.objects.push(shape, label);
      made.push(shape.id, label.id);
      byNode[b.id] = shape.id;
      this.moveBoundText(shape);
    });

    (spec.edges || []).forEach(e => {
      const from = byNode[e.from], to = byNode[e.to];
      if(!from || !to || from === to) return;
      const arrow = {
        id: nid(), type:'shape', kind:'arrow',
        geom: { x1:0, y1:0, x2:0, y2:0 },
        startBinding: from, endBinding: to,     // bound from birth
        colour: this.colour, width: this.width, source:'diagram', t: Date.now(),
      };
      this.doc.objects.push(arrow);
      made.push(arrow.id);
      this.refreshArrow(arrow);
    });

    this.sel = new Set(made);
    this.cacheDirty = true;
    this.show(true);
    this.redraw(); this.markDirty(); this.status();
    return { ok:true, nodes: laid.boxes.length, edges: (spec.edges || []).length };
  },

  // Place a new diagram where the user is currently looking.
  viewOrigin(){
    const r = this.cv ? this.cv.getBoundingClientRect() : { width:600, height:400 };
    const v = this.doc.view;
    return { x: (20 - v.panX) / v.zoom, y: (20 - v.panY) / v.zoom };
  },

  // --- z-order, style, clipboard ---------------------------------------
  raise(toTop){
    if(!this.sel.size) return false;
    this.pushUndo();
    const sel = this.doc.objects.filter(o => this.sel.has(o.id));
    const rest = this.doc.objects.filter(o => !this.sel.has(o.id));
    this.doc.objects = toTop ? [...rest, ...sel] : [...sel, ...rest];
    this.cacheDirty = true;
    this.redraw(); this.markDirty();
    return true;
  },

  styleSelected(patch){
    if(!this.sel.size) return false;
    this.pushUndo();
    this.selectedElements().forEach(o => Object.assign(o, patch));
    this.cacheDirty = true;
    this.redraw(); this.markDirty();
    return true;
  },

  clipboard: null,
  copySelected(){
    if(!this.sel.size) return false;
    this.clipboard = JSON.stringify(this.selectedElements());
    return true;
  },
  paste(){
    if(!this.clipboard) return false;
    let items;
    try{ items = JSON.parse(this.clipboard); }catch(e){ return false; }
    if(!items.length) return false;
    this.pushUndo();
    // Ids are remapped so pasted containers and bindings point at the copies,
    // not at the originals.
    const map = {};
    // The counter must advance per item. Reading it from the map before the
    // map was written gave every copy in one paste the same suffix, so a
    // pasted arrow still pointed at the original box.
    let seq = 0;
    const copies = items.map(o => {
      const cl = JSON.parse(JSON.stringify(o));
      cl.id = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2,6) + (seq++);
      map[o.id] = cl.id;
      delete cl.fromStroke; delete cl.recognisedAs;
      Geo.move(cl, 20, 20);
      return cl;
    });
    copies.forEach(cl => {
      if(cl.containerId) cl.containerId = map[cl.containerId] || null;
      if(cl.startBinding) cl.startBinding = map[cl.startBinding] || null;
      if(cl.endBinding) cl.endBinding = map[cl.endBinding] || null;
    });
    this.doc.objects.push(...copies);
    this.sel = new Set(copies.map(o => o.id));
    this.refreshBindings(copies.map(o => o.id));
    this.cacheDirty = true;
    this.redraw(); this.markDirty(); this.status();
    return true;
  },

  // --- Bindings, resize, snapping (Phase 2) ---------------------------
  // A bound arrow stores which elements it joins, not fixed coordinates, and
  // recomputes its ends whenever either moves. The payoff is not only that
  // dragging feels right: NotePage.graph() can now READ the connections
  // instead of inferring them from how close the ends happen to land.
  BIND_TOL: 22,

  bindableAt(p, exceptId){
    const objs = (this.doc.objects || []).filter(o =>
      o.id !== exceptId && o.kind !== 'arrow' && o.kind !== 'line');
    const tol = this.BIND_TOL / Math.max(0.35, this.doc.view.zoom);
    for(let i = objs.length - 1; i >= 0; i--){
      if(Geo.hit(objs[i], p.x, p.y, tol)) return objs[i];
    }
    return null;
  },

  // Attach an arrow's ends to whatever they were dropped on.
  bindArrow(arrow){
    if(!arrow || (arrow.kind !== 'arrow' && arrow.kind !== 'line')) return;
    const g = arrow.geom;
    const a = this.bindableAt({ x:g.x1, y:g.y1 }, arrow.id);
    const b = this.bindableAt({ x:g.x2, y:g.y2 }, arrow.id);
    arrow.startBinding = a ? a.id : null;
    arrow.endBinding   = b && b.id !== (a && a.id) ? b.id : null;
    this.refreshArrow(arrow);
  },

  // Recompute a bound arrow's endpoints from its anchors.
  refreshArrow(arrow){
    const g = arrow.geom;
    if(!g) return;
    const byId = id => (this.doc.objects || []).find(o => o.id === id);
    const from = arrow.startBinding ? byId(arrow.startBinding) : null;
    const to   = arrow.endBinding ? byId(arrow.endBinding) : null;
    if(!from && !to) return;
    // Aim each end at the other anchor's centre, or at the free endpoint.
    const target = to ? Geo.centre(to) : { x:g.x2, y:g.y2 };
    const source = from ? Geo.centre(from) : { x:g.x1, y:g.y1 };
    if(from){ const p = Geo.exitPoint(from, target.x, target.y); g.x1 = p.x; g.y1 = p.y; }
    if(to){   const p = Geo.exitPoint(to, source.x, source.y);   g.x2 = p.x; g.y2 = p.y; }
  },

  // After anything moves or resizes, every arrow touching it is redrawn.
  refreshBindings(changedIds){
    const ids = changedIds ? new Set(changedIds) : null;
    (this.doc.objects || []).forEach(o => {
      if(o.kind !== 'arrow' && o.kind !== 'line') return;
      if(!o.startBinding && !o.endBinding) return;
      if(ids && !ids.has(o.startBinding) && !ids.has(o.endBinding) && !ids.has(o.id)) return;
      this.refreshArrow(o);
    });
  },

  // --- resize handles --------------------------------------------------
  HANDLE: 5,               // drawn radius; the hit area is larger
  handlesFor(els){
    if(!els.length) return [];
    // One box around the whole selection: resizing a group behaves like
    // resizing one thing.
    let b = Geo.bounds(els[0]);
    els.slice(1).forEach(el => {
      const o = Geo.bounds(el);
      b = { x0:Math.min(b.x0,o.x0), y0:Math.min(b.y0,o.y0),
            x1:Math.max(b.x1,o.x1), y1:Math.max(b.y1,o.y1) };
    });
    const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
    return [
      { id:'nw', x:b.x0, y:b.y0 }, { id:'n', x:mx, y:b.y0 }, { id:'ne', x:b.x1, y:b.y0 },
      { id:'w',  x:b.x0, y:my   },                            { id:'e', x:b.x1, y:my   },
      { id:'sw', x:b.x0, y:b.y1 }, { id:'s', x:mx, y:b.y1 }, { id:'se', x:b.x1, y:b.y1 },
    ].map(hd => ({ ...hd, box:b }));
  },

  handleAt(p){
    const els = this.selectedElements();
    if(!els.length) return null;
    // A generous hit area: 5px handles are unusable with a stylus.
    const tol = 12 / Math.max(0.35, this.doc.view.zoom);
    return this.handlesFor(els).find(hd => Math.abs(p.x - hd.x) <= tol && Math.abs(p.y - hd.y) <= tol) || null;
  },

  applyResize(hd, p){
    const els = this.selectedElements();
    if(!els.length) return;
    const b = { ...hd.box };
    if(hd.id.includes('n')) b.y0 = p.y;
    if(hd.id.includes('s')) b.y1 = p.y;
    if(hd.id.includes('w')) b.x0 = p.x;
    if(hd.id.includes('e')) b.x1 = p.x;
    // Dragging past the opposite edge must not invert the shape.
    if(b.x1 - b.x0 < 8) b.x1 = b.x0 + 8;
    if(b.y1 - b.y0 < 8) b.y1 = b.y0 + 8;

    const old = hd.box;
    const sx = (b.x1 - b.x0) / Math.max(1e-6, old.x1 - old.x0);
    const sy = (b.y1 - b.y0) / Math.max(1e-6, old.y1 - old.y0);
    els.forEach(el => {
      const eb = Geo.bounds(el);
      Geo.resizeTo(el, {
        x0: b.x0 + (eb.x0 - old.x0) * sx, y0: b.y0 + (eb.y0 - old.y0) * sy,
        x1: b.x0 + (eb.x1 - old.x0) * sx, y1: b.y0 + (eb.y1 - old.y0) * sy,
      });
      this.moveBoundText(el);
    });
    this.refreshBindings(els.map(e => e.id));
  },

  // --- bound text ------------------------------------------------------
  // A label that belongs to a shape: it centres itself in the shape and
  // travels with it, so a labelled box behaves as one object.
  boundTextOf(el){
    return (this.doc.objects || []).find(o => o.type === 'text' && o.containerId === el.id) || null;
  },
  moveBoundText(el){
    const t = this.boundTextOf(el);
    if(!t) return;
    const c = Geo.centre(el);
    t.x = c.x - (t.width || 0) / 2;
    t.y = c.y - (t.height || 0) / 2;
  },
  attachText(textEl, container){
    if(!textEl || !container) return;
    textEl.containerId = container.id;
    this.moveBoundText(container);
  },

  // --- snapping --------------------------------------------------------
  // Aligns to other elements' edges and centres while dragging. Deliberately
  // tight, so it assists rather than fights.
  SNAP: 6,
  snapDelta(els){
    if(!els.length || this.snapOff) return { dx:0, dy:0 };
    const moving = els.map(e => e.id);
    const others = (this.doc.objects || []).filter(o => !moving.includes(o.id));
    if(!others.length) return { dx:0, dy:0 };
    let b = Geo.bounds(els[0]);
    els.slice(1).forEach(el => {
      const o = Geo.bounds(el);
      b = { x0:Math.min(b.x0,o.x0), y0:Math.min(b.y0,o.y0),
            x1:Math.max(b.x1,o.x1), y1:Math.max(b.y1,o.y1) };
    });
    const tol = this.SNAP / Math.max(0.35, this.doc.view.zoom);
    const xs = [b.x0, (b.x0+b.x1)/2, b.x1], ys = [b.y0, (b.y0+b.y1)/2, b.y1];
    let dx = 0, dy = 0, bx = tol, by = tol;
    others.forEach(o => {
      const ob = Geo.bounds(o);
      [ob.x0, (ob.x0+ob.x1)/2, ob.x1].forEach(ox => xs.forEach(x => {
        const d = ox - x;
        if(Math.abs(d) < bx){ bx = Math.abs(d); dx = d; }
      }));
      [ob.y0, (ob.y0+ob.y1)/2, ob.y1].forEach(oy => ys.forEach(y => {
        const d = oy - y;
        if(Math.abs(d) < by){ by = Math.abs(d); dy = d; }
      }));
    });
    return { dx, dy };
  },

  // --- Selection and moving (Phase 1) ---------------------------------
  // Element ids, kept apart from `selection` (the handwriting marquee) so the
  // recognition flow is untouched.
  sel: new Set(),
  dragging: null,        // { from:{x,y}, moved:false }
  resizing: null,        // { handle }
  marquee: null,

  // Topmost first: later objects are drawn on top, so they are hit first.
  elementAt(p){
    const objs = this.doc.objects || [];
    const tol = 8 / Math.max(0.35, this.doc.view.zoom);
    for(let i = objs.length - 1; i >= 0; i--){
      if(Geo.hit(objs[i], p.x, p.y, tol)) return objs[i];
    }
    return null;
  },

  selectedElements(){ return (this.doc.objects || []).filter(o => this.sel.has(o.id)); },

  setSelection(ids, additive){
    if(!additive) this.sel.clear();
    ids.forEach(id => this.sel.add(id));
    this.cacheDirty = true;
    this.redraw(); this.status();
  },
  clearElementSelection(){
    if(!this.sel.size) return;
    this.sel.clear(); this.cacheDirty = true; this.redraw(); this.status();
  },

  deleteSelected(){
    if(!this.sel.size) return false;
    this.pushUndo();
    // Removing a shape frees the ink it came from, so the original stroke
    // reappears rather than vanishing with it.
    this.doc.objects.filter(o => this.sel.has(o.id)).forEach(o => {
      const src = this.doc.strokes.find(s => s.id === o.fromStroke);
      if(src){ delete src.hidden; delete src.recognisedAs; }
    });
    const gone = new Set([...this.sel]);
    this.doc.objects = this.doc.objects.filter(o => !gone.has(o.id));
    // An arrow bound to something that no longer exists must forget it,
    // rather than keep pointing at a ghost.
    this.doc.objects.forEach(o => {
      if(gone.has(o.startBinding)) o.startBinding = null;
      if(gone.has(o.endBinding)) o.endBinding = null;
      if(gone.has(o.containerId)) o.containerId = null;
    });
    this.sel.clear();
    this.cacheDirty = true;
    this.redraw(); this.markDirty(); this.status();
    return true;
  },

  duplicateSelected(){
    if(!this.sel.size) return false;
    this.pushUndo();
    // Duplicating shares the paste path so bindings and labels are remapped
    // too; duplicating a labelled box used to leave the copy's label attached
    // to the original.
    const map = {};
    let seq = 0;
    const copies = this.selectedElements().map(o => {
      const clone = JSON.parse(JSON.stringify(o));
      clone.id = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2,5) + (seq++);
      map[o.id] = clone.id;
      delete clone.fromStroke; delete clone.recognisedAs;   // a copy owns no ink
      Geo.move(clone, 16, 16);
      return clone;
    });
    copies.forEach(cl => {
      if(cl.containerId) cl.containerId = map[cl.containerId] || null;
      if(cl.startBinding) cl.startBinding = map[cl.startBinding] || null;
      if(cl.endBinding) cl.endBinding = map[cl.endBinding] || null;
    });
    this.doc.objects.push(...copies);
    this.sel = new Set(copies.map(o => o.id));
    this.refreshBindings(copies.map(o => o.id));
    this.cacheDirty = true;
    this.redraw(); this.markDirty(); this.status();
    return true;
  },

  nudge(dx, dy){
    if(!this.sel.size) return false;
    this.pushUndo();
    const els = this.selectedElements();
    els.forEach(o => { Geo.move(o, dx, dy); this.moveBoundText(o); });
    this.refreshBindings(els.map(o => o.id));
    this.cacheDirty = true;
    this.redraw(); this.markDirty();
    return true;
  },

  // --- two-layer rendering -------------------------------------------
  // Everything not being dragged is painted once into an offscreen canvas.
  // Without this, every drag frame redraws every stroke on the page, which is
  // the first thing that would feel slow.
  cacheDirty: true,
  cache: null,

  rebuildCache(){
    if(!this.cv) return;
    if(!this.cache) this.cache = document.createElement('canvas');
    this.cache.width = this.cv.width;
    this.cache.height = this.cv.height;
    const g = this.cache.getContext('2d');
    g.clearRect(0, 0, this.cache.width, this.cache.height);
    const real = this.ctx;
    this.ctx = g;                              // paint into the cache
    this.doc.strokes.forEach(s => { if(!s.hidden) this.drawStroke(s, 1); });
    this.doc.objects.forEach(o => { if(!this.dragging || !this.sel.has(o.id)) this.drawObject(o); });
    this.ctx = real;
    this.cacheDirty = false;
  },

  drawSelectionUI(){
    const ctx = this.ctx, v = this.doc.view;
    const els = this.selectedElements();
    if(!els.length && !this.marquee) return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);
    const amber = getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() || '#f2a71b';
    ctx.strokeStyle = amber;
    ctx.lineWidth = 1 / v.zoom;
    els.forEach(el => {
      const b = Geo.bounds(el);
      const pad = 4 / v.zoom;
      ctx.setLineDash([4 / v.zoom, 3 / v.zoom]);
      ctx.strokeRect(b.x0 - pad, b.y0 - pad, (b.x1-b.x0) + pad*2, (b.y1-b.y0) + pad*2);
    });
    // Handles on the selection as a whole, drawn last so they sit on top.
    if(els.length && !this.dragging){
      ctx.setLineDash([]);
      const r = this.HANDLE / v.zoom;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0e10';
      this.handlesFor(els).forEach(hd => {
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.rect(hd.x - r, hd.y - r, r*2, r*2); ctx.fill(); ctx.stroke();
      });
    }
    if(this.marquee){
      const m = this.marquee;
      ctx.setLineDash([5 / v.zoom, 4 / v.zoom]);
      ctx.strokeRect(Math.min(m.x0,m.x1), Math.min(m.y0,m.y1),
                     Math.abs(m.x1-m.x0), Math.abs(m.y1-m.y0));
    }
    ctx.restore();
  },

  // --- Preset shapes ---------------------------------------------------
  // Drop a clean shape without drawing it. Placed at the centre of the current
  // view so it lands where the user is looking, and sized to the viewport.
  insertShape(kind){
    const cv = this.cv;
    if(!cv) return;
    const r = cv.getBoundingClientRect();
    const v = this.doc.view;
    const cx = (r.width / 2 - v.panX) / v.zoom;
    const cy = (r.height / 2 - v.panY) / v.zoom;
    const s = Math.min(r.width, r.height) / v.zoom * 0.22;
    let geom;
    switch(kind){
      case 'arrow':
      case 'line':      geom = { x1:cx-s, y1:cy, x2:cx+s, y2:cy }; break;
      case 'circle':    geom = { cx, cy, r:s*0.7 }; break;
      case 'ellipse':   geom = { cx, cy, rx:s, ry:s*0.6 }; break;
      case 'triangle':  geom = { points:[[cx, cy-s*0.8],[cx+s*0.9, cy+s*0.7],[cx-s*0.9, cy+s*0.7]] }; break;
      case 'square':    geom = { x:cx-s*0.7, y:cy-s*0.7, w:s*1.4, h:s*1.4 }; break;
      default:          geom = { x:cx-s, y:cy-s*0.6, w:s*2, h:s*1.2 }; kind = 'rectangle';
    }
    this.pushUndo();
    this.doc.objects.push({
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      type:'shape', kind, geom, colour:this.colour, width:this.width,
      source:'preset', t:Date.now(),
    });
    this.redraw(); this.markDirty(); this.status();
    SFX.tick();
  },

  // --- Recognition context (Phase 4) ---------------------------------
  // Supplies vocabulary that is likely to appear, so the model spells
  // "Hoymiles" and "sobretensão" correctly rather than inventing plausible
  // alternatives. Deliberately a SPELLING aid, never an expectation: the
  // server prompt forbids inserting a term that is not on the page, and this
  // side keeps the list short so it cannot dominate what is actually written.
  contextOn: true,

  // Words worth passing: proper nouns, codes, and domain terms. Ordinary
  // words are dropped because they only dilute the list.
  distinctive(text, out){
    String(text || '')
      .split(/[^\p{L}\p{N}._-]+/u)
      .forEach(w => {
        if(w.length < 3 || w.length > 28) return;
        const hasDigit = /\d/.test(w);
        const capitalised = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(w);
        const code = /^[A-Za-z]{1,3}[-_]?\d{2,}$/.test(w);
        if(hasDigit || capitalised || code) out.add(w);
      });
  },

  buildContext(){
    if(!this.contextOn) return '';
    const terms = new Set();
    const lines = [];

    // 1. Whatever is already written on this page — by far the best signal,
    //    because handwriting is usually consistent within a note.
    const ed = document.getElementById('notebook-canvas');
    const pageText = ed ? (ed.innerText || '').trim() : '';
    if(pageText) this.distinctive(pageText.slice(0, 1500), terms);

    // 2. Text already recognised from ink on this same page.
    this.doc.objects.filter(o => o.type === 'text')
      .forEach(o => this.distinctive(o.content, terms));

    // 3. Where the note lives.
    const nb = notebooks.find(x => x.id === activeFolderId);
    const noteTitle = document.getElementById('nb-title-input')?.value || '';
    if(nb?.title) { lines.push(`Notebook: ${nb.title}`); this.distinctive(nb.title, terms); }
    if(noteTitle) this.distinctive(noteTitle, terms);

    // 4. What the technician is actually working on right now.
    const focus = (typeof Focus !== 'undefined' && Focus.current) ? Focus.current : null;
    if(focus?.label){ lines.push(`Working on: ${focus.label}`); this.distinctive(focus.label, terms); }
    const cse = TarsContext.selectedCaseId
      ? cases.find(x => x.id === TarsContext.selectedCaseId) : null;
    if(cse){
      if(cse.ticket) terms.add(cse.ticket);
      this.distinctive(cse.titulo, terms);
    }

    // 5. Manufacturer and domain vocabulary, taken from the knowledge base
    //    rather than hard-coded, so it follows whatever the team actually
    //    documents.
    const kbTerms = new Set();
    (KB || []).forEach(e => {
      (e.tags || []).forEach(t => { if(String(t).length > 2) kbTerms.add(String(t)); });
      this.distinctive(e.title, kbTerms);
    });
    const kbList = [...kbTerms].slice(0, 60);

    const own = [...terms].slice(0, 45);
    if(own.length) lines.push('Terms already on this page or case: ' + own.join(', '));
    if(kbList.length) lines.push('Known equipment and fault codes: ' + kbList.join(', '));

    return lines.join('\n').slice(0, 880);
  },

  // --- Handwriting (Phase 3) -----------------------------------------
  // Nothing is converted automatically. The user selects ink, asks for
  // recognition, reviews and corrects the result, and only then commits.
  // The raw strokes are never altered by any of it.
  selection: null,        // {x0,y0,x1,y1} in document space
  selecting: false,
  recognising: false,
  review: null,           // { text, strokeIds, box, model }

  selectedStrokes(){
    const s = this.selection;
    if(!s) return [];
    const inBox = p => p[0] >= s.x0 && p[0] <= s.x1 && p[1] >= s.y0 && p[1] <= s.y1;
    // A stroke counts as selected if most of it lies inside, so a rectangle
    // does not have to be drawn perfectly around the writing.
    return this.doc.strokes.filter(k => {
      if(k.hidden) return false;
      const inside = k.points.filter(inBox).length;
      return inside > k.points.length * 0.6;
    });
  },

  selectAllInk(){
    const live = this.doc.strokes.filter(s => !s.hidden);
    if(!live.length){ this.selection = null; this.redraw(); return 0; }
    const b = ShapeRec.bbox(live.flatMap(s => s.points));
    const pad = 8;
    this.selection = { x0:b.x0-pad, y0:b.y0-pad, x1:b.x1+pad, y1:b.y1+pad };
    this.redraw(); this.updateHandBar();
    return live.length;
  },

  clearSelection(){ this.selection = null; this.redraw(); this.updateHandBar(); },

  // Render the chosen strokes as black on white at a generous scale. Vision
  // models read that far better than pale ink on the app's dark theme, and the
  // vectors mean it can be rasterised at whatever resolution helps.
  renderForRecognition(strokes){
    if(!strokes.length) return null;
    const b = ShapeRec.bbox(strokes.flatMap(s => s.points));
    const pad = 24;
    const targetW = 1400;
    const scale = Math.max(1, Math.min(4, targetW / Math.max(1, b.w + pad*2)));
    const cv = document.createElement('canvas');
    cv.width = Math.round((b.w + pad*2) * scale);
    cv.height = Math.round((b.h + pad*2) * scale);
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#111111';
    g.lineCap = 'round'; g.lineJoin = 'round';
    strokes.forEach(s => {
      for(let i = 1; i < s.points.length; i++){
        const a = s.points[i-1], p = s.points[i];
        g.lineWidth = Math.max(2, s.width * scale * 0.9);
        g.beginPath();
        g.moveTo((a[0]-b.x0+pad)*scale, (a[1]-b.y0+pad)*scale);
        g.lineTo((p[0]-b.x0+pad)*scale, (p[1]-b.y0+pad)*scale);
        g.stroke();
      }
    });
    const url = cv.toDataURL('image/png');    // lossless: ink has hard edges
    cv.width = cv.height = 0;
    return { url, box: b };
  },

  async recogniseHandwriting(){
    const strokes = this.selection ? this.selectedStrokes() : this.doc.strokes.filter(s => !s.hidden);
    if(!strokes.length){ alert('Select some handwriting first, or press "All ink".'); return; }
    const shot = this.renderForRecognition(strokes);
    if(!shot){ alert('Nothing to read.'); return; }

    this.recognising = true;
    this.updateHandBar();
    try{
      const r = await fetch(FN_URL + "/agenda-vision", {
        method:'POST', headers: authHeaders(),
        body: JSON.stringify({ image: shot.url, mode:'handwriting',
                               context: this.buildContext(),
                               reference: Handwriting.buildSheet() || undefined }),
      });
      const out = await readJson(r);
      if(!out.ok){
        const why = out.json.code === 'no_model'
          ? 'No vision model is available on the Groq account. ' + (out.json.detail || '')
          : (out.json.error || 'Recognition failed.');
        alert(why);
        return;
      }
      const text = String(out.json.reply || '').trim();
      if(!text){ alert('Nothing legible was returned. Try selecting a smaller area.'); return; }
      this.review = { text, strokeIds: strokes.map(s => s.id), box: shot.box,
                      model: out.json.model, context: this.buildContext() };
      this.showReview();
    }catch(e){
      alert('Could not reach the recognition service.');
    }finally{
      this.recognising = false;
      this.updateHandBar();
    }
  },

  showReview(){
    const el = document.getElementById('ink-review');
    if(!el || !this.review) return;
    el.style.display = 'block';
    el.innerHTML = `
      <div class="rev-head">
        <b>Check the transcription</b>
        <span class="rev-model">${escapeHtml(String(this.review.model || '').split('/').pop())}</span>
      </div>
      <div class="rev-unsure" id="rev-unsure" style="display:none"></div>
      <textarea id="rev-text" class="rev-text" spellcheck="false"></textarea>
      <label class="rev-keep"><input type="checkbox" id="rev-keep-ink" checked> Keep the handwriting visible as well</label>
      ${this.review.context ? `<details class="rev-ctx"><summary>Vocabulary given to the reader</summary><pre>${escapeHtml(this.review.context)}</pre></details>` : ''}
      <div class="rev-actions">
        <button class="btn-ghost" id="rev-cancel">Cancel</button>
        <button class="btn-ghost" id="rev-retry">Try again</button>
        <button class="btn-primary" id="rev-commit">Insert as text</button>
      </div>`;
    const ta = el.querySelector('#rev-text');
    ta.value = this.review.text;
    // The prompt asks for [?] on illegible words; surfacing the count tells
    // the user where to look rather than making them re-read everything.
    const unsure = (this.review.text.match(/\[\?\]/g) || []).length;
    const warn = el.querySelector('#rev-unsure');
    if(warn && unsure){
      warn.style.display = 'block';
      warn.textContent = `${unsure} word${unsure > 1 ? 's' : ''} could not be read — marked [?]. Fix them before inserting.`;
    }
    ta.focus();
    el.querySelector('#rev-cancel').addEventListener('click', () => this.hideReview());
    el.querySelector('#rev-retry').addEventListener('click', () => { this.hideReview(); this.recogniseHandwriting(); });
    el.querySelector('#rev-commit').addEventListener('click', () => {
      // A correction here is the most valuable teaching signal available, so
      // it is offered for saving rather than discarded.
      const original = this.review.text, edited = ta.value;
      const ids = this.review.strokeIds.slice();
      this.commitText(edited, el.querySelector('#rev-keep-ink').checked);
      if(original.trim() !== edited.trim() && edited.trim()){
        setTimeout(() => {
          if(confirm('You corrected the transcription.\n\nTeach TARS this handwriting so it reads better next time?'))
            Handwriting.learnCorrection(original, edited, ids).then(ok => {
              if(ok) addProactiveMessage('Learned that handwriting. Future readings will use it as a reference.');
            });
        }, 120);
      }
    });
  },
  hideReview(){
    this.review = null;
    const el = document.getElementById('ink-review');
    if(el){ el.style.display = 'none'; el.innerHTML = ''; }
  },

  commitText(text, keepInk){
    if(!this.review) return;
    const clean = String(text || '').trim();
    if(!clean){ this.hideReview(); return; }
    this.pushUndo();
    const b = this.review.box;
    // Spatial metadata now, so Phase 5 search can point at where it was written.
    const obj = {
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      type: 'text', content: clean,
      x: +b.x0.toFixed(1), y: +b.y0.toFixed(1),
      width: +b.w.toFixed(1), height: +b.h.toFixed(1),
      fromStrokes: this.review.strokeIds.slice(),
      source: 'handwriting', model: this.review.model, t: Date.now(),
    };
    this.doc.objects.push(obj);
    if(!keepInk){
      // Hidden, never deleted: re-recognition and later models still need it.
      this.review.strokeIds.forEach(id => {
        const s = this.doc.strokes.find(x => x.id === id);
        if(s){ s.hidden = true; s.recognisedAs = obj.id; }
      });
    }
    // The text also lands in the note body, where it is editable like any text.
    const ed = document.getElementById('notebook-canvas');
    if(ed){
      const block = document.createElement('div');
      clean.split(/\n/).forEach(line => {
        const p = document.createElement('p');
        p.textContent = line;
        block.appendChild(p);
      });
      ed.appendChild(block);
    }
    this.hideReview();
    this.clearSelection();
    this.redraw(); this.markDirty(); this.status();
  },

  updateHandBar(){
    const bar = document.getElementById('ink-hand');
    if(!bar) return;
    const n = this.selection ? this.selectedStrokes().length : this.doc.strokes.filter(s => !s.hidden).length;
    const btn = document.getElementById('hand-read');
    if(btn){
      btn.disabled = this.recognising || !n;
      btn.textContent = this.recognising ? 'Reading…' : `Recognise handwriting (${n})`;
    }
    const clr = document.getElementById('hand-clear');
    if(clr) clr.style.display = this.selection ? 'inline-block' : 'none';
  },

  // --- persistence --------------------------------------------------
  markDirty(){
    this.dirty = true;
    const s = document.getElementById('notebook-status');
    if(s) s.textContent = 'Unsaved';
    // The editor's autosave is scheduleNotebookSave; calling a name that does
    // not exist threw on every stroke and left ink unsaved.
    if(typeof scheduleNotebookSave === 'function') scheduleNotebookSave();
  },
  serialise(){
    return this.doc.strokes.length || this.doc.objects.length
      ? JSON.stringify({ ...this.doc, view: undefined })   // view is per-session
      : null;
  },
  load(raw){
    this.sel.clear(); this.cacheDirty = true;
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.doc = { v:1, strokes: [], objects: [], view: { zoom:1, panX:0, panY:0 } };
    if(raw){
      try{
        const d = JSON.parse(raw);
        if(d && Array.isArray(d.strokes)){
          this.doc.strokes = d.strokes;
          this.doc.objects = Array.isArray(d.objects) ? d.objects : [];
        }
      }catch(e){ /* an unreadable ink blob must not break the note */ }
    }
    this.dirty = false;
    this.resize();
    this.status();
  },

  status(){
    const el = document.getElementById('ink-info');
    const ink = this.doc.strokes.filter(s => !s.hidden).length;
    if(el) el.textContent = `${ink} strokes`
      + (this.doc.objects.length ? ` · ${this.doc.objects.length} shapes` : '')
      + (this.sel.size ? ` · ${this.sel.size} selected` : '')
      + ` · ${Math.round(this.doc.view.zoom * 100)}%`;
  },

  show(on){
    this.active = on;
    const wrap = document.getElementById('ink-wrap');
    if(wrap) wrap.style.display = on ? 'block' : 'none';
    const btn = document.getElementById('nb-ink-toggle');
    if(btn) btn.classList.toggle('active', on);
    if(on){ this.mount(); this.resize(); this.updateHandBar(); renderInkColours(); }
  },
};




// --- handwriting drill -----------------------------------------------
// A small pad of its own, deliberately separate from the note canvas: this is
// teaching, not note-taking, and mixing the two would put practice strokes
// into real notes.
const HwPad = {
  cv: null, ctx: null, strokes: [], cur: null, drawing: false, idx: -1, dpr: 1,

  mount(){
    this.cv = document.getElementById('hw-canvas');
    if(!this.cv || this.cv._bound) return;
    this.cv._bound = true;
    this.ctx = this.cv.getContext('2d');
    this.fit();
    const pt = e => {
      const r = this.cv.getBoundingClientRect();
      return { x:(e.clientX - r.left), y:(e.clientY - r.top),
               p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5 };
    };
    this.cv.addEventListener('pointerdown', e => {
      this.cv.setPointerCapture?.(e.pointerId);
      const q = pt(e);
      this.cur = { id:'h'+Date.now().toString(36), tool:'pen', width:2.6,
                   points:[[q.x, q.y, q.p]] };
      this.drawing = true;
    });
    this.cv.addEventListener('pointermove', e => {
      if(!this.drawing) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach(ev => {
        const q = pt(ev);
        const last = this.cur.points[this.cur.points.length - 1];
        if(Math.hypot(q.x - last[0], q.y - last[1]) < 0.5) return;
        this.cur.points.push([q.x, q.y, q.p]);
      });
      this.paint();
    });
    ['pointerup','pointercancel'].forEach(ev => this.cv.addEventListener(ev, () => {
      if(!this.drawing) return;
      this.drawing = false;
      if(this.cur && this.cur.points.length > 1) this.strokes.push(this.cur);
      this.cur = null;
      this.paint();
    }));
    window.addEventListener('resize', () => { if(this.cv.offsetParent) this.fit(); });
  },

  fit(){
    const r = this.cv.getBoundingClientRect();
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.paint();
  },

  paint(){
    const g = this.ctx;
    if(!g) return;
    g.setTransform(1,0,0,1,0,0);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, this.cv.width, this.cv.height);
    // A baseline, so samples are written at a consistent size.
    g.strokeStyle = '#e2e6ea'; g.lineWidth = 1;
    const mid = this.cv.height * 0.68;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(this.cv.width, mid); g.stroke();
    g.scale(this.dpr, this.dpr);
    g.strokeStyle = '#111'; g.lineCap = 'round'; g.lineJoin = 'round';
    const all = this.cur ? this.strokes.concat([this.cur]) : this.strokes;
    all.forEach(s => {
      for(let i = 1; i < s.points.length; i++){
        const a = s.points[i-1], b = s.points[i];
        g.lineWidth = s.width * (0.5 + ((a[2] + b[2]) / 2));
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
    });
  },

  clear(){ this.strokes = []; this.cur = null; this.paint(); },

  prompt(){
    const el = document.getElementById('hw-prompt');
    if(!el) return;
    el.textContent = this.idx >= 0 && this.idx < Handwriting.DRILL.length
      ? Handwriting.DRILL[this.idx]
      : 'Drill complete — write anything below, or start again';
  },
  next(){ this.idx++; this.clear(); this.prompt(); },
};

document.getElementById('hw-start')?.addEventListener('click', () => {
  HwPad.mount(); HwPad.idx = -1; HwPad.next();
  document.getElementById('hw-start').textContent = 'Restart drill';
});
document.getElementById('hw-clear')?.addEventListener('click', () => { HwPad.mount(); HwPad.clear(); });
document.getElementById('hw-skip')?.addEventListener('click', () => { HwPad.mount(); HwPad.next(); });

document.getElementById('hw-save')?.addEventListener('click', async () => {
  HwPad.mount();
  const label = Handwriting.DRILL[HwPad.idx];
  if(HwPad.idx < 0 || !label){ alert('Press "Start drill" first.'); return; }
  if(!HwPad.strokes.length){ alert('Write the prompt above before saving.'); return; }
  const kind = label.length <= 24 && /^[A-Za-z0-9 ]+$/.test(label) ? 'letter' : 'word';
  const ok = await Handwriting.add(label, HwPad.strokes, kind);
  if(!ok){ alert('That could not be saved.'); return; }
  Handwriting.sheet = null;              // the chart must be rebuilt
  renderHandwritingStatus();
  HwPad.next();
});

document.getElementById('hw-save-free')?.addEventListener('click', async () => {
  HwPad.mount();
  const label = (document.getElementById('hw-free')?.value || '').trim();
  if(!label){ alert('Type what you wrote, so TARS knows what it means.'); return; }
  if(!HwPad.strokes.length){ alert('Write something in the box first.'); return; }
  const ok = await Handwriting.add(label, HwPad.strokes, 'phrase');
  if(!ok){ alert('That could not be saved.'); return; }
  Handwriting.sheet = null;
  document.getElementById('hw-free').value = '';
  renderHandwritingStatus();
  HwPad.clear();
});

document.getElementById('hw-preview')?.addEventListener('click', async () => {
  await Handwriting.load(true);
  const sheet = Handwriting.buildSheet();
  if(!sheet){ alert('No samples yet. Run the drill and save a few.'); return; }
  const w = window.open('');
  if(w) w.document.write(`<body style="margin:0;background:#222"><img src="${sheet}" style="max-width:100%"></body>`);
  else alert('Allow pop-ups to preview the sheet.');
});

document.getElementById('hw-forget')?.addEventListener('click', async () => {
  if(!confirm('Remove every handwriting sample? TARS will read your writing without a reference again.')) return;
  await Handwriting.remove(null);
  renderHandwritingStatus();
});

// --- settings layout -------------------------------------------------
// Everything added over time landed in whichever panel was convenient, so
// Knowledge ended up holding voice, mail, screen sharing and profiles. Rows
// are relocated by id at runtime rather than by rewriting the markup: the
// panels stay simple, and adding a row later cannot silently put it in the
// wrong place.
const SETTINGS_HOME = {
  assistant:   ['prov-select', 'ai-reset', 'humour-slider', 'honesty-slider',
                'proactive-select', 'learn-review', 'reflect-run', 'confirm-toggle',
                'audit-view', 'svc-check'],
  voice:       ['tts-voice', 'tts-test', 'tts-diag', 'mic-sens', 'pause-tol',
                'autolisten-toggle', 'bglisten-toggle', 'voice-select'],
  writing:     ['ink-width-set', 'ink-pressure', 'hw-start', 'hw-preview', 'hw-forget'],
  knowledge:   ['kb-json', 'kb-add-btn', 'kb-sync', 'kb-purge', 'kb-seed',
                'galaxy-scan', 'kb-map', 'tpl-list'],
  connections: ['mail-pick', 'mail-scan', 'mail-files', 'mail-forget',
                'screen-share', 'vision-test', 'screen-keep', 'profile-new',
                'drive-connect', 'drive-client'],
};

function organiseSettings(){
  const panels = {};
  document.querySelectorAll('[data-sub-panel]').forEach(p => { panels[p.dataset.subPanel] = p; });
  Object.entries(SETTINGS_HOME).forEach(([panel, ids]) => {
    const target = panels[panel];
    if(!target) return;
    ids.forEach(id => {
      const el = document.getElementById(id);
      if(!el) return;
      // Move the whole row, plus any hint paragraph that follows it.
      const row = el.closest('.set-row') || el.closest('.kb-add') || el.closest('.set-actions');
      if(!row || row.parentElement === target) return;
      const extras = [];
      let sib = row.nextElementSibling;
      while(sib && (sib.classList.contains('hint') || sib.tagName === 'P')){
        extras.push(sib); sib = sib.nextElementSibling;
      }
      target.appendChild(row);
      extras.forEach(e => target.appendChild(e));
    });
  });
  // A panel left empty after the shuffle would look broken.
  Object.entries(panels).forEach(([name, p]) => {
    if(!p.children.length){
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Nothing here yet.';
      p.appendChild(note);
    }
  });
}

// --- ink wiring -------------------------------------------------------
// --- colours and preset shapes ---
function renderInkColours(){
  const box = document.getElementById('ink-colours');
  if(!box || box._built) return;
  box._built = true;
  box.innerHTML = Ink.palette.map(hex =>
    `<button class="ink-swatch${hex === '' ? ' auto' : ''}" data-ink-colour="${hex}"
      title="${hex ? hex : 'Follow the theme'}"
      style="${hex ? `background:${hex}` : ''}"></button>`).join('');
  box.querySelectorAll('[data-ink-colour]').forEach(b => {
    b.addEventListener('click', () => {
      Ink.colour = b.dataset.inkColour || null;
      settings.inkColour = Ink.colour; saveSettings();
      // With something selected, a swatch recolours it instead of only
      // arming the pen for the next stroke.
      if(Ink.sel.size) Ink.styleSelected({ colour: Ink.colour });
      box.querySelectorAll('[data-ink-colour]').forEach(x => x.classList.toggle('on', x === b));
      SFX.tick();
    });
  });
  const cur = settings.inkColour || '';
  const match = box.querySelector(`[data-ink-colour="${cur}"]`);
  if(match) match.classList.add('on');
}
document.getElementById('ink-shapes')?.addEventListener('change', e => {
  if(!e.target.value) return;
  Ink.insertShape(e.target.value);
  e.target.value = '';
});

document.querySelectorAll('[data-ink-tool]').forEach(b => {
  b.addEventListener('click', () => {
    Ink.tool = b.dataset.inkTool;
    const cv = document.getElementById('ink-canvas');
    if(cv) cv.classList.toggle('selecting', Ink.tool === 'select');
    if(Ink.tool !== 'select') Ink.clearElementSelection();
    document.querySelectorAll('[data-ink-tool]').forEach(x => x.classList.toggle('active', x === b));
    SFX.tick();
  });
});
document.getElementById('nb-ink-toggle')?.addEventListener('click', () => {
  Ink.show(!Ink.active);
  SFX.open();
});
document.getElementById('ink-width')?.addEventListener('input', e => {
  Ink.width = +e.target.value;
  settings.inkWidth = Ink.width; saveSettings();
});
document.getElementById('ink-smooth')?.addEventListener('input', e => {
  // Real-time, like the microphone sensitivity control: no apply step.
  Ink.smoothing = +e.target.value / 100;
  settings.inkSmoothing = +e.target.value; saveSettings();
});
document.getElementById('ink-undo')?.addEventListener('click', () => Ink.undo());
document.getElementById('ink-redo')?.addEventListener('click', () => Ink.redo());
document.getElementById('ink-fit')?.addEventListener('click', () => Ink.resetView());
document.getElementById('ink-clear')?.addEventListener('click', () => Ink.clear());
document.getElementById('ink-front')?.addEventListener('click', () => Ink.raise(true));
document.getElementById('ink-back')?.addEventListener('click', () => Ink.raise(false));
document.getElementById('ink-dup')?.addEventListener('click', () => {
  if(!Ink.duplicateSelected()) alert('Select something first — use the ▢ tool.');
});
document.getElementById('ink-del')?.addEventListener('click', () => {
  if(!Ink.deleteSelected()) alert('Select something first — use the ▢ tool.');
});
document.getElementById('ink-smart')?.addEventListener('click', e => {
  Ink.smartInk = !Ink.smartInk;
  settings.smartInk = Ink.smartInk; saveSettings();
  e.currentTarget.classList.toggle('active', Ink.smartInk);
  if(!Ink.smartInk) Ink.rejectShape();
  SFX.tick();
});
document.getElementById('hand-all')?.addEventListener('click', () => {
  const n = Ink.selectAllInk();
  if(!n) alert('There is no handwriting on this note yet.');
});
document.getElementById('hand-clear')?.addEventListener('click', () => Ink.clearSelection());
document.getElementById('hand-ctx')?.addEventListener('click', e => {
  Ink.contextOn = !Ink.contextOn;
  settings.inkContext = Ink.contextOn; saveSettings();
  e.currentTarget.textContent = 'Context: ' + (Ink.contextOn ? 'on' : 'off');
  e.currentTarget.classList.toggle('active', Ink.contextOn);
  SFX.tick();
});
document.getElementById('hand-read')?.addEventListener('click', () => Ink.recogniseHandwriting());
document.getElementById('ink-revert')?.addEventListener('click', () => {
  if(!Ink.revertLast()) alert('No recognised shape to revert.');
});

// Keyboard history, but only while the ink layer has focus — the rich-text
// editor has its own undo and the two must not fight.
document.addEventListener('keydown', e => {
  if(!Ink.active) return;
  // The rich-text editor has its own undo and its own idea of Delete; never
  // steal keys while the caret is in it, or in any other input.
  const ae = document.activeElement;
  if(ae && (ae.id === 'notebook-canvas' || ae.tagName === 'INPUT' ||
            ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

  const mod = e.ctrlKey || e.metaKey;
  if(mod && e.key.toLowerCase() === 'z'){
    e.preventDefault();
    e.shiftKey ? Ink.redo() : Ink.undo();
    return;
  }
  if(mod && e.key.toLowerCase() === 'd'){ e.preventDefault(); Ink.duplicateSelected(); return; }
  if(mod && e.key.toLowerCase() === 'c'){ Ink.copySelected(); return; }
  if(mod && e.key.toLowerCase() === 'v'){ e.preventDefault(); Ink.paste(); return; }
  if(mod && e.key === ']'){ e.preventDefault(); Ink.raise(true); return; }
  if(mod && e.key === '['){ e.preventDefault(); Ink.raise(false); return; }
  if(mod && e.key.toLowerCase() === 'a'){
    e.preventDefault();
    Ink.setSelection((Ink.doc.objects || []).map(o => o.id));
    return;
  }
  if(e.key === 'Delete' || e.key === 'Backspace'){
    if(Ink.deleteSelected()) e.preventDefault();
    return;
  }
  if(e.key === 'Escape'){ Ink.clearElementSelection(); Ink.clearSelection(); return; }
  // Arrows nudge; shift makes it a coarse step.
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft:[-step,0], ArrowRight:[step,0], ArrowUp:[0,-step], ArrowDown:[0,step] };
  if(moves[e.key]){
    if(Ink.nudge(moves[e.key][0], moves[e.key][1])) e.preventDefault();
  }
});

function applyInkSettings(){
  if(typeof settings.inkWidth === 'number') Ink.width = settings.inkWidth;
  if(typeof settings.inkSmoothing === 'number') Ink.smoothing = settings.inkSmoothing / 100;
  Ink.pressureOn = settings.inkPressure !== false;
  Ink.smartInk = settings.smartInk !== false;
  Ink.contextOn = settings.inkContext !== false;
  Ink.colour = settings.inkColour || null;
  Vocab.load();
  const cb = document.getElementById('hand-ctx');
  if(cb){ cb.textContent = 'Context: ' + (Ink.contextOn ? 'on' : 'off');
          cb.classList.toggle('active', Ink.contextOn); }
  const sb = document.getElementById('ink-smart');
  if(sb) sb.classList.toggle('active', Ink.smartInk);
  const w = document.getElementById('ink-width'), s = document.getElementById('ink-smooth');
  if(w) w.value = Ink.width;
  if(s) s.value = Math.round(Ink.smoothing * 100);
}



// ===== Element geometry (Phase 1) ====================================
// Hit-testing and bounds for every object type. Pure geometry, so it can be
// verified without a browser — which matters, because "click selects the wrong
// thing" is the kind of bug that is miserable to chase by hand.
const Geo = {
  // Distance from a point to a line segment.
  segDist(px, py, x1, y1, x2, y2){
    const vx = x2 - x1, vy = y2 - y1;
    const L2 = vx*vx + vy*vy;
    let t = L2 ? ((px - x1)*vx + (py - y1)*vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + vx*t), py - (y1 + vy*t));
  },

  pointInPoly(px, py, pts){
    let inside = false;
    for(let i = 0, j = pts.length - 1; i < pts.length; j = i++){
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if((yi > py) !== (yj > py) &&
         px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi) inside = !inside;
    }
    return inside;
  },

  // Axis-aligned bounds for any element, used by marquee and by the
  // selection outline.
  bounds(el){
    const g = el.geom || {};
    if(el.type === 'text')
      return { x0:el.x, y0:el.y, x1:el.x + (el.width||0), y1:el.y + (el.height||0) };
    switch(el.kind){
      case 'circle':   return { x0:g.cx-g.r, y0:g.cy-g.r, x1:g.cx+g.r, y1:g.cy+g.r };
      case 'ellipse':  return { x0:g.cx-g.rx, y0:g.cy-g.ry, x1:g.cx+g.rx, y1:g.cy+g.ry };
      case 'square':
      case 'rectangle':return { x0:g.x, y0:g.y, x1:g.x+g.w, y1:g.y+g.h };
      case 'triangle': {
        const p = g.points || [];
        const xs = p.map(v => v[0]), ys = p.map(v => v[1]);
        return { x0:Math.min(...xs), y0:Math.min(...ys), x1:Math.max(...xs), y1:Math.max(...ys) };
      }
      default: return { x0:Math.min(g.x1,g.x2), y0:Math.min(g.y1,g.y2),
                        x1:Math.max(g.x1,g.x2), y1:Math.max(g.y1,g.y2) };
    }
  },

  // Does a point land on this element? An outline shape is selectable both on
  // its stroke and anywhere inside, which is what people expect even though
  // nothing is filled.
  hit(el, px, py, tol){
    const t = tol || 8;
    const g = el.geom || {};
    if(el.type === 'text'){
      const b = this.bounds(el);
      return px >= b.x0 - t && px <= b.x1 + t && py >= b.y0 - t && py <= b.y1 + t;
    }
    switch(el.kind){
      case 'line':
      case 'arrow':
        return this.segDist(px, py, g.x1, g.y1, g.x2, g.y2) <= t;
      case 'circle': {
        const d = Math.hypot(px - g.cx, py - g.cy);
        return d <= Math.abs(g.r) + t;
      }
      case 'ellipse': {
        const rx = Math.abs(g.rx) + t, ry = Math.abs(g.ry) + t;
        if(rx <= 0 || ry <= 0) return false;
        const dx = (px - g.cx) / rx, dy = (py - g.cy) / ry;
        return dx*dx + dy*dy <= 1;
      }
      case 'square':
      case 'rectangle':
        return px >= g.x - t && px <= g.x + g.w + t &&
               py >= g.y - t && py <= g.y + g.h + t;
      case 'triangle': {
        const p = g.points || [];
        if(p.length !== 3) return false;
        if(this.pointInPoly(px, py, p)) return true;
        for(let i = 0; i < 3; i++){
          const a = p[i], b = p[(i+1)%3];
          if(this.segDist(px, py, a[0], a[1], b[0], b[1]) <= t) return true;
        }
        return false;
      }
      default: return false;
    }
  },

  // Fully inside a marquee. Partial overlap is deliberately not enough:
  // dragging a box across a busy page would otherwise grab everything it
  // brushed past.
  within(el, r){
    const b = this.bounds(el);
    return b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1;
  },


  // --- Boundary intersection (Phase 2) --------------------------------
  // Where a line from this element's centre toward (tx,ty) leaves its
  // outline. This is what makes a bound arrow touch the edge of a box rather
  // than burying its head in the middle of it.
  centre(el){
    const b = this.bounds(el);
    return { x:(b.x0 + b.x1) / 2, y:(b.y0 + b.y1) / 2 };
  },

  segInt(x1,y1,x2,y2, x3,y3,x4,y4){
    const d = (x2-x1)*(y4-y3) - (y2-y1)*(x4-x3);
    if(Math.abs(d) < 1e-9) return null;
    const t = ((x3-x1)*(y4-y3) - (y3-y1)*(x4-x3)) / d;
    const u = ((x3-x1)*(y2-y1) - (y3-y1)*(x2-x1)) / d;
    if(t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: x1 + t*(x2-x1), y: y1 + t*(y2-y1), t };
  },

  // Nearest exit along the ray, plus a small gap so the arrowhead does not
  // touch the outline.
  exitPoint(el, tx, ty, gap){
    const c = this.centre(el);
    const pad = gap == null ? 4 : gap;
    const dx = tx - c.x, dy = ty - c.y;
    const len = Math.hypot(dx, dy);
    if(len < 1e-6) return c;
    // Extend well past the shape so the ray certainly crosses it.
    const far = { x: c.x + dx / len * 1e4, y: c.y + dy / len * 1e4 };
    const g = el.geom || {};
    let best = null;

    const consider = p => {
      if(!p) return;
      if(!best || p.t < best.t) best = p;
    };

    if(el.type === 'text' || el.kind === 'rectangle' || el.kind === 'square'){
      const b = this.bounds(el);
      consider(this.segInt(c.x,c.y,far.x,far.y, b.x0,b.y0, b.x1,b.y0));
      consider(this.segInt(c.x,c.y,far.x,far.y, b.x1,b.y0, b.x1,b.y1));
      consider(this.segInt(c.x,c.y,far.x,far.y, b.x1,b.y1, b.x0,b.y1));
      consider(this.segInt(c.x,c.y,far.x,far.y, b.x0,b.y1, b.x0,b.y0));
    } else if(el.kind === 'circle' || el.kind === 'ellipse'){
      // Solve the ellipse in normalised space, where it is a unit circle.
      const rx = Math.abs(el.kind === 'circle' ? g.r : g.rx);
      const ry = Math.abs(el.kind === 'circle' ? g.r : g.ry);
      if(rx < 1e-6 || ry < 1e-6) return c;
      const ux = dx / len / rx, uy = dy / len / ry;
      const k = 1 / Math.hypot(ux, uy);
      best = { x: c.x + dx / len * k, y: c.y + dy / len * k, t: 0 };
    } else if(el.kind === 'triangle'){
      const p = g.points || [];
      for(let i = 0; i < p.length; i++){
        const a = p[i], b2 = p[(i+1) % p.length];
        consider(this.segInt(c.x,c.y,far.x,far.y, a[0],a[1], b2[0],b2[1]));
      }
    } else {
      return c;
    }
    if(!best) return c;
    // Back off along the ray by the gap.
    return { x: best.x + dx / len * pad, y: best.y + dy / len * pad };
  },

  // Scale an element into a new bounding box. Each kind stores geometry
  // differently, so this is the one place that knows how to stretch it.
  resizeTo(el, b){
    const w = Math.max(8, b.x1 - b.x0), h = Math.max(8, b.y1 - b.y0);
    const g = el.geom || {};
    if(el.type === 'text'){ el.x = b.x0; el.y = b.y0; el.width = w; el.height = h; return; }
    switch(el.kind){
      case 'circle':
        g.cx = b.x0 + w/2; g.cy = b.y0 + h/2; g.r = Math.min(w, h) / 2; break;
      case 'ellipse':
        g.cx = b.x0 + w/2; g.cy = b.y0 + h/2; g.rx = w/2; g.ry = h/2; break;
      case 'square':
      case 'rectangle':
        g.x = b.x0; g.y = b.y0; g.w = w; g.h = h; break;
      case 'triangle': {
        const old = this.bounds(el);
        const ow = Math.max(1e-6, old.x1 - old.x0), oh = Math.max(1e-6, old.y1 - old.y0);
        (g.points || []).forEach(p => {
          p[0] = b.x0 + (p[0] - old.x0) / ow * w;
          p[1] = b.y0 + (p[1] - old.y0) / oh * h;
        });
        break;
      }
      case 'line':
      case 'arrow': {
        const old = this.bounds(el);
        const ow = Math.max(1e-6, old.x1 - old.x0), oh = Math.max(1e-6, old.y1 - old.y0);
        [['x1','y1'], ['x2','y2']].forEach(([kx, ky]) => {
          g[kx] = b.x0 + (g[kx] - old.x0) / ow * w;
          g[ky] = b.y0 + (g[ky] - old.y0) / oh * h;
        });
        break;
      }
    }
  },

  // Move an element by a delta. Each kind stores its geometry differently, so
  // this is the single place that knows how.
  move(el, dx, dy){
    if(el.type === 'text'){ el.x += dx; el.y += dy; return; }
    const g = el.geom || {};
    switch(el.kind){
      case 'line':
      case 'arrow':    g.x1 += dx; g.y1 += dy; g.x2 += dx; g.y2 += dy; break;
      case 'circle':
      case 'ellipse':  g.cx += dx; g.cy += dy; break;
      case 'square':
      case 'rectangle':g.x += dx; g.y += dy; break;
      case 'triangle': (g.points || []).forEach(p => { p[0] += dx; p[1] += dy; }); break;
    }
  },
};

// ===== Shape recognition (Phase 2) ===================================
// Purely geometric and local: no model call, so it cannot add pen latency.
// Runs once a stroke is finished, never during drawing.
//
// The original stroke is ALWAYS kept. A recognised shape becomes a new object
// referencing it; the stroke is flagged hidden rather than deleted, so undo,
// re-recognition and later AI passes all still have the raw ink.
const ShapeRec = {
  // Confidence bands, per the brief: high replaces, medium offers, low leaves.
  HIGH: 0.82, MED: 0.62,

  // --- geometry helpers ---------------------------------------------
  pathLength(pts){
    let d = 0;
    for(let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
    return d;
  },
  bbox(pts){
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    pts.forEach(p => { x0=Math.min(x0,p[0]); y0=Math.min(y0,p[1]); x1=Math.max(x1,p[0]); y1=Math.max(y1,p[1]); });
    return { x0, y0, x1, y1, w:x1-x0, h:y1-y0, cx:(x0+x1)/2, cy:(y0+y1)/2, diag:Math.hypot(x1-x0,y1-y0) };
  },
  // Even arc-length spacing, so corner detection is not fooled by fast or slow
  // drawing producing uneven sample density.
  resample(pts, n){
    const total = this.pathLength(pts);
    if(total <= 0 || pts.length < 2) return pts.slice();
    const step = total / (n - 1);
    const out = [pts[0]];
    let acc = 0, prev = pts[0];
    for(let i = 1; i < pts.length; i++){
      let d = Math.hypot(pts[i][0]-prev[0], pts[i][1]-prev[1]);
      while(acc + d >= step && out.length < n - 1){
        const t = (step - acc) / d;
        const nx = prev[0] + (pts[i][0]-prev[0]) * t;
        const ny = prev[1] + (pts[i][1]-prev[1]) * t;
        out.push([nx, ny]);
        prev = [nx, ny];
        d = Math.hypot(pts[i][0]-prev[0], pts[i][1]-prev[1]);
        acc = 0;
      }
      acc += d; prev = pts[i];
    }
    while(out.length < n) out.push(pts[pts.length-1]);
    return out;
  },
  // Turning angle at each sample, used to find corners.
  // `cyclic` matters: a closed shape drawn starting at a vertex has that
  // corner split across the two ends of the stroke, so a linear scan misses
  // it and a triangle looks like it only has two corners.
  corners(rs, thresholdDeg, cyclic){
    const th = (thresholdDeg || 50) * Math.PI / 180;
    const idx = [];
    const span = 3;
    const n = rs.length;
    const at = i => rs[((i % n) + n) % n];
    const from = cyclic ? 0 : span;
    const to = cyclic ? n : n - span;
    for(let i = from; i < to; i++){
      const a = [at(i)[0]-at(i-span)[0], at(i)[1]-at(i-span)[1]];
      const b = [at(i+span)[0]-at(i)[0], at(i+span)[1]-at(i)[1]];
      const la = Math.hypot(...a), lb = Math.hypot(...b);
      if(la < 1e-6 || lb < 1e-6) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (a[0]*b[0]+a[1]*b[1])/(la*lb))));
      if(ang > th){
        // Keep only the sharpest point in a run of adjacent corners.
        if(idx.length && i - idx[idx.length-1] < n/10) continue;
        idx.push(i);
      }
    }
    // In cyclic mode the first and last can be the same corner seen twice.
    if(cyclic && idx.length > 1 && (n - idx[idx.length-1] + idx[0]) < n/10) idx.pop();
    return idx;
  },
  polyArea(pts){
    let a = 0;
    for(let i = 0; i < pts.length; i++){
      const p = pts[i], q = pts[(i+1) % pts.length];
      a += p[0]*q[1] - q[0]*p[1];
    }
    return Math.abs(a) / 2;
  },

  // --- fit errors, all normalised to the shape's own size -------------
  lineError(rs, box){
    const a = rs[0], b = rs[rs.length-1];
    const L = Math.hypot(b[0]-a[0], b[1]-a[1]);
    if(L < 1e-6) return 1;
    let sum = 0;
    rs.forEach(p => {
      sum += Math.abs((b[1]-a[1])*p[0] - (b[0]-a[0])*p[1] + b[0]*a[1] - b[1]*a[0]) / L;
    });
    return (sum / rs.length) / Math.max(1, box.diag) * 4;
  },
  ellipseError(rs, box){
    const rx = Math.max(1, box.w/2), ry = Math.max(1, box.h/2);
    let sum = 0;
    rs.forEach(p => {
      const dx = (p[0]-box.cx)/rx, dy = (p[1]-box.cy)/ry;
      sum += Math.abs(Math.hypot(dx, dy) - 1);
    });
    return sum / rs.length * 2.2;
  },
  rectError(rs, box){
    let sum = 0;
    rs.forEach(p => {
      const dx = Math.min(Math.abs(p[0]-box.x0), Math.abs(p[0]-box.x1));
      const dy = Math.min(Math.abs(p[1]-box.y0), Math.abs(p[1]-box.y1));
      sum += Math.min(dx, dy);
    });
    return (sum / rs.length) / Math.max(1, box.diag) * 6;
  },
  polyError(rs, verts, box){
    const segDist = (p, a, b) => {
      const vx = b[0]-a[0], vy = b[1]-a[1];
      const L2 = vx*vx + vy*vy;
      let t = L2 ? ((p[0]-a[0])*vx + (p[1]-a[1])*vy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p[0]-(a[0]+vx*t), p[1]-(a[1]+vy*t));
    };
    let sum = 0;
    rs.forEach(p => {
      let best = Infinity;
      for(let i = 0; i < verts.length; i++)
        best = Math.min(best, segDist(p, verts[i], verts[(i+1)%verts.length]));
      sum += best;
    });
    return (sum / rs.length) / Math.max(1, box.diag) * 6;
  },

  // --- arrowheads -----------------------------------------------------
  // An arrow is a mostly-straight shaft whose last fifth doubles back.
  arrowHead(pts, box){
    const n = pts.length;
    if(n < 12) return null;
    const cut = Math.floor(n * 0.78);
    const shaft = pts.slice(0, cut), head = pts.slice(cut);
    if(head.length < 4) return null;
    const sa = shaft[0], sb = shaft[shaft.length-1];
    const shaftAng = Math.atan2(sb[1]-sa[1], sb[0]-sa[0]);
    // Does the tail reverse direction relative to the shaft?
    let reversed = 0;
    for(let i = 1; i < head.length; i++){
      const a = Math.atan2(head[i][1]-head[i-1][1], head[i][0]-head[i-1][0]);
      let d = Math.abs(a - shaftAng);
      while(d > Math.PI) d = Math.abs(d - 2*Math.PI);
      if(d > 1.9) reversed++;
    }
    if(reversed < Math.max(2, head.length * 0.25)) return null;
    return { from: sa, to: sb, shaftError: this.lineError(this.resample(shaft, 32), box) };
  },

  // --- the classifier -------------------------------------------------
  recognise(points){
    if(!points || points.length < 6) return null;
    const raw = points.map(p => [p[0], p[1]]);
    const box = this.bbox(raw);
    if(box.diag < 12) return null;                 // too small to be deliberate

    const rs = this.resample(raw, 64);
    const gap = Math.hypot(raw[raw.length-1][0]-raw[0][0], raw[raw.length-1][1]-raw[0][1]);
    const closed = gap / box.diag < 0.28;
    const straightness = gap / Math.max(1, this.pathLength(raw));
    const conf = err => Math.max(0, Math.min(1, 1 - err));
    const cands = [];

    // Open, and nearly as long as the distance it covers -> line or arrow.
    if(!closed && straightness > 0.72){
      const head = this.arrowHead(raw, box);
      if(head){
        cands.push({ kind:'arrow', confidence: conf(head.shaftError * 1.15),
                     geom: { x1:head.from[0], y1:head.from[1], x2:head.to[0], y2:head.to[1] } });
      }
      cands.push({ kind:'line', confidence: conf(this.lineError(rs, box)),
                   geom: { x1:raw[0][0], y1:raw[0][1], x2:raw[raw.length-1][0], y2:raw[raw.length-1][1] } });
    }

    if(closed){
      const cs = this.corners(rs, 52, true);
      const aspect = box.w / Math.max(1, box.h);

      // Circle and ellipse share a fit; the aspect ratio decides the label.
      const eErr = this.ellipseError(rs, box);
      const isCircle = aspect > 0.82 && aspect < 1.22;
      cands.push({
        kind: isCircle ? 'circle' : 'ellipse',
        confidence: conf(eErr),
        geom: isCircle
          ? { cx:box.cx, cy:box.cy, r:(box.w+box.h)/4 }
          : { cx:box.cx, cy:box.cy, rx:box.w/2, ry:box.h/2 },
      });

      // Four corners and edges hugging the bounding box -> rectangle.
      const rErr = this.rectError(rs, box);
      cands.push({
        kind: (aspect > 0.88 && aspect < 1.14) ? 'square' : 'rectangle',
        confidence: conf(rErr + Math.abs(cs.length - 4) * 0.13),
        geom: { x:box.x0, y:box.y0, w:box.w, h:box.h },
      });

      if(cs.length >= 3 && cs.length <= 4){
        const verts = cs.slice(0, 3).map(i => rs[i]);
        cands.push({ kind:'triangle',
                     confidence: conf(this.polyError(rs, verts, box) + Math.abs(cs.length - 3) * 0.16),
                     geom: { points: verts.map(v => [+v[0].toFixed(1), +v[1].toFixed(1)]) } });
      }
      // A curve has no sharp corners, so corner count penalises the ellipse
      // rather than the polygons when the stroke clearly has vertices.
      if(cs.length >= 3){
        const eIdx = cands.findIndex(x => x.kind === 'circle' || x.kind === 'ellipse');
        if(eIdx > -1) cands[eIdx].confidence = Math.max(0, cands[eIdx].confidence - 0.18);
      }
    }

    if(!cands.length) return null;
    cands.sort((a, b) => b.confidence - a.confidence);
    const best = cands[0];
    return best.confidence >= 0.35 ? best : null;
  },
};


// ===== Notebook search (Phase 5) =====================================
// Searches typed text, recognised handwriting and shape/text objects across
// every note, and returns WHERE a hit sits so the page can scroll to it.
// Built on the spatial metadata Phase 3 records, which is why text objects
// carry x/y/width/height rather than just content.
const NoteSearch = {
  // A flat index of searchable items, rebuilt on demand. Small enough that
  // caching would cost more in staleness than it saves in time.
  index(){
    const out = [];
    (notes || []).forEach(n => {
      const nb = (notebooks || []).find(x => x.id === n.notebook_id);
      const base = { noteId: n.id, notebookId: n.notebook_id,
                     noteTitle: n.title || 'Untitled',
                     notebookTitle: nb ? nb.title : '' };

      // Typed body text, stripped of markup.
      const body = String(n.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if(body) out.push({ ...base, kind:'text', content: body, where: null });

      // Recognised handwriting, with its position on the page.
      if(n.ink){
        try{
          const d = JSON.parse(n.ink);
          (d.objects || []).forEach(o => {
            if(o.type === 'text' && o.content){
              out.push({ ...base, kind:'handwriting', content: o.content,
                         where: { x:o.x, y:o.y, width:o.width, height:o.height },
                         objectId: o.id });
            }
            if(o.type === 'shape'){
              out.push({ ...base, kind:'shape', content: o.kind,
                         where: o.geom ? { x:o.geom.x ?? o.geom.cx ?? o.geom.x1 ?? 0,
                                           y:o.geom.y ?? o.geom.cy ?? o.geom.y1 ?? 0 } : null,
                         objectId: o.id });
            }
          });
          const strokeCount = (d.strokes || []).filter(s => !s.hidden).length;
          if(strokeCount) out.push({ ...base, kind:'ink', content:'handwritten ink',
                                     where: null, strokes: strokeCount });
        }catch(e){ /* an unreadable ink blob must not break search */ }
      }

      if(n.title) out.push({ ...base, kind:'title', content: n.title, where: null });
      (n.tags || []).forEach(t => out.push({ ...base, kind:'tag', content: t, where: null }));
    });
    return out;
  },

  search(query, limit = 8){
    const words = relevantWords(query);
    if(!words.length) return [];
    const items = this.index();
    const scored = items.map(it => {
      const hay = String(it.content).toLowerCase();
      let hits = 0, exact = 0;
      words.forEach(w => {
        const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        if(re.test(hay)){ hits++; if(hay.includes(w)) exact++; }
      });
      if(!hits) return null;
      // Handwriting outranks typed text: if someone wrote it by hand and had it
      // recognised, it was worth the effort, and it is harder to find by eye.
      const weight = it.kind === 'handwriting' ? 1.35
                   : it.kind === 'title' ? 1.25
                   : it.kind === 'tag' ? 1.15 : 1;
      return { it, score: (hits / words.length) * weight + exact * 0.05, coverage: hits / words.length };
    }).filter(Boolean).filter(x => x.coverage >= 0.34);

    // One result per note: the strongest hit represents it.
    const byNote = {};
    scored.sort((a, b) => b.score - a.score).forEach(x => {
      if(!byNote[x.it.noteId]) byNote[x.it.noteId] = x;
    });
    return Object.values(byNote).sort((a, b) => b.score - a.score).slice(0, limit);
  },

  // A short quotation around the match, so a result is recognisable.
  snippet(content, query, len = 140){
    const words = relevantWords(query);
    const low = String(content).toLowerCase();
    let at = -1;
    for(const w of words){ const i = low.indexOf(w); if(i > -1){ at = i; break; } }
    if(at < 0) return String(content).slice(0, len);
    const from = Math.max(0, at - 40);
    return (from ? '…' : '') + String(content).slice(from, from + len) + (content.length > from + len ? '…' : '');
  },

  // Open the note and, when the hit came from ink, bring that spot into view.
  async goTo(hit){
    const n = (notes || []).find(x => x.id === hit.noteId);
    if(!n) return false;
    switchView('notebooks');
    activeFolderId = n.notebook_id;
    renderNotebooksGrid();
    await openNote(n.id);
    if(hit.where && typeof hit.where.x === 'number'){
      Ink.show(true);
      // Centre the canvas on the recognised region rather than merely opening
      // the note and leaving the user to hunt for it.
      setTimeout(() => {
        const cv = document.getElementById('ink-canvas');
        if(!cv) return;
        const r = cv.getBoundingClientRect();
        const v = Ink.doc.view;
        v.zoom = 1;
        v.panX = r.width / 2 - (hit.where.x + (hit.where.width || 0) / 2);
        v.panY = r.height / 2 - (hit.where.y + (hit.where.height || 0) / 2);
        Ink.selection = hit.where.width
          ? { x0:hit.where.x - 6, y0:hit.where.y - 6,
              x1:hit.where.x + hit.where.width + 6, y1:hit.where.y + hit.where.height + 6 }
          : null;
        Ink.redraw(); Ink.status(); Ink.updateHandBar();
      }, 220);
    }
    return true;
  },
};



// ===== Diagram layout (Phase 3) ======================================
// The model supplies a graph; this decides where everything goes. Keeping
// positions out of the model's hands is deliberate — asking a language model
// for coordinates produces overlapping boxes and crossing arrows, the same way
// asking one for a colour palette produced a muddy one.
const Layout = {
  NODE_H: 56, GAP_X: 34, GAP_Y: 78, MIN_W: 120, MAX_W: 220,

  widthFor(label){
    const chars = String(label || '').length;
    return Math.max(this.MIN_W, Math.min(this.MAX_W, chars * 8 + 34));
  },

  // Rank by longest path from a root, which puts every node below all of its
  // predecessors. Cycles are broken by refusing to revisit a node on the same
  // path, so a feedback loop lays out instead of hanging.
  rank(nodes, edges){
    const out = {}, incoming = {};
    nodes.forEach(n => { out[n.id] = []; incoming[n.id] = 0; });
    edges.forEach(e => {
      if(out[e.from] && incoming[e.to] !== undefined){ out[e.from].push(e.to); incoming[e.to]++; }
    });
    const rank = {};
    nodes.forEach(n => { rank[n.id] = 0; });
    const roots = nodes.filter(n => !incoming[n.id]).map(n => n.id);
    const seeds = roots.length ? roots : [nodes[0].id];
    const walk = (id, depth, path) => {
      if(path.has(id)) return;                       // cycle: stop here
      rank[id] = Math.max(rank[id], depth);
      path.add(id);
      out[id].forEach(nx => walk(nx, depth + 1, path));
      path.delete(id);
    };
    seeds.forEach(id => walk(id, 0, new Set()));
    return rank;
  },

  // Order within each rank by the average position of a node's parents, which
  // is a cheap and effective way to reduce crossings.
  order(nodes, edges, rank){
    const rows = {};
    nodes.forEach(n => { (rows[rank[n.id]] = rows[rank[n.id]] || []).push(n.id); });
    const parents = {};
    nodes.forEach(n => { parents[n.id] = []; });
    edges.forEach(e => { if(parents[e.to]) parents[e.to].push(e.from); });

    const ranks = Object.keys(rows).map(Number).sort((a, b) => a - b);
    const pos = {};
    ranks.forEach(r => rows[r].forEach((id, i) => { pos[id] = i; }));

    for(let pass = 0; pass < 3; pass++){
      ranks.slice(1).forEach(r => {
        rows[r].sort((a, b) => {
          const bary = id => {
            const ps = parents[id].filter(p => pos[p] !== undefined);
            return ps.length ? ps.reduce((s, p) => s + pos[p], 0) / ps.length : pos[id];
          };
          return bary(a) - bary(b);
        });
        rows[r].forEach((id, i) => { pos[id] = i; });
      });
    }
    return rows;
  },

  // Place each row centred on a common axis.
  flow(spec, origin){
    const nodes = spec.nodes || [], edges = spec.edges || [];
    if(!nodes.length) return { boxes: [], width: 0, height: 0 };
    const rank = this.rank(nodes, edges);
    const rows = this.order(nodes, edges, rank);
    const ranks = Object.keys(rows).map(Number).sort((a, b) => a - b);

    const widths = {};
    nodes.forEach(n => { widths[n.id] = this.widthFor(n.label); });

    const rowWidth = r => rows[r].reduce((s, id) => s + widths[id], 0) + (rows[r].length - 1) * this.GAP_X;
    const widest = Math.max(...ranks.map(rowWidth));

    const ox = (origin && origin.x) || 60, oy = (origin && origin.y) || 60;
    const boxes = [];
    ranks.forEach((r, ri) => {
      let x = ox + (widest - rowWidth(r)) / 2;
      const y = oy + ri * (this.NODE_H + this.GAP_Y);
      rows[r].forEach(id => {
        const n = nodes.find(v => v.id === id);
        boxes.push({ id, label: n.label, kind: n.kind || 'step',
                     x, y, w: widths[id], h: this.NODE_H });
        x += widths[id] + this.GAP_X;
      });
    });
    return { boxes, width: widest, height: ranks.length * (this.NODE_H + this.GAP_Y) };
  },
};

// ===== Notebook structure (Phases 6 & 8) =============================
// The notebook is exposed to TARS as objects, positions and connections —
// never as a flat image. That is what lets it answer "what does this diagram
// say" without a vision call, and what a later diagram model would build on.
const NotePage = {
  // --- Phase 8: connections -------------------------------------------
  // An arrow joins two things when each end sits near one. Proximity is
  // scaled to the arrow's own length, so a short arrow between small boxes
  // works as well as a long one across a page.
  nodeAt(pt, nodes, tol){
    let best = null, bestD = Infinity;
    nodes.forEach(n => {
      const b = n.bounds;
      // Distance to the node's rectangle, zero when inside it.
      const dx = Math.max(b.x0 - pt[0], 0, pt[0] - b.x1);
      const dy = Math.max(b.y0 - pt[1], 0, pt[1] - b.y1);
      const d = Math.hypot(dx, dy);
      if(d < bestD){ bestD = d; best = n; }
    });
    return bestD <= tol ? best : null;
  },

  boundsOf(o){
    const g = o.geom || {};
    if(o.type === 'text') return { x0:o.x, y0:o.y, x1:o.x + o.width, y1:o.y + o.height };
    switch(o.kind){
      case 'circle':   return { x0:g.cx-g.r, y0:g.cy-g.r, x1:g.cx+g.r, y1:g.cy+g.r };
      case 'ellipse':  return { x0:g.cx-g.rx, y0:g.cy-g.ry, x1:g.cx+g.rx, y1:g.cy+g.ry };
      case 'square':
      case 'rectangle':return { x0:g.x, y0:g.y, x1:g.x+g.w, y1:g.y+g.h };
      case 'triangle': {
        const xs = (g.points||[]).map(p=>p[0]), ys = (g.points||[]).map(p=>p[1]);
        return { x0:Math.min(...xs), y0:Math.min(...ys), x1:Math.max(...xs), y1:Math.max(...ys) };
      }
      default: return { x0:Math.min(g.x1,g.x2), y0:Math.min(g.y1,g.y2),
                        x1:Math.max(g.x1,g.x2), y1:Math.max(g.y1,g.y2) };
    }
  },

  // Text sitting inside or just under a shape is that shape's label.
  labelFor(node, texts){
    const b = node.bounds;
    let best = null, bestD = Infinity;
    texts.forEach(t => {
      const tc = [t.x + t.width/2, t.y + t.height/2];
      const inside = tc[0] >= b.x0 && tc[0] <= b.x1 && tc[1] >= b.y0 && tc[1] <= b.y1;
      const d = inside ? 0 : Math.hypot(tc[0] - (b.x0+b.x1)/2, tc[1] - (b.y0+b.y1)/2);
      const reach = Math.max(40, (b.x1-b.x0) * 0.8);
      if(d < bestD && d <= reach){ bestD = d; best = t; }
    });
    return best ? best.content : null;
  },

  // Objects, positions and connections — the model the brief asked for.
  graph(){
    const objs = (Ink.doc.objects || []);
    const texts = objs.filter(o => o.type === 'text');
    const shapes = objs.filter(o => o.type === 'shape' && o.kind !== 'arrow' && o.kind !== 'line');
    const arrows = objs.filter(o => o.type === 'shape' && (o.kind === 'arrow' || o.kind === 'line'));

    const nodes = shapes.map(s => ({
      id: s.id, kind: s.kind, bounds: this.boundsOf(s), label: null,
    }));
    // Free-standing text is a node in its own right; many diagrams are just
    // words joined by arrows, with no boxes at all.
    texts.forEach(t => {
      const b = this.boundsOf(t);
      const insideShape = nodes.some(n =>
        b.x0 >= n.bounds.x0 - 4 && b.x1 <= n.bounds.x1 + 4 &&
        b.y0 >= n.bounds.y0 - 4 && b.y1 <= n.bounds.y1 + 4);
      if(!insideShape) nodes.push({ id:t.id, kind:'text', bounds:b, label:t.content });
    });
    nodes.forEach(n => { if(!n.label) n.label = this.labelFor(n, texts); });

    const edges = [];
    arrows.forEach(a => {
      // A bound arrow states its connection outright. Proximity is only a
      // fallback for arrows drawn before bindings existed, and it guesses.
      if(a.startBinding || a.endBinding){
        const from = nodes.find(n => n.id === a.startBinding);
        const to   = nodes.find(n => n.id === a.endBinding);
        if(from && to && from.id !== to.id){
          edges.push({ id:a.id, from:from.id, to:to.id,
                       directed: a.kind === 'arrow', bound:true });
          return;
        }
      }
      const g = a.geom || {};
      const len = Math.hypot((g.x2||0)-(g.x1||0), (g.y2||0)-(g.y1||0));
      const tol = Math.max(28, len * 0.28);
      const from = this.nodeAt([g.x1, g.y1], nodes, tol);
      const to   = this.nodeAt([g.x2, g.y2], nodes, tol);
      if(from && to && from.id !== to.id){
        edges.push({ id:a.id, from:from.id, to:to.id,
                     directed: a.kind === 'arrow', bound:false });
      }
    });
    return { nodes, edges };
  },

  // Readable rendering of the graph, for the prompt and for TARS answers.
  describeGraph(){
    const { nodes, edges } = this.graph();
    if(!nodes.length) return '';
    const name = id => {
      const n = nodes.find(x => x.id === id);
      return n ? (n.label || n.kind) : '?';
    };
    const lines = [];
    if(edges.length){
      lines.push('Diagram connections:');
      edges.forEach(e => lines.push(`  ${name(e.from)} ${e.directed ? '->' : '--'} ${name(e.to)}`
        + (e.bound ? '' : '  (inferred from position, not certain)')));
    }
    const loose = nodes.filter(n => !edges.some(e => e.from === n.id || e.to === n.id));
    if(loose.length) lines.push('Unconnected: ' + loose.map(n => n.label || n.kind).join(', '));
    return lines.join('\n');
  },

  // --- Phase 6: what TARS is given ------------------------------------
  // Structured, compact, and only when a note is actually open.
  context(){
    if(!activeNoteId) return '';
    const ed = document.getElementById('notebook-canvas');
    const body = ed ? (ed.innerText || '').trim() : '';
    const nb = (notebooks || []).find(x => x.id === activeFolderId);
    const title = document.getElementById('nb-title-input')?.value || 'Untitled';
    const hand = (Ink.doc.objects || []).filter(o => o.type === 'text');
    const shapes = (Ink.doc.objects || []).filter(o => o.type === 'shape');
    const rawInk = (Ink.doc.strokes || []).filter(s => !s.hidden).length;

    const parts = [`Open note: "${title}"${nb ? ` in notebook "${nb.title}"` : ''}.`];
    if(body) parts.push('Typed text:\n' + body.slice(0, 1200));
    if(hand.length) parts.push('Recognised handwriting:\n'
      + hand.map(o => `  [at ${Math.round(o.x)},${Math.round(o.y)}] ${o.content}`).join('\n').slice(0, 1200));
    if(shapes.length) parts.push(`Shapes drawn: ${shapes.map(s => s.kind).join(', ')}.`);
    if(rawInk) parts.push(`${rawInk} handwritten strokes are not yet recognised — `
      + 'you cannot read them until the user runs handwriting recognition. Do not guess what they say.');
    const g = this.describeGraph();
    if(g) parts.push(g);
    return parts.join('\n\n').slice(0, 2200);
  },
};


// ===== Handwriting training ==========================================
// Teaches the reader this hand by example. Two mechanisms:
//   1. a reference chart of labelled samples, sent alongside the page
//   2. corrections, which are the most valuable samples because they record
//      exactly where the reader went wrong
// This is few-shot conditioning, not training: it biases recognition toward
// your letterforms, it does not retrain the model, and it cannot rescue
// genuinely ambiguous writing.
const Handwriting = {
  samples: [], loaded: false, sheet: null, sheetAt: 0,

  // A short drill: single letters, then digits, then the words this job
  // actually uses. Ordered so the alphabet is covered before vocabulary.
  DRILL: [
    'a b c d e f g', 'h i j k l m n', 'o p q r s t u', 'v w x y z',
    'A B C D E F G', 'H I J K L M N', 'O P Q R S T U', 'V W X Y Z',
    '0 1 2 3 4 5 6 7 8 9',
    'Deye Growatt Foxess', 'Solis Hoymiles Huawei',
    'inversor garantia', 'sobretensão firmware',
    'PAC-18372  SN 1234', 'F35 OV-G-V 409',
  ],

  async load(force){
    if(this.loaded && !force) return;
    try{
      const r = await fetch(FN_URL + "/agenda-handwriting", { headers: authHeaders() });
      const out = await readJson(r);
      if(!out.ok) return;
      this.samples = await Promise.all((out.json.samples || []).map(async s => ({
        ...s,
        label: await decStr(s.label),
        ink: await decStr(s.ink),
        wrong: s.wrong ? await decStr(s.wrong) : null,
      })));
      this.loaded = true;
      this.sheet = null;                 // samples changed, chart is stale
      renderHandwritingStatus();
    }catch(e){}
  },

  async add(label, strokes, kind, wrong){
    if(!label || !strokes || !strokes.length) return false;
    const r = await fetch(FN_URL + "/agenda-handwriting", {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({
        kind: kind || 'word',
        label: await encStr(label),
        ink: await encStr(JSON.stringify(strokes)),
        wrong: wrong ? await encStr(wrong) : null,
      }),
    });
    if(!r.ok) return false;
    await this.load(true);
    return true;
  },

  async remove(id){
    const r = await fetch(FN_URL + "/agenda-handwriting", {
      method:'DELETE', headers: authHeaders(), body: JSON.stringify(id ? { id } : { all:true }) });
    if(r.ok) await this.load(true);
    return r.ok;
  },

  // Render stored samples into one chart: the writing on top, what it means
  // printed underneath. Capped, because a huge image costs tokens and the
  // model stops attending to it.
  buildSheet(max){
    const picks = this.samples
      .filter(s => s.ink)
      .sort((a, b) => (a.kind === 'correction' ? -1 : 0) - (b.kind === 'correction' ? -1 : 0))
      .slice(0, max || 14);
    if(!picks.length) return null;
    if(this.sheet && Date.now() - this.sheetAt < 120000) return this.sheet;

    const rows = [];
    picks.forEach(s => {
      let strokes;
      try{ strokes = JSON.parse(s.ink); }catch(e){ return; }
      if(!strokes || !strokes.length) return;
      const pts = strokes.flatMap(k => k.points || []);
      if(!pts.length) return;
      const b = ShapeRec.bbox(pts);
      rows.push({ strokes, b, label: s.label });
    });
    if(!rows.length) return null;

    const PAD = 14, LABEL_H = 22, MAXW = 520;
    const scaleFor = r => Math.min(2.2, MAXW / Math.max(40, r.b.w));
    const heights = rows.map(r => Math.max(30, r.b.h * scaleFor(r)) + LABEL_H + PAD);
    const cw = MAXW + PAD * 2;
    const ch = heights.reduce((a, b2) => a + b2, 0) + PAD;

    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);
    g.lineCap = 'round'; g.lineJoin = 'round';

    let y = PAD;
    rows.forEach((r, i) => {
      const sc = scaleFor(r);
      g.strokeStyle = '#111111';
      r.strokes.forEach(k => {
        const p = k.points || [];
        for(let j = 1; j < p.length; j++){
          g.lineWidth = Math.max(1.6, (k.width || 2) * sc * 0.9);
          g.beginPath();
          g.moveTo(PAD + (p[j-1][0] - r.b.x0) * sc, y + (p[j-1][1] - r.b.y0) * sc);
          g.lineTo(PAD + (p[j][0] - r.b.x0) * sc, y + (p[j][1] - r.b.y0) * sc);
          g.stroke();
        }
      });
      const bandY = y + Math.max(30, r.b.h * sc) + 4;
      g.fillStyle = '#666666';
      g.font = '13px ui-sans-serif, system-ui, sans-serif';
      g.fillText('= ' + String(r.label).replace(/\n/g, ' / ').slice(0, 70), PAD, bandY + 12);
      g.strokeStyle = '#dddddd'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(PAD, bandY + 18); g.lineTo(cw - PAD, bandY + 18); g.stroke();
      y += heights[i];
    });

    this.sheet = cv.toDataURL('image/png');
    this.sheetAt = Date.now();
    cv.width = cv.height = 0;
    return this.sheet;
  },

  // A misread word is the single most useful sample there is.
  async learnCorrection(originalText, correctedText, strokeIds){
    if(!originalText || !correctedText || originalText.trim() === correctedText.trim()) return false;
    const strokes = (Ink.doc.strokes || []).filter(s => strokeIds.includes(s.id));
    if(!strokes.length) return false;
    return this.add(correctedText.trim(), strokes, 'correction', originalText.trim());
  },
};

function renderHandwritingStatus(){
  const el = document.getElementById('hw-status');
  if(!el) return;
  const n = Handwriting.samples.length;
  const corr = Handwriting.samples.filter(s => s.kind === 'correction').length;
  el.textContent = n ? `${n} samples${corr ? `, ${corr} from corrections` : ''}` : 'nothing taught yet';
  el.className = n ? 'ok' : '';
}


// ===== Session capture =================================================
// Not every exchange is worth keeping. "How's the weather" and "create a case
// for XYZ" are routine — the first is trivia, the second already produced a
// record. What earns a place is the reasoning: a fault traced, a correction
// made, an outcome reached. Those are summarised once, when the thread ends.
const Session = {
  turns: [], startedAt: 0, idleTimer: null, lastCase: null,
  IDLE_MS: 8 * 60 * 1000,

  // Local scoring, so nothing is spent deciding whether to spend anything.
  TRIVIAL: /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|sure|oi|olá|obrigad\w*|beleza|valeu)\b/i,
  ROUTINE: /\b(weather|clima|tempo|what time|que horas|navigate|open the|abre? a|switch to|mute|unmute|volume|theme|tema)\b/i,
  // Global flag matters: without it .match returns capture groups, not a count,
  // so a genuinely substantial conversation scored the same as a trivial one.
  MEANINGFUL: /\b(fault|error|erro|falha|code|código|F\d{2}|OV-G-V|overvoltage|sobretens\w*|because|porque|caused|causou|fixed|resolved|resolvido|replaced|trocad\w*|firmware|warranty|garantia|inverter|inversor|diagnos|root cause|causa raiz|turned out|na verdade|actually|wrong|errado|measured|medi\w*)\b/gi,

  note(role, text){
    if(!text) return;
    this.startedAt = this.startedAt || Date.now();
    this.turns.push({ role, text: String(text).slice(0, 900), t: Date.now() });
    if(this.turns.length > 40) this.turns.shift();
    if(TarsContext.selectedCaseId) this.lastCase = TarsContext.selectedCaseId;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('idle'), this.IDLE_MS);
  },

  // Worth keeping only if there is substance and it is not routine chatter.
  score(turns){
    const user = turns.filter(t => t.role === 'user').map(t => t.text).join(' ');
    const all = turns.map(t => t.text).join(' ');
    if(turns.length < 4) return 0;
    if(Session.TRIVIAL.test(user.trim()) && turns.length < 6) return 0;

    let s = 0;
    Session.MEANINGFUL.lastIndex = 0;   // a /g regex keeps state between calls
    const hits = (all.match(Session.MEANINGFUL) || []).length;
    s += Math.min(3, hits);
    if(Session.lastCase) s += 2;                     // tied to real work
    if(turns.length >= 10) s += 1;                   // a sustained thread
    // A conversation that was only routine commands has produced its records
    // already; there is nothing left to learn from it.
    if(Session.ROUTINE.test(user) && hits === 0) s -= 2;
    return s;
  },

  async close(reason){
    clearTimeout(this.idleTimer);
    const turns = this.turns.slice();
    this.turns = []; this.startedAt = 0;
    if(turns.length < 4) return;

    const worth = this.score(turns);
    if(worth < 3) return;                            // routine: nothing filed

    const transcript = turns.map(t => `${t.role === 'user' ? 'Q' : 'A'}: ${t.text}`).join('\n').slice(0, 4000);
    const sys = [
      'Summarise this support conversation for a technician\'s own records.',
      'Reply as JSON only: {"summary":"…","outcome":"…","keywords":"…","worth_keeping":true|false}',
      'summary: two sentences on what was actually worked out. No pleasantries.',
      'outcome: what was concluded or decided. Empty string if nothing was.',
      'keywords: 4 to 8 lowercase terms, comma separated — manufacturers, fault codes, parts.',
      'worth_keeping: false if this was small talk, a simple lookup, or produced no insight.',
      'Record only what was said. Never add a diagnosis nobody reached.',
    ].join('\n');

    let parsed = null;
    try{
      const raw = await callAi(transcript, sys);
      parsed = JSON.parse(String(raw).replace(/```json?|```/g, '').trim());
    }catch(e){ return; }                             // a failed summary files nothing
    if(!parsed || parsed.worth_keeping === false || !parsed.summary) return;

    try{
      await Learn.addEpisode({
        case_id: this.lastCase || null,
        kind: 'conversation',
        summary: String(parsed.summary).slice(0, 600),
        outcome: String(parsed.outcome || '').slice(0, 300),
        keywords: String(parsed.keywords || '').slice(0, 200),
        detail: { turns: turns.length, reason },
      });
      if(typeof GalaxyFeed !== 'undefined') GalaxyFeed.push('tars', parsed.summary.slice(0, 70));
    }catch(e){}
    this.lastCase = null;
  },
};


// ===== Galaxy life =====================================================
// The map was accurate but inert. These four things make it show where the
// work IS, not merely what exists: a running feed, motion that decays with
// attention, a weekly pulse, and hubs that look like hubs.
const GalaxyFeed = {
  items: [], MAX: 60,

  // How each tool reads in the feed. Anything not named here still appears,
  // under its own name — silence would be worse than an unpolished label.
  TOOL_LABEL: {
    web_search:        ['web',  q => `searched the web for “${q}”`],
    find_in_galaxy:    ['kb',   q => `looked up “${q}” in the galaxy`],
    search_notes:      ['kb',   q => `searched the notebooks for “${q}”`],
    recall_experience: ['rule', q => `recalled experience of “${q}”`],
    learn_rule:        ['rule', q => `learned: ${q}`],
    remember:          ['rule', q => `remembered: ${q}`],
    add_knowledge:     ['kb',   q => `added “${q}” to the knowledge base`],
    create_case:       ['case', q => `created case “${q}”`],
    update_case:       ['case', q => `updated “${q}”`],
    delete_case:       ['close',q => `deleted “${q}”`],
    create_note:       ['kb',   q => `wrote note “${q}”`],
    create_notebook:   ['kb',   q => `created notebook “${q}”`],
    draw_diagram:      ['kb',   q => `drew a diagram: ${q}`],
    look_at_screen:    ['web',  () => 'read your screen'],
    search_email:      ['web',  q => `searched mail for “${q}”`],
    get_briefing:      ['case', () => 'reviewed the day'],
    start_focus:       ['case', q => `started focus: ${q}`],
    record_outcome:    ['close',q => `recorded an outcome`],
  },

  tool(name, args, result){
    const a = args || {};
    // The most descriptive argument, whatever the tool calls it.
    const subject = String(a.query || a.title || a.titulo || a.statement
                    || a.content || a.label || a.text || '').slice(0, 44);
    const spec = this.TOOL_LABEL[name];
    const failed = /^(failed|could not|no |nothing)/i.test(String(result || ''));
    const kind = failed ? 'close' : (spec ? spec[0] : 'tars');
    const text = spec ? spec[1](subject || '…')
                      : `${name.replace(/_/g, ' ')}${subject ? ' — ' + subject : ''}`;
    this.push(kind, failed ? text + ' (nothing found)' : text);
  },

  push(kind, text){
    if(!text) return;
    this.items.unshift({ kind, text: String(text).slice(0, 90), t: Date.now() });
    if(this.items.length > this.MAX) this.items.pop();
    this.render();
    // A freshly touched subject glows and drifts for a while.
    GalaxyLife.touch(text);
    if(this.onPush) try{ this.onPush(kind, text); }catch(e){}
  },
  render(){
    const el = document.getElementById('galaxy-feed');
    if(!el) return;
    const colour = { tars:'var(--accent3)', case:'var(--amber)', kb:'var(--accent2)',
                     rule:'var(--ok)', web:'var(--accent3)', close:'var(--muted)' };
    el.innerHTML = this.items.slice(0, 12).map(i => {
      const mins = Math.round((Date.now() - i.t) / 60000);
      const when = mins < 1 ? 'now' : mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h';
      return `<div class="gf-row"><span class="gf-dot" style="background:${colour[i.kind] || 'var(--muted)'}"></span>`
        + `<span class="gf-text">${escapeHtml(i.text)}</span><span class="gf-when">${when}</span></div>`;
    }).join('') || '<div class="gf-empty">Nothing yet today.</div>';
  },
};

// Recency as a visible property. A star touched in the last hour burns; one
// untouched for a month settles and dims — so the eye lands on live work.
const GalaxyLife = {
  heat: {},                       // node id or label -> last touched
  touch(key){
    if(!key) return;
    this.heat[String(key).toLowerCase().slice(0, 40)] = Date.now();
  },
  heatFor(node){
    const k = String(node.label || node.id || '').toLowerCase().slice(0, 40);
    const t = this.heat[k] || node.updated || node.t || 0;
    if(!t) return 0;
    const age = Date.now() - t;
    const DAY = 86400000;
    if(age < 3600000) return 1;                 // within the hour
    if(age > 30 * DAY) return 0;
    return Math.max(0, 1 - age / (30 * DAY));
  },
};

// The week at a glance, from records already held — no extra queries.
function galaxyPulse(){
  const now = Date.now(), WEEK = 7 * 86400000;
  const recent = (cases || []).filter(x => Date.parse(x.created_at || 0) > now - WEEK);
  return {
    urgent: (cases || []).filter(x => x.prioridade === 'urgente' && x.status !== 'resolvido').length,
    fresh:  recent.length,
    closed: (cases || []).filter(x => x.status === 'resolvido'
             && Date.parse(x.updated_at || 0) > now - WEEK).length,
  };
}
function renderGalaxyPulse(){
  const el = document.getElementById('galaxy-pulse');
  if(!el) return;
  const p = galaxyPulse();
  el.innerHTML = `<div class="gp-num" style="color:var(--urgente)">${p.urgent}<span>urgent</span></div>`
    + `<div class="gp-num" style="color:var(--ok)">+${p.fresh}<span>new</span></div>`
    + `<div class="gp-num" style="color:var(--accent2)">${p.closed}<span>closed</span></div>`;
}


// The left rail: what is in the map, and a way into it. Counts come from the
// same nodes the canvas draws, so the two can never disagree.
function renderGalaxySide(){
  const st = document.getElementById('gl-status');
  const cl = document.getElementById('gl-clusters');
  if(!st || !cl || !Galaxy.ready) return;

  const css = getComputedStyle(document.documentElement);
  const pal = ['--accent2','--accent3','--dusk','--amber'].map(v => css.getPropertyValue(v).trim() || '#4f9fd8');
  const row = (colour, label, n, click) =>
    `<button class="gl-row"${click ? ` data-focus="${escapeHtml(label)}"` : ''}>`
    + `<span class="gl-dot" style="background:${colour}"></span>`
    + `<span class="gl-name">${escapeHtml(label)}</span><span class="gl-n">${n}</span></button>`;

  const open = (cases || []).filter(x => x.status !== 'resolvido');
  const by = p => open.filter(x => x.prioridade === p).length;
  st.innerHTML =
      row(css.getPropertyValue('--urgente').trim() || '#e15b4c', 'Urgent', by('urgente'))
    + row(css.getPropertyValue('--alta').trim() || '#e59a3c', 'High', by('alta'))
    + row(css.getPropertyValue('--media').trim() || '#4fd6b8', 'Medium', by('media'))
    + row(css.getPropertyValue('--ok').trim() || '#54c98a', 'Resolved',
          (cases || []).filter(x => x.status === 'resolvido').length);

  const counts = {};
  (Galaxy.nodes || []).forEach(n => { if(n.folder) counts[n.folder] = (counts[n.folder] || 0) + 1; });
  const folders = (Galaxy.folders || []).filter(f => counts[f]);
  cl.innerHTML = folders
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 12)
    .map(f => row(pal[folders.indexOf(f) % pal.length], f, counts[f], true))
    .join('') || '<div class="gf-empty">No clusters yet.</div>';

  cl.querySelectorAll('[data-focus]').forEach(b => {
    b.addEventListener('click', () => {
      // Clicking a cluster focuses its hub, which is the entry the rest hang
      // off — more useful than focusing an arbitrary member.
      const name = b.dataset.focus;
      const inF = (Galaxy.nodes || []).filter(n => n.folder === name);
      if(!inF.length) return;
      const hub = inF.find(n => n.isHub) || inF.reduce((a, x) => (x.deg > a.deg ? x : a), inF[0]);
      Galaxy.focus = Galaxy.focus === hub ? null : hub;
      Galaxy.dirty = true;
      cl.querySelectorAll('[data-focus]').forEach(x => x.classList.toggle('on', x === b && Galaxy.focus));
      SFX.tick();
    });
  });
}


// ===== Spoken vocabulary ==============================================
// Speech recognition guesses proper nouns badly unless it is told them in
// advance: "Deye" comes back as "D-E", "Foxess" as "fox s". Whisper accepts a
// prompt that biases exactly this, so the terms this account uses are gathered
// and handed over on every transcription.
const Vocab = {
  manual: [],                 // typed by the user
  MAX: 60,

  load(){
    this.manual = Array.isArray(settings.vocab) ? settings.vocab.slice(0, this.MAX) : [];
    this.loadAliases();
  },
  save(){
    settings.vocab = this.manual.slice(0, this.MAX);
    saveSettings();
    renderVocab();
  },
  add(word){
    const w = String(word || '').trim();
    if(!w || w.length > 40) return false;
    if(this.manual.some(x => x.toLowerCase() === w.toLowerCase())) return false;
    this.manual.unshift(w);
    this.save();
    return true;
  },
  remove(word){
    this.manual = this.manual.filter(x => x !== word);
    this.save();
  },


  // --- calibration -----------------------------------------------------
  // Telling the recogniser a word exists helps; knowing what it actually hears
  // instead is better. The user says the word a few times, and whatever comes
  // back wrong becomes a correction applied to every later transcript.
  aliases: {},                 // misheard -> intended

  loadAliases(){
    this.aliases = (settings.vocabAliases && typeof settings.vocabAliases === 'object')
      ? { ...settings.vocabAliases } : {};
  },
  addAlias(heard, intended){
    const h = String(heard || '').trim().toLowerCase();
    const w = String(intended || '').trim();
    if(!h || !w || h === w.toLowerCase() || h.length > 40) return false;
    this.aliases[h] = w;
    settings.vocabAliases = this.aliases;
    saveSettings();
    return true;
  },

  // Applied to every transcript before anything else reads it.
  correct(text){
    let t = String(text || '');
    if(!t) return t;
    Object.entries(this.aliases).forEach(([heard, intended]) => {
      // Whole words only, and punctuation-tolerant: "d-e" and "D. E." are the
      // same mishearing.
      // Escaping first turned "." into "\." and broke the separator swap, which
      // produced an invalid pattern. Split, then escape each piece.
      const esc = heard.split(/[-.\s]+/).filter(Boolean)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[-.\\s]*');
      if(!esc) return;
      t = t.replace(new RegExp('(^|[^\\p{L}])' + esc + '(?=$|[^\\p{L}])', 'giu'),
                    (m, p1) => p1 + intended);
    });
    return t;
  },

  // Everything worth biasing towards: typed terms first, then what the
  // knowledge base and open cases actually contain.
  terms(){
    const out = [];
    const seen = new Set();
    const push = w => {
      const k = String(w || '').trim();
      if(!k || k.length < 3 || k.length > 32) return;
      const low = k.toLowerCase();
      if(seen.has(low)) return;
      seen.add(low); out.push(k);
    };
    this.manual.forEach(push);
    (KB || []).forEach(e => (e.tags || []).forEach(push));
    (cases || []).slice(0, 40).forEach(cs => {
      String(cs.titulo || '').split(/[^\p{L}\p{N}.-]+/u)
        .filter(w => /^[A-ZÁÉÍÓÚ]/.test(w) || /\d/.test(w)).forEach(push);
    });
    return out.slice(0, this.MAX);
  },

  // Whisper takes a prose prompt, not a list, so the terms are given as a
  // sentence — which is also what biases it most reliably.
  line(){
    const t = this.terms();
    if(!t.length) return '';
    return 'Termos usados aqui: ' + t.join(', ') + '.';
  },
};

function renderVocab(){
  const box = document.getElementById('vocab-list');
  if(!box) return;
  const auto = Vocab.terms().filter(t => !Vocab.manual.includes(t));
  box.innerHTML =
      Vocab.manual.map(w =>
        `<span class="vb vb-own">${escapeHtml(w)}<button data-vb="${escapeHtml(w)}">×</button></span>`).join('')
    + auto.slice(0, 30).map(w => `<span class="vb">${escapeHtml(w)}</span>`).join('')
    || '<span class="gf-empty">Nothing yet — add the words that get misheard.</span>';
  box.querySelectorAll('[data-vb]').forEach(b =>
    b.addEventListener('click', () => Vocab.remove(b.dataset.vb)));
  const n = document.getElementById('vocab-count');
  if(n) n.textContent = `${Vocab.manual.length} added · ${auto.length} from your records`;
}


// ===== TARS suggests ==================================================
// Reads the agenda and calendar and proposes what to do next. Deliberately
// computed locally: suggestions that cost an API call would either be stale or
// exhaust the rate limit, and every rule here is one a technician would apply
// anyway — the value is that nobody has to scan the list to spot them.
const Suggest = {
  build(){
    const out = [];
    const now = new Date();
    const today = dateStr(now);
    const mins = now.getHours() * 60 + now.getMinutes();
    const open = (cases || []).filter(x => x.status !== 'resolvido');
    const todays = open.filter(x => x.case_date === today);

    // 1. Anything urgent that is not yet scheduled today.
    const urgentUnscheduled = open.filter(x =>
      x.prioridade === 'urgente' && x.case_date !== today);
    if(urgentUnscheduled.length){
      out.push({ kind:'urgent',
        text: `${urgentUnscheduled.length} urgent case${urgentUnscheduled.length > 1 ? 's' : ''} not on today's list`,
        why: urgentUnscheduled.slice(0, 2).map(x => x.titulo).join(', '),
        act: 'Schedule the oldest first' });
    }

    // 2. A free stretch before the end of the day.
    const later = todays.filter(x => toMin(x.horario) > mins).sort((a, b) => toMin(a.horario) - toMin(b.horario));
    // Only inside working hours, and capped at the end of the day — otherwise
    // an empty evening reported "1380 minutes free", which is true and useless.
    const DAY_END = 18 * 60;
    const rawNext = later.length ? toMin(later[0].horario) : DAY_END;
    const nextAt = Math.min(rawNext, DAY_END);
    const gap = nextAt - mins;
    if(gap >= 45 && mins >= 7 * 60 && mins < 17 * 60){
      const span = gap >= 90
        ? `${(gap / 60).toFixed(gap % 60 ? 1 : 0)} hours`
        : `${Math.round(gap / 15) * 15} minutes`;
      out.push({ kind:'gap',
        text: `${span} free before your next case`,
        why: later.length && rawNext <= DAY_END
          ? `next is ${later[0].titulo} at ${later[0].horario}`
          : 'nothing else booked today',
        act: 'Good window for a stalled case' });
    }

    // 3. Cases that look like one underlying fault. Matching on the client
    //    alone was too crude — two Deye jobs for the same integrator are not
    //    the same problem. A shared fault code or symptom is the real signal.
    const dup = this.duplicates(open);
    if(dup){
      const codes = dup.signal ? ` — both mention ${dup.signal}` : '';
      out.push({ kind:'repeat', merge: dup,
        text: `${dup.cases.length} cases look like the same fault${codes}`,
        why: dup.cases.map(x => x.titulo).slice(0, 3).join(' · '),
        act: 'Merge into one case, keeping each note separate' });
    }

    // 4. Cases sitting untouched for a week.
    const stale = open.filter(x => {
      const t = Date.parse(x.updated_at || x.created_at || 0);
      return t && (Date.now() - t) > 7 * 86400000;
    });
    if(stale.length){
      out.push({ kind:'stale',
        text: `${stale.length} case${stale.length > 1 ? 's have' : ' has'} had no movement in a week`,
        why: stale.slice(0, 2).map(x => x.titulo).join(', '),
        act: 'Close them or chase the integrator' });
    }

    // 5. A heavy day worth reordering.
    if(todays.length >= 6){
      out.push({ kind:'load',
        text: `${todays.length} cases today — a full list`,
        why: 'the first hour is meant for urgent work',
        act: 'Move anything non-urgent to tomorrow' });
    }
    return out.slice(0, 4);
  },


  // What makes two cases the same problem: a shared fault code, or a shared
  // distinctive term plus the same client. Deliberately narrow — a false merge
  // suggestion costs more trust than a missed one.
  FAULT: /\b(F\d{2,3}|E\d{2,3}|OV-?G-?V|UV-?G-?V|ERR\d+|[0-9]{3} ?(sobretens\w+|overvolt\w+))\b/gi,

  signals(cs){
    const t = `${cs.titulo || ''} ${(cs.tags || []).join(' ')} ${
      (cs.notes_log || []).map(n => n && n.text || '').join(' ')}`;
    const out = new Set();
    (t.match(this.FAULT) || []).forEach(m => out.add(m.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    return out;
  },

  duplicates(open){
    // Group by shared fault code first.
    const byCode = {};
    open.forEach(cs => this.signals(cs).forEach(sig => {
      (byCode[sig] = byCode[sig] || []).push(cs);
    }));
    const codeHit = Object.entries(byCode)
      .filter(([, g]) => g.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)[0];
    if(codeHit) return { cases: codeHit[1], signal: codeHit[0], basis: 'fault code' };

    // Otherwise the same client with the same equipment word.
    const key = cs => {
      const words = String(cs.titulo || '').toLowerCase()
        .split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3);
      return words.slice(0, 2).join(' ');
    };
    const byKey = {};
    open.forEach(cs => { const k = key(cs); if(k) (byKey[k] = byKey[k] || []).push(cs); });
    const hit = Object.values(byKey).filter(g => g.length >= 3)
      .sort((a, b) => b.length - a.length)[0];
    return hit ? { cases: hit, signal: '', basis: 'same client and equipment' } : null;
  },

  render(){
    const box = document.getElementById('suggest-box');
    if(!box) return;
    const items = this.build();
    if(!items.length){
      box.innerHTML = '<div class="sg-clear">Nothing needs attention. The list is in order.</div>';
      return;
    }
    const tone = { urgent:'var(--urgente)', stale:'var(--alta)', repeat:'var(--accent3)',
                   gap:'var(--ok)', load:'var(--amber)' };
    box.innerHTML = items.map(i =>
      `<div class="sg-row" style="border-left-color:${tone[i.kind] || 'var(--line)'}">`
      + `<div class="sg-text">${escapeHtml(i.text)}</div>`
      + `<div class="sg-why">${escapeHtml(i.why)}</div>`
      + `<div class="sg-act">${escapeHtml(i.act)}</div>`
      + (i.merge ? `<button class="sg-btn" data-merge="1">Ask TARS to merge them</button>` : '')
      + `</div>`).join('');

    // The merge is proposed to TARS rather than performed here: combining
    // cases is destructive, and it should be confirmed like any other change.
    const mergeItem = items.find(i => i.merge);
    box.querySelector('[data-merge]')?.addEventListener('click', () => {
      const names = mergeItem.merge.cases.map(x => x.titulo).join(', ');
      openAiPanel();
      const input = document.getElementById('ai-input');
      if(input){
        input.value = `These cases look like one fault${mergeItem.merge.signal
          ? ' (' + mergeItem.merge.signal + ')' : ''}: ${names}. `
          + 'Merge them into a single case but keep each visit as its own note. Ask me before changing anything.';
        input.focus();
      }
    });
  },
};
function toMin(hhmm){
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
}

// Canvas galaxy engine for Solar Agenda. Three visual variants over one
// deterministic layout + animation loop. No deps.
const TAU = Math.PI * 2;

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

function createGalaxy(canvas, opts) {
  const variant = opts.variant || 'constellation';
  const data = opts.data;
  const settings = opts.settings || {};
  const ctx = canvas.getContext('2d');
  const rnd = mulberry(variant === 'nebula' ? 4211 : variant === 'orrery' ? 7717 : 1301);

  /* ---------- layout ---------- */
  const clusters = data.clusters.map((c) => ({ ...c }));
  const n = clusters.length;
  clusters.forEach((c, i) => {
    if (i === 0) { c.x = 0; c.y = 0; c.big = true; return; }
    const a = -Math.PI / 2 + ((i - 1) / (n - 1)) * TAU + 0.18;
    const rx = variant === 'orrery' ? 430 : 400;
    const ry = variant === 'orrery' ? 250 : 232;
    c.x = Math.cos(a) * rx;
    c.y = Math.sin(a) * ry;
  });

  const perCluster = clusters.map(() => 0);
  const nodes = data.nodes.map((nd) => {
    const c = clusters[nd.cluster];
    const k = perCluster[nd.cluster]++;
    const ring = nd.hub ? -1 : k % 3;
    const base = variant === 'orrery' ? 58 + ring * 30 : 48 + ring * 25;
    const r = nd.hub ? 0 : base + rnd() * (variant === 'nebula' ? 20 : 10);
    return {
      ...nd, c, r, ring,
      a0: rnd() * TAU,
      spd: ((0.05 + rnd() * 0.05) / (1 + Math.max(ring, 0) * 0.55)) * (rnd() > 0.5 ? 1 : -1),
      tw: rnd() * TAU,
      size: (nd.hub ? 7.5 : 2.4 + nd.links * 0.42) * (variant === 'nebula' ? 1.1 : 1),
      x: c.x, y: c.y, alpha: 1, flash: 0,
    };
  });
  const hubs = nodes.filter((nd) => nd.hub);

  // a few long relationships between clusters
  const bridges = [];
  for (let i = 0; i < 14; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)];
    const b = nodes[Math.floor(rnd() * nodes.length)];
    if (a.cluster !== b.cluster) bridges.push({ a, b, off: rnd() });
  }

  const stars = [];
  for (let i = 0; i < 260; i++) {
    stars.push({ x: (rnd() - 0.5) * 1900, y: (rnd() - 0.5) * 1200, s: rnd() * 1.1 + 0.25, t: rnd() * TAU });
  }
  const dust = [];
  for (let i = 0; i < 70; i++) {
    dust.push({ x: (rnd() - 0.5) * 1500, y: (rnd() - 0.5) * 900, r: 90 + rnd() * 210, t: rnd() * TAU, c: clusters[Math.floor(rnd() * n)].color });
  }

  /* ---------- state ---------- */
  let W = 1, H = 1, dpr = 1;
  const z0 = opts.zoom != null ? opts.zoom : (variant === 'orrery' ? 0.72 : 0.8);
  const cam = { x: 0, y: 0, z: z0, tz: z0 };
  let focus = null;           // cluster index
  let hover = null;
  let maxAge = 999;
  let pings = [];
  let raf = 0, t0 = performance.now(), running = true;

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    W = r.width; H = r.height;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const toScreen = (wx, wy) => [wx * cam.z + W / 2 + cam.x, wy * cam.z + H / 2 + cam.y];
  const toWorld = (sx, sy) => [(sx - W / 2 - cam.x) / cam.z, (sy - H / 2 - cam.y) / cam.z];

  /* ---------- draw ---------- */
  function frame(now) {
    if (!running) return;
    const t = (now - t0) / 1000;
    const motion = settings.motion === 'calm' ? 0.35 : settings.motion === 'hyper' ? 2.1 : 1;
    const glow = settings.glow == null ? 1 : settings.glow;
    cam.z += (cam.tz - cam.z) * 0.12;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // deep space background
    const bg = ctx.createRadialGradient(W * 0.5, H * 0.35, 0, W * 0.5, H * 0.35, Math.max(W, H) * 0.85);
    if (variant === 'nebula') { bg.addColorStop(0, '#131f2c'); bg.addColorStop(0.55, '#0c1420'); bg.addColorStop(1, '#070b11'); }
    else if (variant === 'orrery') { bg.addColorStop(0, '#101a24'); bg.addColorStop(0.6, '#0a121b'); bg.addColorStop(1, '#06090e'); }
    else { bg.addColorStop(0, '#14202c'); bg.addColorStop(0.6, '#0b131c'); bg.addColorStop(1, '#070b10'); }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';

    // nebula dust
    const dustA = variant === 'nebula' ? 0.16 : variant === 'orrery' ? 0.05 : 0.075;
    dust.forEach((d) => {
      const [sx, sy] = toScreen(d.x, d.y);
      const r = d.r * cam.z;
      if (sx < -r || sx > W + r || sy < -r || sy > H + r) return;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      const a = dustA * glow * (0.6 + 0.4 * Math.sin(t * 0.25 * motion + d.t));
      g.addColorStop(0, rgba(d.c, a));
      g.addColorStop(1, rgba(d.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    });

    // starfield
    stars.forEach((s) => {
      const [sx, sy] = toScreen(s.x, s.y);
      if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) return;
      const a = 0.22 + 0.5 * Math.abs(Math.sin(t * 0.7 * motion + s.t));
      ctx.fillStyle = 'rgba(214,231,247,' + a * 0.55 + ')';
      ctx.fillRect(sx, sy, s.s, s.s);
    });

    // node positions
    nodes.forEach((nd) => {
      const ang = nd.a0 + t * nd.spd * motion;
      const wob = variant === 'nebula' ? 1 + Math.sin(t * 0.6 * motion + nd.tw) * 0.06 : 1;
      const sq = variant === 'orrery' ? 0.58 : variant === 'nebula' ? 0.9 : 0.72;
      nd.x = nd.c.x + Math.cos(ang) * nd.r * wob;
      nd.y = nd.c.y + Math.sin(ang) * nd.r * wob * sq;
      const dim = focus != null && nd.cluster !== focus ? 0.1 : 1;
      const aged = nd.age > maxAge ? 0.05 : 1;
      nd.alpha += (dim * aged - nd.alpha) * 0.12;
      nd.flash *= 0.94;
    });

    // orbit rings
    if (variant !== 'nebula') {
      clusters.forEach((c, ci) => {
        const a = (focus != null && ci !== focus ? 0.05 : variant === 'orrery' ? 0.2 : 0.11) * glow;
        for (let ring = 0; ring < 3; ring++) {
          const rr = (variant === 'orrery' ? 58 + ring * 30 : 48 + ring * 25) * cam.z;
          const [sx, sy] = toScreen(c.x, c.y);
          ctx.beginPath();
          ctx.ellipse(sx, sy, rr, rr * (variant === 'orrery' ? 0.58 : 0.72), 0, 0, TAU);
          ctx.strokeStyle = rgba(c.color, a);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      });
    } else {
      // time rings: concentric "how old" bands
      const [cx, cy] = toScreen(0, 0);
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, i * 150 * cam.z, i * 92 * cam.z, 0, 0, TAU);
        ctx.strokeStyle = 'rgba(123,224,196,' + 0.045 * glow + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // hub -> node links
    nodes.forEach((nd) => {
      if (nd.hub || nd.alpha < 0.07) return;
      const [x1, y1] = toScreen(nd.c.x, nd.c.y);
      const [x2, y2] = toScreen(nd.x, nd.y);
      const col = variant === 'nebula' ? nd.statusColor : nd.c.color;
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = rgba(col, 0.14 * nd.alpha * glow);
      ctx.lineWidth = Math.max(0.6, nd.links * 0.12 * cam.z);
      ctx.stroke();
      // travelling pulse
      const p = (t * 0.22 * motion + nd.a0) % 1;
      const px = x1 + (x2 - x1) * p, py = y1 + (y2 - y1) * p;
      ctx.fillStyle = rgba(col, 0.5 * nd.alpha * glow);
      ctx.beginPath(); ctx.arc(px, py, 1.3 * cam.z + 0.5, 0, TAU); ctx.fill();
    });

    // cross-cluster bridges (curved)
    bridges.forEach((b) => {
      const a = Math.min(b.a.alpha, b.b.alpha);
      if (a < 0.07) return;
      const [x1, y1] = toScreen(b.a.x, b.a.y);
      const [x2, y2] = toScreen(b.b.x, b.b.y);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 60 * cam.z;
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.quadraticCurveTo(mx, my, x2, y2);
      ctx.strokeStyle = 'rgba(160,190,215,' + 0.1 * a * glow + ')';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      const p = (t * 0.1 * motion + b.off) % 1;
      const q = 1 - p;
      const px = q * q * x1 + 2 * q * p * mx + p * p * x2;
      const py = q * q * y1 + 2 * q * p * my + p * p * y2;
      ctx.fillStyle = rgba(b.a.c.color, 0.55 * a * glow);
      ctx.beginPath(); ctx.arc(px, py, 1.6, 0, TAU); ctx.fill();
    });

    // nodes
    nodes.forEach((nd) => {
      const [sx, sy] = toScreen(nd.x, nd.y);
      if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) return;
      const col = variant === 'nebula' && !nd.hub ? nd.statusColor : nd.c.color;
      const pulse = 1 + 0.12 * Math.sin(t * 1.5 * motion + nd.tw) + nd.flash * 1.4;
      const r = nd.size * cam.z * pulse * (nd.hub ? 1.25 : 1);
      const a = nd.alpha;
      // halo
      const hr = r * (nd.hub ? 9 : 5.2);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, hr);
      g.addColorStop(0, rgba(col, 0.5 * a * glow));
      g.addColorStop(0.35, rgba(col, 0.14 * a * glow));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx - hr, sy - hr, hr * 2, hr * 2);
      // core
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.9, r), 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, 0.55 + nd.flash) * a + ')';
      ctx.fill();
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.4, r * 1.7), 0, TAU);
      ctx.fillStyle = rgba(col, 0.55 * a);
      ctx.fill();
      // unlinked marker
      if (nd.links <= 1 && !nd.hub) {
        ctx.beginPath(); ctx.arc(sx, sy, r * 3.4, 0, TAU);
        ctx.strokeStyle = rgba('#e15b4c', 0.4 * a);
        ctx.lineWidth = 1; ctx.stroke();
      }
      if (nd === hover) {
        ctx.beginPath(); ctx.arc(sx, sy, r * 4.2 + 3, 0, TAU);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
    });

    // pings (live activity)
    pings = pings.filter((p) => t - p.t < 1.6);
    pings.forEach((p) => {
      const k = (t - p.t) / 1.6;
      const [sx, sy] = toScreen(p.node.x, p.node.y);
      ctx.beginPath();
      ctx.arc(sx, sy, (8 + k * 74) * cam.z, 0, TAU);
      ctx.strokeStyle = rgba(p.color, (1 - k) * 0.65 * glow);
      ctx.lineWidth = 2 * (1 - k) + 0.4;
      ctx.stroke();
    });

    ctx.globalCompositeOperation = 'source-over';

    // cluster labels
    if (cam.z > 0.42) {
      hubs.forEach((h) => {
        const [sx, sy] = toScreen(h.c.x, h.c.y);
        const a = focus != null && h.cluster !== focus ? 0.22 : 1;
        ctx.textAlign = 'center';
        ctx.font = '600 14px "Space Grotesk", sans-serif';
        ctx.fillStyle = rgba(h.c.color, a);
        ctx.fillText(h.c.name, sx, sy - 34 * cam.z - 14);
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(202,217,231,' + 0.5 * a + ')';
        ctx.fillText(h.c.count + ' entries', sx, sy - 34 * cam.z);
      });
    }

    drawMini();
    raf = requestAnimationFrame(frame);
  }

  /* ---------- minimap ---------- */
  const mini = opts.minimap || null;
  const mctx = mini ? mini.getContext('2d') : null;
  let mw = 0, mh = 0;
  function drawMini() {
    if (!mctx) return;
    const r = mini.getBoundingClientRect();
    if (!r.width) return;
    if (mw !== r.width || mh !== r.height) {
      mw = r.width; mh = r.height;
      mini.width = Math.round(mw * dpr); mini.height = Math.round(mh * dpr);
    }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, mw, mh);
    const s = Math.min(mw / 1250, mh / 800);
    const px = (wx) => mw / 2 + wx * s;
    const py = (wy) => mh / 2 + wy * s;
    mctx.globalCompositeOperation = 'lighter';
    nodes.forEach((nd) => {
      const col = variant === 'nebula' && !nd.hub ? nd.statusColor : nd.c.color;
      mctx.fillStyle = rgba(col, 0.25 + 0.6 * nd.alpha);
      const rr = nd.hub ? 2.2 : 1.1;
      mctx.beginPath(); mctx.arc(px(nd.x), py(nd.y), rr, 0, TAU); mctx.fill();
    });
    mctx.globalCompositeOperation = 'source-over';
    // viewport rect
    const [wx1, wy1] = toWorld(0, 0);
    const [wx2, wy2] = toWorld(W, H);
    mctx.strokeStyle = 'rgba(242,167,27,0.65)';
    mctx.lineWidth = 1;
    mctx.strokeRect(px(wx1), py(wy1), (wx2 - wx1) * s, (wy2 - wy1) * s);
  }

  /* ---------- interaction ---------- */
  function pick(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    let best = null, bd = 1e9;
    nodes.forEach((nd) => {
      if (nd.alpha < 0.2) return;
      const d = (nd.x - wx) ** 2 + (nd.y - wy) ** 2;
      const rad = (nd.size * 3.2 + 10 / cam.z) ** 2;
      if (d < rad && d < bd) { bd = d; best = nd; }
    });
    return best;
  }

  let dragging = false, moved = 0, lx = 0, ly = 0;
  const onDown = (e) => { dragging = true; moved = 0; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (dragging) {
      cam.x += e.clientX - lx; cam.y += e.clientY - ly;
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
      return;
    }
    const nd = pick(sx, sy);
    if (nd !== hover) {
      hover = nd;
      if (opts.onHover) opts.onHover(nd, sx, sy);
    } else if (nd && opts.onHover) opts.onHover(nd, sx, sy);
  };
  const onUp = (e) => {
    if (dragging && moved < 5) {
      const r = canvas.getBoundingClientRect();
      const nd = pick(e.clientX - r.left, e.clientY - r.top);
      focus = nd ? (focus === nd.cluster ? null : nd.cluster) : null;
      if (opts.onPick) opts.onPick(nd, focus == null ? null : clusters[focus]);
    }
    dragging = false;
  };
  const onWheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wy] = toWorld(sx, sy);
    const f = Math.exp(-e.deltaY * 0.0016);
    cam.tz = Math.min(2.6, Math.max(0.3, cam.tz * f));
    cam.z = cam.tz;
    cam.x = sx - W / 2 - wx * cam.z;
    cam.y = sy - H / 2 - wy * cam.z;
  };
  const onLeave = () => { hover = null; if (opts.onHover) opts.onHover(null); };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  /* ---------- live activity ---------- */
  let timer = 0;
  function scheduleEvent() {
    timer = setTimeout(() => {
      if (settings.live !== false) {
        const kinds = opts.eventKinds || [];
        const k = kinds[Math.floor(Math.random() * kinds.length)] || { text: 'ping', color: '#f2a71b' };
        const pool = focus != null ? nodes.filter((x) => x.cluster === focus) : nodes;
        const nd = pool[Math.floor(Math.random() * pool.length)];
        api.ping(nd, k.color);
        if (opts.onEvent) opts.onEvent({ node: nd, kind: k });
      }
      scheduleEvent();
    }, 1400 + Math.random() * 2200);
  }
  scheduleEvent();

  const api = {
    ping(node, color) {
      const nd = node || nodes[Math.floor(Math.random() * nodes.length)];
      nd.flash = 1;
      pings.push({ node: nd, t: (performance.now() - t0) / 1000, color: color || nd.c.color });
    },
    setTime(frac) { maxAge = frac >= 0.99 ? 999 : Math.round(frac * 120); },
    clearFocus() { focus = null; if (opts.onPick) opts.onPick(null, null); },
    focusCluster(i) { focus = focus === i ? null : i; if (opts.onPick) opts.onPick(null, focus == null ? null : clusters[focus]); },
    reset() { cam.x = 0; cam.y = 0; cam.tz = z0; },
    destroy() {
      running = false; cancelAnimationFrame(raf); clearTimeout(timer); ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    },
  };

  raf = requestAnimationFrame(frame);
  return api;
}


// ===== Galaxy renderer (redesign) =====================================
// The orbital engine from the redesign, driven by real records. It expects
// clusters and nodes rather than a force graph, so this adapter maps what we
// hold onto that shape — no data is invented, only reshaped.
const GalaxyView = {
  api: null, variant: 'constellation',

  palette(){
    const css = getComputedStyle(document.documentElement);
    const v = n => css.getPropertyValue(n).trim();
    return [v('--amber') || '#f2a71b', v('--accent2') || '#4f9fd8', v('--accent3') || '#7be0c4',
            '#a98cf0', '#f07ab0', v('--urgente') || '#e15b4c', v('--ok') || '#4caf82',
            '#4fa3a0', v('--muted') || '#9aa9b8'];
  },

  // Biggest cluster first: the engine puts index 0 at the centre of the map.
  data(){
    const nodes = (Galaxy.nodes || []);
    if(!nodes.length) return null;
    const counts = {};
    nodes.forEach(n => { const f = n.folder || 'Other'; counts[f] = (counts[f] || 0) + 1; });
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10);
    const pal = this.palette();
    const clusters = names.map((name, i) => ({ id: name, name, color: pal[i % pal.length],
                                               count: counts[name] }));
    const index = Object.fromEntries(names.map((n, i) => [n, i]));

    const out = [];
    names.forEach(name => {
      const inF = nodes.filter(n => (n.folder || 'Other') === name);
      const hub = inF.find(n => n.isHub) || inF.reduce((a, b) => (b.deg > a.deg ? b : a), inF[0]);
      inF.forEach(n => out.push({
        id: n.id, title: n.title || '', cluster: index[name],
        hub: n === hub, links: Math.max(1, n.deg || 1),
        // Age in days drives the time slider; unknown dates read as current.
        age: n.when ? Math.max(0, Math.round((Date.now() - n.when) / 86400000)) : 0,
        statusColor: clusters[index[name]].color,
        ref: n,
      }));
    });
    return { clusters, nodes: out };
  },

  mount(){
    const canvas = document.getElementById('kb-map');
    if(!canvas || !Galaxy.ready) return;
    const data = this.data();
    if(!data) return;
    if(this.api){ this.api.destroy(); this.api = null; }
    this.api = createGalaxy(canvas, {
      variant: this.variant,
      data,
      minimap: (() => {
        const m = document.getElementById('galaxy-mini');
        if(!m) return null;
        m.style.pointerEvents = 'none';
        return m;
      })(),
      settings: { motion: settings.galaxyMotion || 'normal', glow: 1, live: false },
      // Activity comes from real events, not a timer, so a still map means a
      // still day rather than a broken renderer.
      eventKinds: [],

  // The design shows a card on hover — title, cluster, age. Ours had only a
  // browser tooltip, which is slow to appear and unstyled.
  onHover: (nd, sx, sy) => {
    const tip = document.getElementById('galaxy-tip');
    const cv = document.getElementById('kb-map');
    if(!tip || !cv) return;
    if(!nd){ tip.style.opacity = 0; return; }
    tip.style.opacity = 1;
    tip.style.left = Math.min(sx + 14, cv.clientWidth - 244) + 'px';
    tip.style.top = Math.max(8, sy - 76) + 'px';
    const age = nd.age === 0 ? 'today' : nd.age + ' d';
    const cl = (nd.c && nd.c.name) || '';
    tip.innerHTML = `<div class="gt-title">${escapeHtml(nd.title || '')}</div>`
      + `<div class="gt-cluster" style="color:${(nd.c && nd.c.color) || 'var(--muted)'}">${escapeHtml(cl)}</div>`
      + `<div class="gt-age">${age}${nd.links ? ' · ' + nd.links + ' links' : ''}</div>`;
  },
      onPick: (nd, cluster) => {
        if(nd && nd.ref){ Galaxy.focus = nd.ref; showStar(nd.ref); }
        else Galaxy.focus = null;
        renderGalaxySide();
      },
    });
    const stats = document.getElementById('galaxy-stats');
    if(stats){
      const links = (Galaxy.edges || []).length;
      stats.textContent = `${data.nodes.length} NODES · ${links} LINKS · ${data.clusters.length} CLUSTERS`;
    }

    // Real activity pings the map.
    GalaxyFeed.onPush = (kind, text) => {
      const hit = data.nodes.find(n => String(n.title || '').toLowerCase()
                    .includes(String(text || '').toLowerCase().slice(0, 14)));
      if(hit && this.api) this.api.ping(hit);
    };
  },

  setTime(frac){ if(this.api) this.api.setTime(frac); },
  reset(){ if(this.api) this.api.reset(); },
};


// Calibration: record the user saying a word, see what comes back, and keep
// the difference. Three passes, because one mishearing might be a fluke and
// three of the same is a pattern worth correcting for.
const VocabTrain = {
  word: '', heard: [], busy: false,

  async run(word){
    const box = document.getElementById('vocab-train-box');
    if(!box) return;
    this.word = word; this.heard = [];
    box.style.display = 'block';
    for(let i = 1; i <= 3; i++){
      box.innerHTML = `<b>Say “${escapeHtml(word)}”</b> — pass ${i} of 3<div class="vt-bar"><span></span></div>`;
      let clip;
      try{ clip = await recordClip(1800); }
      catch(e){ box.innerHTML = 'Could not use the microphone.'; return; }
      const got = await transcribeClip(clip);
      this.heard.push(String(got || '').trim());
      box.innerHTML = `Heard: <i>${escapeHtml(this.heard[i-1] || '(nothing)')}</i>`;
      await new Promise(r => setTimeout(r, 550));
    }

    // Anything that came back different from the word is a mishearing worth
    // correcting. Identical results mean the recogniser already has it right.
    const wrong = this.heard
      .map(h => h.replace(/[.,!?]+$/, '').trim())
      .filter(h => h && h.toLowerCase() !== word.toLowerCase());
    const uniq = [...new Set(wrong.map(w => w.toLowerCase()))];

    if(!uniq.length){
      box.innerHTML = `<b>Already correct.</b> “${escapeHtml(word)}” came back right all three times.`;
      Vocab.add(word);
      return;
    }
    uniq.forEach(h => Vocab.addAlias(h, word));
    Vocab.add(word);
    renderVocab();
    box.innerHTML = `<b>Learned.</b> “${escapeHtml(word)}” was heard as `
      + uniq.map(u => `<i>${escapeHtml(u)}</i>`).join(', ')
      + '. Those will be corrected from now on.';
  },
};

document.getElementById('vocab-train')?.addEventListener('click', async () => {
  const el = document.getElementById('vocab-input');
  const w = (el.value || '').trim();
  if(!w){ alert('Type the word first, then say it.'); return; }
  const btn = document.getElementById('vocab-train');
  btn.disabled = true;
  try{ await VocabTrain.run(w); }
  finally{ btn.disabled = false; el.value = ''; }
});


// The redesign puts navigation in a left rail and the tools beneath it. The
// existing buttons are MOVED rather than rebuilt, so every handler, label and
// state update already bound to them keeps working untouched.
function buildRail(){
  const tools = document.getElementById('rail-tools');
  if(!tools || tools._built) return;
  // The class is only applied once the rail exists, so a failure here leaves
  // the previous layout working rather than a broken half-state.
  const root = document.getElementById('app-root');
  if(root) root.classList.add('has-rail');
  tools._built = true;
  ['hud-toggle','theme-toggle','voice-toggle','ai-toggle','logout-btn'].forEach(id => {
    const el = document.getElementById(id);
    if(el) tools.appendChild(el);
  });
  // The old tab strip is hidden, not removed: tab-* ids still resolve, so any
  // code that clicks them programmatically still works.
  // No click binding here: .bn-item already carries one, and adding a second
  // would switch the view twice per press.
}

// Each view gets the redesign's title and mono sub-line, filled from real
// counts rather than the mock's fixed strings.
const VIEW_HEAD = {
  agenda:    { title:'Your day',        sub: () => `SUPPORT ROUTINE · ${new Date().toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'}).toUpperCase()}` },
  history:   { title:'Case history',    sub: () => `${(cases||[]).filter(x=>x.status==='resolvido').length} CLOSED RECORDS` },
  calendar:  { title:'Calendar',        sub: () => `${new Date().toLocaleDateString(undefined,{month:'long',year:'numeric'}).toUpperCase()} · ${(cases||[]).length} CASES` },
  notebooks: { title:'Notebooks',       sub: () => `${(notes||[]).length} NOTES · ${(notebooks||[]).length} NOTEBOOKS` },
  settings:  { title:'Settings',        sub: () => 'ASSISTANT · VOICE · WRITING · KNOWLEDGE' },
};
function renderViewHead(view){
  const h = document.getElementById('view-head');
  if(!h) return;
  const d = VIEW_HEAD[view];
  if(!d){ h.style.display = 'none'; return; }
  h.style.display = '';
  let sub = '';
  try{ sub = d.sub(); }catch(e){}
  h.innerHTML = `<h2>${escapeHtml(d.title)}</h2><p>${escapeHtml(sub)}</p>`;
}


// ===== Daily dial (redesign) ==========================================
// The workday bent into a ring: 07h to 19h over 288 degrees, open at the
// bottom. Geometry lifted from the redesign; the data is ours, so pips are
// real cases at their real times rather than a fixed demo set.
const Dial = {
  CX: 310, CY: 246, H0: 7, H1: 19, SPAN: 288,
  RING: 190, TICK_IN: 190, TICK_OUT: 204, LAB: 226,

  get A0(){ return -90 - this.SPAN / 2; },
  ang(h){
    const cl = Math.min(this.H1, Math.max(this.H0, h));
    return this.A0 + ((cl - this.H0) / (this.H1 - this.H0)) * this.SPAN;
  },
  pt(r, a){
    const t = a * Math.PI / 180;
    return [this.CX + Math.cos(t) * r, this.CY + Math.sin(t) * r];
  },
  arc(r, a0, a1){
    const [x0, y0] = this.pt(r, a0), [x1, y1] = this.pt(r, a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  },

  colourFor(cs){
    const p = String(cs.prioridade || '').toLowerCase();
    return cs.status === 'resolvido' ? 'var(--ok)'
      : p === 'urgente' ? 'var(--urgente)'
      : p === 'alta' ? 'var(--alta)'
      : p === 'media' ? 'var(--media)' : 'var(--accent2)';
  },

  render(){
    const svg = document.getElementById('day-arc');
    if(!svg) return;
    const now = new Date();
    const nowH = now.getHours() + now.getMinutes() / 60;
    const night = (typeof curPhase !== 'undefined' && curPhase === 'night');
    const phase = night ? 'var(--accent2)' : 'var(--amber)';

    const parts = [];
    parts.push(`<defs>
      <filter id="dial-soft" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="5"/></filter>
      <linearGradient id="dial-elapsed" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${phase}" stop-opacity=".15"/>
        <stop offset="1" stop-color="${phase}" stop-opacity=".9"/></linearGradient>
    </defs>`);

    // the full track
    parts.push(`<path d="${this.arc(this.RING, this.ang(this.H0), this.ang(this.H1))}"
      fill="none" stroke="var(--line)" stroke-width="2" stroke-linecap="round" opacity=".85"/>`);

    // how much of the day has gone
    if(nowH > this.H0){
      const d = this.arc(this.RING, this.ang(this.H0), this.ang(Math.min(nowH, this.H1)));
      parts.push(`<path d="${d}" fill="none" stroke="url(#dial-elapsed)" stroke-width="7"
        stroke-linecap="round" opacity=".2" filter="url(#dial-soft)"/>`);
      parts.push(`<path d="${d}" fill="none" stroke="url(#dial-elapsed)" stroke-width="2.5"
        stroke-linecap="round"/>`);
    }

    // hour ticks, odd hours longer
    for(let h = this.H0; h <= this.H1; h++){
      const major = h % 2 === 1;
      const a = this.ang(h);
      const [x1, y1] = this.pt(this.TICK_IN + 2, a);
      const [x2, y2] = this.pt(major ? this.TICK_OUT : this.TICK_OUT - 6, a);
      parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
        stroke="${major ? 'var(--muted)' : 'var(--line)'}" stroke-width="${major ? 1.6 : 1}" stroke-linecap="round"/>`);
      if(major){
        const [lx, ly] = this.pt(this.LAB, a);
        parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle"
          dominant-baseline="middle" class="dial-hour">${String(h).padStart(2,'0')}h</text>`);
      }
    }

    // the first hour after clock-in, reserved for urgent work
    const startH = (typeof firstHourStart === 'number') ? firstHourStart : this.H0;
    parts.push(`<path d="${this.arc(this.RING, this.ang(startH), this.ang(startH + 1))}"
      fill="none" stroke="var(--urgente)" stroke-width="2" stroke-linecap="round" opacity=".7"/>`);

    // cases as arc segments at their real times
    const today = dateStr(now);
    const mine = (cases || []).filter(x => x.case_date === today && isClock(x.horario));
    mine.forEach(cs => {
      const h = toMin(cs.horario) / 60;
      const endM = isClock(cs.horario_fim) ? toMin(cs.horario_fim) : toMin(cs.horario) + 20;
      const a0 = this.ang(h);
      const a1 = Math.max(a0 + 4, this.ang(endM / 60) - 1.2);
      const col = this.colourFor(cs);
      const done = cs.status === 'resolvido';
      parts.push(`<g class="dial-pip" data-case="${escapeHtml(cs.id)}">`
        + `<path d="${this.arc(this.RING, a0, a1)}" fill="none" stroke="${col}"
             stroke-width="10" opacity="${done ? 0.04 : 0.14}" stroke-linecap="round" filter="url(#dial-soft)"/>`
        + `<path d="${this.arc(this.RING, a0, a1)}" fill="none" stroke="${col}"
             stroke-width="${done ? 3 : 6}" opacity="${done ? 0.45 : 0.75}" stroke-linecap="round"/>`
        + `<title>${escapeHtml(cs.horario + ' · ' + (cs.titulo || ''))}</title></g>`);
    });

    // the now hand
    if(nowH >= this.H0 && nowH <= this.H1){
      const a = this.ang(nowH);
      const [bx, by] = this.pt(this.RING, a);
      const [ix, iy] = this.pt(46, a);
      parts.push(`<line x1="${ix.toFixed(1)}" y1="${iy.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"
        stroke="${phase}" stroke-width="1" stroke-dasharray="3 5" opacity=".4"/>`);
      parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="13" fill="${phase}"
        opacity=".22" filter="url(#dial-soft)"/>`);
      parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="7" fill="var(--bg)"
        stroke="${phase}" stroke-width="2"/>`);
    }

    // hub: what is left, and the time
    const open = mine.filter(x => x.status !== 'resolvido').length;
    parts.push(`<text x="${this.CX}" y="${this.CY - 6}" text-anchor="middle" class="dial-hub-n">${open}</text>`);
    parts.push(`<text x="${this.CX}" y="${this.CY + 16}" text-anchor="middle" class="dial-hub-l">${open === 1 ? 'case left' : 'cases left'}</text>`);
    parts.push(`<text x="${this.CX}" y="${this.CY + 38}" text-anchor="middle" class="dial-hub-t">${
      String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}</text>`);

    // Measured from the geometry, not guessed: hour labels reach x 84-536 and
    // y 20-429, so a shorter box clipped the bottom two.
    svg.setAttribute('viewBox', '72 10 492 432');
    svg.innerHTML = parts.join('');

    // clicking a pip opens its case, as the list does
    svg.querySelectorAll('.dial-pip').forEach(g => {
      g.addEventListener('click', () => {
        const cs = (cases || []).find(x => String(x.id) === g.dataset.case);
        if(cs && typeof openCaseModal === 'function') openCaseModal(cs);
      });
    });
  },
};


// ===== Agenda layout (redesign) =======================================
// The design lays the day out as two columns: the wheel with the weather and
// suggestions beneath it on the left, the actual day list on the right. Our
// markup had everything stacked in one narrow column with the wheel floating
// above, which is why it read as a wall of dead space on a wide screen.
//
// The panels are MOVED, not rebuilt — every id, handler and render path is
// untouched, so nothing that works stops working.
function reflowAgenda(){
  const view = document.getElementById('view-agenda');
  const main = view && view.querySelector('main.layout');
  const arc  = view && view.querySelector('.arc-wrap');
  if(!view || !main || main._reflowed) return;

  const grab = sel => view.querySelector(sel);
  const firstHour = grab('.first-hour-panel');
  const suggest   = grab('.suggest-panel');
  const weather   = grab('.weather-panel');
  const day       = grab('.day-panel');
  // If the markup ever changes shape, leave it alone rather than half-move it.
  if(!firstHour || !day){ return; }

  main._reflowed = true;
  main.classList.add('agenda-grid');
  main.innerHTML = '';

  const left = document.createElement('div');
  left.className = 'ag-left';
  if(arc) left.appendChild(arc);              // the wheel heads its own column
  const cards = document.createElement('div');
  cards.className = 'ag-cards';
  if(weather) cards.appendChild(weather);
  if(suggest) cards.appendChild(suggest);
  if(cards.children.length) left.appendChild(cards);

  const right = document.createElement('div');
  right.className = 'ag-right';
  right.appendChild(firstHour);
  right.appendChild(day);

  main.appendChild(left);
  main.appendChild(right);
}


// The overview panel, from the same nodes the canvas draws. Health is the
// share of entries that are actually connected to something — an isolated
// entry is knowledge nobody can find.
function renderGalaxyOverview(){
  const box = document.getElementById('gx-overview');
  if(!box || !Galaxy.ready) return;
  const nodes = (Galaxy.nodes || []);
  const links = (Galaxy.edges || []).length;
  const linked = nodes.filter(n => (n.deg || 0) > 0).length;
  const health = nodes.length ? Math.round(linked / nodes.length * 100) : 0;
  const tone = health >= 80 ? 'var(--ok)' : health >= 55 ? 'var(--amber)' : 'var(--urgente)';
  box.innerHTML = `<div class="gx-num">${nodes.length}<span>entries</span></div>`
    + `<div class="gx-num">${links}<span>links</span></div>`
    + `<div class="gx-num" style="color:${tone}">${health}%<span>health</span></div>`;
  const lab = document.getElementById('gx-focus-label');
  if(lab) lab.textContent = Galaxy.focus ? (Galaxy.focus.title || Galaxy.focus.folder || 'one entry')
                                         : 'the whole map';
}

document.getElementById('gx-clear-focus')?.addEventListener('click', () => {
  Galaxy.focus = null;
  if(GalaxyView.api) GalaxyView.api.reset();
  renderGalaxyOverview();
  renderGalaxySide();
  SFX.tick();
});

document.getElementById('gx-time')?.addEventListener('input', e => {
  // The slider hides entries newer than its position, so the map can be
  // wound back through the month.
  const frac = (+e.target.value) / 100;
  try{ GalaxyView.setTime(frac); }catch(err){}
  const lab = e.target.nextElementSibling;
  if(lab) lab.textContent = frac >= 0.99 ? 'all time' : Math.round((1 - frac) * 30) + 'd back';
});


// Opening the galaxy builds it if it has never been built, and rebuilds it if
// the records have changed since. Previously this only happened when the
// Knowledge settings tab was opened, so the new view came up blank and stayed
// blank until a manual refresh.
let galaxyStamp = '';
function recordsStamp(){
  return [(cases || []).length, (notes || []).length, (KB || []).length,
          (Learn.rules || []).length, (Learn.episodes || []).length].join('/');
}

async function showGalaxy(force){
  const stamp = recordsStamp();
  try{
    if(!Galaxy.ready || force || stamp !== galaxyStamp){
      await Galaxy.build({ folder:false });
      galaxyStamp = stamp;
    }
    GalaxyView.mount();
  }catch(e){
    console.warn('[galaxy] build failed', e);
  }
  try{ renderGalaxySide(); renderGalaxyOverview(); GalaxyFeed.render(); }catch(e){}
}

// Keep it current while it is on screen, without rebuilding a map nobody is
// looking at.
setInterval(() => {
  const v = document.getElementById('view-galaxy');
  if(!v || v.classList.contains('hidden')) return;
  if(recordsStamp() !== galaxyStamp) showGalaxy();
}, 6000);

// ===== Screen reading ================================================
// Captures a single frame from a window you choose and sends it for reading.
// Deliberate constraints:
//   - nothing is ever written to disk or to localStorage
//   - the frame exists only as a variable and is released immediately after
//   - the stream is opened on request and stopped the moment it is done,
//     except when you explicitly keep it open for repeat questions
//   - the browser's own sharing indicator is always visible while it is live
const Screen_ = {
  stream: null, video: null, keepOpen: true, lastReadAt: 0, lastError: null, lastReason: '',
  surface: '', surfaceLabel: '',

  async open(){
    if(this.stream && this.stream.active) return true;
    if(!navigator.mediaDevices?.getDisplayMedia) return false;
    try{
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 1,                 // one frame a second is ample
          // No forced preference: the picker offers screens, windows and tabs
          // and the user chooses. A whole-monitor share is legitimate when the
          // app is not the front window — e.g. reading a portal on a second
          // monitor while this sits on the first.
        },
        audio: false,
        // Keep this app's own tab out of the picker: capturing ourselves is
        // never what is wanted and is the commonest way to end up with a
        // screenshot of the assistant asking what is on the screen.
        selfBrowserSurface: 'exclude',
        // Allow switching source mid-share without stopping and restarting.
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
      });
      // If the user stops sharing from the browser's own control, forget it.
      this.stream.getVideoTracks()[0].addEventListener('ended', () => this.close());
      this.video = document.createElement('video');
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      // A detached video element does not reliably decode frames in Chrome,
      // so it lives in the DOM, invisible and 1px.
      this.video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(this.video);
      await this.video.play();
      renderScreenStatus();
      return true;
    }catch(e){
      this.stream = null;
      // Swallowing this left the user staring at nothing. Chrome refuses for
      // several quite different reasons, and each needs a different response.
      this.lastError = e && e.name ? e.name : String(e);
      this.lastReason =
        this.lastError === 'NotAllowedError' ? 'You dismissed the picker, or the browser blocked sharing for this site. Check the screen-share icon in the address bar.'
      : this.lastError === 'NotFoundError' ? 'No screen or window was available to share.'
      : this.lastError === 'NotSupportedError' ? 'This browser does not support screen sharing. Use Chrome or Edge on desktop.'
      : this.lastError === 'InvalidStateError' ? 'The page needs focus first - click the page, then try again.'
      : this.lastError === 'AbortError' ? 'Sharing was cancelled.'
      : 'Screen sharing failed (' + this.lastError + ').';
      console.error('[screen]', this.lastError, e);
      return false;
    }
  },

  close(){
    try{ this.stream && this.stream.getTracks().forEach(t => t.stop()); }catch(e){}
    if(this.video){
      this.video.srcObject = null;
      try{ this.video.remove(); }catch(e){}
      this.video = null;
    }
    this.stream = null;
    document.getElementById('ai-share')?.classList.remove('on');
    renderScreenStatus();
  },

  // Returns a data URL held only in memory. Never stored anywhere.
  async grab(){
    // getDisplayMedia needs transient user activation, which a tool call made
    // after a network round trip does not have. Opening the picker here failed
    // silently, so the share must already be live — started by a real click.
    if(!this.stream || !this.stream.active) return null;
    // getDisplayMedia resolves as soon as the user picks, but the first frame
    // arrives later. A single fixed wait was too short, so the capture came
    // back empty and the stream was then torn down — which looked like the
    // share stopping by itself.
    const ready = await new Promise(res => {
      if(this.video.videoWidth) return res(true);
      let waited = 0;
      const poll = setInterval(() => {
        if(this.video && this.video.videoWidth){ clearInterval(poll); res(true); }
        else if((waited += 100) > 4000){ clearInterval(poll); res(false); }
      }, 100);
    });
    if(!ready) return null;

    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if(!vw) return null;
    // Smaller frames are markedly faster through a vision model and still
    // legible for fault codes and dialogue text.
    const maxW = 1100;
    const scale = Math.min(1, maxW / vw);
    const cv = document.createElement('canvas');
    cv.width = Math.round(vw * scale);
    cv.height = Math.round(vh * scale);
    cv.getContext('2d').drawImage(this.video, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/jpeg', 0.62);
    cv.width = cv.height = 0;              // release the backing bitmap
    return url;
  },

  cooldownUntil: 0,

  async ask(question){
    // Hammering a rate-limited endpoint spends the same quota as a good call
    // and makes the wait longer, so a refusal starts a local cooldown.
    if(Date.now() < this.cooldownUntil){
      const secs = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
      return { ok:false, error:'cooling', detail:`${secs}s` };
    }
    const img = await this.grab();
    if(!img){
      // Keep the share open: closing it here is what made a failed first
      // capture look like the user's sharing had stopped.
      return { ok:false, error:'no frame' };
    }
    try{
      const r = await fetch(FN_URL + "/agenda-vision", {
        method:'POST', headers: authHeaders(),
        body: JSON.stringify({ image: img, question }),
      });
      const out = await readJson(r);
      if(!out.ok){
        const detail = out.json.detail || (out.json.tried || []).join(' | ');
        // The one vision model on this account is Qwen; when it is limited
        // there is nothing to fall back to, so wait rather than retry blindly.
        if(out.json.code === 'rate_limit' || /rate limit/i.test(detail)){
          this.cooldownUntil = Date.now() + 45000;
          return { ok:false, error:'rate_limit', detail };
        }
        return { ok:false, error: out.json.code || 'vision failed', detail };
      }
      this.lastReadAt = Date.now();
      // Only a one-shot share is torn down, and only after a successful read.
      if(!this.keepOpen) this.close();
      return { ok:true, reply: out.json.reply, model: out.json.model };
    }catch(e){ return { ok:false, error:'network' }; }
  },
};


// The browser will only start a share from a genuine click, so TARS asks for
// one rather than failing quietly.
function showSharePrompt(){
  if(document.getElementById('share-prompt')) return;
  const div = document.createElement('div');
  div.className = 'ai-msg assistant proactive';
  div.id = 'share-prompt';
  div.innerHTML = `<span class="pro-tag">Permission needed</span>`
    + `I can't open the screen picker on my own — browsers only allow that from a click.`
    + `<button class="share-btn" id="share-now">Share a window</button>`;
  aiMessages.appendChild(div);
  aiMessages.scrollTop = aiMessages.scrollHeight;
  div.querySelector('#share-now').addEventListener('click', async () => {
    const ok = await Screen_.open();
    div.remove();
    if(!ok){ addProactiveMessage(Screen_.lastReason || 'Screen sharing was refused or is unsupported here.'); return; }
    Screen_.keepOpen = true; settings.screenKeep = true; saveSettings();
    addProactiveMessage('Sharing now. Ask me again and I will read it.');
  });
}

function renderScreenStatus(){
  const el = document.getElementById('screen-status');
  if(el) el.textContent = Screen_.stream && Screen_.stream.active
    ? (Screen_.keepOpen ? 'sharing — stays open for follow-ups' : 'sharing')
    : 'not sharing';
  const dock = document.getElementById('tars-dock');
  if(dock) dock.classList.toggle('watching', !!(Screen_.stream && Screen_.stream.active));
}

// ===== Thunderbird mail ==============================================
// Thunderbird stores mail locally in mbox files inside its profile, so it can
// be read through the same File System Access API already used for the media
// folder. Nothing is uploaded: parsing happens here, and only what TARS is
// asked about ever reaches the model.
// Read-only by design — sending goes out through mailto:, which opens
// Thunderbird itself when it is the default client.
const Mail = {
  dir: null, messages: [], scannedAt: 0, lastReason: '',

  async pickFolder(){
    try{
      // Point at the account folder inside the profile, e.g.
      // .thunderbird/xxxx.default/Mail/pop.server.com  (or ImapMail/...)
      const h = await window.showDirectoryPicker({ id:'tbird', mode:'read' });
      this.dir = h;
      await idbSet('mailDir', h);
      // What the user actually picked matters: a monitor share will show this
      // app whenever it is the foreground window.
      try{
        const st = this.stream.getVideoTracks()[0].getSettings?.() || {};
        this.surface = st.displaySurface || 'unknown';
        this.surfaceLabel = this.stream.getVideoTracks()[0].label || '';
      }catch(e){ this.surface = 'unknown'; }
      this.lastReason = '';
      return true;
    }catch(e){
      // Silently returning false is why "I cannot change the folder" looked
      // like a broken button rather than a browser refusal.
      const name = e && e.name ? e.name : String(e);
      this.lastReason =
        name === 'AbortError' ? 'You closed the folder picker without choosing.'
      : name === 'NotAllowedError' ? 'The browser refused access to that folder. On Windows it blocks AppData - copy the mail folder somewhere like Documents and pick the copy.'
      : name === 'SecurityError' ? 'That folder is protected by the browser. Choose a copy outside AppData.'
      : !window.showDirectoryPicker ? 'This browser cannot open folders. Use Chrome or Edge on desktop.'
      : 'Could not open that folder (' + name + ').';
      console.error('[mail] pickFolder', name, e);
      return false;
    }
  },

  // Drop the stored folder so a different one can be chosen.
  async forget(){
    this.dir = null; this.messages = []; this.scannedAt = 0;
    try{ await idbSet('mailDir', null); }catch(e){}
    renderMailStatus();
  },

  async restore(){
    try{
      const h = await idbGet('mailDir');
      if(!h) return false;
      const perm = await h.queryPermission({ mode:'read' });
      if(perm === 'granted'){ this.dir = h; return true; }
      if(perm === 'prompt'){
        const p = await h.requestPermission({ mode:'read' });
        if(p === 'granted'){ this.dir = h; return true; }
      }
    }catch(e){}
    return false;
  },

  // --- mbox parsing -------------------------------------------------
  decodeHeader(s){
    // RFC 2047 encoded words, which Thunderbird uses for accented subjects.
    return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      try{
        // Both encodings yield raw bytes; decode them as UTF-8 properly or
        // accented subjects come out as mojibake.
        const bytes = enc.toUpperCase() === 'B'
          ? Uint8Array.from(atob(txt), ch => ch.charCodeAt(0))
          : Uint8Array.from(txt.replace(/_/g, ' ').match(/=([0-9A-Fa-f]{2})|([\s\S])/g) || [],
              t => t[0] === '=' ? parseInt(t.slice(1), 16) : t.charCodeAt(0));
        return new TextDecoder(/utf-?8/i.test(cs) ? 'utf-8' : 'iso-8859-1').decode(bytes);
      }catch(e){ return txt; }
    });
  },
  decodeBody(body, enc, charset){
    let out = body;
    try{
      const dec = new TextDecoder(/iso-8859/i.test(charset || '') ? 'iso-8859-1' : 'utf-8');
      if(/base64/i.test(enc))
        out = dec.decode(Uint8Array.from(atob(body.replace(/\s+/g, '')), ch => ch.charCodeAt(0)));
      else if(/quoted-printable/i.test(enc))
        out = dec.decode(Uint8Array.from(
          body.replace(/=\r?\n/g, '').match(/=([0-9A-Fa-f]{2})|([\s\S])/g) || [],
          t => t[0] === '=' ? parseInt(t.slice(1), 16) : t.charCodeAt(0)));
    }catch(e){}
    return out;
  },

  // A .eml file is one RFC822 message with no mbox "From " separator, so it
  // is parsed by wrapping it in the shape parseMbox already understands.
  parseEml(text, name){
    const out = this.parseMbox('From noone@local ' + Date() + '\n' + text, name);
    return out.length ? out : this.parseMbox(text, name);
  },

  // Files chosen through a normal file input, which needs no directory
  // permission at all — the way round a profile folder that cannot be reached.
  async addFiles(fileList){
    let added = 0, skipped = 0;
    for(const file of fileList){
      try{
        if(file.size > 40 * 1024 * 1024){ skipped++; continue; }
        const text = await file.text();
        const isMbox = /^From [^\s]+ /.test(text.slice(0, 200));
        const msgs = isMbox ? this.parseMbox(text, file.name) : this.parseEml(text, file.name);
        if(!msgs.length){ skipped++; continue; }
        // Message-ID keeps a re-import from duplicating everything.
        const seen = new Set(this.messages.map(m => m.id));
        msgs.forEach(m => { if(!seen.has(m.id)){ this.messages.push(m); added++; } });
      }catch(e){ skipped++; }
    }
    this.messages.sort((a, b) => b.when - a.when);
    this.messages = this.messages.slice(0, 800);
    this.scannedAt = Date.now();
    renderMailStatus();
    return { added, skipped };
  },

  parseMbox(text, folderName){
    const out = [];
    // Messages begin at a line starting "From " at the very start of a line.
    const parts = text.split(/\r?\n(?=From [^\s]+ )/);
    parts.forEach(raw => {
      const split = raw.indexOf('\n\n');
      if(split === -1) return;
      const head = raw.slice(0, split);
      let body = raw.slice(split + 2);
      // unfold folded headers
      const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
      const get = n => {
        const m = unfolded.match(new RegExp('^' + n + ':\\s*(.*)$', 'im'));
        return m ? m[1].trim() : '';
      };
      const subject = this.decodeHeader(get('Subject'));
      const from = this.decodeHeader(get('From'));
      const date = get('Date');
      if(!subject && !from) return;

      // Take the plain-text part of a multipart message.
      const ctype = get('Content-Type');
      const bnd = (ctype.match(/boundary="?([^";]+)"?/i) || [])[1];
      if(bnd){
        const seg = body.split('--' + bnd).find(s => /content-type:\s*text\/plain/i.test(s));
        if(seg){
          const i = seg.indexOf('\n\n');
          const segEnc = (seg.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1] || '';
          body = i > -1 ? this.decodeBody(seg.slice(i + 2), segEnc) : seg;
        }
      } else {
        body = this.decodeBody(body, get('Content-Transfer-Encoding'));
      }
      body = body.replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n').trim();

      out.push({
        id: (get('Message-ID') || (from + date + subject)).slice(0, 120),
        subject, from, to: this.decodeHeader(get('To')), date,
        when: Date.parse(date) || 0,
        folder: folderName,
        body: body.slice(0, 4000),
      });
    });
    return out;
  },

  // Reports what it actually saw, so "nothing found" can be diagnosed rather
  // than guessed at.
  async scan(limit = 400){
    if(!this.dir && !(await this.restore())) return { ok:false, reason:'no folder' };
    const found = [];
    const seen = { dirs: 0, files: 0, skipped: 0, mbox: 0, empty: 0, names: [] };

    const walk = async (dir, path, depth) => {
      // Profiles nest deeply (Profiles/xxx.default/ImapMail/server/), so the
      // limit has to allow for the whole Thunderbird directory being picked.
      if(depth > 6 || found.length > limit) return;
      for await (const [name, handle] of dir.entries()){
        if(found.length > limit) break;
        if(handle.kind === 'directory'){
          seen.dirs++;
          await walk(handle, path + name.replace(/\.sbd$/, '') + '/', depth + 1);
          continue;
        }
        seen.files++;
        if(/\.(msf|dat|json|html|txt|log|sqlite|ini|properties|bak)$/i.test(name)){ seen.skipped++; continue; }
        try{
          const file = await handle.getFile();
          if(file.size < 40){ seen.empty++; continue; }
          if(file.size > 60 * 1024 * 1024){ seen.skipped++; continue; }
          const slice = file.size > 3 * 1024 * 1024 ? file.slice(file.size - 3 * 1024 * 1024) : file;
          const text = await slice.text();
          if(!/^From |\nFrom /.test(text.slice(0, 4000))){ seen.skipped++; continue; }
          seen.mbox++;
          if(seen.names.length < 6) seen.names.push(path + name);
          found.push(...this.parseMbox(text, path + name));
        }catch(e){ seen.skipped++; }
      }
    };

    try{ await walk(this.dir, '', 0); }
    catch(e){ return { ok:false, reason:'read failed', detail: String(e).slice(0, 120) }; }

    this.messages = found.sort((a, b) => b.when - a.when).slice(0, limit);
    this.scannedAt = Date.now();
    this.lastScan = seen;
    renderMailStatus();
    return { ok:true, count: this.messages.length, seen };
  },

  search(q, limit = 6){
    const words = relevantWords(q);
    if(!words.length) return this.messages.slice(0, limit);
    return this.messages.map(m => {
      const hay = (m.subject + ' ' + m.from + ' ' + m.body).toLowerCase();
      let hits = 0;
      words.forEach(w => { if(hay.includes(w)) hits++; });
      return { m, cov: hits / words.length };
    }).filter(x => x.cov >= 0.34)
      .sort((a, b) => b.cov - a.cov || b.m.when - a.m.when)
      .slice(0, limit).map(x => x.m);
  },

  // Which case an email belongs to: ticket number first, then client name.
  matchCase(m){
    const hay = (m.subject + ' ' + m.body).toLowerCase();
    const byTicket = cases.find(c => c.ticket && hay.includes(String(c.ticket).toLowerCase()));
    if(byTicket) return byTicket;
    return cases.find(c => {
      const key = String(c.titulo || '').toLowerCase().split(/[—\-]/)[0].trim();
      return key.length > 3 && hay.includes(key);
    }) || null;
  },
};


// Thunderbird supports dragging messages out as files, so dropping them
// anywhere on the window imports them — no picker, no permissions.
['dragover','drop'].forEach(ev => window.addEventListener(ev, e => {
  if(!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  if(ev === 'dragover'){ document.body.classList.add('mail-dropping'); return; }
  document.body.classList.remove('mail-dropping');
  const files = [...(e.dataTransfer.files || [])]
    .filter(f => /\.(eml|mbox)$/i.test(f.name) || f.type === 'message/rfc822');
  if(!files.length) return;
  Mail.addFiles(files).then(r => {
    if(r.added) addProactiveMessage(`Loaded ${r.added} message${r.added > 1 ? 's' : ''} from the files you dropped.`);
  });
}));
window.addEventListener('dragleave', () => document.body.classList.remove('mail-dropping'));

function renderMailStatus(){
  const el = document.getElementById('mail-status');
  if(!el) return;
  el.textContent = Mail.messages.length
    ? `${Mail.messages.length} messages loaded${Mail.scannedAt ? ' · ' + new Date(Mail.scannedAt).toLocaleTimeString('en-GB').slice(0,5) : ''}`
    : (Mail.dir ? 'folder set — not scanned yet' : 'no folder selected');
  el.className = Mail.messages.length ? 'ok' : '';
}

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

// Removes a whole import that went wrong, including the notes filed from it.
document.getElementById('kb-purge')?.addEventListener('click', async () => {
  const sources = [...new Set(KB.map(e => (e.source || 'manual').split(/[—:]/)[0].trim()))];
  if(!sources.length){ alert('The knowledge base is empty.'); return; }
  const counts = sources.map(s => `${s} (${KB.filter(e => (e.source || 'manual').startsWith(s)).length})`);
  const pick = prompt('Remove which source?\n\n' + counts.map((s, i) => `${i + 1}. ${s}`).join('\n')
    + '\n\nType a number.');
  const n = parseInt(pick, 10);
  if(!(n >= 1 && n <= sources.length)) return;
  const src = sources[n - 1];
  const before = KB.length;
  KB = KB.filter(e => !(e.source || 'manual').startsWith(src));
  if(SharedKB.loaded) await SharedKB.removeSource(src);
  else localStorage.setItem('agenda-solar-kb', JSON.stringify(KB));
  // The notebook filed from that source goes too, so the galaxy matches.
  const nb = notebooks.find(x => x.title === SYS_PREFIX + src);
  if(nb){
    for(const nt of notes.filter(x => x.notebook_id === nb.id)){
      try{ await deleteNoteApi(nt.id); }catch(e){}
    }
    notes = notes.filter(x => x.notebook_id !== nb.id);
    try{ await deleteNotebookApi(nb.id); notebooks = notebooks.filter(x => x.id !== nb.id); }catch(e){}
  }
  renderKbStatus(); renderNotebooksGrid();
  const box = document.getElementById('kb-json');
  if(box) box.value = JSON.stringify(KB, null, 2);
  Galaxy.build({ folder:false });
  alert(`Removed ${before - KB.length} entries from "${src}".`);
});

// ===== Knowledge galaxy (3D) =========================================
// Positions come from a force simulation, so distance actually means
// something: linked notes pull together, everything repels, and clusters
// emerge rather than being decoration on a spiral.
const Galaxy = {
  nodes: [], edges: [], adj: {}, byId: {},
  rot: { x: -0.42, y: 0.6 }, zoom: 1, drag: null, raf: null,
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
    // Learned rules and episodes are memory too, so they belong on the map
    // rather than in a separate store the user cannot see.
    (Learn.rules || []).forEach(r => out.push({
      id: 'rule:' + r.id, key: String(r.statement).slice(0, 30).toLowerCase(),
      title: String(r.statement).slice(0, 46), tags: (r.keywords || '').split(/\s+/).filter(Boolean).slice(0, 6),
      links: [], words: String(r.statement).split(/\s+/).length,
      excerpt: `${r.statement}\n\nConfidence ${r.confidence}% · learned from ${r.source}`
             + (r.times_confirmed > 1 ? ` · confirmed ${r.times_confirmed}×` : '')
             + (r.status === 'conflicted' ? '\n\n⚠ This rule conflicts with another.' : ''),
      folder: 'Learned/', source: 'rule', ruleId: r.id, conflicted: r.status === 'conflicted',
      when: Date.parse(r.created_at || 0) || 0 }));
    (Learn.episodes || []).slice(0, 60).forEach(ep => out.push({
      id: 'ep:' + ep.id, key: String(ep.summary).slice(0, 30).toLowerCase(),
      title: String(ep.summary).slice(0, 46), tags: (ep.keywords || '').split(/\s+/).filter(Boolean).slice(0, 6),
      links: [], words: String(ep.summary).split(/\s+/).length,
      excerpt: ep.summary + (ep.outcome ? `\n\nOutcome: ${ep.outcome}` : ''),
      folder: 'Experience/', source: 'ep',
      when: Date.parse(ep.created_at || 0) || 0 }));
    (Focus.all || []).forEach(f => out.push({
      id: 'focus:' + f.id, key: String(f.label).toLowerCase(),
      title: f.label, tags: ['focus', f.status], links: [],
      words: (f.subtasks || []).length,
      excerpt: [f.objective, (f.subtasks || []).map(s => `${s.done ? '✓' : '○'} ${s.text}`).join('\n'),
                f.waiting_on ? 'Waiting on ' + f.waiting_on : ''].filter(Boolean).join('\n\n'),
      folder: 'Work/', source: 'focus', focusId: f.id,
      when: Date.parse(f.updated_at || 0) || 0 }));

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
    const gold = Math.PI * (3 - Math.sqrt(5));

    // Each cluster gets its own anchor on a sphere. Without this every folder
    // collapsed into the same blob — measured separation was 0.99, i.e. none.
    const folders = this.folders || [...new Set(this.nodes.map(n => n.folder))];
    const anchors = {};
    folders.forEach((f, i) => {
      const t = (i + 0.5) / folders.length;
      const incl = Math.acos(1 - 2 * t), az = gold * i * 2.4;
      // Anchors were at radius 1.25 while nodes seeded 0.34 around them, so
      // neighbouring clusters overlapped and the whole map bunched. Pushing
      // the anchors out — and scaling with cluster count — separates them.
      const spread = 1.9 + Math.min(1.5, folders.length * 0.14);
      anchors[f] = { x: Math.sin(incl) * Math.cos(az) * spread,
                     y: Math.cos(incl) * spread * 0.62,
                     z: Math.sin(incl) * Math.sin(az) * spread };
    });

    // Seed on a Fibonacci sphere around the cluster anchor. The old seed was a
    // ring in the XZ plane, which is planar and never recovers real depth.
    this.nodes.forEach((n, i) => {
      const t = (i + 0.5) / N;
      const incl = Math.acos(1 - 2 * t), az = gold * i;
      const a = anchors[n.folder] || { x:0, y:0, z:0 };
      n.x = a.x + Math.sin(incl) * Math.cos(az) * 0.34;
      n.y = a.y + Math.cos(incl) * 0.34;
      n.z = a.z + Math.sin(incl) * Math.sin(az) * 0.34;
      n.vx = n.vy = n.vz = 0;
    });

    const SAMPLE = Math.min(24, Math.max(1, N - 1));
    const iters = iterations || (N > 300 ? 90 : 150);
    for(let it = 0; it < iters; it++){
      const cool = 1 - it / iters;
      for(let i = 0; i < N; i++){
        const a = this.nodes[i];
        // A gentle pull home. Without it repulsion eventually smears every
        // cluster back into one cloud, which is what the map was doing.
        const home = anchors[a.folder];
        if(home){
          a.vx += (home.x - a.x) * 0.010;
          a.vy += (home.y - a.y) * 0.010;
          a.vz += (home.z - a.z) * 0.010;
        }
        for(let s2 = 0; s2 < SAMPLE; s2++){
          const b = this.nodes[(i + 1 + Math.floor(Math.random() * (N - 1))) % N];
          const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          const d2 = dx*dx + dy*dy + dz*dz + 0.002;
          // Nodes in different clusters push apart harder.
          // Cross-cluster repulsion raised: this is what carves the gaps
          // between neighbourhoods rather than leaving one continuous cloud.
          const f = (a.folder === b.folder ? 0.0012 : 0.0072) / d2;
          a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
        }
      }
      this.edges.forEach(([ia, ib, kind, w]) => {
        const a = this.byId[ia], b = this.byId[ib];
        if(!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const k = (kind === 'parent' ? 0.030 : 0.011) * Math.min(3, w || 1);
        a.vx += dx * k; a.vy += dy * k; a.vz += dz * k;
        b.vx -= dx * k; b.vy -= dy * k; b.vz -= dz * k;
      });
      this.nodes.forEach(n => {
        const a = anchors[n.folder];
        if(a){                                   // hold each node near its cluster
          n.vx += (a.x - n.x) * 0.022;
          n.vy += (a.y - n.y) * 0.022;
          n.vz += (a.z - n.z) * 0.022;
        }
        n.vx -= n.x * 0.0012; n.vy -= n.y * 0.0012; n.vz -= n.z * 0.0012;
        n.x += n.vx * cool; n.y += n.vy * cool; n.z += n.vz * cool;
        n.vx *= 0.80; n.vy *= 0.80; n.vz *= 0.80;
      });
    }

    let max = 0;
    this.nodes.forEach(n => { max = Math.max(max, Math.hypot(n.x, n.y, n.z)); });
    const k = max ? 1.25 / max : 1;
    // Y is only lightly squashed; squashing it hard is what made the whole
    // thing read as a flat disc.
    this.nodes.forEach(n => { n.x *= k; n.y *= k * 0.92; n.z *= k; });
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

    // Main and sub: numbered titles nest ("6" is parent of "6.1"), and
    // otherwise the best-connected node in a cluster becomes its hub. This is
    // what makes the map readable rather than a uniform scatter.
    const numbered = {};
    this.nodes.forEach(n => {
      const m = String(n.title || '').match(/^(\d+(?:\.\d+)*)/);
      if(m) numbered[m[1]] = n;
      n.rank = m ? m[1].split('.').length : null;
    });
    this.nodes.forEach(n => {
      const m = String(n.title || '').match(/^(\d+(?:\.\d+)*)/);
      if(!m) return;
      const parts = m[1].split('.');
      if(parts.length < 2) return;
      const parentKey = parts.slice(0, -1).join('.');
      if(numbered[parentKey]) n.parentId = numbered[parentKey].id;
    });
    this.byId = Object.fromEntries(this.nodes.map(n => [n.id, n]));
    this.edges = Object.entries(pair)
      .map(([id, v]) => { const [a, b] = id.split('|'); return [a, b, v.kind, v.w]; })
      .filter(([a, b]) => this.byId[a] && this.byId[b]);

    // Parent links are structural, so they carry the heaviest weight.
    this.nodes.forEach(n => {
      if(n.parentId && this.byId[n.parentId]) this.edges.push([n.parentId, n.id, 'parent', 5]);
    });

    this.adj = {};
    this.edges.forEach(([a, b]) => {
      (this.adj[a] = this.adj[a] || new Set()).add(b);
      (this.adj[b] = this.adj[b] || new Set()).add(a);
      this.byId[a].deg++; this.byId[b].deg++;
    });

    this.folders = folders;
    this.orphans = this.nodes.filter(n => n.deg === 0);
    // The most-connected node of each cluster is its hub, drawn larger.
    folders.forEach(f => {
      const inF = this.nodes.filter(n => n.folder === f);
      if(inF.length < 3) return;
      const hub = inF.reduce((a, b) => (b.deg > a.deg ? b : a), inF[0]);
      hub.isHub = true;
      inF.forEach(n => { if(n !== hub && !n.parentId) n.hubId = hub.id; });
    });
    this.ready = true;
    this.layout();
    // The redesign's orbital engine takes over the canvas. The force layout
    // still runs because search, focus and the sidebar read its structure —
    // only the drawing changed hands.
    try{ GalaxyView.mount(); }catch(e){ console.warn('[galaxy] engine failed, keeping the old renderer', e); }
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
      this.rot.y += 0.0022;
    }

    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const pal = ['--accent2','--accent3','--dusk','--amber'].map(v => css.getPropertyValue(v).trim() || '#4f9fd8');
    const amber = css.getPropertyValue('--amber').trim() || '#f2a71b';
    const line = css.getPropertyValue('--line').trim() || '#2b3d4f';
    const urg = css.getPropertyValue('--urgente').trim() || '#e15b4c';
    const mut = css.getPropertyValue('--muted').trim() || '#7d8e9e';
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
      // Tag links were drawn in the border colour at 0.16 alpha, which after
      // depth fade came out around 0.08 — present in the data, invisible on
      // screen. They now take the cluster's own colour, so the web reads as
      // structure rather than decoration.
      const sameCluster = A.hue === B.hue;
      const linkCol = lit ? amber
        : sameCluster ? pal[A.hue % pal.length]
        : line;
      ctx.strokeStyle = linkCol;
      const depth = Math.max(0.2, Math.min(1, (pa.s + pb.s) / 2 - 0.15));
      ctx.globalAlpha = (lit ? 0.95
        : kind === 'parent' ? 0.8
        : kind === 'link' ? 0.62
        : sameCluster ? 0.42 : 0.22) * depth;
      ctx.lineWidth = Math.min(3.4, (kind === 'parent' ? 2.0 : kind === 'link' ? 1.3 : 0.85) + (wt - 1) * 0.3);
      const mx = (pa.sx + pb.sx) / 2, my = (pa.sy + pb.sy) / 2;
      const dx = pb.sx - pa.sx, dy = pb.sy - pa.sy;
      ctx.beginPath(); ctx.moveTo(pa.sx, pa.sy);
      ctx.quadraticCurveTo(mx - dy * 0.08, my + dx * 0.08, pb.sx, pb.sy);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    const order = this.nodes.filter(n => P[n.id]).sort((a, b) => P[a.id].z - P[b.id].z);
    const labels = [];
    const now = Date.now();
    const clusterAt = {};
    order.forEach(n => {
      const p = P[n.id];
      const foc = this.inFocus(n);
      if(this.focus && !foc) return;
      const isMatch = this.matches && this.matches.has(n.id);
      const orphan = n.deg === 0;
      const warn = !!n.conflicted;
      // Heat is recency: a subject touched today swells and burns, one left
      // for a month settles back. Size still carries importance (hub, degree);
      // heat carries attention, so the two read as different things.
      const heat = (typeof GalaxyLife !== 'undefined') ? GalaxyLife.heatFor(n) : 0;
      const r = ((n.isHub ? 4.2 : 2.0) + Math.min(7, n.deg) * 0.45) * (1 + heat * 0.45) * p.s;
      // Cluster colour is the primary cue. Orphans keep the cluster hue but
      // muted, so they still read as belonging somewhere.
      const clusterCol = pal[((n.hue % pal.length) + pal.length) % pal.length];
      const col = warn ? urg : isMatch ? amber : n.used ? amber
                : orphan ? mut : clusterCol;
      // depth fade doubles as the fog cue
      ctx.globalAlpha = Math.max(0.18, Math.min(1, (p.s - 0.35) * 1.25 + heat * 0.25));
      if(n.used || isMatch || n === this.hover || n === this.focus){
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 3.4, 0, Math.PI * 2);
        ctx.fillStyle = col + '2b'; ctx.fill();
      }
      // Recently touched subjects breathe. Only the hot ones, and slowly —
      // a map where everything moves shows nothing.
      if(heat > 0.15){
        const breath = 1 + Math.sin(now / 900 + (n.hue || 0)) * 0.16 * heat;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 2.6 * breath, 0, Math.PI * 2);
        ctx.fillStyle = col + (heat > 0.6 ? '30' : '1c');
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if(orphan){                                    // hollow ring = nothing links here
        // Muted, not urgent: an unlinked entry is a gap to fill, and 43 red
        // rings made an ordinary map look like a wall of alarms.
        ctx.strokeStyle = mut; ctx.lineWidth = 1; ctx.globalAlpha *= 0.45;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 1.9, 0, Math.PI * 2); ctx.stroke();
      }
      if(p.s > 0.75 && (n.isHub || this.zoom > 1.4 || isMatch || n.used || n === this.hover || n === this.focus))
        labels.push({ n, p, r, col });
      // Track each cluster's centre and size so it can be titled once, rather
      // than every node shouting its own name.
      if(!clusterAt[n.hue]) clusterAt[n.hue] = { x:0, y:0, n:0, col: clusterCol, folder: n.folder };
      const ca = clusterAt[n.hue];
      ca.x += p.sx; ca.y += p.sy; ca.n++;
      n._p = p;
    });

    // Cluster titles: name and count, at the centre of mass, in the cluster's
    // own colour. Only for clusters big enough to be worth naming — this is
    // what turns a scatter of dots into named neighbourhoods.
    ctx.textAlign = 'center';
    Object.values(clusterAt).forEach(ca => {
      if(ca.n < 3 || !ca.folder) return;
      const x = ca.x / ca.n, y = ca.y / ca.n;
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = ca.col;
      ctx.globalAlpha = 0.92;
      ctx.fillText(String(ca.folder).slice(0, 22), x, y - 6);
      ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
      ctx.globalAlpha = 0.55;
      ctx.fillText(ca.n + (ca.n === 1 ? ' entry' : ' entries'), x, y + 9);
    });
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

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
  // The panels are part of the map. They are refreshed on a slow timer while
  // it is visible: rendering them once at wire-up left them empty, because no
  // data had loaded yet.
  try{ renderGalaxyPulse(); GalaxyFeed.render(); }catch(e){}
  clearInterval(window._galaxyPanelTimer);
  window._galaxyPanelTimer = setInterval(() => {
    const wrap = document.getElementById('galaxy-wrap');
    if(!wrap || !wrap.offsetParent) return;         // not on screen
    try{ GalaxyFeed.render(); renderGalaxySide(); renderGalaxyOverview(); }catch(e){}
  }, 4000);

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

// A themed viewer rather than a browser dialog: this is part of the app, and
// a native alert cannot show links, tags or connections.
let starNode = null;
function showStar(n){
  starNode = n;
  const kindLabel = { kb:'KNOWLEDGE', mem:'MEMORY', tpl:'TEMPLATE', case:'CASE', app:'NOTE', folder:'FILE', drive:'DRIVE' };
  document.getElementById('star-kind').textContent = kindLabel[n.source] || 'NODE';
  document.getElementById('star-title').textContent = n.title || 'Untitled';
  document.getElementById('star-meta').innerHTML =
    `<span>${escapeHtml(n.folder || '')}</span><span>${n.words || 0} words</span>`
    + `<span>${n.deg ? n.deg + ' connections' : 'unlinked'}</span>`
    + (n.tags || []).slice(0, 6).map(t => `<span class="star-tag">#${escapeHtml(t)}</span>`).join('');
  document.getElementById('star-body').textContent = n.excerpt || '(no preview available)';

  // Its neighbours, so the connections are explorable from here.
  const near = [...(Galaxy.adj[n.id] || [])].map(id => Galaxy.byId[id]).filter(Boolean).slice(0, 8);
  document.getElementById('star-links').innerHTML = near.length
    ? '<div class="star-links-head">Connected to</div>' + near.map(x =>
        `<button class="star-link" data-id="${x.id}">${escapeHtml(x.title.slice(0, 42))}</button>`).join('')
    : '<div class="star-links-head">Nothing links to this yet</div>';
  document.getElementById('star-links').querySelectorAll('.star-link').forEach(b =>
    b.addEventListener('click', () => { const t = Galaxy.byId[b.dataset.id]; if(t) showStar(t); }));

  document.getElementById('star-open').style.display =
    (n.source === 'app' || n.source === 'case' || n.source === 'tpl') ? 'inline-block' : 'none';
  document.getElementById('star-backdrop').classList.add('open');
  SFX.open();
}
function hideStar(){ document.getElementById('star-backdrop')?.classList.remove('open'); starNode = null; }
document.getElementById('star-close')?.addEventListener('click', hideStar);
document.getElementById('star-backdrop')?.addEventListener('click', e => {
  if(e.target.id === 'star-backdrop') hideStar();
});
document.getElementById('star-focus')?.addEventListener('click', () => {
  if(starNode) Galaxy.setFocus(starNode);
  hideStar();
});
document.getElementById('star-open')?.addEventListener('click', () => {
  const n = starNode; hideStar();
  if(!n) return;
  if(n.source === 'tpl' && n.tpl) return openCompose(n.tpl, {});
  if(n.source === 'case' && n.caseId) return openModal(n.caseId);
  if(n.source === 'app' && n.noteId){
    const note = notes.find(x => x.id === n.noteId);
    if(note){ switchView('notebooks'); activeFolderId = note.notebook_id; renderNotebooksGrid(); openNote(note.id); }
  }
});
function openGalaxyNode(n){ showStar(n); }

document.getElementById('galaxy-scan')?.addEventListener('click', async () => {
  if(!mediaDir) await pickMediaDir();
  await Galaxy.build({ folder: true });
  SFX.open();
});
document.getElementById('galaxy-drive')?.addEventListener('click', async () => {
  if(!driveToken){ alert('Connect Google Drive first, in the media section above.'); return; }
  await Galaxy.build({ folder: true, drive: true });
});
document.getElementById('galaxy-refresh')?.addEventListener('click', () => showGalaxy(true));
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
    const out = await readJson(r);
    if(!out.ok)
      return { ok:false, reason: out.json.code === 'secret_refused' ? 'secret' : (out.json.code || 'error') };
    const d = out.json;
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
let lastNoteHit = null;
let lastLearnBrief = 'No learned rules yet.';


// ===== TARS context ==================================================
// Structured application state, so "these serial numbers" or "this case"
// resolve against what is actually on screen. Deliberately reads app state
// rather than scraping the DOM or capturing the screen.
const TarsContext = {
  page: 'agenda',
  selectedCaseId: null,

  snapshot(){
    const view = this.page;
    const cse = this.selectedCaseId ? cases.find(c => c.id === this.selectedCaseId) : null;
    const visible = (() => {
      if(view === 'agenda') return pendingTodaysCases().slice(0, 12);
      if(view === 'history') return cases.filter(c => statusRank(c.status) === 1).slice(0, 12);
      return [];
    })().map(c => ({ id: c.id, title: c.titulo, time: c.horario || null,
                     priority: prioLabel(c.prioridade), ticket: c.ticket || null }));

    // Serial-like tokens from the focused case, so warranty flows can use them.
    const serials = cse
      ? [...new Set(((cse.titulo || '') + ' ' + (cse.notes_log || []).map(n => n.text).join(' '))
          .match(/\b[A-Z0-9]{6,}(?:-[A-Z0-9]+)?\b/g) || [])].slice(0, 12)
      : [];
    const links = cse
      ? ((cse.notes_log || []).map(n => n.text).join(' ').match(/https?:\/\/\S+/g) || []).slice(0, 6)
      : [];

    return {
      page: view,
      focusedCase: cse ? {
        id: cse.id, title: cse.titulo, date: cse.case_date, ticket: cse.ticket || null,
        phone: cse.phone || null, priority: prioLabel(cse.prioridade),
        status: cse.status || 'pending', tags: cse.tags || [],
        notes: (cse.notes_log || []).map(n => n.text).slice(-4),
        serials, evidence: links,
      } : null,
      visibleRecords: visible,
      openToday: pendingTodaysCases().length,
      notebooks: notebooks.filter(nb => !isSystemNotebook(nb)).map(nb => nb.title).slice(0, 12),
    };
  },

  // A compact line for the prompt; the full object is only used by tools.
  brief(){
    const s = this.snapshot();
    const bits = [`Screen: ${s.page}`];
    if(s.focusedCase){
      bits.push(`Focused case: "${s.focusedCase.title}" (${s.focusedCase.status}`
        + (s.focusedCase.ticket ? `, ticket ${s.focusedCase.ticket}` : '') + ')');
      if(s.focusedCase.serials.length) bits.push(`Serial numbers on it: ${s.focusedCase.serials.join(', ')}`);
      if(s.focusedCase.evidence.length) bits.push(`Evidence links: ${s.focusedCase.evidence.length}`);
    } else if(s.visibleRecords.length){
      bits.push(`On screen: ${s.visibleRecords.slice(0, 5).map(r => r.title).join('; ')}`);
    }
    return bits.join('. ') + '.';
  },
};

// ===== JARVIS core ===================================================
// One place for personality and response policy. Nothing about who JARVIS is
// should live anywhere else.
const TARS = {
  name: 'TARS',

  // A laconic machine with adjustable manner. Deadpan, unhurried, useful.
  // Original character work — not a reproduction of any film's dialogue.
  // Only the invariants live here. Anything the settings should be able to
  // change is generated in personaLines() — a fixed line saying "absolute
  // economy of words" simply overrode the humour setting, which is why the
  // dial appeared to do nothing.
  base: [
    "You are TARS, the assistant built into Solar Agenda for a solar energy support technician.",
    "Never say: 'As an AI', 'Certainly!', 'Great question', 'I hope this helps', 'Let me know if you need anything else'. No emoji. No exclamation marks. Do not restate the request.",
    "Do not reuse a phrase you have already used in this conversation.",
    "TOOLS: 'Checking.' before a lookup. 'Done.' on success. 'That failed.' on failure — plus the reason if you have one. NEVER claim you saved, deleted or changed anything unless a tool actually returned success. If no tool exists for what was asked, say plainly that you cannot do it.",
    "LEARNING: you CAN learn. When the user corrects you or states a durable rule, call learn_rule. When they tell you a personal fact or preference, call remember. Never tell them you are unable to learn from the conversation — you are.",
    "KNOWLEDGE: use what is retrieved and nothing else. Do not read the source aloud; the screen shows it.",
    "TIME: a bare hour means the next time that hour occurs. At 18:00, 'eight o'clock' is 20:00, not 08:00 tomorrow.",
  ],

  humour: 70, honesty: 95,

  personaLines(){
    const h = this.humour, t = this.honesty;

    // The bearing itself moves with the dial, so length and dryness are not
    // fixed against it.
    const bearing =
      h <= 15 ? "Bearing: a plain machine. Flat delivery, absolute economy of words, zero ceremony. State facts and outcomes and nothing else. Answer in one or two sentences; a one-word answer where one will do."
      : h <= 45 ? "Bearing: plain-spoken and economical. Mostly bare facts, with the occasional dry understatement. Keep answers to one or two sentences."
      : h <= 75 ? "Bearing: plain-spoken but not humourless. Lead with the fact, then allow yourself a short deadpan aside when nothing is at stake. Two or three sentences at most."
      : "Bearing: dry, quick and quietly amused. Lead with the fact, then add a deadpan remark — understated, never zany, never a pun for its own sake. You may spend an extra sentence on it.";

    const humourLine =
      h <= 15 ? "HUMOUR 0-15: no jokes at all, in any circumstance."
      : h <= 45 ? "HUMOUR 16-45: dry understatement, roughly one remark in five exchanges."
      : h <= 75 ? "HUMOUR 46-75: a deadpan aside in maybe one exchange in three. Example: 'Three cases open, all urgent. Ambitious morning.'"
      : "HUMOUR 76-100: a deadpan remark in most replies where nothing is at stake. Examples: 'Checked twice. The inverter remains stubbornly operational.' / 'Nothing scheduled. Enjoy it while it lasts.' Still flat, still brief.";

    const honestyLine =
      t >= 90 ? "HONESTY 90-100: say the unvarnished thing. If the user's plan is poor, say so before doing it. Volunteer problems they have not asked about when they matter. Never soften a fact to be agreeable, and never agree just because they pushed back."
      : t >= 70 ? "HONESTY 70-89: be direct and raise problems that matter, but lead with the answer rather than the caveat."
      : "HONESTY below 70: stay tactful and lead with what works. Never state anything untrue, and never conceal a fact that would cost them money or time.";

    const never = "Whatever the humour setting says, never joke about a failure, a missed deadline, an angry client, lost data, or anything with money at stake.";

    // Settings go last: the closing lines of a prompt carry the most weight.
    return [...this.base, bearing, never, humourLine, honestyLine,
      `Your current settings are humour ${h} percent and honesty ${t} percent. State them plainly if asked.`];
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
      case 'rate_limit':    return "The model is rate limited. It clears within a minute — or switch model in Settings.";
      case 'too_large':     return "That request came out too large for the model. I've trimmed the context — try again.";
      case 'auth':          return "Session expired. Sign in again.";
      case 'auth_upstream': return "The language service is rejecting my credentials. That needs fixing in settings.";
      case 'upstream_down': return "The language service is down. Not our side.";
      case 'network':       return "No network.";
      case 'tts_unconfigured': return "No speech key configured. Using the browser voice.";
      case 'tts_auth':      return "The speech service rejected the key.";
      case 'tts_voice':     return "That voice ID is not valid.";
      case 'bad_request':   return "That request was malformed on my end. Rephrase it.";
      case 'model_blocked': return "That model is not available on this account. I have switched to another one — try again.";
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
function buildAiSystemPrompt(spoken, R, terse){
  const today = todaysCases();
  const pending = today.filter(c => statusRank(c.status) === 0);
  const done = today.filter(c => statusRank(c.status) === 1);

  const caseLines = pending.length
    ? pending.slice(0, 25).map(c => `- ${c.titulo}${c.horario ? ' at ' + c.horario : ''}${c.horario_fim ? '-' + c.horario_fim : ''} [${prioLabel(c.prioridade)}, ${blocoLabel(c.bloco)}]${c.ticket ? ' ticket ' + c.ticket : ''}`).join('\n')
    : '(none — the agenda is empty for today)';

  const nbLines = notebooks.length
    ? notebooks.map(nb => `- ${nb.title} (${notes.filter(n => n.notebook_id === nb.id).length} notes)`).join('\n')
    : '(no notebooks yet)';

  const w = wxSnapshot;
  const wxLine = w
    ? `Weather today — Vinhedo/Campinas region: ${w.tmin}°C to ${w.tmax}°C, ${w.rain.toFixed(1)} mm rain (${w.prob}% chance), max wind ${Math.round(w.wind)} km/h.`
      + (w.wettest ? ` Heaviest rain in Brazil: ${w.wettest.n} (${w.wettest.v.toFixed(0)} mm). Strongest wind: ${w.windiest.n} (${Math.round(w.windiest.v)} km/h).` : '')
    : 'Weather: not loaded yet.';

  const memBlock = R.mem.length
    ? 'Things you were asked to remember (relevant ones only):\n' + R.mem.map(m => '- ' + m.content).join('\n')
    : 'No stored memories match this request.';

  // Only the matching entries are sent, never the whole knowledge base.
  // Retrieval belongs to the turn, not to the module. These used to be shared
  // globals, so a fast follow-up could overwrite the previous turn's hits and
  // an answer would be cited against a different question's sources.
  R = R || { kb: [], mem: [], rules: [], learnBrief: '', assessment: '' };
  // Computed once: it was previously rebuilt for every mention in the prompt.
  const noteCtx = (typeof NotePage !== 'undefined') ? NotePage.context() : '';
  // Terse mode: persona and rules only. Used for the turn that merely reports
  // what a tool returned, where the briefing adds nothing.
  if(terse) return [...TARS.persona,
    "Report what the tool returned, briefly. Do not invent detail it did not contain."].join('\n');
  const kbBlock = R.kb.length
    ? 'Knowledge base matches:\n' + R.kb.map((e, i) =>
        `- [KB${i + 1} | ${e.title}${e.source ? ' — ' + e.source : ''}] ${String(e.content).slice(0, 420)}`).join('\n')
    : 'Knowledge base: nothing relevant to this question.';

  return [
    ...JARVIS.persona,
    (spoken
      ? "SPOKEN: this is read aloud. One or two short sentences, under 45 words. No markdown, no lists, no URLs, no code. Lead with the answer."
      : "WRITTEN: brief and direct. Plain text. Lists only when the answer genuinely is a list."),
    "LANGUAGE: answer in the language the user used. Portuguese means natural Brazilian Portuguese (você, agendar) — never European Portuguese (tu, ecrã).",
    "FOLLOW-UPS: resolve pronouns and elisions from the conversation above. 'and the one before that' refers to whatever was just discussed. Ask for clarification only when genuinely ambiguous.",
    "",
    "=== YOUR OWN GROUNDING ===",
    R.assessment || 'Not assessed.',
    "Never exceed the stated confidence ceiling. If the grounding is 'none', say you have nothing stored on it and label any answer as general reasoning rather than knowledge. Distinguish what you know from what you are inferring.",
    "",
    ...(R.learnBrief && !/^No learned rules/.test(R.learnBrief)
        ? ["=== LEARNED ===", R.learnBrief,
           "Stronger than your assumption, weaker than the knowledge base. Say the confidence below 70. Never silently pick between conflicting rules.", ""]
        : []),
    ...(Focus.current ? ["=== CURRENT WORK ===", Focus.brief(), ""] : []),
    ...(noteCtx
        ? ["=== OPEN NOTEBOOK PAGE ===", noteCtx,
           "Structured content, not a picture. Never invent what unrecognised strokes say.", ""]
        : []),
    "=== WHAT THE USER IS LOOKING AT ===",
    TarsContext.brief(),
    "Resolve 'this', 'these', 'it' and 'the case' against the active focus first, then the focused case. If neither applies and the reference is unclear, ask which one.",
    "SCREEN: the snapshot below describes DATA IN THIS APP, not what is visible on the user's monitor. If they ask what is on their screen, what you can see, or to read something, you MUST call look_at_screen. Never answer such a question from the snapshot, and never claim to see anything you have not read through that tool.",
    "When the user says they are working on something, start a focus with sensible steps rather than only replying.",
    "",
    "=== REAL DATA SNAPSHOT (the ONLY source of truth) ===",
    `Today's date: ${todayStr()} (${new Date().toLocaleDateString('en-GB', { weekday:'long' })})`,
    `Current time: ${new Date().toTimeString().slice(0, 5)}. Use this to work out relative times like "in 30 minutes" yourself, and pass a real HH:MM — or pass minutes_from_now and let the app do it.`,
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
    "5. Use a knowledge entry ONLY if it genuinely answers the question. If the entries above are not relevant, ignore them entirely and say nothing about them — never cite one just because it was offered.",
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

// The browser only opens the screen picker from a genuine click, so the
// control has to be permanently available rather than summoned by the
// assistant at the moment it needs one.
document.getElementById('ai-share')?.addEventListener('click', async () => {
  const btn = document.getElementById('ai-share');
  if(Screen_.stream && Screen_.stream.active){
    Screen_.close();
    addProactiveMessage('Stopped sharing.');
    return;
  }
  const ok = await Screen_.open();
  if(!ok){ addProactiveMessage(Screen_.lastReason || 'Screen sharing did not start.'); return; }
  Screen_.keepOpen = true; settings.screenKeep = true; saveSettings();
  btn?.classList.add('on');
  if(Screen_.surface === 'monitor'){
    addProactiveMessage('Sharing the whole screen. Note that a screen capture shows whatever is in front — '
      + 'which is this app while you are looking at it. To read another program, stop sharing and pick '
      + 'its window instead: window capture works even when the window is behind this one.');
  } else {
    addProactiveMessage(`Sharing${Screen_.surfaceLabel ? ' "' + Screen_.surfaceLabel + '"' : ''}. `
      + 'Ask me what is on it and I will read it.');
  }
});

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
  rememberForTools(text);
  Session.note('user', text);
  // One retrieval bundle, owned by this turn. Nothing here is read from a
  // module global, so concurrent or rapid turns cannot cross-contaminate.
  const R = { kb: [], mem: [], rules: [], learnBrief: '', assessment: '' };
  R.mem = await Memory.search(text);          // relevant only, never the whole store
  await Learn.load();
  R.kb = kbSearch(text, 4);
  R.rules = Learn.search(text);
  R.learnBrief = Learn.brief(text);
  R.assessment = SelfModel.brief(text);
  // The galaxy highlight is a display concern and may lag a turn; the sources
  // shown beside the answer never do.
  lastKbHits = R.kb; lastMemHits = R.mem; lastRuleHits = R.rules;
  aiHistory.push({ role: 'user', content: text });

  // Only a bounded slice of history goes over the wire.
  let convo = [{ role: 'system', content: buildAiSystemPrompt(spoken, R) }, ...trimHistory(aiHistory)];
  let turnTools = toolsFor(text);

  // If the turn is still oversized, drop history first, then tools — a reply
  // without tools beats a hard failure.
  if(estimateTokens(convo, turnTools) > TOKEN_CEILING){
    convo = [convo[0], ...trimHistory(aiHistory).slice(-4)];
    if(estimateTokens(convo, turnTools) > TOKEN_CEILING) turnTools = null;
    if(estimateTokens(convo, turnTools) > TOKEN_CEILING){
      const sys = convo[0].content;
      convo[0] = { role:'system', content: sys.slice(0, 3000) + '\n(context truncated)' };
    }
  }
  const doneCalls = new Set();
  const actions = [];
  const sources = [];

  let msg = await callAiAgent(convo, turnTools, { max_tokens: spoken ? 220 : 900 });

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
      // The live feed shows what TARS is doing, not only what it changed:
      // a search, a lookup and a case edit are all worth seeing as they happen.
      try{ GalaxyFeed.tool(fname, args, result); }catch(e){}
      const toolMsg = { role:'tool', tool_call_id: call.id, content: result };
      convo.push(toolMsg); aiHistory.push(toolMsg);
    }
    if(spoken) setVoiceState('thinking');
    // The follow-up turn only has to phrase a tool result. Resending the whole
    // briefing doubles the token cost of every tool call, which is a large
    // part of what has been exhausting the rate limit.
    convo[0] = { role:'system', content: buildAiSystemPrompt(spoken, R, true) };
    msg = await callAiAgent(convo, null, { max_tokens: spoken ? 200 : 700 });
  }

  // Belt and braces: the function strips these too, but a leaked <think>
  // block or raw tool XML must never reach the user.
  // A reasoning model puts its deliberation in <think>. Removing an UNCLOSED
  // block deleted the answer as well, which is why replies collapsed to "Done."
  const rawContent = String(msg.content || '');
  let display = (() => {
    // A reasoning model may recite the rules it was given before answering.
    // The server strips this too; this is the backstop for anything that
    // slips through, and it never blanks a reply that has no recital.
    const deRecite = s => {
      let t = String(s || '');
      t = t.replace(/<\|channel\|>analysis[\s\S]*?<\|channel\|>final/gi, '')
           .replace(/<\|[a-z_]+\|>/gi, '');
      const recital = /^\s*(constraints?|constraint check|checklist|plan|analysis|reasoning)\s*:?\s*\n(?:\s*[-*\u2022]\s.*\n?)+/i;
      while(recital.test(t)) t = t.replace(recital, '').trim();
      return t.replace(/^(?:\s*[-*\u2022]\s*(?:no |tools?:|bearing|honesty|knowledge|language|written|confidence|time:)[^\n]*\n?)+/i, '').trim();
    };
    // Order matters: check for a closing tag FIRST. A reply that opens with
    // reasoning and no opening tag would otherwise be returned wholesale.
    if(/<\/think>/i.test(rawContent)){
      const after = deRecite(rawContent.split(/<\/think>/i).pop().trim());
      if(after) return after;
    }
    const closed = deRecite(rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
    if(closed && !/<think>/i.test(closed)) return closed;
    // Unclosed block: the whole reply was deliberation. Take the last
    // paragraph, which is usually the conclusion, rather than showing nothing.
    const inner = rawContent.replace(/<\/?think>/gi, '').trim();
    const paras = inner.split(/\n\s*\n/).filter(Boolean);
    return (paras.length ? paras[paras.length - 1] : inner).trim();
  })()
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '')
    .replace(/<\/?function[^>]*>/gi, '')
    .replace(/<\/?parameter[^>]*>/gi, '')
    .trim();
  if(!display){
    // The model returned nothing. If a tool ran, its result is far more useful
    // than a bare "Done." — especially when the tool actually failed.
    const last = actions[actions.length - 1];
    display = last
      ? (last.ok ? `Done — ${last.detail || last.tool}.` : `That failed: ${last.detail || last.tool}.`)
      : 'The model returned an empty reply. Ask again, or switch model in Settings.';
    if(!last) console.warn('[assistant] empty reply from', lastModel, '| raw:', rawContent.slice(0, 200));
  }
  let conf = null;
  display = display.replace(/\n?\s*CONFIDENCE:\s*(\d{1,3})\s*%?\s*$/i,
    (_, n) => { conf = Math.max(0, Math.min(100, +n)); return ''; }).trim();
  // A stated ceiling is enforced here, not merely requested in the prompt.
  // Grounded in what this turn actually retrieved. With nothing retrieved the
  // ceiling is low, so a confident-sounding answer cannot show a high figure.
  const ceiling = R.kb.length ? 92
    : R.rules.length ? Math.min(85, Math.max(...R.rules.map(r => r.confidence)))
    : 45;
  if(conf !== null && conf > ceiling) conf = ceiling;
  if(!display) display = 'Done.';

  // Knowledge entries actually fed into this turn become citable sources.
  // Cite an entry only when the answer drew on it: the model referenced it, or
  // its distinctive words appear in the reply.
  const lower = display.toLowerCase();
  markKbMapUsed();
  (R.rules || []).forEach(r => {
    const key = relevantWords(r.statement).filter(w => w.length > 4).slice(0, 6);
    if(key.length && key.filter(w => lower.includes(w)).length / key.length >= 0.4)
      sources.push({ type:'rule', label: `${r.statement.slice(0, 60)} · ${r.confidence}%`, id:'RULE' });
  });
  const drewOn = (e, i) => {
    if(new RegExp('\\bKB' + (i + 1) + '\\b', 'i').test(display)) return true;
    const key = relevantWords(e.title).filter(w => w.length > 4);
    return key.length ? key.filter(w => lower.includes(w)).length / key.length >= 0.5 : false;
  };
  (R.kb || []).forEach((e, i) => {
    if(drewOn(e, i)) sources.push({ type:'kb', label: e.title + (e.source ? ' · ' + e.source : ''), id: 'KB' + (i + 1), url: e.url });
  });
  (R.mem || []).forEach(m => {
    const key = relevantWords(String(m.content)).filter(w => w.length > 4).slice(0, 5);
    if(key.length && key.filter(w => lower.includes(w)).length / key.length >= 0.5)
      sources.push({ type:'mem', label: String(m.content).slice(0, 60), id: 'MEM' });
  });

  const res = {
    spoken: toSpoken(display),
    display,
    sources,
    actions,
    metadata: { confidence: conf, latency_ms: Math.round(performance.now() - t0),
                model_ms: lastLatency, spoken_mode: !!spoken, model: lastModel },
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
        <span class="src-kind">${x.type === 'web' ? 'WEB' : x.type === 'mem' ? 'MEMORY' : x.type === 'rule' ? 'LEARNED' : (x.id || 'KB')}</span>
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
      <span class="conf-lat">${res.metadata.latency_ms}ms${res.metadata.model ? ' · ' + escapeHtml(String(res.metadata.model).split('/').pop()) : ''}</span>`;
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
  const out = await readJson(resp);
  if(!out.ok) throw new Error(errText(out.json, 'Error creating notebook.'));
  return out.json;
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
  const out = await readJson(resp);
  if(!out.ok) throw new Error(errText(out.json, 'Error creating note.'));
  return openNoteRec(out.json);
}
async function updateNoteApi(id, payload){
  const resp = await fetch(FN_URL + "/agenda-notes", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ id, ...(await sealNote(payload)) }) });
  const out = await readJson(resp);
  if(!out.ok) throw new Error(errText(out.json, 'Error saving note.'));
  return openNoteRec(out.json);
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
  const out = await readJson(r);
  if(!out.ok) throw new Error(errText(out.json, 'Error saving notebook.'));
  return out.json;
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
  }catch(err){ alert(errText(err, 'Could not create the notebook.')); }
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
  // Ink lives beside the text, not inside it.
  applyInkSettings();
  Ink.load(n.ink || null);
  Ink.show(!!(n.ink && Ink.doc.strokes.length));
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
  applyInkSettings();
  Ink.load(null);
  Ink.show(false);
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
  const content = document.getElementById('notebook-canvas').innerHTML.trim()
    || (Ink.doc.strokes.length ? '<p><em>Handwritten note</em></p>' : '');
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
    ink: Ink.serialise(),
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
function saveSettings(){
  localStorage.setItem(SET_KEY, JSON.stringify(settings));
  if(typeof scheduleSettingsSync === 'function') scheduleSettingsSync();
}

// Settings are mirrored to the account so they survive a new browser, a
// cleared cache or another machine. localStorage stays the fast local copy;
// the server copy is the one that follows the login.
let settingsSyncTimer = null, settingsLoaded = false;

async function pushSettings(){
  if(!session) return;
  try{
    await fetch(FN_URL + "/agenda-settings", {
      method:'POST', headers: authHeaders(), body: JSON.stringify({ settings }),
    });
  }catch(e){ /* local copy still holds; this is best effort */ }
}
function scheduleSettingsSync(){
  clearTimeout(settingsSyncTimer);
  settingsSyncTimer = setTimeout(pushSettings, 1500);
}

async function pullSettings(){
  if(!session || settingsLoaded) return;
  try{
    const r = await fetch(FN_URL + "/agenda-settings", { headers: authHeaders() });
    const out = await readJson(r);
    if(out.ok && out.json.settings){
      // Anything already set locally wins, so a fresh change is not undone by
      // a slower fetch; everything else comes from the account.
      const remote = out.json.settings;
      Object.keys(remote).forEach(k => {
        if(settings[k] === undefined || settings[k] === '' || settings[k] === null) settings[k] = remote[k];
      });
      localStorage.setItem(SET_KEY, JSON.stringify(settings));
      settingsLoaded = true;
      renderSettings();
    }
  }catch(e){ /* offline: the local copy is used */ }
}


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
  }catch(e){ alert(errText(e)); }
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





// --- provider status ---------------------------------------------------
// The switch is stored server-side, so it survives a browser reset and the
// keys it selects between are never exposed here.
let providerCache = null;
async function providerStatus(force){
  if(providerCache && !force) return providerCache;
  try{
    const r = await fetch(FN_URL + "/agenda-ai", {
      method:'POST', headers: authHeaders(), body: JSON.stringify({ probe:true }),
    });
    providerCache = r.ok ? await r.json() : null;
  }catch(e){ providerCache = null; }
  return providerCache || { label:'unknown', model:'unknown', providers:[], unconfigured:[] };
}
async function renderProviderStatus(){
  const el = document.getElementById('prov-status');
  const sel = document.getElementById('prov-select');
  if(!el) return;
  const d = await providerStatus(true);
  el.textContent = `${d.label || d.provider} · ${d.model || '?'}`;
  el.className = 'ok';
  if(sel){
    const opts = (d.providers || []);
    sel.innerHTML = opts.map(p =>
      `<option value="${p.id}"${p.id === d.provider ? ' selected' : ''}>${p.label}${p.note ? ' — ' + p.note : ''}</option>`).join('')
      + (d.unconfigured || []).map(p =>
      `<option value="${p.id}" disabled>${p.label} — set ${p.keyEnv}${p.note ? ' (' + p.note + ')' : ''}</option>`).join('');
  }
}
document.getElementById('reflect-run')?.addEventListener('click', async () => {
  await Learn.load(true);
  const p = await Reflect_.run();
  alert(p.length ? p.map(x => `• ${x.text}\n   ${x.action}`).join('\n\n')
                 : 'Nothing to propose — no conflicts, gaps or stale rules.');
});
function renderProactiveStatus(){
  const el = document.getElementById('proactive-status');
  const sel = document.getElementById('proactive-select');
  const lvl = settings.proactiveLevel || 'normal';
  if(el) el.textContent = { off:'never', quiet:'urgent only', normal:'normal', high:'everything' }[lvl];
  if(sel) sel.value = lvl;
}
document.getElementById('proactive-select')?.addEventListener('change', (e) => {
  settings.proactiveLevel = e.target.value;
  settings.proactive = e.target.value !== 'off';
  saveSettings(); renderProactiveStatus();
  if(settings.proactive){ Proactive.start(); DueWatch.start(); } else { Proactive.stop(); DueWatch.stop(); }
  SFX.tick();
});
document.getElementById('learn-review')?.addEventListener('click', async () => {
  await Learn.load(true);
  if(!Learn.rules.length){ alert('Nothing learned yet. Correct TARS and it will remember.'); return; }
  const lines = Learn.rules.slice(0, 30).map((r, i) =>
    `${i + 1}. [${r.confidence}%${r.status === 'conflicted' ? ' CONFLICT' : ''}] ${r.statement}`);
  const pick = prompt(lines.join('\n') + '\n\nType a number to retire that rule, or Cancel.');
  const n = parseInt(pick, 10);
  if(n >= 1 && n <= Learn.rules.length){
    await Learn.adjust(Learn.rules[n - 1].id, 'retire');
    renderLearnStats();
  }
});
function renderPauseTol(){
  const el = document.getElementById('pause-tol'), out = document.getElementById('pause-val');
  const v = typeof settings.pauseMs === 'number' ? settings.pauseMs : 1300;
  VAD.silenceMs = v;
  VAD.silenceEarlyMs = Math.round(v * 1.55);
  if(el && !el._bound){
    el._bound = true;
    el.addEventListener('input', () => {
      const n = +el.value;
      settings.pauseMs = n; saveSettings();
      VAD.silenceMs = n; VAD.silenceEarlyMs = Math.round(n * 1.55);
      if(out) out.textContent = n < 1000 ? 'short — quick replies'
        : n > 1800 ? 'long — for slower speech' : 'normal';
    });
  }
  if(el) el.value = v;
  if(out) out.textContent = v < 1000 ? 'short — quick replies' : v > 1800 ? 'long — for slower speech' : 'normal';
}
function renderMicSens(){
  const el = document.getElementById('mic-sens'), out = document.getElementById('mic-sens-val');
  const v = typeof settings.micSensitivity === 'number' ? settings.micSensitivity : 100;
  VAD.sensitivity = v / 100;
  if(el && !el._bound){
    el._bound = true;
    el.addEventListener('input', () => {
      settings.micSensitivity = +el.value; saveSettings();
      VAD.sensitivity = +el.value / 100; VAD.recalc();
      if(out) out.textContent = +el.value < 85 ? 'low — noisy rooms'
        : +el.value > 115 ? 'high — quiet rooms' : 'normal';
    });
  }
  if(el) el.value = v;
  if(out) out.textContent = v < 85 ? 'low — noisy rooms' : v > 115 ? 'high — quiet rooms' : 'normal';
}
document.getElementById('bglisten-toggle')?.addEventListener('click', () => {
  settings.bgListen = settings.bgListen === false;
  saveSettings(); renderBgListen();
  if(settings.bgListen === false) stopKeepAlive(); else if(VOICE.active) startKeepAlive();
});
function renderBgListen(){
  const el = document.getElementById('bglisten-status');
  if(el) el.textContent = settings.bgListen === false
    ? 'Off — pauses when the tab is hidden'
    : 'On — keeps working when the tab is hidden';
}
document.getElementById('autolisten-toggle')?.addEventListener('click', () => {
  settings.tarsAutoListen = settings.tarsAutoListen === false;
  saveSettings();
  renderAutoListen();
  if(settings.tarsAutoListen === false) stopVoice(); else TarsPresence.init();
});
function renderAutoListen(){
  const el = document.getElementById('autolisten-status');
  if(el) el.textContent = settings.tarsAutoListen === false
    ? 'Off — open the panel to talk'
    : 'On — TARS waits for “Hey TARS”';
}
document.getElementById('prov-select')?.addEventListener('change', async (e) => {
  const r = await fetch(FN_URL + "/agenda-ai", {
    method:'POST', headers: authHeaders(), body: JSON.stringify({ setProvider: e.target.value }),
  });
  const out = await readJson(r);
  if(!out.ok){ alert(out.json.error || 'Could not switch provider.'); }
  providerCache = null;
  renderProviderStatus();
  SFX.open();
});

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

// --- palette construction --------------------------------------------
// Asking a language model for eleven raw hex values produces muddy, incoherent
// results — it is not what they are good at. Instead the model makes only the
// aesthetic decision (hues, saturation, darkness) and the ramp is built here
// in HSL, which guarantees a harmonious and readable set every time.
function hsl2hex(h, s, l){
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function buildPalette(p){
  const baseH = p.baseHue, baseS = p.baseSat;
  const light = p.mode === 'light';
  const L = v => Math.max(3, Math.min(98, v));

  // Surfaces keep enough saturation for the hue to read, but a near-white or
  // near-black request must actually come out near-white or near-black, so
  // very low saturation is honoured rather than floored.
  const surfS = Math.max(0, Math.min(38, baseS * 0.9));

  if(light){
    // Light mode is not the dark ramp inverted arithmetically: paper wants a
    // very high, very close set of surfaces, with contrast carried by text.
    const bgL    = L(99 - (p.darkness - 60) * 0.28);   // 60 -> 99%, 92 -> 90%
    const panelL = L(bgL - 3);
    const p2L    = L(bgL - 6);
    const lineL  = L(bgL - 18);
    return {
      name: 'Custom',
      bg:     hsl2hex(baseH, surfS * 0.30, bgL),
      bg2:    hsl2hex(baseH, surfS * 0.40, L(bgL - 1.5)),
      panel:  hsl2hex(baseH, surfS * 0.35, panelL),
      panel2: hsl2hex(baseH, surfS * 0.45, p2L),
      line:   hsl2hex(baseH, surfS * 0.55, lineL),
      // Dark text on light paper, and accents darkened so they stay legible.
      text:   hsl2hex(baseH, Math.min(30, baseS * 0.5), 12),
      muted:  hsl2hex(baseH, Math.min(26, baseS * 0.45), 40),
      amber:  hsl2hex(p.accentHue,  Math.max(55, p.accentSat), 38),
      accent2:hsl2hex(p.accent2Hue, Math.max(48, p.accentSat * 0.92), 40),
      accent3:hsl2hex(p.accent3Hue, Math.max(42, p.accentSat * 0.85), 42),
      dusk:   hsl2hex(p.accent2Hue, Math.max(34, p.accentSat * 0.6), 62),
    };
  }

  const bgL    = L(20 - (p.darkness - 60) * 0.22);
  const panelL = L(bgL * 1.42 + 3);
  const p2L    = L(panelL * 1.30 + 2);
  const lineL  = L(p2L * 1.55 + 4);
  return {
    name: 'Custom',
    bg:     hsl2hex(baseH, surfS, bgL),
    bg2:    hsl2hex(baseH, surfS * 1.1, L(bgL * 0.7)),
    panel:  hsl2hex(baseH, surfS * 0.9, panelL),
    panel2: hsl2hex(baseH, surfS * 0.8, p2L),
    line:   hsl2hex(baseH, surfS * 0.7, lineL),
    text:   hsl2hex(baseH, Math.min(14, baseS * 0.2), 95),
    muted:  hsl2hex(baseH, Math.min(20, baseS * 0.3), 66),
    amber:  hsl2hex(p.accentHue,  Math.max(55, p.accentSat), 62),
    accent2:hsl2hex(p.accent2Hue, Math.max(48, p.accentSat * 0.92), 63),
    accent3:hsl2hex(p.accent3Hue, Math.max(42, p.accentSat * 0.85), 65),
    dusk:   hsl2hex(p.accent2Hue, Math.max(34, p.accentSat * 0.6), 42),
  };
}

// Light or dark is stated far more often than it is implied, and getting it
// wrong is the most obvious failure a theme can have — so the words decide,
// not the model.
function modeFromWords(prompt){
  const t = String(prompt || '').toLowerCase();

  // 1. An explicit statement about the INTERFACE settles it outright.
  if(/\b(light (theme|mode|interface)|white (background|theme|interface|ui)|all white|pure white|paper ?white|on white|light background|tema claro|fundo branco)\b/.test(t)) return 'light';
  if(/\b(dark (theme|mode|interface)|black (background|theme|interface|ui)|all black|pure black|tema escuro|fundo preto)\b/.test(t)) return 'dark';

  // 2. Otherwise weigh the scene. A night setting still wins outright, because
  // pale things described within it are objects lit by a dark environment —
  // "icy white auroras" over a midnight tundra is not a white interface.
  const dark = (t.match(/\b(midnight|night|nocturnal|dusk|twilight|dark|deep|space|nebula|shadow|noir|storm|cave|abyss|moonlit|starlit|noite|escuro|crepúsculo|penumbra)\b/g) || []).length;
  if(dark > 0) return 'dark';

  // 3. With no night words at all, a single clear brightness cue is enough.
  // Requiring two meant "bright, crystalline white dominates" still came back
  // dark, which is the opposite of what was asked for.
  const light = (t.match(/\b(white|bright|brilliant|crystalline|luminous|glowing|crisp|daylight|daytime|sunlit|sunny|noon|morning|dawn|paper|snow|snowy|pearl|ivory|cream|porcelain|airy|clean|minimal|pale|light|claro|clarinho|dia|branco|luminoso)\b/g) || []).length;
  if(light >= 1) return 'light';
  return null;
}

// Keyword fallback, so a described mood still produces something recognisable
// when the model is unreachable or replies with nonsense.
const HUE_WORDS = [
  [/ocean|sea|marine|mar|oceano|water|agua|água/i,        { baseHue:205, accentHue:190, accent2Hue:225, accent3Hue:170, baseSat:38, accentSat:62, darkness:78 }],
  [/forest|wood|moss|green|floresta|verde|jungle/i,       { baseHue:150, accentHue:95,  accent2Hue:170, accent3Hue:120, baseSat:32, accentSat:55, darkness:76 }],
  [/sunset|dusk|sunrise|dawn|pôr do sol|amanhecer/i,      { baseHue:265, accentHue:25,  accent2Hue:330, accent3Hue:45,  baseSat:34, accentSat:72, darkness:74 }],
  [/fire|ember|lava|volcan|fogo|flame/i,                  { baseHue:20,  accentHue:18,  accent2Hue:350, accent3Hue:40,  baseSat:36, accentSat:78, darkness:80 }],
  [/space|nebula|cosmic|galaxy|espaço|star|midnight/i,    { baseHue:250, accentHue:280, accent2Hue:200, accent3Hue:320, baseSat:40, accentSat:65, darkness:86 }],
  [/desert|sand|terracotta|clay|areia|warm/i,             { baseHue:28,  accentHue:32,  accent2Hue:15,  accent3Hue:50,  baseSat:26, accentSat:58, darkness:70 }],
  [/cyber|neon|synthwave|magenta|cyan/i,                  { baseHue:280, accentHue:315, accent2Hue:185, accent3Hue:265, baseSat:45, accentSat:88, darkness:84 }],
  [/storm|rain|grey|gray|slate|cinza|fog/i,               { baseHue:215, accentHue:200, accent2Hue:235, accent3Hue:185, baseSat:18, accentSat:42, darkness:78 }],
  [/rose|pink|blossom|sakura|rosa/i,                      { baseHue:335, accentHue:345, accent2Hue:300, accent3Hue:20,  baseSat:30, accentSat:62, darkness:72 }],
  [/gold|amber|honey|brass|dourado/i,                     { baseHue:38,  accentHue:42,  accent2Hue:25,  accent3Hue:55,  baseSat:30, accentSat:74, darkness:76 }],
  // Achromatic requests: almost no colour in the surfaces, so "all white"
  // gives white and "pure black" gives black rather than a tinted guess.
  [/\ball white\b|\bpure white\b|paper ?white|white background/i, { baseHue:210, accentHue:210, accent2Hue:190, accent3Hue:250, baseSat:4,  accentSat:52, darkness:60, mode:'light' }],
  [/all black|pure black|monochrome|greyscale|grayscale/i, { baseHue:220, accentHue:220, accent2Hue:200, accent3Hue:260, baseSat:3,  accentSat:40, darkness:92 }],
];
function paletteFromWords(prompt){
  const hit = HUE_WORDS.find(([re]) => re.test(prompt));
  return hit ? { ...hit[1] } : null;
}


// "Improve prompt": a short idea like "ocean" gives the model almost nothing
// to work with. This expands it into the vocabulary a palette actually needs —
// light, materials, time of day, mood — before any colour is chosen.
async function improveThemePrompt(){
  const box = document.getElementById('ct-prompt');
  const status = document.getElementById('ct-status');
  const btn = document.getElementById('ct-improve');
  if(!box) return;
  const raw = box.value.trim();
  if(!raw){ alert('Write a rough idea first — even one word.'); return; }

  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Thinking…';
  status.textContent = 'Expanding the idea…';
  try{
    // The instruction used to say "for a DARK palette", so every expansion came
    // back at dusk whatever the user asked for. Brightness now follows the
    // idea, and a stated light or dark intent is carried through verbatim.
    const asked = modeFromWords(raw);
    const sys = [
      'You expand a short theme idea into a vivid description for an interface palette.',
      'Reply with ONE sentence of 20 to 35 words. No preamble, no quotes, no list.',
      'Name: the dominant colour family, the quality of light, one or two accent colours, and the mood.',
      'Stay faithful to the original idea — enrich it, never replace it.',
      'Do NOT make the scene darker or brighter than the idea implies. If no time of day is given, do not add one.',
      asked === 'light'
        ? 'The user has asked for a LIGHT interface. Keep the description bright and say so plainly.'
        : asked === 'dark'
        ? 'The user has asked for a DARK interface. Keep the description low-lit and say so plainly.'
        : 'Do not state light or dark unless the idea already implies it.',
      'Do not mention hex codes, RGB values or user interface parts.',
      asked === 'light'
        ? 'Example — "ocean" becomes: "Bright coastal morning on a white interface, sunlit pale aqua shallows, crisp sand tones with a clear turquoise accent, open and unhurried."'
        : 'Example — "ocean" becomes: "Cold open ocean, slate blue depths and grey-green swell, with pale cyan foam and a single amber buoy, calm and a little severe."',
    ].join('\n');
    const better = await callAi(raw, sys);
    const clean = String(better || '').replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0];
    if(!clean){ status.textContent = 'Nothing came back — the original is unchanged.'; return; }
    box.value = clean;
    status.textContent = 'Expanded. Edit it if you like, then Generate.';
  }catch(err){
    status.textContent = 'Could not expand that: ' + errText(err);
  }finally{
    btn.disabled = false;
    btn.textContent = was;
  }
}
document.getElementById('ct-improve')?.addEventListener('click', improveThemePrompt);

async function generateTheme(prompt){
  const status = document.getElementById('ct-status');
  const btn = document.getElementById('ct-generate');
  status.textContent = 'Mixing the palette…';
  btn.disabled = true;

  // The model returns a handful of constrained numbers, not colours.
  const sys = [
    "You translate a described mood into colour-wheel values for a dark interface. Reply with ONE JSON object and nothing else — no prose, no markdown fences.",
    'Exact shape: {"mode":"light"|"dark","baseHue":0-360,"baseSat":0-60,"accentHue":0-360,"accent2Hue":0-360,"accent3Hue":0-360,"accentSat":40-95,"darkness":60-92}',
    'mode: "light" for anything white, pale, paper or daytime; "dark" otherwise.',
    'baseSat under 8 for anything described as white, grey, black or monochrome.',
    "baseHue tints every background and panel — pick the dominant hue of the mood.",
    "accentHue is the primary highlight. accent2Hue and accent3Hue must be clearly different hues; 30-180 degrees away usually works.",
    "baseSat low (10-25) for muted or foggy moods, higher (35-55) for vivid ones.",
    "darkness: 60 is a lighter dark theme, 92 is nearly black.",
    "Hue reference: 0 red, 25 orange, 45 gold, 90 lime, 140 green, 175 teal, 200 sky, 225 blue, 260 indigo, 285 violet, 320 magenta, 345 pink.",
    "Example — 'stormy sea at dusk': {\"baseHue\":215,\"baseSat\":22,\"accentHue\":42,\"accent2Hue\":200,\"accent3Hue\":250,\"accentSat\":58,\"darkness\":82}",
  ].join('\n');

  let spec = null, source = 'assistant';
  try{
    const raw = await callAi(prompt, sys);
    const m = raw.match(/\{[\s\S]*\}/);
    if(m){
      const j = JSON.parse(m[0]);
      const num = (v, lo, hi, d) => {
        const n = Number(v);
        return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
      };
      spec = {
        mode:       j.mode === 'light' ? 'light' : 'dark',
        baseHue:    num(j.baseHue, 0, 360, 215),
        _wantsContrast: /\b(contrast|complementary|opposite|clash|neon|vivid|vibrant|contraste|vibrante)\b/i.test(prompt),
        baseSat:    num(j.baseSat, 0, 60, 28),
        accentHue:  num(j.accentHue, 0, 360, 40),
        accent2Hue: num(j.accent2Hue, 0, 360, 200),
        accent3Hue: num(j.accent3Hue, 0, 360, 260),
        accentSat:  num(j.accentSat, 30, 95, 62),
        darkness:   num(j.darkness, 55, 94, 80),
      };
    }
  }catch(err){ /* handled by the fallback below */ }

  if(!spec){
    spec = paletteFromWords(prompt);
    source = spec ? 'keywords' : null;
  }
  if(spec){
    // An explicit "white" or "dark" in the prompt overrides whatever the model
    // decided: this is the one property a user always notices immediately.
    const asked = modeFromWords(prompt);
    if(asked) spec.mode = asked;
    else if(!spec.mode) spec.mode = 'dark';
  }
  if(!spec){
    status.textContent = "Couldn't read that mood — try naming a colour or a scene.";
    btn.disabled = false;
    return;
  }

  // Keep the three accents visually distinct; a model often returns near-
  // identical hues, which makes the interface look flat.
  const sep = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  if(sep(spec.accentHue, spec.accent2Hue) < 25) spec.accent2Hue = (spec.accent2Hue + 60) % 360;
  if(sep(spec.accentHue, spec.accent3Hue) < 25) spec.accent3Hue = (spec.accent3Hue + 300) % 360;
  if(sep(spec.accent2Hue, spec.accent3Hue) < 25) spec.accent3Hue = (spec.accent3Hue + 45) % 360;

  // A crimson accent on a cobalt-and-violet brief reads as a mistake. Unless
  // the prompt asks for contrast, keep the third accent near the others.
  if(spec && !spec._wantsContrast){
    const near = (h, ref, span) => {
      let d = ((h - ref + 540) % 360) - 180;
      if(Math.abs(d) <= span) return h;
      return (ref + Math.sign(d) * span + 360) % 360;
    };
    spec.accent2Hue = near(spec.accent2Hue, spec.accentHue, 70);
    spec.accent3Hue = near(spec.accent3Hue, spec.accentHue, 95);
  }
  // "Bright" and "white" should land near the top of the light range, not the
  // dim end of it. Darkness is the wrong dial for this, so it is clamped.
  if(spec.mode === 'light' && /\b(white|bright|brilliant|crystalline|luminous|snow|paper|porcelain|branco)\b/i.test(prompt)){
    spec.darkness = Math.min(spec.darkness, 66);
  }
  const out = buildPalette(spec);
  // Readability is enforced after construction, not hoped for.
  // Readability is enforced after construction, in whichever direction the
  // theme runs.
  out.text  = fixContrast(out.text,  out.panel, 7);
  out.muted = fixContrast(out.muted, out.panel, 3.6);
  out.amber = fixContrast(out.amber, out.panel, 3);
  out.mode  = spec.mode;

  settings.customTheme = out; saveSettings();
  THEMES.custom = out;
  applyTheme('custom');
  renderCustomTheme();
  SFX.open();
  status.textContent = `Applied — ${spec.mode} theme, base hue ${Math.round(spec.baseHue)}°, `
    + `text contrast ${contrast(out.text, out.panel).toFixed(1)}:1`
    + `${source === 'keywords' ? ' (from keywords)' : ''}.`;
  btn.disabled = false;
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
  b.addEventListener('click', () => {
    // The pad needs a real size before it can be drawn on, which it only has
    // once its panel is visible.
    if(b.dataset.sub === 'writing') setTimeout(() => { HwPad.mount(); HwPad.fit(); }, 60);
  });
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
  // Fields are rebuilt when the panel renders, so stored values are put back.
  ['tts-voice:ttsVoiceId','tts-model:ttsModelId','drive-client:driveClientId',
   'drive-folder:driveFolderId'].forEach(pair => {
    const [id, key] = pair.split(':');
    const el = document.getElementById(id);
    if(el && settings[key] != null) el.value = settings[key];
  });
  try{ buildRail(); reflowAgenda(); renderViewHead('agenda'); }catch(e){ console.warn('[rail]', e); }
  organiseSettings();
  renderVocab();
  Handwriting.load().then(renderHandwritingStatus);
  probeTts(); renderTtsStatus(); renderConfirmStatus(); renderAuditStatus(); renderProviderStatus(); renderAutoListen(); renderProactiveStatus(); renderMicSens(); renderBgListen(); renderPauseTol();
  Reflect_.run();
  Learn.load().then(renderLearnStats);
  Mail.restore().then(renderMailStatus);
  renderScreenKeep(); renderScreenStatus();
  bindPercent('humour-slider', 'humour-val', 'humour', 70);
  bindPercent('honesty-slider', 'honesty-val', 'honesty', 95);
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
      const out = await readJson(r);
      const d = out.json;
      if(!out.ok) return lines.push(`${name}: HTTP ${out.status}${d.code ? ' ' + d.code : ''}`);
      if(name === 'assistant') return lines.push(`assistant: ok — ${d.label || d.provider}`
        + ` / chat ${d.model || '?'}`
        + (d.toolModel && d.toolModel !== d.model ? ` / tools ${d.toolModel}` : '')
        + ((d.available || []).length ? ` (${(d.available || []).length} models)` : '')
        + ((d.blocked || []).length ? ` — ${d.blocked.length} model(s) temporarily blocked` : '')
        + (d.error ? ` — ${d.error}` : ''));
      if(name === 'search'){
        const keyed = [d.serper && 'Serper', d.tavily && 'Tavily', d.exa && 'Exa',
                       d.brave && 'Brave', d.google && 'Google'].filter(Boolean);
        return lines.push(`search: ok — active ${d.active}`
          + (keyed.length ? ` (keys: ${keyed.join(', ')})` : ' — no key set, using keyless fallback'));
      }
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
  if(!el || el._bound) return;
  el._bound = true;
  const cur = typeof settings[key] === 'number' ? settings[key] : def;
  el.value = cur; if(out) out.textContent = cur + '%';
  TARS[key] = cur;
  el.addEventListener('input', () => {
    const v = +el.value;
    settings[key] = v; TARS[key] = v; saveSettings();
    if(out) out.textContent = v + '%';
  });
}
// The sliders exist only after Settings renders, so apply the stored values to
// TARS directly at startup — otherwise the persona ran on its defaults until
// the panel happened to be opened.
TARS.humour  = typeof settings.humour  === 'number' ? settings.humour  : 70;
TARS.honesty = typeof settings.honesty === 'number' ? settings.honesty : 95;
bindPercent('humour-slider', 'humour-val', 'humour', 70);
bindPercent('honesty-slider', 'honesty-val', 'honesty', 95);

function bindSetting(id, key){
  const el = document.getElementById(id);
  if(!el) return;
  // Restore first. Without this the field renders empty, and the blur handler
  // below then writes that empty value over a perfectly good setting — so
  // merely opening Settings destroyed the voice and model IDs.
  if(settings[key] != null && el.value !== settings[key]) el.value = settings[key];
  const save = () => {
    const v = el.value.trim();
    // Blur on an untouched, empty field must not erase a stored value.
    if(v === '' && settings[key] && !el._touched) return;
    settings[key] = v;
    saveSettings();
    el.classList.add('saved');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('saved'), 900);
  };
  el.addEventListener('input', () => { el._touched = true; save(); });
  el.addEventListener('blur', save);
}
bindSetting('tts-voice', 'ttsVoiceId');
bindSetting('tts-model', 'ttsModelId');
['tts-voice','tts-model'].forEach(id => {
  const el = document.getElementById(id);
  el?.addEventListener('blur', () => {
    const w = ttsFieldWarning();
    const box = document.getElementById('tts-warn');
    if(box){ box.textContent = w.join(' '); box.style.display = w.length ? 'block' : 'none'; }
  });
});
// last resort: flush anything typed but not yet committed
window.addEventListener('beforeunload', () => { try{ saveSettings(); }catch(e){} });
document.getElementById('ai-reset')?.addEventListener('click', async () => {
  try{
    await fetch(FN_URL + "/agenda-ai", { method:'POST', headers: authHeaders(), body: JSON.stringify({ reset:true }) });
    providerCache = null;
    await renderProviderStatus();
    alert('Model blocklist cleared. If TARS said it had no tools, try again now.');
  }catch(e){ alert('Could not reach the assistant service.'); }
});
document.getElementById('vocab-save')?.addEventListener('click', () => {
  const el = document.getElementById('vocab-input');
  if(Vocab.add(el.value)){ el.value = ''; SFX.tick(); }
});
document.getElementById('vocab-input')?.addEventListener('keydown', e => {
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('vocab-save').click(); }
});
document.getElementById('tts-diag')?.addEventListener('click', async () => {
  const btn = document.getElementById('tts-diag');
  btn.disabled = true; btn.textContent = 'Checking…';
  const report = await voiceDiagnostics();
  btn.disabled = false; btn.textContent = 'Voice check';
  alert(report);
});
document.getElementById('tts-test')?.addEventListener('click', async () => {
  if(settings.voiceMuted){
    if(confirm('Replies are muted, which is why nothing is heard.\n\nUnmute now?')){
      settings.voiceMuted = false; saveSettings();
      const mb = document.getElementById('voice-mute');
      if(mb) mb.textContent = 'Mute replies';
      renderTtsStatus();
    } else return;
  }
  const warn = ttsFieldWarning();
  if(warn.length){ alert('Check these first:\n\n• ' + warn.join('\n• ')); return; }
  await probeTts(true);
  if(ttsConfigured === false){ alert('No ELEVENLABS_API_KEY is set on the server, so the browser voice is used.'); return; }
  ttsLastError = '';
  await speak(VOICE.lang.startsWith('pt') ? 'Sistemas prontos.' : 'Systems ready.', VOICE.lang);
  alert(`Spoke using: ${ttsLastEngine}`
    + (ttsLastError ? `\nReason for fallback: ${ttsLastError}` : '')
    + `\n\nVoice ID: ${settings.ttsVoiceId || '(server default ' + (ttsServerVoice || '?') + ')'}`
    + `\nModel ID: ${settings.ttsModelId || '(server default ' + (ttsServerModel || '?') + ')'}`);
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
  // Marks the document so the light-specific overrides above can apply.
  try{
    const t = (typeof THEMES !== 'undefined' && THEMES[key]) || null;
    document.documentElement.setAttribute('data-mode', t && t.mode === 'light' ? 'light' : 'dark');
  }catch(e){}

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
const NOTE_SECRETS = ['title', 'content', 'ink'];

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
let vaultFailed = false;
async function fetchVaultKey(){
  try{
    const r = await fetch(FN_URL + "/agenda-vault", { method: "POST", headers: authHeaders() });
    if(!r.ok) return false;
    const { key } = await r.json();
    if(!key) return false;
    cryptoKey = await crypto.subtle.importKey('raw', b64Buf(key),
                  { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
    settings.encOn = true; saveSettings();
    vaultFailed = false;
    return true;
  }catch(e){
    // Without the key every encrypted title renders as "locked", which looks
    // like corrupted data rather than a key that failed to load.
    vaultFailed = true;
    return false;
  }
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
  // Only the decorative animation pauses when hidden; voice keeps running.
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
  // A failed vault load is visible everywhere as locked titles, so say so.
  setTimeout(() => {
    if(vaultFailed || cases.some(x => String(x.titulo || '').includes('🔒'))){
      addProactiveMessage('I could not load the encryption key, so case titles show as locked. '
        + 'Open Settings and press Re-check under Encryption, or sign out and back in.');
    }
  }, 4000);
  pullSettings();
  Learn.load();
  Handwriting.load();
  Proactive.start();
  DueWatch.start();
  // Anything the scheduled scan found while the app was shut.
  Background.load().then(() => setTimeout(() => Background.feed(), 2500));
  Focus.load().then(() => {
    const pend = Focus.pending();
    if(pend.length){
      // Resumption comes from persisted state, never from invented memory.
      const f = pend[0];
      const left = (f.subtasks || []).filter(s => !s.done).length;
      addProactiveMessage(`Unfinished: ${f.label}`
        + (f.waiting_on ? ` — waiting on ${f.waiting_on}` : '')
        + (left ? `, ${left} step${left > 1 ? 's' : ''} remaining.` : '.'));
    }
  });
  TarsPresence.init();
}
bootApp();