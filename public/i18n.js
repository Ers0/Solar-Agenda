// ============================================================================
// Solar Agenda — Bilingual i18n Complete Engine (EN / PT-BR)
// Reactive UI translations, dynamic DOM localization, speech language sync
// ============================================================================

(function(window){
  'use strict';

  const STORAGE_KEY = 'solar_agenda_lang';

  // Supported languages: 'en' (English) | 'pt' (Português do Brasil)
  let currentLang = localStorage.getItem(STORAGE_KEY) || 'pt';

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
      'todays_cases': "Today's cases",
      'filter_all': 'All',
      'filter_urgent': 'Urgent',
      'filter_high': 'High',
      'filter_medium': 'Medium',
      'filter_low': 'Low',
      'filter_open': 'Open',
      'filter_done': 'Done',
      'filter_closed': 'Closed',

      // Dial legend
      'legend_urgent': 'urgent',
      'legend_high': 'high',
      'legend_normal': 'normal',
      'legend_done': 'done',
      'legend_now': 'now',
      'legend_first_hour': 'first hour',

      // History View
      'hist_filter_ph': 'Filter by title, client or ticket…',
      'hist_totals': 'Totals',
      'hist_resolution_rate': 'Resolution rate',
      'hist_recurring_faults': 'Recurring faults',
      'hist_by_manufacturer': 'By manufacturer',

      // Calendar View
      'cal_today': 'Today',
      'cal_select_day': 'Select a day',
      'cal_this_month': 'This month',
      'month_label': 'Month',

      // Galaxy View
      'clusters': 'Clusters',
      'galaxy_legend': 'Legend',
      'galaxy_entry': 'Entry',
      'galaxy_cluster_hub': 'Cluster hub',
      'galaxy_unlinked': 'Unlinked',
      'galaxy_link_between': 'Link between clusters',
      'galaxy_hint': 'drag · zoom · click to focus',
      'galaxy_empty': 'Nothing mapped yet — scan a folder of markdown notes to build the galaxy.',
      'galaxy_this_week': 'This week',
      'galaxy_focus_prefix': 'Focus: ',
      'galaxy_all_map': 'the whole map',
      'galaxy_clear_focus': 'Clear focus',
      'galaxy_live': 'TARS live ',
      'galaxy_since': 'today',
      'galaxy_all_time': 'all time',

      // SLA Hub View
      'sla_title': 'SLA HUB & HYPERFLOW VISION BRIDGE',
      'sla_desc': 'Real-time equipment telemetry, autonomous diagnostic intake & enterprise SLA governance',
      'sla_sub_title': 'Persistent Case Memory, Equipment Tracking & Service Level Control',
      'sla_btn_new': '+ New SLA Case',
      'sla_btn_bridge': '⚡ TARS Bridge Intake',
      'sla_btn_legacy': 'Legacy Notes',
      'sla_btn_refresh': 'Sync Live Data',
      'sla_stat_total_active': 'Total Active',
      'sla_stat_in_pipeline': 'Cases in pipeline',
      'sla_stat_on_time': 'On-Time SLA',
      'sla_stat_contract_compliance': 'Contractual compliance',
      'sla_stat_at_risk': 'At Risk',
      'sla_stat_at_risk_sub': '< 8h or < 50% left',
      'sla_stat_overdue': 'Overdue',
      'sla_stat_overdue_sub': 'SLA breached',
      'sla_stat_waiting_mfr': 'Waiting Mfr',
      'sla_stat_waiting_mfr_sub': 'Awaiting manufacturer',
      'sla_stat_waiting_cust': 'Waiting Customer',
      'sla_stat_waiting_cust_sub': 'Requested info/test',
      'sla_search_ph': 'Search by SN, Customer, Phone, Equipment, Jira protocol, Technician…',
      'sla_sort_urgency': 'Sort: Urgency / Deadline',
      'sla_sort_recent': 'Sort: Recently Updated',
      'sla_sort_created': 'Sort: Created Date',
      'sla_sort_priority': 'Sort: Priority',
      'sla_f_all': 'All Active',
      'sla_f_at_risk': '⚠️ At Risk / Overdue',
      'sla_f_pending_mfr': 'Pending Manufacturer Contact',
      'sla_f_waiting_mfr': 'Waiting Manufacturer',
      'sla_f_mfr_responded': 'Manufacturer Responded',
      'sla_f_waiting_cust': 'Waiting Customer',
      'sla_f_follow_up': 'Technical Follow-up',
      'sla_f_resolved': 'Resolved / Closed',
      'sla_breach_alert': 'CONTRACTUAL SLA ALERT:',
      'sla_breach_filter_btn': '⚡ Filter Critical Cases',

      // SLA Modal Subtabs
      'sla_tab_overview': '📋 Overview',
      'sla_tab_timeline': '⏱️ Timeline & History',
      'sla_tab_conversation': '💬 WhatsApp Messages',
      'sla_tab_notes': '📝 Notebooks',
      'sla_tab_equipment': '⚡ Equipment & SN',
      'sla_tab_protocols': '🎫 Jira & Protocols',
      'sla_tab_files': '📎 Files & Photos',
      'sla_tab_tars': '🧠 TARS Analysis',

      // Case Modal / Form Fields
      'case_modal_new_title': 'New case',
      'case_modal_edit_title': 'Edit case',
      'field_title': 'Title',
      'field_title_ph': 'Customer, equipment or symptom…',
      'field_client': 'Client / Installer',
      'field_client_ph': 'Customer or company name',
      'field_ticket': 'Ticket / Protocol',
      'field_ticket_ph': 'e.g. ADB-12345 or WhatsApp ID',
      'field_equipment': 'Equipment / Model',
      'field_equipment_ph': 'e.g. Deye SUN-5K-SG04LP1-EU',
      'field_status': 'Status',
      'field_priority': 'Priority',
      'field_time_block': 'Time block',
      'field_tags': 'Tags',
      'field_tags_ph': 'Add a tag, press Enter',
      'field_case_notes': 'Case notes',
      'field_notes_ph': 'Add a note about this case...',
      'btn_rephrase_ai': '✦ Rephrase with AI',
      'btn_add_to_history': '+ Add to history',
      'btn_email_case': '✉️ Email Case',
      'btn_delete': 'Delete',
      'btn_cancel': 'Cancel',
      'btn_save': 'Save',
      'btn_close': 'Close',

      // Time Blocks
      'block_first_hour': 'First hour',
      'block_morning': 'Morning',
      'block_afternoon': 'Afternoon',
      'block_end_of_day': 'End of day',

      // Case Statuses
      'status_aberto': 'Open',
      'status_em_andamento': 'In progress',
      'status_aguardando': 'Waiting',
      'status_resolvido': 'Resolved',

      // Settings Hubs & Tabs
      'set_search_ph': 'Search settings (e.g. SMTP, voice, model, contacts, backup)...',
      'set_tab_ai': 'AI & TARS',
      'set_tab_integrations': 'Integrations',
      'set_tab_knowledge': 'Knowledge',
      'set_tab_system': 'System',

      // Settings Cards & Fields
      'set_card_model_title': '🧠 Reasoning Model & Intelligence',
      'set_card_model_sub': 'Choose LLM provider, personality parameters, and tool audits',
      'set_reasoning_model': 'Reasoning model',
      'set_service_check': 'Service check',
      'set_tool_activity': 'Tool activity',
      'set_run_check': 'Run check',
      'set_view_log': 'View log',
      'set_reset_models': 'Reset models',
      'set_self_check': 'Self-check',
      'set_humour': 'Humour',
      'set_honesty': 'Honesty',
      'set_interruptions': 'Interruptions',
      'set_learned_exp': 'Learned experience',
      'set_confirm_actions': 'Confirm spoken actions',
      'set_desktop_alerts': 'Desktop alerts',

      'set_card_voice_title': '🎙️ Voice & Listening',
      'set_card_voice_sub': 'Microphone thresholds, hotword listening, custom vocabulary and ElevenLabs speech',
      'set_mic_sensitivity': 'Microphone sensitivity',
      'set_pause_tolerance': 'Pause tolerance',
      'set_always_listening': 'Always listening',
      'set_bg_listen': 'Listen in background tabs',
      'set_spoken_vocab': 'Spoken vocabulary',
      'set_speech_synth': 'TARS speech synthesis',
      'set_test_voice': 'Test voice',
      'set_voice_check': 'Voice check',

      'set_card_vision_title': '👁️ Vision & Screen Reading',
      'set_card_vision_sub': 'Window capture for inverter portals, technical diagrams, and diagnostic vision',
      'set_screen_reading': 'Screen reading',
      'set_share_window': 'Share a window',
      'set_check_vision': 'Check vision',
      'set_keep_sharing': 'Keep sharing between questions',

      'set_card_email_title': '✉️ Email Dispatcher (Gmail for Testing & Mailcorp)',
      'set_card_email_sub': 'Automated case summaries, technical reports, and inverter warranty emails',
      'set_save_credentials': 'Save Credentials',
      'set_verify_conn': 'Verify Connection',
      'set_send_test_email': 'Send Test Email',

      'set_card_jira_title': '📋 Atlassian Jira Cloud Integration',
      'set_card_jira_sub': 'Formal warranty claims, board dispatching (ADB, GABEF, AGH, CIDG), and issue synchronization',

      'set_card_security_title': '🔒 Security, Encryption & Profiles',
      'set_card_security_sub': 'AES-256-GCM client-side encryption and multi-profile workspace isolation',
      'set_enc_status': 'AES-256 Encryption status',
      'set_recheck': 'Re-check',
      'set_existing_records': 'Existing records',
      'set_encrypt_data': 'Encrypt existing data',
      'set_tech_profile': 'Technician profile',
      'set_create_profile': 'Create profile',

      'set_card_backup_title': '💾 Data Backup & Export',
      'set_card_backup_sub': 'Export your agenda cases, notebooks, technical logs, and JSON backups',

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
      'todays_cases': 'Casos de hoje',
      'filter_all': 'Todos',
      'filter_urgent': 'Urgente',
      'filter_high': 'Alta',
      'filter_medium': 'Média',
      'filter_low': 'Baixa',
      'filter_open': 'Abertos',
      'filter_done': 'Concluídos',
      'filter_closed': 'Resolvidos',

      // Dial legend
      'legend_urgent': 'urgente',
      'legend_high': 'alta',
      'legend_normal': 'normal',
      'legend_done': 'concluído',
      'legend_now': 'agora',
      'legend_first_hour': 'primeira hora',

      // History View
      'hist_filter_ph': 'Filtrar por título, cliente ou chamado…',
      'hist_totals': 'Totais',
      'hist_resolution_rate': 'Taxa de resolução',
      'hist_recurring_faults': 'Falhas recorrentes',
      'hist_by_manufacturer': 'Por fabricante',

      // Calendar View
      'cal_today': 'Hoje',
      'cal_select_day': 'Selecione um dia',
      'cal_this_month': 'Este mês',
      'month_label': 'Mês',

      // Galaxy View
      'clusters': 'Grupos',
      'galaxy_legend': 'Legenda',
      'galaxy_entry': 'Item',
      'galaxy_cluster_hub': 'Núcleo do grupo',
      'galaxy_unlinked': 'Não vinculado',
      'galaxy_link_between': 'Vínculo entre grupos',
      'galaxy_hint': 'arraste · zoom · clique para focar',
      'galaxy_empty': 'Nada mapeado ainda — analise uma pasta de notas markdown para construir a galáxia.',
      'galaxy_this_week': 'Esta semana',
      'galaxy_focus_prefix': 'Foco: ',
      'galaxy_all_map': 'o mapa inteiro',
      'galaxy_clear_focus': 'Limpar foco',
      'galaxy_live': 'TARS ao vivo ',
      'galaxy_since': 'hoje',
      'galaxy_all_time': 'todo período',

      // SLA Hub View
      'sla_title': 'HUB DE SLA & HYPERFLOW VISION BRIDGE',
      'sla_desc': 'Telemetria de equipamentos em tempo real, triagem diagnóstica e governança de SLA',
      'sla_sub_title': 'Memória Persistente de Casos, Rastreamento de Equipamento e Controle de Nível de Serviço',
      'sla_btn_new': '+ Novo Caso SLA',
      'sla_btn_bridge': '⚡ Entrada TARS Bridge',
      'sla_btn_legacy': 'Notas Legadas',
      'sla_btn_refresh': 'Sincronizar Dados',
      'sla_stat_total_active': 'Total Ativo',
      'sla_stat_in_pipeline': 'Casos em atendimento',
      'sla_stat_on_time': 'SLA no Prazo',
      'sla_stat_contract_compliance': 'Conformidade contratual',
      'sla_stat_at_risk': 'Em Risco',
      'sla_stat_at_risk_sub': '< 8h ou < 50% restante',
      'sla_stat_overdue': 'Vencidos / Estouro',
      'sla_stat_overdue_sub': 'SLA violado',
      'sla_stat_waiting_mfr': 'Aguardando Fabr.',
      'sla_stat_waiting_mfr_sub': 'Pendente fabricante',
      'sla_stat_waiting_cust': 'Aguardando Cliente',
      'sla_stat_waiting_cust_sub': 'Solicitado info/teste',
      'sla_search_ph': 'Buscar por NS, Cliente, Telefone, Equipamento, Protocolo Jira, Técnico…',
      'sla_sort_urgency': 'Ordenar: Urgência / Prazo',
      'sla_sort_recent': 'Ordenar: Atualizados Recentemente',
      'sla_sort_created': 'Ordenar: Data de Criação',
      'sla_sort_priority': 'Ordenar: Prioridade',
      'sla_f_all': 'Todos os Ativos',
      'sla_f_at_risk': '⚠️ Em Risco / Vencidos',
      'sla_f_pending_mfr': 'Pendente Contato Fabricante',
      'sla_f_waiting_mfr': 'Aguardando Fabricante',
      'sla_f_mfr_responded': 'Fabricante Respondeu',
      'sla_f_waiting_cust': 'Aguardando Cliente',
      'sla_f_follow_up': 'Acompanhamento Técnico',
      'sla_f_resolved': 'Resolvidos / Encerrados',
      'sla_breach_alert': 'ALERTA DE SLA CONTRATUAL:',
      'sla_breach_filter_btn': '⚡ Filtrar Casos Críticos',

      // SLA Modal Subtabs
      'sla_tab_overview': '📋 Visão Geral',
      'sla_tab_timeline': '⏱️ Linha do Tempo & Histórico',
      'sla_tab_conversation': '💬 Mensagens WhatsApp',
      'sla_tab_notes': '📝 Cadernos',
      'sla_tab_equipment': '⚡ Equipamento & NS',
      'sla_tab_protocols': '🎫 Jira & Protocolos',
      'sla_tab_files': '📎 Arquivos & Fotos',
      'sla_tab_tars': '🧠 Diagnóstico TARS',

      // Case Modal / Form Fields
      'case_modal_new_title': 'Novo caso',
      'case_modal_edit_title': 'Editar caso',
      'field_title': 'Título',
      'field_title_ph': 'Cliente, equipamento ou sintoma…',
      'field_client': 'Cliente / Instalador',
      'field_client_ph': 'Nome do cliente ou empresa',
      'field_ticket': 'Chamado / Protocolo',
      'field_ticket_ph': 'ex. ADB-12345 ou ID WhatsApp',
      'field_equipment': 'Equipamento / Modelo',
      'field_equipment_ph': 'ex. Deye SUN-5K-SG04LP1-EU',
      'field_status': 'Status',
      'field_priority': 'Prioridade',
      'field_time_block': 'Bloco de horário',
      'field_tags': 'Tags',
      'field_tags_ph': 'Adicione uma tag e tecle Enter',
      'field_case_notes': 'Notas do caso',
      'field_notes_ph': 'Adicione uma nota sobre este caso...',
      'btn_rephrase_ai': '✦ Reformular com IA',
      'btn_add_to_history': '+ Adicionar ao histórico',
      'btn_email_case': '✉️ Enviar por E-mail',
      'btn_delete': 'Excluir',
      'btn_cancel': 'Cancelar',
      'btn_save': 'Salvar',
      'btn_close': 'Fechar',

      // Time Blocks
      'block_first_hour': 'Primeira hora',
      'block_morning': 'Manhã',
      'block_afternoon': 'Tarde',
      'block_end_of_day': 'Fim do dia',

      // Case Statuses
      'status_aberto': 'Aberto',
      'status_em_andamento': 'Em andamento',
      'status_aguardando': 'Aguardando',
      'status_resolvido': 'Resolvido',

      // Settings Hubs & Tabs
      'set_search_ph': 'Buscar configurações (ex. SMTP, voz, modelo, contatos, backup)...',
      'set_tab_ai': 'IA & TARS',
      'set_tab_integrations': 'Integrações',
      'set_tab_knowledge': 'Conhecimento',
      'set_tab_system': 'Sistema',

      // Settings Cards & Fields
      'set_card_model_title': '🧠 Modelo de Raciocínio & Inteligência',
      'set_card_model_sub': 'Provedor de LLM, parâmetros de personalidade e auditoria de ferramentas',
      'set_reasoning_model': 'Modelo de raciocínio',
      'set_service_check': 'Verificação de serviço',
      'set_tool_activity': 'Atividade de ferramentas',
      'set_run_check': 'Executar teste',
      'set_view_log': 'Ver log',
      'set_reset_models': 'Resetar modelos',
      'set_self_check': 'Auto-diagnóstico',
      'set_humour': 'Humor',
      'set_honesty': 'Honestidade',
      'set_interruptions': 'Interrupções',
      'set_learned_exp': 'Experiência adquirida',
      'set_confirm_actions': 'Confirmar ações faladas',
      'set_desktop_alerts': 'Notificações de desktop',

      'set_card_voice_title': '🎙️ Voz & Audição',
      'set_card_voice_sub': 'Limiares de microfone, escuta de hotword, vocabulário customizado e síntese ElevenLabs',
      'set_mic_sensitivity': 'Sensibilidade do microfone',
      'set_pause_tolerance': 'Tolerância de pausa',
      'set_always_listening': 'Sempre ouvindo',
      'set_bg_listen': 'Ouvir em abas em segundo plano',
      'set_spoken_vocab': 'Vocabulário falado',
      'set_speech_synth': 'Síntese de voz do TARS',
      'set_test_voice': 'Testar voz',
      'set_voice_check': 'Verificar voz',

      'set_card_vision_title': '👁️ Visão & Leitura de Tela',
      'set_card_vision_sub': 'Captura de janelas de portais de inversores, esquemáticos e visão diagnóstica',
      'set_screen_reading': 'Leitura de tela',
      'set_share_window': 'Compartilhar janela',
      'set_check_vision': 'Verificar visão',
      'set_keep_sharing': 'Manter compartilhamento ativo entre perguntas',

      'set_card_email_title': '✉️ Disparador de E-mail (Gmail de Teste & Mailcorp)',
      'set_card_email_sub': 'Resumos de casos automatizados, laudos técnicos e acionamento de garantia',
      'set_save_credentials': 'Salvar Credenciais',
      'set_verify_conn': 'Verificar Conexão',
      'set_send_test_email': 'Enviar E-mail de Teste',

      'set_card_jira_title': '📋 Integração Atlassian Jira Cloud',
      'set_card_jira_sub': 'Abertura formal de garantia, encaminhamento de boards (ADB, GABEF, AGH, CIDG) e sincronização',

      'set_card_security_title': '🔒 Segurança, Criptografia & Perfis',
      'set_card_security_sub': 'Criptografia de ponta a ponta AES-256-GCM e isolamento de workspaces',
      'set_enc_status': 'Status da Criptografia AES-256',
      'set_recheck': 'Verificar novamente',
      'set_existing_records': 'Registros existentes',
      'set_encrypt_data': 'Criptografar dados existentes',
      'set_tech_profile': 'Perfil do técnico',
      'set_create_profile': 'Criar perfil',

      'set_card_backup_title': '💾 Backup de Dados & Exportação',
      'set_card_backup_sub': 'Exporte casos da agenda, cadernos, registros técnicos e backups JSON',

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

      if (typeof window.showToast === 'function') {
        window.showToast(this.t(lang === 'pt' ? 'lang_switched_pt' : 'lang_switched_en'));
      }
    },

    toggle() {
      this.setLang(currentLang === 'pt' ? 'en' : 'pt');
    },

    // Apply translations across all DOM elements throughout the app
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

      // 3. Topbar elements
      const tbSub = document.getElementById('tb-sub');
      if (tbSub) tbSub.textContent = this.t('tb_tagline');

      const gSearch = document.getElementById('global-search');
      if (gSearch) gSearch.placeholder = this.t('tb_search_placeholder');

      const tbNew = document.getElementById('tb-new-case');
      if (tbNew) tbNew.textContent = this.t('new_case_btn');

      // TARS status pill
      const tarsStatus = document.getElementById('tars-status');
      if (tarsStatus && tarsStatus.lastChild) {
        const isOffline = tarsStatus.classList.contains('offline');
        tarsStatus.lastChild.textContent = isOffline ? this.t('tars_offline') : this.t('tars_online');
      }

      // Rail navigation buttons
      document.querySelectorAll('#bottom-nav .bn-item, #app-rail .bn-item').forEach(btn => {
        const view = btn.dataset.view;
        const span = btn.querySelector('span');
        if (span && view) {
          span.textContent = this.t('nav_' + view, span.textContent);
        }
      });

      // Header controls
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

      // Weather panel
      const wxHeadTitle = document.querySelector('#weather-panel .wx-head .wx-title');
      if (wxHeadTitle) wxHeadTitle.textContent = this.t('weather_local');
      const wxBrazilTitle = document.querySelectorAll('#weather-panel .wx-head .wx-title')[1];
      if (wxBrazilTitle) wxBrazilTitle.textContent = this.t('weather_brazil');

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

      // Today's cases panel header
      const dayPanelH2 = document.querySelector('.day-panel-header h2');
      if (dayPanelH2) dayPanelH2.textContent = this.t('todays_cases');
      const addCaseBtn = document.getElementById('add-case-btn');
      if (addCaseBtn) addCaseBtn.textContent = this.t('new_case_btn');

      // Day filters
      const dfAll = document.querySelector('#day-filters [data-df="all"]');
      if (dfAll) dfAll.textContent = this.t('filter_all');
      const dfUrg = document.querySelector('#day-filters [data-df="urgente"]');
      if (dfUrg) dfUrg.textContent = this.t('filter_urgent');
      const dfOpen = document.querySelector('#day-filters [data-df="open"]');
      if (dfOpen) dfOpen.textContent = this.t('filter_open');
      const dfDone = document.querySelector('#day-filters [data-df="done"]');
      if (dfDone) dfDone.textContent = this.t('filter_done');

      // History filters & Search
      const hfAll = document.querySelector('#hist-filters [data-hf="all"]');
      if (hfAll) hfAll.textContent = this.t('filter_all');
      const hfUrg = document.querySelector('#hist-filters [data-hf="urgente"]');
      if (hfUrg) hfUrg.textContent = this.t('filter_urgent');
      const hfAlta = document.querySelector('#hist-filters [data-hf="alta"]');
      if (hfAlta) hfAlta.textContent = this.t('filter_high');
      const hfRes = document.querySelector('#hist-filters [data-hf="resolvido"]');
      if (hfRes) hfRes.textContent = this.t('filter_closed');
      const histSearch = document.getElementById('hist-search');
      if (histSearch) histSearch.placeholder = this.t('hist_filter_ph');

      // History side cards
      const histSideTitles = document.querySelectorAll('.hist-side .gs-title');
      if (histSideTitles[0]) histSideTitles[0].textContent = this.t('hist_totals');
      if (histSideTitles[1]) histSideTitles[1].textContent = this.t('hist_resolution_rate');
      if (histSideTitles[2]) histSideTitles[2].textContent = this.t('hist_recurring_faults');
      if (histSideTitles[3]) histSideTitles[3].textContent = this.t('hist_by_manufacturer');

      // Calendar controls
      const calTodayBtn = document.getElementById('cal-today');
      if (calTodayBtn) calTodayBtn.textContent = this.t('cal_today');
      const calDayTitle = document.getElementById('cal-day-title');
      if (calDayTitle && calDayTitle.textContent.includes('day') || calDayTitle && calDayTitle.textContent.includes('dia')) {
        calDayTitle.textContent = this.t('cal_select_day');
      }
      const calSideCards = document.querySelectorAll('.cal-side .gs-title');
      if (calSideCards[1]) calSideCards[1].textContent = this.t('cal_this_month');

      // Galaxy View
      const gxColLeftCards = document.querySelectorAll('.gx-col-left .gs-title');
      if (gxColLeftCards[0]) {
        const btn = document.getElementById('gx-new-cluster');
        gxColLeftCards[0].childNodes[0].textContent = this.t('clusters') + ' ';
      }
      if (gxColLeftCards[1]) gxColLeftCards[1].textContent = this.t('galaxy_legend');
      const gxLegend = document.querySelector('.gx-legend');
      if (gxLegend) {
        gxLegend.innerHTML = `
          <span><i class="lg-ring"></i>${this.t('galaxy_entry')}</span>
          <span><i class="lg-sun"></i>${this.t('galaxy_cluster_hub')}</span>
          <span><i class="lg-orphan"></i>${this.t('galaxy_unlinked')}</span>
          <span><i class="lg-line"></i>${this.t('galaxy_link_between')}</span>
        `;
      }
      const gxHint = document.querySelector('.galaxy-hint');
      if (gxHint) gxHint.textContent = this.t('galaxy_hint');
      const kbMapEmpty = document.getElementById('kb-map-empty');
      if (kbMapEmpty) kbMapEmpty.textContent = this.t('galaxy_empty');
      const gxClearFocus = document.getElementById('gx-clear-focus');
      if (gxClearFocus) gxClearFocus.textContent = this.t('galaxy_clear_focus');

      // Settings Search & Tabs
      const setSearch = document.getElementById('set-search-input');
      if (setSearch) setSearch.placeholder = this.t('set_search_ph');
      const subTabs = document.querySelectorAll('.sub-tabs .sub-tab');
      if (subTabs[0]) subTabs[0].textContent = this.t('set_tab_ai');
      if (subTabs[1]) subTabs[1].textContent = this.t('set_tab_integrations');
      if (subTabs[2]) subTabs[2].textContent = this.t('set_tab_knowledge');
      if (subTabs[3]) subTabs[3].textContent = this.t('set_tab_system');

      // Settings Card Titles
      const setCardTitles = document.querySelectorAll('.set-card-title');
      const setCardSubs = document.querySelectorAll('.set-card-sub');
      setCardTitles.forEach(t => {
        const txt = t.textContent || '';
        if (txt.includes('Reasoning Model') || txt.includes('Modelo de Raciocínio')) {
          t.innerHTML = this.t('set_card_model_title');
        } else if (txt.includes('Voice & Listening') || txt.includes('Voz & Audição')) {
          t.innerHTML = this.t('set_card_voice_title');
        } else if (txt.includes('Vision & Screen') || txt.includes('Visão & Leitura')) {
          t.innerHTML = this.t('set_card_vision_title');
        } else if (txt.includes('Email Dispatcher') || txt.includes('Disparador de E-mail')) {
          t.innerHTML = this.t('set_card_email_title');
        } else if (txt.includes('Atlassian Jira') || txt.includes('Jira Cloud')) {
          t.innerHTML = this.t('set_card_jira_title');
        } else if (txt.includes('Security, Encryption') || txt.includes('Segurança, Criptografia')) {
          t.innerHTML = this.t('set_card_security_title');
        } else if (txt.includes('Data Backup') || txt.includes('Backup de Dados')) {
          t.innerHTML = this.t('set_card_backup_title');
        }
      });

      // Settings Common Buttons
      const aiReset = document.getElementById('ai-reset');
      if (aiReset) aiReset.textContent = this.t('set_reset_models');
      const selfCheck = document.getElementById('self-check');
      if (selfCheck) selfCheck.textContent = this.t('set_self_check');
      const diagRun = document.getElementById('diag-run');
      if (diagRun) diagRun.textContent = this.t('set_run_check');
      const auditShow = document.getElementById('audit-show');
      if (auditShow) auditShow.textContent = this.t('set_view_log');
      const ttsTest = document.getElementById('tts-test');
      if (ttsTest) ttsTest.textContent = this.t('set_test_voice');
      const ttsDiag = document.getElementById('tts-diag');
      if (ttsDiag) ttsDiag.textContent = this.t('set_voice_check');
      const screenShare = document.getElementById('screen-share');
      if (screenShare) screenShare.textContent = this.t('set_share_window');
      const visionTest = document.getElementById('vision-test');
      if (visionTest) visionTest.textContent = this.t('set_check_vision');
      const smtpSaveBtn = document.getElementById('smtp-save-btn');
      if (smtpSaveBtn) smtpSaveBtn.textContent = this.t('set_save_credentials');
      const smtpTestBtn = document.getElementById('smtp-test-btn');
      if (smtpTestBtn) smtpTestBtn.textContent = this.t('set_verify_conn');
      const smtpSendTestBtn = document.getElementById('smtp-send-test-btn');
      if (smtpSendTestBtn) smtpSendTestBtn.textContent = this.t('set_send_test_email');
      const encRefresh = document.getElementById('enc-refresh');
      if (encRefresh) encRefresh.textContent = this.t('set_recheck');
      const encMigrate = document.getElementById('enc-migrate');
      if (encMigrate) encMigrate.textContent = this.t('set_encrypt_data');
      const profileNew = document.getElementById('profile-new');
      if (profileNew) profileNew.textContent = this.t('set_create_profile');

      // SLA Hub View Elements
      const slaH2 = document.querySelector('.sla-heading h2');
      if (slaH2) {
        slaH2.innerHTML = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--amber)" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="11" r="3"/><path d="M12 10v2l1 1"/></svg>
          ${this.t('sla_hub')}
        `;
      }
      const slaHeadP = document.querySelector('.sla-heading p');
      if (slaHeadP) slaHeadP.textContent = this.t('sla_sub_title');
      const slaNewBtn = document.getElementById('sla-new-btn');
      if (slaNewBtn) {
        slaNewBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> ${this.t('sla_btn_new')}`;
      }
      const slaBridgeBtn = document.getElementById('sla-bridge-intake-btn');
      if (slaBridgeBtn) {
        slaBridgeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg> ${this.t('sla_btn_bridge')}`;
      }
      const slaLegacyBtn = document.getElementById('sla-legacy-notes-btn');
      if (slaLegacyBtn) {
        slaLegacyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> ${this.t('sla_btn_legacy')}`;
      }

      // SLA Stat Cards Labels
      const slaStatCards = document.querySelectorAll('.sla-stat-card');
      if (slaStatCards[0]) {
        const lbl = slaStatCards[0].querySelector('.sla-stat-label');
        const sub = slaStatCards[0].querySelector('.sla-stat-sub');
        if (lbl) lbl.textContent = this.t('sla_stat_total_active');
        if (sub) sub.textContent = this.t('sla_stat_in_pipeline');
      }
      if (slaStatCards[1]) {
        const lbl = slaStatCards[1].querySelector('.sla-stat-label');
        const sub = slaStatCards[1].querySelector('.sla-stat-sub');
        if (lbl) lbl.innerHTML = `<span class="dotmark" style="background:#4ade80"></span> ${this.t('sla_stat_on_time')}`;
        if (sub) sub.textContent = this.t('sla_stat_contract_compliance');
      }
      if (slaStatCards[2]) {
        const lbl = slaStatCards[2].querySelector('.sla-stat-label');
        const sub = slaStatCards[2].querySelector('.sla-stat-sub');
        if (lbl) lbl.innerHTML = `<span class="dotmark" style="background:#facc15"></span> ${this.t('sla_stat_at_risk')}`;
        if (sub) sub.textContent = this.t('sla_stat_at_risk_sub');
      }
      if (slaStatCards[3]) {
        const lbl = slaStatCards[3].querySelector('.sla-stat-label');
        const sub = slaStatCards[3].querySelector('.sla-stat-sub');
        if (lbl) lbl.innerHTML = `<span class="dotmark" style="background:#f87171"></span> ${this.t('sla_stat_overdue')}`;
        if (sub) sub.textContent = this.t('sla_stat_overdue_sub');
      }
      if (slaStatCards[4]) {
        const lbl = slaStatCards[4].querySelector('.sla-stat-label');
        const sub = slaStatCards[4].querySelector('.sla-stat-sub');
        if (lbl) lbl.innerHTML = `<span class="dotmark" style="background:#fb923c"></span> ${this.t('sla_stat_waiting_mfr')}`;
        if (sub) sub.textContent = this.t('sla_stat_waiting_mfr_sub');
      }
      if (slaStatCards[5]) {
        const lbl = slaStatCards[5].querySelector('.sla-stat-label');
        const sub = slaStatCards[5].querySelector('.sla-stat-sub');
        if (lbl) lbl.innerHTML = `<span class="dotmark" style="background:#fde047"></span> ${this.t('sla_stat_waiting_cust')}`;
        if (sub) sub.textContent = this.t('sla_stat_waiting_cust_sub');
      }

      // SLA Filters row
      const slaSearch = document.getElementById('sla-search-input');
      if (slaSearch) slaSearch.placeholder = this.t('sla_search_ph');

      const slaSortSel = document.getElementById('sla-sort-select');
      if (slaSortSel && slaSortSel.options.length >= 4) {
        slaSortSel.options[0].text = this.t('sla_sort_urgency');
        slaSortSel.options[1].text = this.t('sla_sort_recent');
        slaSortSel.options[2].text = this.t('sla_sort_created');
        slaSortSel.options[3].text = this.t('sla_sort_priority');
      }

      const fPills = document.querySelectorAll('.sla-filters-row .sla-f-pill');
      if (fPills[0]) fPills[0].textContent = this.t('sla_f_all');
      if (fPills[1]) fPills[1].textContent = this.t('sla_f_at_risk');
      if (fPills[2]) fPills[2].textContent = this.t('sla_f_pending_mfr');
      if (fPills[3]) fPills[3].textContent = this.t('sla_f_waiting_mfr');
      if (fPills[4]) fPills[4].textContent = this.t('sla_f_mfr_responded');
      if (fPills[5]) fPills[5].textContent = this.t('sla_f_waiting_cust');
      if (fPills[6]) fPills[6].textContent = this.t('sla_f_follow_up');
      if (fPills[7]) fPills[7].textContent = this.t('sla_f_resolved');

      // SLA Breach Alert Filter Button
      const slaBreachBtn = document.getElementById('sla-breach-filter-btn');
      if (slaBreachBtn) slaBreachBtn.textContent = this.t('sla_breach_filter_btn');

      // Case Modal Labels & Inputs
      const fTitulo = document.getElementById('f-titulo');
      if (fTitulo) fTitulo.placeholder = this.t('field_title_ph');
      const fCliente = document.getElementById('f-cliente');
      if (fCliente) fCliente.placeholder = this.t('field_client_ph');
      const fChamado = document.getElementById('f-chamado');
      if (fChamado) fChamado.placeholder = this.t('field_ticket_ph');
      const fEquip = document.getElementById('f-equipamento');
      if (fEquip) fEquip.placeholder = this.t('field_equipment_ph');
      const fTags = document.getElementById('f-tags-input');
      if (fTags) fTags.placeholder = this.t('field_tags_ph');
      const fNotas = document.getElementById('f-notas');
      if (fNotas) fNotas.placeholder = this.t('field_notes_ph');

      const reformularBtn = document.getElementById('reformular-btn');
      if (reformularBtn) reformularBtn.textContent = this.t('btn_rephrase_ai');
      const addNoteEntryBtn = document.getElementById('add-note-entry-btn');
      if (addNoteEntryBtn) addNoteEntryBtn.textContent = this.t('btn_add_to_history');
      const deleteBtn = document.getElementById('delete-btn');
      if (deleteBtn) deleteBtn.textContent = this.t('btn_delete');
      const emailCaseBtn = document.getElementById('email-case-btn');
      if (emailCaseBtn) emailCaseBtn.textContent = this.t('btn_email_case');
      const cancelBtn = document.getElementById('cancel-btn');
      if (cancelBtn) cancelBtn.textContent = this.t('btn_cancel');
      const saveBtn = document.getElementById('save-btn');
      if (saveBtn) saveBtn.textContent = this.t('btn_save');

      // Priority options in modal
      const fPrioPanel = document.getElementById('f-prioridade-panel');
      if (fPrioPanel) {
        const opts = fPrioPanel.querySelectorAll('.select-option');
        if (opts[0]) opts[0].textContent = this.t('filter_urgent');
        if (opts[1]) opts[1].textContent = this.t('filter_high');
        if (opts[2]) opts[2].textContent = this.t('filter_medium');
        if (opts[3]) opts[3].textContent = this.t('filter_low');
      }

      // Time block options in modal
      const fBlocoPanel = document.getElementById('f-bloco-panel');
      if (fBlocoPanel) {
        const opts = fBlocoPanel.querySelectorAll('.select-option');
        if (opts[0]) opts[0].textContent = this.t('block_first_hour');
        if (opts[1]) opts[1].textContent = this.t('block_morning');
        if (opts[2]) opts[2].textContent = this.t('block_afternoon');
        if (opts[3]) opts[3].textContent = this.t('block_end_of_day');
      }

      // Modal field labels
      document.querySelectorAll('#case-modal .field label').forEach(lbl => {
        const t = (lbl.textContent || '').trim().toLowerCase();
        if (t === 'title' || t === 'título') lbl.textContent = this.t('field_title');
        else if (t === 'client' || t === 'cliente' || t === 'client / installer' || t === 'cliente / instalador') lbl.textContent = this.t('field_client');
        else if (t === 'ticket' || t === 'chamado' || t === 'ticket / protocol' || t === 'chamado / protocolo') lbl.textContent = this.t('field_ticket');
        else if (t === 'equipment' || t === 'equipamento' || t === 'equipment / model' || t === 'equipamento / modelo') lbl.textContent = this.t('field_equipment');
        else if (t === 'status') lbl.textContent = this.t('field_status');
        else if (t === 'priority' || t === 'prioridade') lbl.textContent = this.t('field_priority');
        else if (t === 'time block' || t === 'bloco de horário' || t === 'bloco') lbl.textContent = this.t('field_time_block');
        else if (t === 'tags') lbl.textContent = this.t('field_tags');
        else if (t === 'case notes' || t === 'notas do caso') lbl.textContent = this.t('field_case_notes');
      });

      // Re-render topbar heading if function available
      if (typeof window.renderTopbarHead === 'function') {
        const activeNav = document.querySelector('.bn-item.active');
        if (activeNav && activeNav.dataset.view) {
          window.renderTopbarHead(activeNav.dataset.view);
        }
      }

      // Re-render SLA Hub cards & stats if initialized
      if (window.SLAHub && typeof window.SLAHub.renderSLACasesGrid === 'function') {
        try {
          window.SLAHub.renderSLACasesGrid();
        } catch(e){}
      }
      if (window.SLAHub && typeof window.SLAHub.updateSLAStats === 'function') {
        try {
          window.SLAHub.updateSLAStats();
        } catch(e){}
      }

      // Re-render day blocks if on Agenda view
      if (typeof window.renderBlocks === 'function') {
        try { window.renderBlocks(); } catch(e){}
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => I18n.init());
  } else {
    I18n.init();
  }

})(window);
