// ============================================================================
// Solar Agenda — Bilingual i18n Engine (EN / PT-BR)
// Reactive UI translations, speech language synchronization and locale formatting
// ============================================================================

(function(window){
  'use strict';

  const STORAGE_KEY = 'solar_agenda_lang';

  // Supported languages: 'en' (English) | 'pt' (Português do Brasil)
  let currentLang = localStorage.getItem(STORAGE_KEY) || 'pt'; // default to PT for Solar Brazil context, togglable to EN

  const DICTIONARY = {
    en: {
      // Topbar & Navigation
      'tb_tagline': 'Support routine — from the first hour to end of day',
      'tb_search_placeholder': 'Search cases, notes or knowledge…',
      'tars_online': 'TARS online',
      'tars_offline': 'TARS offline',
      'new_case_btn': '+ New case',
      'nav_agenda': 'Agenda',
      'nav_history': 'History',
      'nav_calendar': 'Calendar',
      'nav_sla': 'SLA',
      'nav_galaxy': 'Galaxy',
      'nav_settings': 'Settings',
      'nav_notebooks': 'Notebooks',
      'sign_out': 'Sign out',
      'hud': 'HUD',
      'theme': 'Theme',
      'voice': 'Voice',
      'assistant': 'Assistant',

      // Views Header
      'your_day': 'Your day',
      'case_history': 'Case history',
      'calendar': 'Calendar',
      'sla_hub': 'SLA Hub',
      'notebooks': 'Notebooks',
      'galaxy': 'Knowledge galaxy',
      'settings': 'Settings',

      // Subtitles
      'sub_support_routine': 'SUPPORT ROUTINE',
      'sub_closed_records': 'CLOSED RECORDS',
      'sub_active_cases': 'ACTIVE CASES · PERSISTENT CONTROL LAYER',
      'sub_knowledge_entries': 'ENTRIES · SHARED BASE',
      'sub_settings': 'ASSISTANT · VOICE · WRITING · KNOWLEDGE · DATA',

      // Agenda Panels
      'first_hour': 'First hour',
      'priority': 'priority',
      'first_hour_hint': 'Urgent and high priority only — everything else waits.',
      'tars_suggests': 'TARS suggests',
      'weather_local': 'Vinhedo today',
      'weather_brazil': 'Roughest in Brazil',
      'forecast_loading': 'loading forecast…',
      'day': 'DAY',
      'night': 'NIGHT',

      // Dial legend
      'legend_urgent': 'urgent',
      'legend_high': 'high',
      'legend_normal': 'normal',
      'legend_done': 'done',
      'legend_now': 'now',
      'legend_first_hour': 'first hour',

      // SLA Hub
      'sla_title': 'SLA HUB & HYPERFLOW VISION BRIDGE',
      'sla_desc': 'Real-time equipment telemetry, autonomous diagnostic intake & enterprise SLA governance',
      'sla_tab_all': 'All Cases',
      'sla_tab_active': 'Active',
      'sla_tab_urgent': 'Urgent / At Risk',
      'sla_tab_mfr': 'Waiting Manufacturer',
      'sla_tab_resolved': 'Resolved',
      'sla_stat_active': 'Active SLA Cases',
      'sla_stat_risk': 'Critical / In Danger',
      'sla_stat_compliance': 'Global SLA Health',
      'sla_stat_mfr': 'Pending Manufacturer',
      'sla_btn_new': '+ New SLA Case',
      'sla_btn_refresh': 'Sync Live Data',

      // Lang switcher labels
      'lang_switched_en': 'Language set to English',
      'lang_switched_pt': 'Idioma alterado para Português (Brasil)'
    },
    pt: {
      // Topbar & Navigation
      'tb_tagline': 'Rotina de suporte — da primeira hora ao fim do dia',
      'tb_search_placeholder': 'Buscar casos, notas ou conhecimento…',
      'tars_online': 'TARS online',
      'tars_offline': 'TARS offline',
      'new_case_btn': '+ Novo caso',
      'nav_agenda': 'Agenda',
      'nav_history': 'Histórico',
      'nav_calendar': 'Calendário',
      'nav_sla': 'SLA',
      'nav_galaxy': 'Galáxia',
      'nav_settings': 'Ajustes',
      'nav_notebooks': 'Cadernos',
      'sign_out': 'Sair',
      'hud': 'HUD',
      'theme': 'Tema',
      'voice': 'Voz',
      'assistant': 'Assistente',

      // Views Header
      'your_day': 'Seu dia',
      'case_history': 'Histórico de casos',
      'calendar': 'Calendário',
      'sla_hub': 'Hub de SLA',
      'notebooks': 'Cadernos',
      'galaxy': 'Galáxia de conhecimento',
      'settings': 'Ajustes',

      // Subtitles
      'sub_support_routine': 'ROTINA DE SUPORTE',
      'sub_closed_records': 'REGISTROS RESOLVIDOS',
      'sub_active_cases': 'CASOS ATIVOS · CAMADA DE CONTROLE PERSISTENTE',
      'sub_knowledge_entries': 'ENTRADAS · BASE COMPARTILHADA',
      'sub_settings': 'ASSISTENTE · VOZ · ESCRITA · CONHECIMENTO · DADOS',

      // Agenda Panels
      'first_hour': 'Primeira hora',
      'priority': 'prioridade',
      'first_hour_hint': 'Apenas urgente e alta prioridade — o restante aguarda.',
      'tars_suggests': 'Sugestões do TARS',
      'weather_local': 'Vinhedo hoje',
      'weather_brazil': 'Mais severo no Brasil',
      'forecast_loading': 'carregando previsão…',
      'day': 'DIA',
      'night': 'NOITE',

      // Dial legend
      'legend_urgent': 'urgente',
      'legend_high': 'alta',
      'legend_normal': 'normal',
      'legend_done': 'concluído',
      'legend_now': 'agora',
      'legend_first_hour': 'primeira hora',

      // SLA Hub
      'sla_title': 'HUB DE SLA & HYPERFLOW VISION BRIDGE',
      'sla_desc': 'Telemetria de equipamentos em tempo real, triagem diagnóstica e governança de SLA',
      'sla_tab_all': 'Todos os Casos',
      'sla_tab_active': 'Ativos',
      'sla_tab_urgent': 'Urgentes / Em Risco',
      'sla_tab_mfr': 'Aguardando Fabricante',
      'sla_tab_resolved': 'Resolvidos',
      'sla_stat_active': 'Casos de SLA Ativos',
      'sla_stat_risk': 'Críticos / Em Risco',
      'sla_stat_compliance': 'Saúde Global de SLA',
      'sla_stat_mfr': 'Pendentes com Fabricante',
      'sla_btn_new': '+ Novo Caso SLA',
      'sla_btn_refresh': 'Sincronizar Dados',

      // Lang switcher labels
      'lang_switched_en': 'Language set to English',
      'lang_switched_pt': 'Idioma alterado para Português (Brasil)'
    }
  };

  const I18n = {
    get lang() {
      return currentLang;
    },

    t(key, fallback = '') {
      const dict = DICTIONARY[currentLang] || DICTIONARY.en;
      return dict[key] || DICTIONARY.en[key] || fallback || key;
    },

    setLang(lang) {
      if (lang !== 'en' && lang !== 'pt') return;
      currentLang = lang;
      try { localStorage.setItem(STORAGE_KEY, lang); } catch(e){}

      // Sync speech synthesizer & voice state if available
      if (window.VOICE) {
        window.VOICE.lang = lang === 'pt' ? 'pt-BR' : 'en-US';
      }

      this.apply();
      this.updateSwitcherUI();

      // Notify user via toast / notification if function exists
      if (typeof window.showToast === 'function') {
        window.showToast(this.t(lang === 'pt' ? 'lang_switched_pt' : 'lang_switched_en'));
      }
    },

    toggle() {
      this.setLang(currentLang === 'pt' ? 'en' : 'pt');
    },

    // Apply translations across DOM elements with data-i18n or specific known IDs
    apply() {
      const isPt = currentLang === 'pt';

      // 1. Static text mapped via [data-i18n]
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const k = el.getAttribute('data-i18n');
        if (k) el.textContent = this.t(k, el.textContent);
      });

      // 2. Placeholders mapped via [data-i18n-ph]
      document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        const k = el.getAttribute('data-i18n-ph');
        if (k) el.setAttribute('placeholder', this.t(k, el.getAttribute('placeholder') || ''));
      });

      // 3. Specific App Elements
      const tbSub = document.getElementById('tb-sub');
      if (tbSub) tbSub.textContent = this.t('tb_tagline');

      const gSearch = document.getElementById('global-search');
      if (gSearch) gSearch.placeholder = this.t('tb_search_placeholder');

      const tbNew = document.getElementById('tb-new-case');
      if (tbNew) tbNew.textContent = this.t('new_case_btn');

      // TARS status pill text
      const tarsStatus = document.getElementById('tars-status');
      if (tarsStatus && tarsStatus.lastChild) {
        const isOffline = tarsStatus.classList.contains('offline');
        tarsStatus.lastChild.textContent = isOffline ? this.t('tars_offline') : this.t('tars_online');
      }

      // Rail navigation items
      document.querySelectorAll('#bottom-nav .bn-item, #app-rail .bn-item').forEach(btn => {
        const view = btn.dataset.view;
        const span = btn.querySelector('span');
        if (span && view) {
          span.textContent = this.t('nav_' + view, span.textContent);
        }
      });

      // Topbar buttons text
      const hudToggle = document.getElementById('hud-toggle');
      if (hudToggle && hudToggle.querySelector('.btn-lab')) hudToggle.querySelector('.btn-lab').textContent = this.t('hud');
      const themeToggle = document.getElementById('theme-toggle');
      if (themeToggle && themeToggle.querySelector('.btn-lab')) themeToggle.querySelector('.btn-lab').textContent = this.t('theme');
      const voiceToggle = document.getElementById('voice-toggle');
      if (voiceToggle && voiceToggle.querySelector('.btn-lab')) voiceToggle.querySelector('.btn-lab').textContent = this.t('voice');
      const aiToggle = document.getElementById('ai-toggle');
      if (aiToggle && aiToggle.querySelector('.btn-lab')) aiToggle.querySelector('.btn-lab').textContent = this.t('assistant');
      const logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn && logoutBtn.querySelector('.btn-lab')) logoutBtn.querySelector('.btn-lab').textContent = this.t('sign_out');

      // First hour panel
      const fhPanel = document.querySelector('.first-hour-panel h2');
      if (fhPanel) {
        fhPanel.innerHTML = `${this.t('first_hour')} <span class="badge">${this.t('priority')}</span>`;
      }
      const fhHint = document.querySelector('.first-hour-panel .hint');
      if (fhHint) fhHint.textContent = this.t('first_hour_hint');

      const sgTitle = document.querySelector('.suggest-panel .sg-title');
      if (sgTitle) sgTitle.textContent = this.t('tars_suggests');

      // Dial legend
      const dialLegend = document.querySelector('.dial-legend');
      if (dialLegend) {
        dialLegend.innerHTML = `
          <span><i style="background:var(--urgente)"></i>${this.t('legend_urgent')}</span>
          <span><i style="background:var(--alta)"></i>${this.t('legend_high')}</span>
          <span><i style="background:var(--media)"></i>${this.t('legend_normal')}</span>
          <span><i style="background:var(--ok)"></i>${this.t('legend_done')}</span>
          <span><i class="lg-now"></i>${this.t('legend_now')}</span>
          <span><i class="lg-fh"></i>${this.t('legend_first_hour')}</span>
        `;
      }

      // Re-render topbar heading if function available
      if (typeof window.renderTopbarHead === 'function') {
        const activeNav = document.querySelector('.bn-item.active');
        if (activeNav && activeNav.dataset.view) {
          window.renderTopbarHead(activeNav.dataset.view);
        }
      }

      // Refresh SLA Hub UI text if open
      if (window.SLAHub && typeof window.SLAHub.renderHeaderStats === 'function') {
        window.SLAHub.renderHeaderStats();
      }
    },

    updateSwitcherUI() {
      const toggleBtn = document.getElementById('lang-toggle-btn');
      if (!toggleBtn) return;
      const isPt = currentLang === 'pt';
      
      toggleBtn.title = isPt ? 'Idioma: Português (Clique para mudar para English)' : 'Language: English (Click to switch to Portuguese)';
      
      const usOpt = toggleBtn.querySelector('.lang-opt-us');
      const brOpt = toggleBtn.querySelector('.lang-opt-br');
      if (usOpt && brOpt) {
        usOpt.classList.toggle('active', !isPt);
        brOpt.classList.toggle('active', isPt);
      }
    },

    init() {
      this.apply();
      this.updateSwitcherUI();
      
      const toggleBtn = document.getElementById('lang-toggle-btn');
      if (toggleBtn && !toggleBtn._bound) {
        toggleBtn._bound = true;
        toggleBtn.addEventListener('click', () => {
          this.toggle();
        });
      }
    }
  };

  window.I18n = I18n;

  // Auto-init on DOMContentLoaded or immediate if DOM is already ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => I18n.init());
  } else {
    I18n.init();
  }

})(window);
