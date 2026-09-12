// ============================================================================
// SLA HUB — Persistent Case Memory, Equipment Tracking & Control Layer
// Solar Agenda — Enterprise Support Routine
// ============================================================================

(function(window){
  'use strict';

  // 12 Lifecycle Stages
  const SLA_STAGES = [
    { key: 'NEW', label: 'New Case', cat: 'us', desc: 'Case received, awaiting triage' },
    { key: 'TRIAGE / ANALYSIS', label: 'Triage / Analysis', cat: 'us', desc: 'Technical evaluation in progress' },
    { key: 'PENDING MANUFACTURER CONTACT', label: 'Pending Mfr Contact', cat: 'us', desc: 'Need to contact inverter/equipment manufacturer' },
    { key: 'WAITING MANUFACTURER RESPONSE', label: 'Waiting Mfr Response', cat: 'mfr', desc: 'Waiting for manufacturer response or RMA decision' },
    { key: 'MANUFACTURER RESPONDED', label: 'Manufacturer Responded', cat: 'us', desc: 'Manufacturer responded; action needed by us' },
    { key: 'WAITING CUSTOMER INFO / TEST', label: 'Waiting Customer Info/Test', cat: 'cust', desc: 'Requested tests, photos, or measurements from customer' },
    { key: 'CUSTOMER RESPONDED', label: 'Customer Responded', cat: 'us', desc: 'Customer sent photos/measurements; review needed' },
    { key: 'SCHEDULED VISIT / PAC', label: 'Scheduled Visit / PAC', cat: 'us', desc: 'Field visit or technical inspection scheduled' },
    { key: 'TECHNICAL FOLLOW-UP', label: 'Technical Follow-up', cat: 'us', desc: 'Under observation / parameter monitoring' },
    { key: 'RESOLVED', label: 'Resolved', cat: 'done', desc: 'Technical problem solved, equipment operating' },
    { key: 'CLOSED', label: 'Closed', cat: 'done', desc: 'Formally closed with customer and manufacturer' },
    { key: 'CANCELED', label: 'Canceled', cat: 'done', desc: 'Canceled or duplicate case' }
  ];

  const PRIORITY_HOURS = {
    urgente: 12,
    alta: 24,
    media: 48,
    baixa: 72
  };

  // State
  let slaCases = [];
  let currentSLACase = null;
  let slaFilter = 'all';
  let slaSort = 'urgency';
  let slaSearchQuery = '';

  // Expose global store
  window.slaCases = slaCases;

  // ============================================================================
  // SERIAL NUMBER (SN) EXTRACTION & DISAMBIGUATION ENGINE
  // ============================================================================
  const SNEngine = {
    // Known manufacturer patterns
    MFR_PATTERNS: {
      Deye: {
        regex: /\b(2[0-9]{11,13})\b/g, // e.g. 230123456789 (12-14 digits starting with 2x)
        desc: 'Deye Inverters / Microinverters (12-14 digits, typically starting with 20-24)'
      },
      FoxESS: {
        regex: /\b([0-9A-Z]{12,16})\b/g, // e.g. 102030405060, FA1020304050
        desc: 'FoxESS Inverters (12-16 alphanumeric)'
      },
      Huawei: {
        regex: /\b(2101[0-9A-Z]{12}|01E[0-9A-Z]{13}|[0-9A-Z]{16,20})\b/gi,
        desc: 'Huawei FusionSolar Inverters (16-20 alphanumeric, often starting 2101 or 01E)'
      },
      Solis: {
        regex: /\b([0-9]{11,16})\b/g,
        desc: 'Solis Inverters (11-16 digits)'
      },
      Growatt: {
        regex: /\b([A-Z0-9]{10,14})\b/gi,
        desc: 'Growatt Inverters (10-14 alphanumeric)'
      },
      Hoymiles: {
        regex: /\b(1[0-9]{11,13})\b/g, // e.g. 112182049581
        desc: 'Hoymiles Microinverters (12-14 digits starting with 1x)'
      },
      Sungrow: {
        regex: /\b(B[0-9]{10,14}|[A-Z0-9]{12,16})\b/gi,
        desc: 'Sungrow Inverters (12-16 alphanumeric)'
      }
    },

    // Check if token is a false positive (CEP, CPF, Phone, Date, Protocol)
    isFalsePositive(token, textBefore, textAfter) {
      const clean = token.replace(/[-.\s]/g, '');
      const context = (textBefore + ' ' + textAfter).toLowerCase();

      // Check CPF (11 digits or labeled)
      if (context.includes('cpf') || context.includes('doc:')) return true;
      if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(token)) return true;

      // Check CEP (8 digits or labeled)
      if (context.includes('cep') || /^\d{5}-?\d{3}$/.test(token)) return true;

      // Check Brazilian Phone (10-11 digits starting with valid DDD 11-99)
      if (context.includes('tel') || context.includes('fone') || context.includes('cel') || context.includes('zap') || context.includes('whatsapp')) {
        if (/^\+?55?\d{10,11}$/.test(clean) || /^\d{10,11}$/.test(clean)) return true;
      }

      // Check Jira Protocol or ticket (e.g. ADB-123456)
      if (/^(ADB|GABEF|AGH|CIDG)-\d+$/i.test(token)) return true;

      // Check Date formats
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(token) || /^\d{4}-\d{2}-\d{2}$/.test(token)) return true;

      // Check pure hex color or HTML entities
      if (/^#[0-9A-Fa-f]{6}$/.test(token)) return true;

      return false;
    },

    // Extract candidates with contextual scoring
    extractCandidates(text) {
      if (!text || typeof text !== 'string') return [];
      const candidates = [];
      const seen = new Set();

      // Look for explicit SN prefixes (Highest confidence)
      const explicitRegex = /(?:s\/n|sn|serial(?:\s*number)?|n[uú]mero\s*de\s*s[eé]rie|s[eé]rie|inversor\s*(?:sn)?)\s*[:=]?\s*([A-Za-z0-9\-_]{7,24})/gi;
      let match;
      while ((match = explicitRegex.exec(text)) !== null) {
        const raw = match[1].trim().replace(/[,.:;]$/, '');
        if (raw.length >= 7 && !seen.has(raw)) {
          seen.add(raw);
          const startIdx = Math.max(0, match.index - 40);
          const endIdx = Math.min(text.length, match.index + match[0].length + 40);
          const ctxBefore = text.slice(startIdx, match.index);
          const ctxAfter = text.slice(match.index + match[0].length, endIdx);

          if (!this.isFalsePositive(raw, ctxBefore, ctxAfter)) {
            candidates.push({
              value: raw,
              confidence: 0.95,
              source: 'explicit_prefix',
              label: 'Explicit Serial Prefix (' + match[0].split(/[:=]/)[0].trim() + ')',
              snippet: text.slice(Math.max(0, match.index - 20), Math.min(text.length, match.index + match[0].length + 20))
            });
          }
        }
      }

      // Generic token scanner for 9-18 digit / alphanumeric numbers
      const tokenRegex = /\b([A-Za-z0-9]{8,20})\b/g;
      while ((match = tokenRegex.exec(text)) !== null) {
        const token = match[1];
        if (seen.has(token)) continue;

        const startIdx = Math.max(0, match.index - 50);
        const endIdx = Math.min(text.length, match.index + match[0].length + 50);
        const ctxBefore = text.slice(startIdx, match.index);
        const ctxAfter = text.slice(match.index + match[0].length, endIdx);
        const context = (ctxBefore + ' ' + ctxAfter).toLowerCase();

        if (this.isFalsePositive(token, ctxBefore, ctxAfter)) continue;

        // Skip plain common English or Portuguese words
        if (/^[a-zA-Z]+$/.test(token) && token.length < 14) {
          const common = ['inversor', 'equipamento', 'cliente', 'garantia', 'protocolo', 'suporte', 'atendimento', 'instalacao', 'mensagem', 'documento'];
          if (common.includes(token.toLowerCase())) continue;
        }

        let score = 0.50;
        let reasons = [];

        // Bonus for numeric or mixed alpha-numeric
        if (/^\d{10,16}$/.test(token)) {
          score += 0.20;
          reasons.push('Numeric length (10-16 digits)');
        } else if (/[0-9]/.test(token) && /[A-Z]/.test(token)) {
          score += 0.25;
          reasons.push('Alphanumeric pattern');
        }

        // Context triggers
        if (context.includes('inversor') || context.includes('deye') || context.includes('foxess') || context.includes('huawei') || context.includes('solis') || context.includes('growatt')) {
          score += 0.20;
          reasons.push('Nearby manufacturer/inverter keyword');
        }
        if (context.includes('placa') || context.includes('etiqueta') || context.includes('visor') || context.includes('foto') || context.includes('modelo')) {
          score += 0.15;
          reasons.push('Hardware context');
        }

        // Specific manufacturer signatures
        if (/^2[0-4]\d{10,12}$/.test(token)) {
          score += 0.15;
          reasons.push('Matches Deye SN signature');
        } else if (/^1[1-9]\d{10,12}$/.test(token)) {
          score += 0.15;
          reasons.push('Matches Hoymiles SN signature');
        }

        score = Math.min(0.98, score);

        if (score >= 0.55) {
          seen.add(token);
          candidates.push({
            value: token,
            confidence: score,
            source: 'contextual_ner',
            label: reasons.join(', ') || 'Probable Equipment SN',
            snippet: text.slice(Math.max(0, match.index - 25), Math.min(text.length, match.index + match[0].length + 25))
          });
        }
      }

      // Sort by confidence descending
      candidates.sort((a, b) => b.confidence - a.confidence);
      return candidates;
    },

    // Extract full intake structure from transcript text
    intakeTranscript(text) {
      const candidates = this.extractCandidates(text);
      const primarySN = candidates.length ? candidates[0].value : '';

      // Detect Manufacturer
      let detectedMfr = 'Other';
      let mfrConf = 0.4;
      const lower = text.toLowerCase();
      const mfrKeywords = [
        { name: 'Deye', keys: ['deye', 'sun-', 'sg01', 'sg03', 'sg04', 'sg05'] },
        { name: 'FoxESS', keys: ['foxess', 'fox-ess', 'fox ess', 'gabef', 't-series', 'f-series'] },
        { name: 'Huawei', keys: ['huawei', 'fusionsolar', 'sun2000', 'agh'] },
        { name: 'Solis', keys: ['solis', 'ginlong'] },
        { name: 'Growatt', keys: ['growatt', 'min ', 'mic ', 'sph '] },
        { name: 'Sungrow', keys: ['sungrow', 'sg110', 'sg5'] },
        { name: 'Hoymiles', keys: ['hoymiles', 'hms-', 'hm-'] },
        { name: 'Sofar', keys: ['sofar', 'hyd '] }
      ];

      for (const m of mfrKeywords) {
        if (m.keys.some(k => lower.includes(k))) {
          detectedMfr = m.name;
          mfrConf = 0.92;
          break;
        }
      }

      // Detect Equipment Model
      let detectedModel = '';
      const modelRegex = /(?:modelo|model|inversor|equipamento)\s*[:=]?\s*([A-Za-z0-9\-]+(?:[\s-][A-Za-z0-9\-]+){1,3})/i;
      const modelMatch = text.match(modelRegex);
      if (modelMatch && modelMatch[1].length > 3) {
        detectedModel = modelMatch[1].trim();
      } else {
        // Look for model patterns
        const directModel = text.match(/\b(SUN-[0-9A-Z\-]+|SUN2000-[0-9A-Z\-]+|FOX-[0-9A-Z\-]+|HMS-[0-9A-Z\-]+|MIN\s*[0-9]+[A-Z\-]+)\b/i);
        if (directModel) detectedModel = directModel[1].trim();
      }
      if (!detectedModel) {
        detectedModel = detectedMfr !== 'Other' ? detectedMfr + ' Inverter' : 'Solar Inverter';
      }

      // Detect Customer Name
      let customerName = '';
      const nameMatch = text.match(/(?:cliente|nome|atendimento\s*com|solicitante)\s*[:=]?\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){1,4})/);
      if (nameMatch) {
        customerName = nameMatch[1].trim();
      } else {
        // Check first line or greeting
        const greetingMatch = text.match(/(?:olá|bom dia|boa tarde|boa noite),?\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)?)/i);
        if (greetingMatch) customerName = greetingMatch[1].trim();
      }
      if (!customerName) customerName = 'Suporte Solar Cliente';

      // Detect Phone
      let phone = '';
      const phoneMatch = text.match(/(?:\+?55\s?)?(?:\(?([1-9]{2})\)?\s?)?(9\d{4}[-\s]?\d{4})\b/);
      if (phoneMatch) phone = phoneMatch[0].trim();

      // Detect Problem summary / error codes
      let problem = '';
      const errMatch = text.match(/\b(F\d{2,3}|alerta\s*\d+|erro\s*\d+|alarme\s*\d+|sobretens[aã]o|grid\s*fault|falha\s*de\s*rede|isolamento|iso\s*fault)\b/i);
      if (errMatch) {
        problem = `Falha identificada: ${errMatch[0]}. `;
      }
      // Take first 160 chars of problem context
      const probSnippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
      problem += probSnippet.length > 200 ? probSnippet.slice(0, 200) + '...' : probSnippet;

      return {
        customer: { name: customerName, phone: phone },
        equipment: {
          manufacturer: detectedMfr,
          model: detectedModel,
          serial_number: primarySN,
          candidates: candidates
        },
        problem_summary: problem,
        confidence: {
          sn: candidates.length ? candidates[0].confidence : 0.2,
          mfr: mfrConf,
          overall: candidates.length ? (candidates[0].confidence * 0.6 + mfrConf * 0.4) : 0.45
        }
      };
    },

    // Extensible TARS Cloud & Local SN Disambiguation Pipeline
    async intakeTranscriptWithTARS(text) {
      try {
        const resp = await fetch('/api/sla-cases/extract-sn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.ok) {
            return data;
          }
        }
      } catch (e) {
        console.warn('[SLAHub] Failed calling /api/sla-cases/extract-sn, using local heuristics:', e);
      }
      return this.intakeTranscript(text);
    }
  };

  // ============================================================================
  // SLA DATA STORE & API SYNC
  // ============================================================================
  async function loadSLACases() {
    try {
      const resp = await fetch('/api/sla-cases');
      if (resp.ok) {
        const raw = await resp.json();
        let loaded = null;
        if (Array.isArray(raw)) {
          loaded = raw;
        } else if (raw && Array.isArray(raw.cases)) {
          loaded = raw.cases;
        }

        if (loaded && loaded.length > 0) {
          slaCases = loaded;
        } else {
          slaCases = loadLocalSLACases();
          if (Array.isArray(slaCases) && slaCases.length > 0) {
            fetch('/api/sla-cases', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cases: slaCases })
            }).catch(() => {});
          }
        }
      } else {
        slaCases = loadLocalSLACases();
      }
    } catch (e) {
      console.warn('[SLAHub] Failed to fetch /api/sla-cases, loading local cache:', e);
      slaCases = loadLocalSLACases();
    }
    if (!Array.isArray(slaCases)) {
      slaCases = generateSeedSLACases();
    }
    window.slaCases = slaCases;
    updateSLAStats();
    renderSLACasesGrid();
    return slaCases;
  }

  function loadLocalSLACases() {
    try {
      const c = localStorage.getItem('solar-agenda-sla-cases');
      if (c) {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        if (parsed && Array.isArray(parsed.cases) && parsed.cases.length > 0) return parsed.cases;
      }
    } catch (e) {}
    return generateSeedSLACases();
  }

  function saveLocalSLACases() {
    try {
      if (!Array.isArray(slaCases)) slaCases = [];
      localStorage.setItem('solar-agenda-sla-cases', JSON.stringify(slaCases));
      window.slaCases = slaCases;
    } catch (e) {}
  }

  async function saveSLACaseApi(slaObj) {
    if (!Array.isArray(slaCases)) slaCases = [];
    const existingIdx = slaCases.findIndex(c => c.id === slaObj.id);
    if (existingIdx >= 0) {
      slaCases[existingIdx] = slaObj;
    } else {
      slaCases.unshift(slaObj);
    }
    saveLocalSLACases();
    updateSLAStats();
    renderSLACasesGrid();

    // Persist to backend
    try {
      await fetch('/api/sla-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case: slaObj, cases: slaCases })
      });
    } catch (e) {
      console.warn('[SLAHub] Failed to persist to /api/sla-cases:', e);
    }
  }

  // Seed sample SLA cases if none exist
  function generateSeedSLACases() {
    const now = Date.now();
    const seed = [
      {
        id: 'SLA-1001',
        customer: {
          name: 'Roberto Dias de Souza',
          phone: '+55 11 98842-1920',
          email: 'roberto.dias@solarenergy.com.br',
          site_location: 'Campinas - SP'
        },
        equipment: {
          manufacturer: 'Deye',
          model: 'SUN-8K-SG01LP1-EU',
          serial_numbers: ['230819405231'],
          category: 'Inverter Alarm / Fault',
          firmware: 'HMI 1001-C037 / MAIN 2001-1140'
        },
        status: 'WAITING MANUFACTURER RESPONSE',
        priority: 'alta',
        problem_summary: 'Inversor travado com Alarme F30 (Falha de Acionamento IGBT) intermitente ao atingir 4.2kW de potência.',
        created_at: new Date(now - 14 * 3600000).toISOString(),
        updated_at: new Date(now - 2 * 3600000).toISOString(),
        sla_deadline: new Date(now + 10 * 3600000).toISOString(),
        sla_limit_hours: 24,
        responsible_tech: 'Suporte Solar',
        next_action: 'Aguardando validação da Deye sobre envio de nova placa de controle para RMA',
        protocols: {
          hyperflow_id: 'HF-8821',
          hyperflow_url: 'https://app.hyperflow.com.br/chat/8821',
          jira: [
            { board: 'ADB', issue_key: 'ADB-48912', summary: 'Deye RMA - Placa SUN-8K F30', status: 'In Review' }
          ]
        },
        timeline: [
          {
            id: 'evt-1',
            type: 'hyperflow_msg',
            title: 'Conversa Importada via TARS Bridge',
            detail: 'Cliente relatou falha F30 no display do inversor Deye SUN-8K. SN 230819405231 extraído com 98% de confiança.',
            author: 'TARS Bridge',
            timestamp: new Date(now - 14 * 3600000).toISOString()
          },
          {
            id: 'evt-2',
            type: 'technical_action',
            title: 'Diagnóstico Preliminar',
            detail: 'Verificada tensão CA nos bornes: 224V fase-fase (dentro dos limites PRODIST). Isolamento CC > 50MΩ.',
            author: 'Técnico Suporte',
            timestamp: new Date(now - 8 * 3600000).toISOString()
          },
          {
            id: 'evt-3',
            type: 'manufacturer_contact',
            title: 'Protocolo Aberto com Deye (ADB-48912)',
            detail: 'Chamado aberto via WhatsApp suporte técnico Deye com relatório de falha e logs.',
            author: 'Técnico Suporte',
            timestamp: new Date(now - 2 * 3600000).toISOString()
          }
        ],
        conversation: {
          source: 'Hyperflow',
          channel: 'WhatsApp Cliente',
          messages: [
            { sender: 'customer', text: 'Boa tarde, meu inversor Deye está apitando e com luz vermelha acesa.', time: '10:14' },
            { sender: 'agent', text: 'Olá Roberto! Pode nos enviar a foto do visor com o código de erro e a etiqueta lateral com o número de série?', time: '10:16' },
            { sender: 'customer', text: 'Segue a foto do display: Erro F30. O número de série na etiqueta é 230819405231.', time: '10:22' }
          ]
        },
        files: [
          { name: 'display_f30_erro.jpg', type: 'image/jpeg', size: '1.4 MB', url: '#' },
          { name: 'etiqueta_sn_230819405231.jpg', type: 'image/jpeg', size: '2.1 MB', url: '#' }
        ]
      },
      {
        id: 'SLA-1002',
        customer: {
          name: 'Fazenda Santa Maria (Eng. Carlos)',
          phone: '+55 19 97123-5544',
          email: 'carlos@santamaria.agr.br',
          site_location: 'Ribeirão Preto - SP'
        },
        equipment: {
          manufacturer: 'FoxESS',
          model: 'T25-G3 Three-Phase',
          serial_numbers: ['FA230911849201'],
          category: 'Grid Overvoltage / AC Fault',
          firmware: 'V1.42'
        },
        status: 'WAITING CUSTOMER INFO / TEST',
        priority: 'alta',
        problem_summary: 'Sobretensão na rede da concessionária (CPFL). Inversor desarmando com alarme Grid Volt Fault por volta das 12h30.',
        created_at: new Date(now - 20 * 3600000).toISOString(),
        updated_at: new Date(now - 4 * 3600000).toISOString(),
        sla_deadline: new Date(now + 4 * 3600000).toISOString(),
        sla_limit_hours: 24,
        responsible_tech: 'Engenharia de Campo',
        next_action: 'Aguardando cliente enviar medições de tensão fase-neutro com multímetro durante o pico solar',
        protocols: {
          hyperflow_id: 'HF-8835',
          jira: [
            { board: 'GABEF', issue_key: 'GABEF-1044', summary: 'FoxESS T25 Grid Overvoltage', status: 'In Progress' }
          ]
        },
        timeline: [
          {
            id: 'evt-11',
            type: 'hyperflow_msg',
            title: 'Caso Criado',
            detail: 'Cliente relatou perdas de geração entre 11h e 13h todos os dias ensolarados.',
            author: 'Hyperflow',
            timestamp: new Date(now - 20 * 3600000).toISOString()
          },
          {
            id: 'evt-12',
            type: 'technical_action',
            title: 'Análise de Histórico FoxCloud',
            detail: 'Tensão da fase A atinge 257V às 12h18, acionando a proteção de sobretensão nível 1 (253V configurado).',
            author: 'Técnico Suporte',
            timestamp: new Date(now - 10 * 3600000).toISOString()
          }
        ],
        files: []
      },
      {
        id: 'SLA-1003',
        customer: {
          name: 'Condomínio Residencial Bougainville',
          phone: '+55 31 99812-4040',
          email: 'sindico@bougainville.com.br',
          site_location: 'Belo Horizonte - MG'
        },
        equipment: {
          manufacturer: 'Huawei',
          model: 'SUN2000-50KTL-M3',
          serial_numbers: ['2101073842100984'],
          category: 'Hardware / Contactor Failure',
          firmware: 'V500R001C00SPC145'
        },
        status: 'PENDING MANUFACTURER CONTACT',
        priority: 'urgente',
        problem_summary: 'Alarme 2064 (Falha no circuito do contator interno). Inversor não reconecta à rede elétrica.',
        created_at: new Date(now - 5 * 3600000).toISOString(),
        updated_at: new Date(now - 1 * 3600000).toISOString(),
        sla_deadline: new Date(now + 7 * 3600000).toISOString(),
        sla_limit_hours: 12,
        responsible_tech: 'Suporte Solar',
        next_action: 'Abrir chamado formal de garantia no portal Huawei FusionSolar com logs de PAC exportados',
        protocols: {
          hyperflow_id: 'HF-8902',
          jira: [
            { board: 'AGH', issue_key: 'AGH-302', summary: 'Huawei 50KTL Contactor Fault', status: 'Open' }
          ]
        },
        timeline: [
          {
            id: 'evt-21',
            type: 'status_change',
            title: 'Caso Aberto com Prioridade Urgente',
            detail: 'Usina comercial parada, gerando perda financeira ao cliente.',
            author: 'Suporte Solar',
            timestamp: new Date(now - 5 * 3600000).toISOString()
          }
        ],
        files: []
      }
    ];
    return seed;
  }

  // Contractual SLA response and resolution limits by priority
  const SLA_PRIORITY_LIMITS = {
    'urgente': { resolutionHrs: 24, firstResponseHrs: 2, label: 'Crítico (24h)' },
    'alta': { resolutionHrs: 48, firstResponseHrs: 6, label: 'Alto (48h)' },
    'media': { resolutionHrs: 120, firstResponseHrs: 24, label: 'Médio (5 dias)' },
    'baixa': { resolutionHrs: 240, firstResponseHrs: 48, label: 'Baixo (10 dias)' }
  };

  // Calculate remaining SLA time and health
  function computeSLAHealth(item) {
    const prioKey = (item.priority || 'alta').toLowerCase();
    const prioConfig = SLA_PRIORITY_LIMITS[prioKey] || SLA_PRIORITY_LIMITS['alta'];
    const totalHrs = item.sla_limit_hours || prioConfig.resolutionHrs;
    const firstResponseHrs = prioConfig.firstResponseHrs;
    const totalMs = totalHrs * 3600000;
    const createdMs = new Date(item.created_at || Date.now()).getTime();
    const now = Date.now();
    const deadlineMs = new Date(item.sla_deadline || (createdMs + totalMs)).getTime();
    const elapsedMs = Math.max(0, now - createdMs);
    const remainingMs = deadlineMs - now;

    const elapsedHrs = Math.floor(elapsedMs / 3600000);
    const elapsedMin = Math.floor((elapsedMs % 3600000) / 60000);
    const elapsedText = `${elapsedHrs}h ${elapsedMin}m decorridos`;

    const pctRemaining = Math.max(0, Math.min(100, Math.round((remainingMs / totalMs) * 100)));
    const pctElapsed = Math.min(100, Math.max(0, 100 - pctRemaining));

    if (['RESOLVED', 'CLOSED', 'CANCELED'].includes(item.status)) {
      return {
        status: 'RESOLVED',
        label: item.status === 'CANCELED' ? 'Cancelado' : 'Concluído no Prazo',
        color: item.status === 'CANCELED' ? 'var(--muted)' : 'var(--ok)',
        icon: '✓',
        isResolved: true,
        remainingText: 'Finalizado com sucesso',
        elapsedText: `${elapsedHrs}h ${elapsedMin}m totais`,
        pctRemaining: 0,
        pctElapsed: 100,
        totalHrs,
        firstResponseHrs,
        riskLevel: 'Finalizado',
        clockState: 'Encerrado'
      };
    }

    const isPaused = ['WAITING MANUFACTURER RESPONSE', 'WAITING CUSTOMER INFO / TEST'].includes(item.status);

    if (remainingMs <= 0) {
      const overdueHrs = Math.abs(Math.floor(remainingMs / 3600000));
      const overdueMin = Math.abs(Math.floor((remainingMs % 3600000) / 60000));
      return {
        status: 'OVERDUE',
        label: `Vencido (${overdueHrs}h)`,
        color: '#f87171',
        icon: '🚨',
        remainingText: `Atrasado há ${overdueHrs}h ${overdueMin}m`,
        elapsedText,
        isOverdue: true,
        isBreached: true,
        isPaused,
        pctRemaining: 0,
        pctElapsed: 100,
        totalHrs,
        firstResponseHrs,
        riskLevel: 'Crítico (SLA Violado)',
        clockState: isPaused ? 'Pausado em atraso' : 'Excedido / Alerta'
      };
    }

    const remainingHrs = Math.floor(remainingMs / 3600000);
    const remainingMin = Math.floor((remainingMs % 3600000) / 60000);
    const remainingText = `${remainingHrs}h ${remainingMin}m restantes`;

    if (isPaused) {
      const pauseReason = item.status === 'WAITING MANUFACTURER RESPONSE' ? 'Aguardando Fabricante' : 'Aguardando Cliente';
      return {
        status: 'PAUSED',
        label: `Pausado (${item.status === 'WAITING MANUFACTURER RESPONSE' ? 'Mfr' : 'Cliente'})`,
        color: '#38bdf8',
        icon: '⏸',
        remainingText: remainingText,
        elapsedText,
        isPaused: true,
        pctRemaining,
        pctElapsed,
        totalHrs,
        firstResponseHrs,
        riskLevel: 'Congelado temporariamente',
        clockState: `Pausado (${pauseReason})`
      };
    }

    // Critical imminent breach (< 2h remaining)
    if (remainingMs <= 2 * 3600000) {
      return {
        status: 'CRITICAL',
        label: `Iminente (${remainingHrs}h ${remainingMin}m)`,
        color: '#f87171',
        icon: '⚠️',
        remainingText: `Estouro iminente: restam ${remainingHrs}h ${remainingMin}m`,
        elapsedText,
        isImminent: true,
        isAtRisk: true,
        pctRemaining,
        pctElapsed,
        totalHrs,
        firstResponseHrs,
        riskLevel: 'Imediato (< 2h para estouro)',
        clockState: 'Contagem regressiva crítica'
      };
    }

    if (remainingMs < 8 * 3600000 || pctRemaining < 45) {
      return {
        status: 'AT_RISK',
        label: `Em Risco (${remainingHrs}h)`,
        color: '#facc15',
        icon: '⚡',
        remainingText: remainingText,
        elapsedText,
        isAtRisk: true,
        pctRemaining,
        pctElapsed,
        totalHrs,
        firstResponseHrs,
        riskLevel: 'Alto (Atenção imediata)',
        clockState: 'Ativo em contagem'
      };
    }

    return {
      status: 'HEALTHY',
      label: `No Prazo (${remainingHrs}h)`,
      color: '#4ade80',
      icon: '🟢',
      remainingText: remainingText,
      elapsedText,
      isHealthy: true,
      pctRemaining,
      pctElapsed,
      totalHrs,
      firstResponseHrs,
      riskLevel: 'Normal (Dentro da meta)',
      clockState: 'Ativo em contagem'
    };
  }

  // Get CSS class for status pills
  function getStatusClass(status) {
    switch (status) {
      case 'NEW': return 'sla-status-new';
      case 'TRIAGE / ANALYSIS': return 'sla-status-triage';
      case 'PENDING MANUFACTURER CONTACT': return 'sla-status-pending-mfr';
      case 'WAITING MANUFACTURER RESPONSE': return 'sla-status-waiting-mfr';
      case 'MANUFACTURER RESPONDED': return 'sla-status-mfr-responded';
      case 'WAITING CUSTOMER INFO / TEST': return 'sla-status-waiting-cust';
      case 'CUSTOMER RESPONDED': return 'sla-status-cust-responded';
      case 'SCHEDULED VISIT / PAC': return 'sla-status-visit';
      case 'TECHNICAL FOLLOW-UP': return 'sla-status-follow-up';
      case 'RESOLVED': return 'sla-status-resolved';
      case 'CLOSED': return 'sla-status-closed';
      case 'CANCELED': return 'sla-status-canceled';
      default: return 'sla-status-new';
    }
  }

  // ============================================================================
  // SLA KPI STAT STRIP & EXECUTIVE BREACH DASHBOARD
  // ============================================================================
  function updateSLAStats() {
    if (!Array.isArray(slaCases)) slaCases = [];
    const activeCases = slaCases.filter(c => !['RESOLVED', 'CLOSED', 'CANCELED'].includes(c.status));

    const totalOpen = activeCases.length;
    let atRisk = 0;
    let overdue = 0;
    let imminent = 0;
    let waitingMfr = 0;
    let waitingCust = 0;

    activeCases.forEach(c => {
      const h = computeSLAHealth(c);
      if (h.status === 'OVERDUE') overdue++;
      else if (h.status === 'CRITICAL') { imminent++; atRisk++; }
      else if (h.status === 'AT_RISK') atRisk++;

      if (c.status === 'WAITING MANUFACTURER RESPONSE') waitingMfr++;
      if (c.status === 'WAITING CUSTOMER INFO / TEST') waitingCust++;
    });

    const complianceRate = totalOpen > 0 ? Math.round(((totalOpen - overdue) / totalOpen) * 100) : 100;

    const elOpen = document.getElementById('sla-stat-open');
    const elCompliance = document.getElementById('sla-stat-compliance');
    const elAtRisk = document.getElementById('sla-stat-atrisk');
    const elOverdue = document.getElementById('sla-stat-overdue');
    const elWaitingMfr = document.getElementById('sla-stat-waiting-mfr');
    const elWaitingCust = document.getElementById('sla-stat-waiting-cust');

    if (elOpen) elOpen.textContent = totalOpen;
    if (elCompliance) {
      elCompliance.textContent = `${complianceRate}%`;
      elCompliance.style.color = complianceRate >= 90 ? '#4ade80' : complianceRate >= 75 ? '#facc15' : '#f87171';
    }
    if (elAtRisk) elAtRisk.textContent = atRisk;
    if (elOverdue) elOverdue.textContent = overdue;
    if (elWaitingMfr) elWaitingMfr.textContent = waitingMfr;
    if (elWaitingCust) elWaitingCust.textContent = waitingCust;

    // Executive SLA Breach Alert Banner
    const banner = document.getElementById('sla-breach-banner');
    const bannerTitle = document.getElementById('sla-breach-title');
    const bannerDesc = document.getElementById('sla-breach-desc');
    const filterBtn = document.getElementById('sla-breach-filter-btn');

    if (banner && bannerTitle) {
      if (overdue > 0 || imminent > 0) {
        banner.classList.remove('hidden');
        bannerTitle.innerHTML = `<b>ALERTA DE SLA CONTRATUAL:</b> ${overdue} caso(s) com prazo estourado ${imminent > 0 ? `e ${imminent} em risco iminente (&lt; 2h)` : ''}`;
        if (bannerDesc) {
          bannerDesc.textContent = `Atenção prioritária requerida para conformidade contratual. Taxa de cumprimento atual da carteira ativa: ${complianceRate}%.`;
        }
        if (filterBtn) {
          filterBtn.onclick = () => {
            slaFilter = 'at_risk';
            document.querySelectorAll('.sla-f-pill, .sla-stat-card').forEach(p => p.classList.toggle('active', p.dataset.slaf === 'at_risk'));
            renderSLACasesGrid();
          };
        }
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  // ============================================================================
  // RENDER SLA CASES GRID
  // ============================================================================
  function renderSLACasesGrid() {
    const grid = document.getElementById('sla-cases-grid');
    if (!grid) return;

    if (!Array.isArray(slaCases)) slaCases = [];
    let list = [...slaCases];

    // Filter
    if (slaFilter === 'all') {
      list = list.filter(c => !['RESOLVED', 'CLOSED', 'CANCELED'].includes(c.status));
    } else if (slaFilter === 'at_risk') {
      list = list.filter(c => {
        const h = computeSLAHealth(c);
        return h.status === 'AT_RISK' || h.status === 'OVERDUE';
      });
    } else if (slaFilter === 'pending_mfr') {
      list = list.filter(c => c.status === 'PENDING MANUFACTURER CONTACT');
    } else if (slaFilter === 'waiting_mfr') {
      list = list.filter(c => c.status === 'WAITING MANUFACTURER RESPONSE');
    } else if (slaFilter === 'mfr_responded') {
      list = list.filter(c => c.status === 'MANUFACTURER RESPONDED');
    } else if (slaFilter === 'waiting_cust') {
      list = list.filter(c => c.status === 'WAITING CUSTOMER INFO / TEST');
    } else if (slaFilter === 'follow_up') {
      list = list.filter(c => c.status === 'TECHNICAL FOLLOW-UP' || c.status === 'SCHEDULED VISIT / PAC');
    } else if (slaFilter === 'resolved') {
      list = list.filter(c => ['RESOLVED', 'CLOSED', 'CANCELED'].includes(c.status));
    } else if (slaFilter === 'my') {
      list = list.filter(c => c.responsible_tech === 'Suporte Solar' && !['RESOLVED', 'CLOSED', 'CANCELED'].includes(c.status));
    }

    // Search
    if (slaSearchQuery.trim()) {
      const q = slaSearchQuery.trim().toLowerCase();
      list = list.filter(c => {
        const sns = (c.equipment?.serial_numbers || []).join(' ');
        const jiras = (c.protocols?.jira || []).map(j => `${j.board}-${j.issue_key} ${j.summary}`).join(' ');
        const hay = `${c.id} ${c.customer?.name} ${c.customer?.phone} ${c.equipment?.model} ${c.equipment?.manufacturer} ${sns} ${jiras} ${c.problem_summary} ${c.responsible_tech}`.toLowerCase();
        return hay.includes(q);
      });
    }

    // Sort
    list.sort((a, b) => {
      if (slaSort === 'urgency') {
        const ha = computeSLAHealth(a);
        const hb = computeSLAHealth(b);
        if (ha.status === 'OVERDUE' && hb.status !== 'OVERDUE') return -1;
        if (hb.status === 'OVERDUE' && ha.status !== 'OVERDUE') return 1;
        if (ha.status === 'AT_RISK' && hb.status !== 'AT_RISK') return -1;
        if (hb.status === 'AT_RISK' && ha.status !== 'AT_RISK') return 1;
        return new Date(a.sla_deadline || 0).getTime() - new Date(b.sla_deadline || 0).getTime();
      } else if (slaSort === 'recent') {
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      } else if (slaSort === 'created') {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      } else if (slaSort === 'priority') {
        const weight = { urgente: 4, alta: 3, media: 2, baixa: 1 };
        return (weight[b.priority] || 0) - (weight[a.priority] || 0);
      }
      return 0;
    });

    if (!list.length) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 48px 24px; text-align:center; background:rgba(255,255,255,0.02); border:1px dashed var(--line); border-radius:12px;">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--muted)" stroke-width="1.6" style="margin-bottom:12px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="11" r="3"/></svg>
          <div style="font-weight:600; font-size:1.05rem; color:var(--text); margin-bottom:6px;">No SLA Cases Found</div>
          <div style="font-size:0.85rem; color:var(--muted); max-width:400px; margin:0 auto 16px;">
            ${slaSearchQuery ? 'No cases match your search query.' : 'There are no active cases in this filter category.'}
          </div>
          <button class="btn-primary" id="sla-empty-new-btn">+ Create First SLA Case</button>
        </div>
      `;
      document.getElementById('sla-empty-new-btn')?.addEventListener('click', () => openNewSLAModal());
      return;
    }

    grid.innerHTML = list.map(c => {
      const health = computeSLAHealth(c);
      const snPrimary = c.equipment?.serial_numbers?.[0] || 'No SN Recorded';
      const mfr = c.equipment?.manufacturer || 'Unknown';
      const model = c.equipment?.model || 'Inverter';
      const statusClass = getStatusClass(c.status);
      const stageObj = SLA_STAGES.find(s => s.key === c.status);
      const stageLabel = stageObj ? stageObj.label : c.status;
      const phoneRaw = c.customer?.phone || '';
      const phoneDigits = phoneRaw.replace(/\D/g, '');

      // Jira badges
      const jiraBadges = (c.protocols?.jira || []).map(j => `
        <span class="sla-proto-tag proto-jira" title="${j.summary || ''}">
          ${j.board}-${j.issue_key}
        </span>
      `).join('');

      const hfBadge = c.protocols?.hyperflow_id ? `
        <span class="sla-proto-tag proto-hf">
          HF #${c.protocols.hyperflow_id.replace(/^HF-?/, '')}
        </span>
      ` : '';

      // Hoymiles account badges (from SLA webhook)
      const hoymilesBadges = (c.protocols?.hoymiles || []).map(h => `
        <span class="sla-proto-tag proto-hoymiles" style="background:rgba(242,167,27,0.18); color:#f2a71b; border:1px solid rgba(242,167,27,0.35);" title="Conta Hoymiles criada via TARS: ${escapeHtml(h.account_email || h.loginEmail || '')}">
          ⚡ ${escapeHtml(h.organization_name || h.company || 'Hoymiles')}
        </span>
      `).join('');

      const waButton = phoneDigits.length >= 10 ? `
        <a href="https://wa.me/55${phoneDigits.replace(/^55/, '')}" target="_blank" rel="noopener" class="sla-card-wa-btn" onclick="event.stopPropagation();" title="Abrir WhatsApp com cliente">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/></svg>
          <span>WhatsApp</span>
        </a>
      ` : '';

      return `
        <div class="sla-card" data-slaid="${c.id}">
          <div class="sla-card-header">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="sla-id-badge">${c.id}</span>
              <span class="sla-prio-tag prio-${c.priority || 'alta'}">${(c.priority || 'alta').toUpperCase()}</span>
            </div>
            <div class="sla-health-pill ${health.status.toLowerCase()} sla-health-${health.status}">
              <span style="font-size:0.85rem;">${health.icon}</span>
              <span>${health.label}</span>
            </div>
          </div>

          <!-- Live SLA Countdown & Compliance Track -->
          <div class="sla-card-countdown ${health.status.toLowerCase()}">
            <div class="sla-countdown-head">
              <span class="sla-countdown-timer">⏱️ ${health.remainingText}</span>
              <span class="sla-countdown-meta">${health.totalHrs}h limite</span>
            </div>
            <div class="sla-countdown-track">
              <div class="sla-countdown-fill" style="width: ${health.pctRemaining}%; background: ${health.color};"></div>
            </div>
          </div>

          <div class="sla-card-body">
            <div class="sla-card-customer-row">
              <span class="sla-card-customer">${escapeHtml(c.customer?.name || 'Cliente Sem Nome')}</span>
              ${waButton}
            </div>

            <div class="sla-card-equipment">
              <span style="color:var(--amber); font-weight:600;">${escapeHtml(mfr)}</span> · ${escapeHtml(model)}
            </div>

            <div class="sla-card-sn-row">
              <div class="sla-card-sn">
                <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                <span>SN: <b>${escapeHtml(snPrimary)}</b></span>
              </div>
              <button type="button" class="sla-card-copy-btn" onclick="event.stopPropagation(); navigator.clipboard.writeText('${escapeHtml(snPrimary)}'); if(window.SFX) SFX.tick(); this.textContent='✓ Copiado'; setTimeout(()=>this.textContent='Copiar SN', 1600);" title="Copiar número de série">
                Copiar SN
              </button>
            </div>

            <div class="sla-card-problem">${escapeHtml(c.problem_summary || 'Sem resumo de problema registrado.')}</div>
          </div>

          <div class="sla-card-footer">
            <div class="sla-card-status">
              <span class="sla-status-pill ${statusClass}">${escapeHtml(stageLabel)}</span>
            </div>
            <div class="sla-card-protocols">
              ${hfBadge}
              ${jiraBadges}
              ${hoymilesBadges}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Click handler to open case deep-dive modal
    grid.querySelectorAll('.sla-card').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.slaid;
        openSLACaseModal(id);
      });
    });
  }

  // ============================================================================
  // SLA CASE MODAL (8 SUB-TABS DEEP DIVE)
  // ============================================================================
  function openSLACaseModal(id) {
    const item = slaCases.find(c => c.id === id);
    if (!item) return;
    currentSLACase = item;

    // Header info
    const elId = document.getElementById('sla-modal-id');
    const elCust = document.getElementById('sla-modal-customer');
    const elHealth = document.getElementById('sla-modal-health-pill');
    const elSelect = document.getElementById('sla-modal-status-select');

    if (elId) elId.textContent = item.id;
    if (elCust) elCust.textContent = item.customer?.name || 'Customer';

    const health = computeSLAHealth(item);
    if (elHealth) {
      elHealth.className = `sla-health-pill ${health.status.toLowerCase()}`;
      elHealth.innerHTML = `<span style="font-size:0.9rem;">${health.icon}</span> <span>${health.label}</span>`;
    }

    // Populate status dropdown
    if (elSelect) {
      elSelect.innerHTML = SLA_STAGES.map(s => `
        <option value="${s.key}" ${s.key === item.status ? 'selected' : ''}>${s.label}</option>
      `).join('');
      elSelect.onchange = (e) => {
        transitionCaseStatus(item.id, e.target.value);
      };
    }

    // Render Sub-Tabs
    switchSLAModalTab('overview');
    renderOverviewPanel(item);
    renderTimelinePanel(item);
    renderConversationPanel(item);
    renderNotesSubTab(item);
    renderEquipmentPanel(item);
    renderProtocolsPanel(item);
    renderFilesPanel(item);
    renderTarsPanel(item);

    // Show modal
    const backdrop = document.getElementById('sla-case-modal-backdrop');
    if (backdrop) backdrop.classList.add('visible');
  }

  function closeSLACaseModal() {
    const backdrop = document.getElementById('sla-case-modal-backdrop');
    if (backdrop) backdrop.classList.remove('visible');
    currentSLACase = null;
  }

  function switchSLAModalTab(tabName) {
    document.querySelectorAll('.sla-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.slatab === tabName);
    });
    document.querySelectorAll('.sla-subpanel').forEach(panel => {
      panel.classList.toggle('hidden', panel.id !== `sla-panel-${tabName}`);
    });
  }

  // 1. Overview Panel
  function renderOverviewPanel(item) {
    const panel = document.getElementById('sla-panel-overview');
    if (!panel) return;

    const health = computeSLAHealth(item);
    const snList = item.equipment?.serial_numbers || [];
    const snPrimary = snList[0] || 'Nenhum SN registrado';
    const mfr = item.equipment?.manufacturer || 'Fabricante não informado';
    const model = item.equipment?.model || 'Inversor Fotovoltaico';
    const createdStr = new Date(item.created_at).toLocaleString();
    const updatedStr = new Date(item.updated_at || item.created_at).toLocaleString();
    const deadlineStr = new Date(item.sla_deadline).toLocaleString();
    const phoneRaw = item.customer?.phone || '';
    const phoneClean = phoneRaw.replace(/\D/g, '');
    const waLink = phoneClean ? `https://wa.me/55${phoneClean.replace(/^55/, '')}` : null;

    // Protocols badges
    const jiraBadges = (item.protocols?.jira || []).map(j => `
      <span class="sla-proto-tag proto-jira" title="${escapeHtml(j.summary || '')}">
        ${escapeHtml(j.board || 'JIRA')}-${escapeHtml(j.issue_key)}
      </span>
    `).join('');

    const hfBadge = item.protocols?.hyperflow_id ? `
      <span class="sla-proto-tag proto-hf">
        HF #${escapeHtml(String(item.protocols.hyperflow_id).replace(/^HF-?/, ''))}
      </span>
    ` : '';

    const hoymilesBadges = (item.protocols?.hoymiles || []).map(h => `
      <span class="sla-proto-tag proto-hoymiles" style="background:rgba(242,167,27,0.18); color:#f2a71b; border:1px solid rgba(242,167,27,0.35);" title="Conta Hoymiles criada via TARS: ${escapeHtml(h.account_email || h.loginEmail || '')}">
        ⚡ Hoymiles: ${escapeHtml(h.organization_name || h.company || 'Installer')}
      </span>
    `).join('');

    panel.innerHTML = `
      <div style="display:grid; grid-template-columns:1.08fr 0.92fr; gap:14px; margin-bottom:14px;">
        <!-- Left: Case Details & Equipment Card -->
        <div class="sla-section-card">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <h4 class="sla-section-title">📋 Informações do Caso & Equipamento</h4>
            <button class="btn-ghost" id="sla-edit-case-details-btn" style="font-size:0.76rem; padding:3px 8px;">✏️ Editar Caso</button>
          </div>

          <div class="sla-detail-grid">
            <span class="sla-prop-label">Cliente</span>
            <span class="sla-prop-val">
              <b>${escapeHtml(item.customer?.name || 'Cliente')}</b>
              ${waLink ? `<a href="${waLink}" target="_blank" class="sla-sn-chip" style="color:#25d366; text-decoration:none; font-size:0.75rem; padding:2px 6px;">💬 WhatsApp</a>` : ''}
            </span>

            <span class="sla-prop-label">Contato</span>
            <span class="sla-prop-val">${escapeHtml(phoneRaw || 'Não informado')}</span>

            <span class="sla-prop-label">Local / Usina</span>
            <span class="sla-prop-val">${escapeHtml(item.customer?.site_location || 'Não informado')}</span>

            <span class="sla-prop-label">Fabricante</span>
            <span class="sla-prop-val">
              <span class="sla-mfr-tag">${escapeHtml(mfr)}</span>
            </span>

            <span class="sla-prop-label">Modelo</span>
            <span class="sla-prop-val"><b>${escapeHtml(model)}</b></span>

            <span class="sla-prop-label">Nº de Série</span>
            <span class="sla-prop-val">
              <span class="sla-sn-chip" id="sla-sn-chip-main">
                ${escapeHtml(snPrimary)}
                ${snList.length > 0 ? `
                  <button type="button" class="sla-sn-copy-btn" id="sla-copy-sn-btn" title="Copiar Número de Série">
                    📋
                  </button>
                ` : ''}
              </span>
              ${snList.length > 1 ? `<span style="font-size:0.72rem; color:var(--muted);">(+${snList.length - 1} extra)</span>` : ''}
            </span>

            <span class="sla-prop-label">Responsável</span>
            <span class="sla-prop-val"><b>${escapeHtml(item.responsible_tech || 'Não atribuído')}</b></span>

            <span class="sla-prop-label">Categoria</span>
            <span class="sla-prop-val">${escapeHtml(item.equipment?.category || 'Inversor / Alarme Geral')}</span>

            <span class="sla-prop-label">Prioridade</span>
            <span class="sla-prop-val">
              <span class="sla-prio-tag prio-${item.priority || 'alta'}">${(item.priority || 'alta').toUpperCase()}</span>
            </span>

            <span class="sla-prop-label">Protocolos</span>
            <span class="sla-prop-val">
              ${hfBadge || jiraBadges || hoymilesBadges ? `${hfBadge} ${jiraBadges} ${hoymilesBadges}` : '<span style="color:var(--muted); font-size:0.76rem;">Nenhum protocolo vinculado</span>'}
            </span>
          </div>
        </div>

        <!-- Right: SLA Target & Health Card -->
        <div class="sla-section-card">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <h4 class="sla-section-title">⏱️ Meta de SLA & Saúde</h4>
            <span class="sla-clock-badge" style="color:${health.color};">
              ${health.icon} ${escapeHtml(health.clockState || health.status)}
            </span>
          </div>

          <!-- Visual Progress Bar -->
          <div class="sla-progress-container">
            <div class="sla-progress-labels">
              <span><b>${health.pctElapsed}%</b> consumido (${health.elapsedText})</span>
              <span style="color:${health.color}; font-weight:700;">${health.remainingText}</span>
            </div>
            <div class="sla-progress-track">
              <div class="sla-progress-bar" style="width:${health.pctElapsed}%; background:${health.color};"></div>
            </div>
          </div>

          <div class="sla-detail-grid">
            <span class="sla-prop-label">Janela SLA</span>
            <span class="sla-prop-val">
              <b>${item.sla_limit_hours || 24} horas</b> (${item.priority === 'urgente' ? 'Urgente / Crítico' : 'Padrão Operacional'})
              <button class="btn-ghost" id="sla-change-limit-btn" style="font-size:0.7rem; padding:1px 6px; margin-left:4px;">Alterar</button>
            </span>

            <span class="sla-prop-label">Estado</span>
            <span class="sla-prop-val" style="color:${health.color}; font-weight:700;">
              ${health.icon} ${health.label}
            </span>

            <span class="sla-prop-label">Risco</span>
            <span class="sla-prop-val">
              <span style="color:${health.color}; font-weight:600;">${health.riskLevel}</span>
            </span>

            <span class="sla-prop-label">Prazo Limite</span>
            <span class="sla-prop-val"><b>${deadlineStr}</b></span>

            <span class="sla-prop-label">Abertura</span>
            <span class="sla-prop-val">${createdStr}</span>

            <span class="sla-prop-label">Última Ação</span>
            <span class="sla-prop-val">${updatedStr}</span>
          </div>

          <!-- Action buttons for SLA clock -->
          <div style="display:flex; gap:8px; margin-top:4px; padding-top:8px; border-top:1px solid var(--line);">
            ${health.isPaused ? `
              <button class="btn-ghost" id="sla-toggle-clock-btn" style="flex:1; font-size:0.78rem; padding:5px 8px; color:#4ade80;">
                ▶ Retomar Relógio SLA
              </button>
            ` : `
              <button class="btn-ghost" id="sla-toggle-clock-btn" style="flex:1; font-size:0.78rem; padding:5px 8px; color:#38bdf8;">
                ⏸ Pausar SLA (Aguardando Fabricante)
              </button>
            `}
            <button class="btn-ghost" id="sla-quick-note-btn" style="flex:1; font-size:0.78rem; padding:5px 8px;">
              📝 Nova Nota Técnica
            </button>
          </div>
        </div>
      </div>

      <!-- Problem & Next Action Block -->
      <div class="sla-section-card" style="margin-bottom:14px;">
        <h4 class="sla-section-title">🚨 Sintomas & Falha Relatada</h4>
        <div style="font-size:0.88rem; line-height:1.6; color:var(--text); background:rgba(0,0,0,0.2); padding:12px; border-radius:8px; border:1px solid var(--line);">
          ${escapeHtml(item.problem_summary || 'Nenhum sintoma ou descrição detalhada registrada.')}
        </div>
      </div>

      <div class="sla-section-card">
        <h4 class="sla-section-title">🎯 Próxima Ação Operacional</h4>
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(245,158,11,0.06); border:1px solid rgba(245,158,11,0.25); border-radius:8px; padding:12px;">
          <div style="font-size:0.88rem; color:var(--amber); font-weight:600;">
            ${escapeHtml(item.next_action || 'Avaliar diagnóstico e acionar suporte do fabricante.')}
          </div>
          <button class="btn-ghost" id="sla-edit-next-action-btn" style="font-size:0.78rem; padding:4px 10px;">Editar Ação</button>
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('sla-copy-sn-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (snPrimary && snPrimary !== 'Nenhum SN registrado') {
        navigator.clipboard?.writeText(snPrimary);
        const btn = document.getElementById('sla-copy-sn-btn');
        if (btn) {
          btn.textContent = '✓ Copiado!';
          setTimeout(() => { btn.textContent = '📋'; }, 2000);
        }
      }
    });

    document.getElementById('sla-edit-case-details-btn')?.addEventListener('click', () => {
      openNewSLAModal(item);
    });

    document.getElementById('sla-quick-note-btn')?.addEventListener('click', () => {
      switchSLAModalTab('notes');
      createCaseNote(item);
    });

    document.getElementById('sla-change-limit-btn')?.addEventListener('click', () => {
      const hrsStr = prompt('Definir nova janela de SLA em horas (ex: 12, 24, 48, 72):', item.sla_limit_hours || 24);
      if (hrsStr !== null) {
        const hrs = parseInt(hrsStr, 10);
        if (!isNaN(hrs) && hrs > 0) {
          item.sla_limit_hours = hrs;
          item.sla_deadline = new Date(new Date(item.created_at).getTime() + hrs * 3600000).toISOString();
          item.updated_at = new Date().toISOString();
          addTimelineEvent(item.id, {
            type: 'status_change',
            title: 'Janela de SLA Alterada',
            detail: `Janela de SLA atualizada para ${hrs} horas.`
          });
          saveSLACaseApi(item);
          renderOverviewPanel(item);
          renderSLACasesGrid();
        }
      }
    });

    document.getElementById('sla-toggle-clock-btn')?.addEventListener('click', () => {
      if (health.isPaused) {
        transitionCaseStatus(item.id, 'TRIAGE / ANALYSIS');
      } else {
        transitionCaseStatus(item.id, 'WAITING MANUFACTURER RESPONSE');
      }
    });

    document.getElementById('sla-edit-next-action-btn')?.addEventListener('click', () => {
      const act = prompt('Próxima ação operacional recomendada:', item.next_action || '');
      if (act !== null) {
        item.next_action = act.trim();
        item.updated_at = new Date().toISOString();
        addTimelineEvent(item.id, {
          type: 'technical_action',
          title: 'Próxima Ação Atualizada',
          detail: item.next_action
        });
        saveSLACaseApi(item);
        renderOverviewPanel(item);
        renderSLACasesGrid();
      }
    });
  }

  // 2. Timeline Panel
  function renderTimelinePanel(item) {
    const list = document.getElementById('sla-modal-timeline-list');
    if (!list) return;

    const events = item.timeline || [];
    if (!events.length) {
      list.innerHTML = `<div style="padding:20px; color:var(--muted); text-align:center;">No timeline events recorded yet.</div>`;
      return;
    }

    // Sort newest first
    const sorted = [...events].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    list.innerHTML = sorted.map(e => {
      const dateStr = new Date(e.timestamp).toLocaleString();
      let dotColor = 'var(--line)';
      if (e.type === 'status_change') dotColor = 'var(--amber)';
      else if (e.type === 'manufacturer_contact') dotColor = '#38bdf8';
      else if (e.type === 'whatsapp_msg' || e.type === 'hyperflow_msg') dotColor = '#25d366';
      else if (e.type === 'technical_action') dotColor = 'var(--ok)';

      return `
        <div class="sla-timeline-item">
          <div class="sla-timeline-dot" style="border-color:${dotColor};"></div>
          <div class="sla-timeline-content">
            <div class="sla-timeline-time">${dateStr} · <b>${escapeHtml(e.author || 'System')}</b></div>
            <div class="sla-timeline-title">${escapeHtml(e.title || '')}</div>
            <div class="sla-timeline-detail">${escapeHtml(e.detail || '')}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 3. Conversation Panel
  function renderConversationPanel(item) {
    const meta = document.getElementById('sla-modal-conversation-meta');
    const chat = document.getElementById('sla-modal-conversation-chat');
    if (!meta || !chat) return;

    meta.innerHTML = `
      Source: <b>${escapeHtml(item.conversation?.source || 'Hyperflow')}</b> · Channel: <b>${escapeHtml(item.conversation?.channel || 'WhatsApp')}</b> · Customer: <b>${escapeHtml(item.customer?.name || '')}</b>
    `;

    const msgs = item.conversation?.messages || [];
    if (!msgs.length) {
      chat.innerHTML = `<div style="padding:20px; text-align:center; color:var(--muted);">No conversation logs attached to this case.</div>`;
      return;
    }

    chat.innerHTML = msgs.map(m => {
      const isCust = m.sender === 'customer';
      return `
        <div style="display:flex; flex-direction:column; align-self:${isCust ? 'flex-start' : 'flex-end'}; max-width:80%;">
          <div style="font-size:0.72rem; color:var(--muted); margin-bottom:2px; align-self:${isCust ? 'flex-start' : 'flex-end'};">
            ${isCust ? item.customer?.name || 'Cliente' : 'Suporte Solar'} · ${m.time || ''}
          </div>
          <div style="padding:10px 14px; border-radius:10px; font-size:0.86rem; line-height:1.45; background:${isCust ? 'rgba(255,255,255,0.06)' : 'rgba(245,158,11,0.18)'}; color:var(--text); border:1px solid ${isCust ? 'var(--line)' : 'rgba(245,158,11,0.3)'};">
            ${escapeHtml(m.text || '')}
          </div>
        </div>
      `;
    }).join('');
  }

  // 4. Notes Sub-Tab (Migrated Notes System)
  function renderNotesSubTab(item) {
    const list = document.getElementById('sla-modal-notes-list');
    if (!list) return;

    // Filter notes belonging to this SLA case or mentioning this SLA ID / SN
    const allNotes = window.notes || [];
    const sn = item.equipment?.serial_numbers?.[0] || '';
    const caseNotes = allNotes.filter(n => {
      if (n.sla_case_id === item.id) return true;
      if (n.tags && (n.tags.includes(item.id) || (sn && n.tags.includes(sn)))) return true;
      const hay = `${n.title || ''} ${n.content || ''}`.toLowerCase();
      if (hay.includes(item.id.toLowerCase())) return true;
      if (sn && hay.includes(sn.toLowerCase())) return true;
      return false;
    });

    if (!caseNotes.length) {
      list.innerHTML = `
        <div style="grid-column:1 / -1; padding:32px 16px; text-align:center; background:rgba(255,255,255,0.02); border:1px dashed var(--line); border-radius:10px;">
          <div style="font-weight:600; color:var(--text); margin-bottom:4px;">No Technical Notes Attached</div>
          <div style="font-size:0.8rem; color:var(--muted); margin-bottom:12px;">Create technical diagnosis records, multimeter readings, checklists or ink drawings for this case.</div>
          <button class="btn-primary" id="sla-empty-note-btn">+ Create First Case Note</button>
        </div>
      `;
      document.getElementById('sla-empty-note-btn')?.addEventListener('click', () => createCaseNote(item));
      return;
    }

    list.innerHTML = caseNotes.map(n => {
      const updated = n.updated_at ? new Date(n.updated_at).toLocaleDateString() : '';
      const snippet = n.content ? n.content.replace(/<[^>]*>/g, ' ').slice(0, 90) : '';
      return `
        <div class="sla-card" style="cursor:pointer; padding:12px;" data-noteid="${n.id}">
          <div style="font-weight:700; font-size:0.92rem; color:var(--text); margin-bottom:4px;">${escapeHtml(n.title || 'Untitled Note')}</div>
          <div style="font-size:0.78rem; color:var(--muted); line-height:1.4; margin-bottom:8px;">${escapeHtml(snippet)}</div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.72rem; color:var(--muted);">
            <span>${(n.tags || []).slice(0, 3).map(t => `#${t}`).join(' ')}</span>
            <span>${updated}</span>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('[data-noteid]').forEach(el => {
      el.addEventListener('click', () => {
        const nId = el.dataset.noteid;
        if (typeof window.openNote === 'function') {
          window.openNote(nId);
        }
      });
    });
  }

  // Create a note specifically bound to this SLA Case
  async function createCaseNote(item) {
    const sn = item.equipment?.serial_numbers?.[0] || '';
    const mfr = item.equipment?.manufacturer || '';
    const notebookId = (window.notebooks && window.notebooks[0] ? window.notebooks[0].id : 'default');
    const newNote = {
      title: `${item.id} — ${item.customer?.name || 'Cliente'} (Nota Técnica)`,
      content: `<h3>Diagnóstico Técnico SLA ${item.id}</h3><p><b>Cliente:</b> ${item.customer?.name || ''}<br><b>Equipamento:</b> ${mfr} ${item.equipment?.model || ''}<br><b>Número de Série:</b> ${sn}</p><p><b>Problema Relatado:</b> ${item.problem_summary || ''}</p><hr><p><b>Procedimentos realizados / medições:</b></p><ul><li>Tensão CA Fase-Neutro: </li><li>Resistência de Isolamento: </li><li>Tensão CC dos Strings: </li></ul>`,
      tags: ['sla', item.id, mfr, sn].filter(Boolean),
      sla_case_id: item.id,
      notebook_id: notebookId
    };

    try {
      let created = null;
      if (typeof window.createNoteApi === 'function') {
        created = await window.createNoteApi(newNote);
      } else {
        created = {
          id: 'note_' + Date.now(),
          ...newNote,
          created_at: new Date().toISOString()
        };
        if (!window.notes) window.notes = [];
        window.notes.unshift(created);
      }
      addTimelineEvent(item.id, {
        type: 'note',
        title: 'Nota Técnica Criada',
        detail: `Nota "${newNote.title}" associada ao caso.`
      });
      saveSLACaseApi(item);
      renderNotesSubTab(item);
      if (typeof window.openNote === 'function' && created && created.id) {
        window.openNote(created.id);
      }
    } catch (err) {
      console.warn('Note API encountered error, falling back locally:', err);
      const fallbackNote = {
        id: 'note_' + Date.now(),
        ...newNote,
        created_at: new Date().toISOString()
      };
      if (!window.notes) window.notes = [];
      window.notes.unshift(fallbackNote);
      addTimelineEvent(item.id, {
        type: 'note',
        title: 'Nota Técnica Criada (Local)',
        detail: `Nota "${newNote.title}" associada localmente.`
      });
      saveSLACaseApi(item);
      renderNotesSubTab(item);
      if (typeof window.openNote === 'function') {
        window.openNote(fallbackNote.id);
      }
    }
  }

  // 5. Equipment Panel
  function renderEquipmentPanel(item) {
    const details = document.getElementById('sla-modal-equipment-details');
    const snHistory = document.getElementById('sla-modal-sn-history');
    if (!details || !snHistory) return;

    const sn = item.equipment?.serial_numbers?.[0] || 'N/A';
    const mfr = item.equipment?.manufacturer || 'Unknown';
    const model = item.equipment?.model || 'Inverter';

    details.innerHTML = `
      <div class="sla-detail-grid">
        <span class="sla-prop-label">Primary Serial Number</span>
        <span class="sla-prop-val" style="font-family:monospace; font-weight:700; color:var(--amber);">${escapeHtml(sn)}</span>

        <span class="sla-prop-label">Manufacturer</span>
        <span class="sla-prop-val"><b>${escapeHtml(mfr)}</b></span>

        <span class="sla-prop-label">Model</span>
        <span class="sla-prop-val">${escapeHtml(model)}</span>

        <span class="sla-prop-label">Firmware Version</span>
        <span class="sla-prop-val">${escapeHtml(item.equipment?.firmware || 'Not verified')}</span>

        <span class="sla-prop-label">Category</span>
        <span class="sla-prop-val">${escapeHtml(item.equipment?.category || 'Inverter')}</span>
      </div>
    `;

    // Cross-check all cases for the same SN
    const relatedCases = slaCases.filter(c => c.id !== item.id && (c.equipment?.serial_numbers || []).includes(sn));
    if (!relatedCases.length) {
      snHistory.innerHTML = `
        <div style="font-size:0.84rem; color:var(--muted); padding:12px; background:rgba(0,0,0,0.15); border-radius:8px;">
          ✓ No prior SLA cases recorded for SN <b>${escapeHtml(sn)}</b>. This is the first incident in the system.
        </div>
      `;
    } else {
      snHistory.innerHTML = relatedCases.map(rc => `
        <div style="background:rgba(255,255,255,0.03); border:1px solid var(--line); border-radius:8px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <span class="sla-id-badge" style="font-size:0.75rem;">${rc.id}</span>
            <span style="font-weight:600; margin-left:8px; font-size:0.86rem;">${escapeHtml(rc.customer?.name || '')}</span>
            <div style="font-size:0.78rem; color:var(--muted); margin-top:2px;">${escapeHtml(rc.problem_summary?.slice(0, 70) || '')}...</div>
          </div>
          <span class="sla-status-pill ${getStatusClass(rc.status)}">${rc.status}</span>
        </div>
      `).join('');
    }
  }

  // 6. Protocols Panel
  function renderProtocolsPanel(item) {
    const hfInput = document.getElementById('sla-proto-hf-input');
    const hfBadge = document.getElementById('sla-proto-hf-badge');
    const jiraNum = document.getElementById('sla-proto-jira-num');
    const jiraBoard = document.getElementById('sla-proto-jira-board');
    const jiraBadge = document.getElementById('sla-proto-jira-badge');

    if (hfInput) hfInput.value = item.protocols?.hyperflow_id || '';
    if (hfBadge) hfBadge.textContent = item.protocols?.hyperflow_id ? `Linked: ${item.protocols.hyperflow_id}` : 'Not Linked';

    const primaryJira = item.protocols?.jira?.[0];
    if (primaryJira) {
      if (jiraBoard) jiraBoard.value = primaryJira.board || 'ADB';
      if (jiraNum) jiraNum.value = primaryJira.issue_key || '';
      if (jiraBadge) jiraBadge.textContent = `${primaryJira.board}-${primaryJira.issue_key} (${primaryJira.status || 'Active'})`;
    } else {
      if (jiraBadge) jiraBadge.textContent = 'No Jira Protocol';
      if (jiraNum) jiraNum.value = '';
    }

    // Hoymiles Account info
    const hoyBadge = document.getElementById('sla-proto-hoymiles-badge');
    const hoyContent = document.getElementById('sla-proto-hoymiles-content');
    const hoymilesList = item.protocols?.hoymiles || [];
    if (hoyBadge && hoyContent) {
      if (hoymilesList.length > 0) {
        const primaryHoy = hoymilesList[0];
        hoyBadge.textContent = `Ativa: ${primaryHoy.organization_name || primaryHoy.company || 'Installer'}`;
        hoyBadge.style.display = 'inline-block';
        hoyContent.innerHTML = `
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:4px;">
            <div><b>Empresa / Instalador:</b> ${escapeHtml(primaryHoy.organization_name || primaryHoy.company || '—')}</div>
            <div><b>Organização Pai:</b> ${escapeHtml(primaryHoy.parent_organization || 'APItest')}</div>
            <div><b>Login / E-mail:</b> <span style="font-family:monospace; color:var(--amber);">${escapeHtml(primaryHoy.account_email || primaryHoy.loginEmail || '—')}</span></div>
            <div><b>Credenciais ao Cliente:</b> ${primaryHoy.password_shared_with_customer ? '<span style="color:#4ade80;">✓ Compartilhadas (Solar123)</span>' : 'Pendente'}</div>
          </div>
          <div style="font-size:0.75rem; color:var(--muted); margin-top:6px;">
            Criada em: ${primaryHoy.created_at ? new Date(primaryHoy.created_at).toLocaleString() : 'Recentemente'} | Status Webhook: <span style="color:#38bdf8;">${primaryHoy.status || 'COMPLETED'}</span>
          </div>
        `;
      } else {
        hoyBadge.textContent = 'Não Vinculada';
        hoyBadge.style.display = 'none';
        hoyContent.innerHTML = `Nenhuma conta Hoymiles vinculada a este caso. Quando a extensão TARS cria uma conta no portal Hoymiles, os metadados são enviados via SLA Webhook (POST /api/sla/webhook) e registrados aqui.`;
      }
    }
  }

  // 7. Files Panel
  function renderFilesPanel(item) {
    const grid = document.getElementById('sla-modal-files-grid');
    if (!grid) return;

    const files = item.files || [];
    if (!files.length) {
      grid.innerHTML = `<div style="grid-column:1 / -1; padding:16px; text-align:center; color:var(--muted); font-size:0.85rem;">No files or photos attached to this case yet.</div>`;
      return;
    }

    grid.innerHTML = files.map(f => `
      <div style="background:rgba(255,255,255,0.03); border:1px solid var(--line); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--amber)" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          <span style="font-weight:600; font-size:0.84rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(f.name || 'File')}</span>
        </div>
        <div style="font-size:0.75rem; color:var(--muted);">${f.size || 'Attachment'}</div>
        <a href="${f.url || '#'}" target="_blank" class="btn-ghost" style="font-size:0.75rem; text-align:center; margin-top:4px;">Open File ↗</a>
      </div>
    `).join('');
  }

  // 8. TARS Intelligence Panel
  function renderTarsPanel(item) {
    const out = document.getElementById('sla-tars-analysis-output');
    if (!out) return;

    if (!item.tars_analysis) {
      out.innerHTML = `
        <div style="padding:24px; text-align:center; background:rgba(0,0,0,0.2); border-radius:10px; border:1px solid var(--line);">
          <div style="font-size:0.9rem; font-weight:600; margin-bottom:6px; color:var(--text);">No TARS Diagnostic Analysis Generated Yet</div>
          <div style="font-size:0.82rem; color:var(--muted); max-width:440px; margin:0 auto 14px;">Click the button above to have TARS synthesize the conversation, equipment model, serial numbers, error codes, and knowledge base into a structured Fact/Inference/Action plan.</div>
        </div>
      `;
      return;
    }

    const a = item.tars_analysis;
    out.innerHTML = `
      <div class="tars-analysis-box">
        <!-- FACTS -->
        <div>
          <div class="tars-badge tars-badge-fact">FACTS & MEASUREMENTS</div>
          <ul class="tars-list">
            ${(a.facts || []).map(f => `<li>${escapeHtml(f)}</li>`).join('')}
          </ul>
        </div>

        <!-- INFERENCES -->
        <div style="margin-top:12px;">
          <div class="tars-badge tars-badge-inf">DIAGNOSTIC INFERENCES</div>
          <ul class="tars-list">
            ${(a.inferences || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}
          </ul>
        </div>

        <!-- RECOMMENDATIONS -->
        <div style="margin-top:12px;">
          <div class="tars-badge tars-badge-rec">RECOMMENDED ACTION PLAN</div>
          <ul class="tars-list">
            ${(a.recommendations || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
        </div>
      </div>
    `;
  }

  // Run TARS Autonomous SLA Analysis
  async function runTarsSLAAnalysis(itemOrId) {
    let item = itemOrId;
    if (typeof itemOrId === 'string') {
      item = (window.slaCases || []).find(x => x.id.toLowerCase() === itemOrId.toLowerCase() || (x.equipment?.serial_numbers || []).some(s => s.toLowerCase() === itemOrId.toLowerCase()));
    }
    if (!item) return 'Caso de SLA não encontrado para análise.';

    const out = document.getElementById('sla-tars-analysis-output');
    if (out) {
      out.innerHTML = `
        <div style="padding:24px; text-align:center; color:var(--amber);">
          <svg viewBox="0 0 24 24" width="24" height="24" class="spin" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom:8px;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
          <div style="font-weight:600; font-size:0.9rem;">TARS analyzing case telemetry, equipment records, and knowledge base...</div>
        </div>
      `;
    }

    const sn = item.equipment?.serial_numbers?.[0] || 'Unknown';
    const mfr = item.equipment?.manufacturer || 'Unknown';
    const model = item.equipment?.model || 'Inverter';
    const prob = item.problem_summary || '';

    // Multi-factor synthesis: Facts, Inferences, Action Plan
    const facts = [
      `Equipamento: Inversor ${mfr} modelo ${model} com número de série primário [${sn}].`,
      `Sintoma/Problema: "${prob}".`,
      `Protocolos vinculados: Hyperflow=${item.protocols?.hyperflow_id || 'Não vinculado'} | Jira=${(item.protocols?.jira || []).map(j => `${j.board}-${j.issue_key}`).join(', ') || 'Pendente'}.`,
      `Estágio Atual de SLA: ${item.status} (${(SLA_STAGES[item.status] || {}).label || item.status}).`,
      `Prazo Restante: ${computeSLAHealth(item).remainingText || 'Calculado'}.`
    ];

    const inferences = [];
    const recommendations = [];

    const mfrLow = mfr.toLowerCase();
    if (mfrLow.includes('deye')) {
      if (prob.includes('F30') || prob.includes('IGBT') || prob.toLowerCase().includes('potência')) {
        inferences.push('Erro F30 Deye: Falha crítica no driver ou módulo IGBT da ponte inversora.');
        inferences.push('Políticas de Garantia Deye: Exige fotos nítidas do lacre de fábrica lateral intacto e vídeo de 10s mostrando o reinício pela chave DC.');
        recommendations.push('Registrar chamado formal de RMA na fila ADB do Jira anexando o checklist Deye.');
        recommendations.push('Orientar o técnico a testar continuidade entre terminais PV+ e PV- para a carcaça de aterramento com disjuntores abertos.');
      } else {
        inferences.push('Inversor Deye: Necessário validar versão de firmware da placa HMI e placa de controle via aplicativo Deye Cloud.');
        recommendations.push('Ajustar parâmetros de reconexão de rede (código de instalador 0001) para padrão brasileiro PRODIST ANEEL.');
      }
    } else if (mfrLow.includes('foxess')) {
      inferences.push('Inversores FoxESS: Procedimento padrão de diagnóstico requer medição de resistência de isolamento em megômetro (>1MΩ).');
      recommendations.push('Verificar logs diários de tensão alternada no portal FoxCloud para descartar sobretensão na rede da concessionária.');
      recommendations.push('Abrir protocolo no quadro GABEF com o relatório do portal para envio à assistência técnica autorizada.');
    } else if (mfrLow.includes('huawei')) {
      inferences.push('Huawei SUN2000: Sistema inteligente de detecção de arco AFCI e atuação por contatores monitorados internamente.');
      recommendations.push('Exportar o relatório completo de diagnóstico PAC (.log) via FusionSolar App.');
      recommendations.push('Formalizar abertura no portal Huawei Enterprise Support com o PAC em anexo.');
    } else if (mfrLow.includes('hoymiles')) {
      inferences.push('Microinversor Hoymiles: Requer verificação de comunicação Sub-1G / Zigbee com a DTU (Data Transfer Unit).');
      recommendations.push('Verificar LEDs do microinversor (luz vermelha intermitente = falha de rede AC; vermelha contínua = falha de hardware).');
      recommendations.push('Registrar solicitação de substituição preventiva de microinversor no S-Miles Cloud.');
    } else {
      inferences.push('Falha típica de campo: verificar conexões dos conectores MC4 e tensões Fase-Neutro e Fase-Fase.');
      recommendations.push('Efetuar medições elétricas completas com multímetro True-RMS e testar integridade do barramento de terra.');
    }

    item.tars_analysis = {
      facts: facts,
      inferences: inferences,
      recommendations: recommendations,
      generated_at: new Date().toISOString()
    };

    addTimelineEvent(item.id, {
      type: 'technical_action',
      title: 'TARS SLA Diagnostic Executed',
      detail: `TARS deduziu ${inferences.length} inferências e ${recommendations.length} recomendações operacionais.`
    });

    saveSLACaseApi(item);
    if (out) renderTarsPanel(item);

    const report = `ANÁLISE DE SLA E DIAGNÓSTICO TARS — [${item.id}]\n\n`
      + `=== FATOS CONFIRMADOS ===\n${facts.map(f => `• ${f}`).join('\n')}\n\n`
      + `=== INFERÊNCIAS TÉCNICAS E FABRICANTE ===\n${inferences.map(i => `• ${i}`).join('\n')}\n\n`
      + `=== PLANO DE AÇÃO RECOMENDADO ===\n${recommendations.map(r => `• ${r}`).join('\n')}`;

    return report;
  }

  // Parse Manufacturer WhatsApp / Email message
  function parseManufacturerMessage(item, rawText) {
    const lower = rawText.toLowerCase();
    const requirements = [];

    if (lower.includes('tensão') || lower.includes('voltagem') || lower.includes('medição') || lower.includes('multímetro')) {
      requirements.push('Medição de tensão AC no disjuntor com multímetro (fase-neutro e fase-fase)');
    }
    if (lower.includes('vídeo') || lower.includes('video') || lower.includes('gravar')) {
      requirements.push('Vídeo curto (15 a 30 segundos) gravando o visor do equipamento');
    }
    if (lower.includes('etiqueta') || lower.includes('serial') || lower.includes('sn') || lower.includes('foto')) {
      requirements.push('Foto nítida da etiqueta de número de série e placa de identificação');
    }
    if (lower.includes('nota fiscal') || lower.includes('nf') || lower.includes('fatura')) {
      requirements.push('Cópia da Nota Fiscal de compra do equipamento');
    }
    if (lower.includes('isolamento') || lower.includes('megômetro') || lower.includes('mego')) {
      requirements.push('Teste de resistência de isolamento dos strings CC');
    }

    if (!requirements.length) {
      requirements.push('Confirmação de dados adicionais e testes solicitados pelo fabricante');
    }

    // Proposed customer draft
    const customerDraft = `Olá ${item.customer?.name || 'Cliente'}! Falamos do Suporte Solar sobre o seu inversor ${item.equipment?.manufacturer || ''} (SN: ${item.equipment?.serial_numbers?.[0] || ''}). O fabricante nos solicitou o seguinte para dar andamento na garantia:\n\n${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nAssim que você nos enviar esses itens, encaminhamos de imediato para liberação. Muito obrigado!`;

    const resultBox = document.getElementById('sla-mfr-parse-result');
    if (resultBox) {
      resultBox.style.display = 'flex';
      resultBox.innerHTML = `
        <div style="background:rgba(37,211,102,0.06); border:1px solid rgba(37,211,102,0.25); border-radius:8px; padding:12px;">
          <div style="font-weight:700; font-size:0.86rem; color:#25d366; margin-bottom:6px;">✓ Requisitos Extraídos da Mensagem do Fabricante:</div>
          <ul style="margin:0 0 10px 18px; padding:0; font-size:0.84rem; color:var(--text); line-height:1.5;">
            ${requirements.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
          <div style="font-weight:600; font-size:0.82rem; margin-bottom:4px; color:var(--text);">Sugestão de Resposta para o Cliente (WhatsApp):</div>
          <textarea id="sla-mfr-cust-draft" rows="4" style="width:100%; border-radius:6px; padding:8px; background:rgba(0,0,0,0.3); border:1px solid var(--line); color:var(--text); font-size:0.82rem; outline:none; resize:vertical;">${escapeHtml(customerDraft)}</textarea>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="btn-primary" id="sla-mfr-apply-btn" style="background:#25d366; color:#111; font-weight:600; flex:1;">Aplicar & Transicionar para 'Waiting Customer'</button>
            <button class="btn-ghost" id="sla-mfr-copy-btn" style="flex:1;">Copiar Mensagem</button>
          </div>
        </div>
      `;

      document.getElementById('sla-mfr-copy-btn')?.addEventListener('click', () => {
        const txt = document.getElementById('sla-mfr-cust-draft')?.value || '';
        navigator.clipboard.writeText(txt);
        alert('Mensagem copiada para a área de transferência!');
      });

      document.getElementById('sla-mfr-apply-btn')?.addEventListener('click', () => {
        item.status = 'WAITING CUSTOMER INFO / TEST';
        item.next_action = `Aguardando cliente enviar: ${requirements.slice(0, 2).join(', ')}`;
        addTimelineEvent(item.id, {
          type: 'whatsapp_msg',
          title: 'Mensagem do Fabricante Processada',
          detail: `Fabricante solicitou: ${requirements.join('; ')}. Caso movido para WAITING CUSTOMER INFO / TEST.`
        });
        saveSLACaseApi(item);
        openSLACaseModal(item.id);
      });
    }
  }

  // Add a timeline event to a case
  function addTimelineEvent(caseId, eventObj) {
    const item = slaCases.find(c => c.id === caseId);
    if (!item) return;

    if (!item.timeline) item.timeline = [];
    item.timeline.unshift({
      id: 'evt-' + Date.now(),
      author: eventObj.author || 'Técnico Suporte',
      timestamp: new Date().toISOString(),
      ...eventObj
    });
    item.updated_at = new Date().toISOString();
  }

  // Transition case lifecycle status
  function transitionCaseStatus(caseId, newStatus, reason) {
    const item = slaCases.find(c => c.id === caseId);
    if (!item) return;

    const oldStatus = item.status;
    item.status = newStatus;
    item.updated_at = new Date().toISOString();

    addTimelineEvent(caseId, {
      type: 'status_change',
      title: `Mudança de Estado: ${oldStatus} ➔ ${newStatus}`,
      detail: reason || `Transição de ciclo de vida operacional realizada pelo técnico.`
    });

    saveSLACaseApi(item);
    openSLACaseModal(item.id);
  }

  // ============================================================================
  // CREATE / EDIT SLA CASE MODAL
  // ============================================================================
  function openNewSLAModal(prefill) {
    const modal = document.getElementById('sla-new-modal-backdrop');
    if (!modal) return;

    const title = document.getElementById('sla-form-modal-title');
    const fId = document.getElementById('sla-form-id');
    const fCust = document.getElementById('sla-form-customer');
    const fPhone = document.getElementById('sla-form-phone');
    const fMfr = document.getElementById('sla-form-mfr');
    const fModel = document.getElementById('sla-form-model');
    const fSn = document.getElementById('sla-form-sn');
    const fCat = document.getElementById('sla-form-category');
    const fPrio = document.getElementById('sla-form-priority');
    const fProb = document.getElementById('sla-form-problem');
    const fStatus = document.getElementById('sla-form-status');
    const fTech = document.getElementById('sla-form-tech');
    const fNext = document.getElementById('sla-form-next-action');

    // Populate status options
    if (fStatus) {
      fStatus.innerHTML = SLA_STAGES.map(s => `<option value="${s.key}">${s.label}</option>`).join('');
    }

    if (prefill) {
      if (title) title.textContent = prefill.id ? 'Edit SLA Case' : '+ Create SLA Case';
      if (fId) fId.value = prefill.id || '';
      if (fCust) fCust.value = prefill.customer?.name || '';
      if (fPhone) fPhone.value = prefill.customer?.phone || '';
      if (fMfr) fMfr.value = prefill.equipment?.manufacturer || 'Deye';
      if (fModel) fModel.value = prefill.equipment?.model || '';
      if (fSn) fSn.value = prefill.equipment?.serial_numbers?.[0] || '';
      if (fCat) fCat.value = prefill.equipment?.category || 'Inverter Alarm / Fault';
      if (fPrio) fPrio.value = prefill.priority || 'alta';
      if (fProb) fProb.value = prefill.problem_summary || '';
      if (fStatus) fStatus.value = prefill.status || 'NEW';
      if (fTech) fTech.value = prefill.responsible_tech || 'Suporte Solar';
      if (fNext) fNext.value = prefill.next_action || '';
    } else {
      if (title) title.textContent = '+ Create SLA Case';
      if (fId) fId.value = '';
      if (fCust) fCust.value = '';
      if (fPhone) fPhone.value = '';
      if (fMfr) fMfr.value = 'Deye';
      if (fModel) fModel.value = '';
      if (fSn) fSn.value = '';
      if (fProb) fProb.value = '';
      if (fStatus) fStatus.value = 'NEW';
      if (fTech) fTech.value = 'Suporte Solar';
      if (fNext) fNext.value = '';
    }

    modal.classList.add('visible');
  }

  function closeNewSLAModal() {
    const modal = document.getElementById('sla-new-modal-backdrop');
    if (modal) modal.classList.remove('visible');
  }

  // Handle SLA form submission
  function handleSLAFormSubmit(e) {
    e.preventDefault();

    const fId = document.getElementById('sla-form-id').value;
    const customerName = document.getElementById('sla-form-customer').value.trim();
    const phone = document.getElementById('sla-form-phone').value.trim();
    const mfr = document.getElementById('sla-form-mfr').value;
    const model = document.getElementById('sla-form-model').value.trim();
    const sn = document.getElementById('sla-form-sn').value.trim();
    const category = document.getElementById('sla-form-category').value;
    const priority = document.getElementById('sla-form-priority').value;
    const problem = document.getElementById('sla-form-problem').value.trim();
    const status = document.getElementById('sla-form-status').value;
    const tech = document.getElementById('sla-form-tech').value.trim() || 'Suporte Solar';
    const nextAction = document.getElementById('sla-form-next-action').value.trim();

    const limitHours = PRIORITY_HOURS[priority] || 24;
    const now = new Date();
    const deadline = new Date(now.getTime() + limitHours * 3600000).toISOString();

    let slaObj;
    if (fId) {
      // Edit existing
      slaObj = slaCases.find(c => c.id === fId);
      if (slaObj) {
        slaObj.customer.name = customerName;
        slaObj.customer.phone = phone;
        slaObj.equipment.manufacturer = mfr;
        slaObj.equipment.model = model;
        slaObj.equipment.serial_numbers = [sn];
        slaObj.equipment.category = category;
        slaObj.priority = priority;
        slaObj.problem_summary = problem;
        slaObj.status = status;
        slaObj.responsible_tech = tech;
        slaObj.next_action = nextAction;
        slaObj.updated_at = now.toISOString();

        addTimelineEvent(slaObj.id, {
          type: 'status_change',
          title: 'Case Updated',
          detail: `Case details updated by technician.`
        });
      }
    } else {
      // Create new
      const nextNum = 1000 + slaCases.length + 1;
      const newId = `SLA-${nextNum}`;

      slaObj = {
        id: newId,
        customer: {
          name: customerName,
          phone: phone,
          email: '',
          site_location: ''
        },
        equipment: {
          manufacturer: mfr,
          model: model,
          serial_numbers: [sn],
          category: category,
          firmware: ''
        },
        status: status,
        priority: priority,
        problem_summary: problem,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        sla_deadline: deadline,
        sla_limit_hours: limitHours,
        responsible_tech: tech,
        next_action: nextAction || 'Perform initial technical triage and review fault logs',
        protocols: {
          hyperflow_id: '',
          jira: []
        },
        timeline: [
          {
            id: 'evt-0',
            type: 'status_change',
            title: `SLA Case ${newId} Created`,
            detail: `Priority ${priority.toUpperCase()} (${limitHours}h SLA target). Assigned to ${tech}.`,
            author: tech,
            timestamp: now.toISOString()
          }
        ],
        files: []
      };
    }

    saveSLACaseApi(slaObj);
    closeNewSLAModal();
    openSLACaseModal(slaObj.id);
  }

  // ============================================================================
  // TARS BRIDGE INTAKE & SN EXTRACTOR MODAL
  // ============================================================================
  function openBridgeIntakeModal() {
    const modal = document.getElementById('sla-bridge-intake-modal-backdrop');
    if (!modal) return;

    const rawText = document.getElementById('sla-intake-raw-text');
    const reviewBox = document.getElementById('sla-intake-review-box');
    if (reviewBox) reviewBox.style.display = 'none';

    // Check if VisionBridge has pending data
    if (window.VisionBridge && typeof window.VisionBridge.takeFrame === 'function') {
      const frame = window.VisionBridge.takeFrame();
      if (frame && (frame.domText || frame.thread || frame.selection)) {
        let content = '';
        if (frame.thread && frame.thread.messages) {
          content = frame.thread.messages.map(m => `${m.sender}: ${m.text}`).join('\n');
        } else {
          content = frame.selection || frame.domText || '';
        }
        if (rawText) rawText.value = content;
        runIntakeExtraction(content);
      }
    }

    modal.classList.add('visible');
  }

  function closeBridgeIntakeModal() {
    const modal = document.getElementById('sla-bridge-intake-modal-backdrop');
    if (modal) modal.classList.remove('visible');
  }

  async function runIntakeExtraction(text) {
    if (!text || !text.trim()) {
      alert('Please paste conversation text or pull from active bridge first.');
      return;
    }

    const extractBtn = document.getElementById('sla-intake-extract-btn');
    const origBtnText = extractBtn ? extractBtn.innerHTML : '';
    if (extractBtn) {
      extractBtn.innerHTML = '⚡ TARS AI Disambiguating...';
      extractBtn.disabled = true;
    }

    try {
      const res = await SNEngine.intakeTranscriptWithTARS(text);
      const reviewBox = document.getElementById('sla-intake-review-box');
      const elOverallConf = document.getElementById('sla-intake-overall-conf');
      const elCust = document.getElementById('sla-intake-customer');
      const elPhone = document.getElementById('sla-intake-phone');
      const elMfr = document.getElementById('sla-intake-mfr');
      const elModel = document.getElementById('sla-intake-model');
      const elSn = document.getElementById('sla-intake-sn');
      const elProblem = document.getElementById('sla-intake-problem');
      const elCandidates = document.getElementById('sla-intake-sn-candidates');
      const elSnConf = document.getElementById('sla-intake-sn-conf');
      const elDisambigBox = document.getElementById('sla-intake-disambiguation-box');
      const elDisambigList = document.getElementById('sla-intake-disambiguation-list');
      const elEngineSource = document.getElementById('sla-intake-engine-source');

      if (reviewBox) reviewBox.style.display = 'flex';

      const pct = Math.round((res.confidence?.overall || 0.8) * 100);
      if (elOverallConf) {
        elOverallConf.textContent = `${pct}% Confidence`;
        elOverallConf.className = `conf-badge ${pct >= 80 ? 'conf-high' : pct >= 50 ? 'conf-mid' : 'conf-low'}`;
      }

      if (elCust) elCust.value = res.customer?.name || '';
      if (elPhone) elPhone.value = res.customer?.phone || '';
      if (elMfr) elMfr.value = res.equipment?.manufacturer || 'Other';
      if (elModel) elModel.value = res.equipment?.model || '';
      if (elSn) elSn.value = res.equipment?.serial_number || '';
      if (elProblem) elProblem.value = res.problem_summary || '';

      if (elSnConf && res.confidence?.sn) {
        const snPct = Math.round(res.confidence.sn * 100);
        elSnConf.innerHTML = `<span class="conf-badge ${snPct >= 80 ? 'conf-high' : 'conf-mid'}" style="font-size:0.7rem; padding:1px 6px;">${snPct}% confidence</span>`;
      }

      // Render SN candidate chips
      if (elCandidates) {
        const cands = res.equipment?.candidates || [];
        if (cands.length > 1) {
          elCandidates.innerHTML = `
            <div style="font-size:0.75rem; color:var(--muted); width:100%; margin-bottom:2px;">Other detected SN candidates (click to select):</div>
            ${cands.map(c => `
              <button type="button" class="btn-ghost" data-snval="${escapeHtml(c.value)}" style="font-family:monospace; font-size:0.78rem; padding:2px 8px; border:1px solid var(--line);">
                ${escapeHtml(c.value)} (${Math.round((c.confidence || 0.8) * 100)}%)
              </button>
            `).join('')}
          `;
          elCandidates.querySelectorAll('[data-snval]').forEach(btn => {
            btn.addEventListener('click', () => {
              if (elSn) elSn.value = btn.dataset.snval;
            });
          });
        } else {
          elCandidates.innerHTML = '';
        }
      }

      // Render TARS Disambiguation Log
      if (elDisambigBox && elDisambigList) {
        const log = res.disambiguation_log || [];
        if (elEngineSource) {
          elEngineSource.textContent = res.source === 'gemini_ai' ? '🤖 TARS Gemini 3.8 Flash' : '⚡ Heuristic ML';
        }
        if (log.length > 0) {
          elDisambigBox.style.display = 'block';
          const typeBadgeStyles = {
            serial_number: 'background:rgba(52,211,153,0.15); color:#34d399; border:1px solid rgba(52,211,153,0.3);',
            phone: 'background:rgba(96,165,250,0.15); color:#60a5fa; border:1px solid rgba(96,165,250,0.3);',
            protocol: 'background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3);',
            measurement: 'background:rgba(192,132,252,0.15); color:#c084fc; border:1px solid rgba(192,132,252,0.3);',
            cep: 'background:rgba(244,114,182,0.15); color:#f472b6; border:1px solid rgba(244,114,182,0.3);',
            model: 'background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);',
            other: 'background:rgba(255,255,255,0.06); color:var(--muted); border:1px solid var(--line);'
          };
          const typeLabels = {
            serial_number: 'SERIAL NUMBER (SN)',
            phone: 'PHONE NUMBER',
            protocol: 'PROTOCOL / TICKET',
            measurement: 'MEASUREMENT / UNIT',
            cep: 'POSTAL CODE (CEP)',
            model: 'EQUIPMENT MODEL',
            other: 'IDENTIFIER'
          };

          elDisambigList.innerHTML = log.map(item => `
            <div style="display:flex; align-items:flex-start; gap:8px; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.05);">
              <span style="display:inline-block; font-size:0.68rem; font-weight:700; padding:1px 6px; border-radius:4px; font-family:monospace; white-space:nowrap; ${typeBadgeStyles[item.classified_as] || typeBadgeStyles.other}">
                ${typeLabels[item.classified_as] || item.classified_as.toUpperCase()}
              </span>
              <div style="flex:1;">
                <strong style="font-family:monospace; color:var(--text);">${escapeHtml(item.token)}</strong>:
                <span style="color:var(--muted);">${escapeHtml(item.reason)}</span>
              </div>
            </div>
          `).join('');
        } else {
          elDisambigBox.style.display = 'none';
        }
      }
    } finally {
      if (extractBtn) {
        extractBtn.innerHTML = origBtnText;
        extractBtn.disabled = false;
      }
    }
  }

  function confirmBridgeIntake() {
    const rawText = document.getElementById('sla-intake-raw-text').value;
    const customerName = document.getElementById('sla-intake-customer').value.trim();
    const phone = document.getElementById('sla-intake-phone').value.trim();
    const mfr = document.getElementById('sla-intake-mfr').value;
    const model = document.getElementById('sla-intake-model').value.trim();
    const sn = document.getElementById('sla-intake-sn').value.trim();
    const problem = document.getElementById('sla-intake-problem').value.trim();
    const priority = document.getElementById('sla-intake-priority').value;
    const status = document.getElementById('sla-intake-status').value;

    const limitHours = PRIORITY_HOURS[priority] || 24;
    const now = new Date();
    const nextNum = 1000 + slaCases.length + 1;
    const newId = `SLA-${nextNum}`;

    const newCase = {
      id: newId,
      customer: { name: customerName, phone: phone, email: '', site_location: '' },
      equipment: {
        manufacturer: mfr,
        model: model,
        serial_numbers: [sn],
        category: 'Inverter Alarm / Fault',
        firmware: ''
      },
      status: status,
      priority: priority,
      problem_summary: problem,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      sla_deadline: new Date(now.getTime() + limitHours * 3600000).toISOString(),
      sla_limit_hours: limitHours,
      responsible_tech: 'Suporte Solar',
      next_action: 'Contatar fabricante ou cliente para prosseguir com diagnóstico',
      protocols: {
        hyperflow_id: 'HF-' + Math.floor(1000 + Math.random() * 9000),
        jira: []
      },
      conversation: {
        source: 'Hyperflow / TARS Bridge',
        channel: 'WhatsApp',
        messages: [
          { sender: 'customer', text: rawText.slice(0, 500), time: 'Intake' }
        ]
      },
      timeline: [
        {
          id: 'evt-0',
          type: 'hyperflow_msg',
          title: 'Conversa Importada via TARS Bridge',
          detail: `Caso criado com SN ${sn} extraído com confirmação do técnico.`,
          author: 'TARS Bridge',
          timestamp: now.toISOString()
        }
      ],
      files: []
    };

    saveSLACaseApi(newCase);
    closeBridgeIntakeModal();
    openSLACaseModal(newCase.id);
  }

  // ============================================================================
  // INITIALIZATION & EVENT BINDINGS
  // ============================================================================
  function initSLAHub() {
    // Top actions
    document.getElementById('sla-new-btn')?.addEventListener('click', () => openNewSLAModal());
    document.getElementById('sla-bridge-intake-btn')?.addEventListener('click', () => openBridgeIntakeModal());
    document.getElementById('sla-legacy-notes-btn')?.addEventListener('click', () => {
      // Toggle to notebooks view for unassigned notes
      if (typeof window.switchView === 'function') {
        window.switchView('notebooks');
      }
    });

    // Stat card filter clicks
    document.querySelectorAll('.sla-stat-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.sla-stat-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        slaFilter = card.dataset.slaf || 'all';

        // sync pills
        document.querySelectorAll('.sla-f-pill').forEach(p => {
          p.classList.toggle('active', p.dataset.slaf === slaFilter);
        });

        renderSLACasesGrid();
      });
    });

    // Filter pills
    document.querySelectorAll('.sla-f-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.sla-f-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        slaFilter = pill.dataset.slaf || 'all';
        renderSLACasesGrid();
      });
    });

    // Search input
    const searchInput = document.getElementById('sla-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        slaSearchQuery = e.target.value;
        renderSLACasesGrid();
      });
    }

    // Sort select
    const sortSelect = document.getElementById('sla-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        slaSort = e.target.value;
        renderSLACasesGrid();
      });
    }

    // Case Modal Tab Navigation
    document.querySelectorAll('.sla-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.slatab;
        switchSLAModalTab(tab);
      });
    });

    // Case Modal Close
    document.getElementById('sla-modal-close-btn')?.addEventListener('click', closeSLACaseModal);
    document.getElementById('sla-case-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'sla-case-modal-backdrop') closeSLACaseModal();
    });

    // Form Modal bindings
    document.getElementById('sla-new-modal-close')?.addEventListener('click', closeNewSLAModal);
    document.getElementById('sla-new-modal-cancel')?.addEventListener('click', closeNewSLAModal);
    document.getElementById('sla-case-form')?.addEventListener('submit', handleSLAFormSubmit);

    // Bridge Intake Modal bindings
    document.getElementById('sla-intake-modal-close')?.addEventListener('click', closeBridgeIntakeModal);
    document.getElementById('sla-intake-cancel')?.addEventListener('click', closeBridgeIntakeModal);
    document.getElementById('sla-intake-extract-btn')?.addEventListener('click', () => {
      const txt = document.getElementById('sla-intake-raw-text')?.value;
      runIntakeExtraction(txt);
    });
    document.getElementById('sla-intake-pull-active-btn')?.addEventListener('click', () => {
      if (window.VisionBridge && typeof window.VisionBridge.takeFrame === 'function') {
        const frame = window.VisionBridge.takeFrame();
        if (frame && (frame.domText || frame.thread || frame.selection)) {
          let content = '';
          if (frame.thread && frame.thread.messages) {
            content = frame.thread.messages.map(m => `${m.sender}: ${m.text}`).join('\n');
          } else {
            content = frame.selection || frame.domText || '';
          }
          document.getElementById('sla-intake-raw-text').value = content;
          runIntakeExtraction(content);
        } else {
          alert('No active conversation frame received from Hyperflow bridge yet.');
        }
      } else {
        alert('Bridge is not installed or active.');
      }
    });
    document.getElementById('sla-intake-confirm-btn')?.addEventListener('click', confirmBridgeIntake);

    // Case Modal sub-actions
    document.getElementById('sla-modal-add-event-btn')?.addEventListener('click', () => {
      document.getElementById('sla-event-modal-backdrop')?.classList.add('visible');
    });
    document.getElementById('sla-event-modal-close')?.addEventListener('click', () => {
      document.getElementById('sla-event-modal-backdrop')?.classList.remove('visible');
    });
    document.getElementById('sla-event-cancel')?.addEventListener('click', () => {
      document.getElementById('sla-event-modal-backdrop')?.classList.remove('visible');
    });
    document.getElementById('sla-event-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!currentSLACase) return;
      const type = document.getElementById('sla-event-type').value;
      const title = document.getElementById('sla-event-title').value.trim();
      const detail = document.getElementById('sla-event-detail').value.trim();

      addTimelineEvent(currentSLACase.id, { type, title, detail });
      saveSLACaseApi(currentSLACase);
      renderTimelinePanel(currentSLACase);
      document.getElementById('sla-event-modal-backdrop')?.classList.remove('visible');
      document.getElementById('sla-event-form').reset();
    });

    // Notes Sub-Tab bindings
    document.getElementById('sla-new-case-note-btn')?.addEventListener('click', () => {
      if (currentSLACase) createCaseNote(currentSLACase);
    });
    document.getElementById('sla-attach-unassigned-note-btn')?.addEventListener('click', () => {
      if (!currentSLACase) return;
      const nTitle = prompt('Enter keyword from note title to attach:');
      if (nTitle && window.notes) {
        const match = window.notes.find(n => (n.title || '').toLowerCase().includes(nTitle.toLowerCase()));
        if (match) {
          match.sla_case_id = currentSLACase.id;
          match.tags = Array.from(new Set([...(match.tags || []), 'sla', currentSLACase.id]));
          if (typeof window.updateNoteApi === 'function') {
            window.updateNoteApi(match.id, match);
          }
          renderNotesSubTab(currentSLACase);
          alert(`Attached note "${match.title}" to ${currentSLACase.id}`);
        } else {
          alert('No note found matching that keyword.');
        }
      }
    });

    // Protocols Save binding
    document.getElementById('sla-proto-save-btn')?.addEventListener('click', () => {
      if (!currentSLACase) return;
      const hfVal = document.getElementById('sla-proto-hf-input')?.value.trim();
      const board = document.getElementById('sla-proto-jira-board')?.value;
      const issueKey = document.getElementById('sla-proto-jira-num')?.value.trim();

      if (!currentSLACase.protocols) currentSLACase.protocols = {};
      currentSLACase.protocols.hyperflow_id = hfVal;
      if (issueKey) {
        currentSLACase.protocols.jira = [
          { board: board, issue_key: issueKey, summary: `Warranty protocol for ${currentSLACase.id}`, status: 'In Progress' }
        ];
      }
      addTimelineEvent(currentSLACase.id, {
        type: 'jira_update',
        title: 'Protocols Updated',
        detail: `Hyperflow: ${hfVal || 'None'} | Jira: ${board}-${issueKey || 'None'}`
      });
      saveSLACaseApi(currentSLACase);
      renderProtocolsPanel(currentSLACase);
      alert('Protocols saved successfully!');
    });

    // Jira Open Button
    document.getElementById('sla-proto-jira-open-btn')?.addEventListener('click', () => {
      const board = document.getElementById('sla-proto-jira-board')?.value || 'ADB';
      const rawNum = document.getElementById('sla-proto-jira-num')?.value.trim();
      const primaryJira = currentSLACase?.protocols?.jira?.[0];
      const targetKey = rawNum || primaryJira?.issue_key;

      if (!targetKey) {
        alert('Please enter a Jira protocol issue key or create an issue first.');
        return;
      }

      const fullKey = targetKey.includes('-') ? targetKey : `${board}-${targetKey}`;
      const host = window.jiraConfig?.host || (primaryJira?.url ? new URL(primaryJira.url).host : null);

      if (host) {
        window.open(`https://${host}/browse/${fullKey}`, '_blank');
      } else {
        alert(`Jira Issue Key: [${fullKey}]\n\nTip: Configure your Jira Cloud host in Settings → Integrations → Jira to open tickets directly with a single click.`);
      }
    });

    // Jira Create Issue Button
    document.getElementById('sla-proto-jira-create-btn')?.addEventListener('click', async () => {
      if (!currentSLACase) return;
      const spinner = document.getElementById('sla-proto-jira-spinner');
      const feedback = document.getElementById('sla-proto-jira-feedback');
      const board = document.getElementById('sla-proto-jira-board')?.value || 'ADB';

      if (spinner) spinner.style.display = 'inline-block';
      if (feedback) {
        feedback.style.color = 'var(--amber)';
        feedback.textContent = `Dispatching warranty claim to Jira [${board}]...`;
      }

      try {
        const payload = {
          slaCaseId: currentSLACase.id,
          projectKey: board,
          summary: `[${currentSLACase.id}] Inversor ${currentSLACase.equipment?.manufacturer || ''} - ${currentSLACase.customer?.name || 'Cliente'}`,
          description: currentSLACase.problem_summary || 'Anomalia técnica em inversor solar registrada no Solar Agenda',
          priority: currentSLACase.priority,
          customerName: currentSLACase.customer?.name,
          customerPhone: currentSLACase.customer?.phone,
          serialNumber: currentSLACase.equipment?.serial_numbers?.[0] || '',
          equipmentModel: currentSLACase.equipment?.model || '',
          manufacturer: currentSLACase.equipment?.manufacturer || ''
        };

        const res = await fetch('/api/jira/issue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to create Jira issue');

        const created = data.issue;
        const key = created.key;

        if (!currentSLACase.protocols) currentSLACase.protocols = {};
        if (!Array.isArray(currentSLACase.protocols.jira)) currentSLACase.protocols.jira = [];

        const existingIdx = currentSLACase.protocols.jira.findIndex(j => j.issue_key === key);
        const jiraRecord = {
          board: board,
          issue_key: key,
          summary: created.summary || payload.summary,
          status: created.status || 'Created',
          url: created.url,
          created_at: new Date().toISOString()
        };

        if (existingIdx >= 0) {
          currentSLACase.protocols.jira[existingIdx] = jiraRecord;
        } else {
          currentSLACase.protocols.jira.unshift(jiraRecord);
        }

        addTimelineEvent(currentSLACase.id, {
          type: 'jira_update',
          title: `Protocolo Jira Gerado: ${key}`,
          detail: `Ticket formal criado na fila ${board}. Status: ${created.status || 'Open'}`
        });

        saveSLACaseApi(currentSLACase);
        renderProtocolsPanel(currentSLACase);
        renderSLADashboard();

        if (feedback) {
          feedback.style.color = 'var(--teal)';
          feedback.innerHTML = `✅ Ticket <b>${key}</b> criado com sucesso no Jira! ${created.isSimulated ? '(Modo Demonstração / Sandbox)' : ''}`;
        }
      } catch (err) {
        if (feedback) {
          feedback.style.color = 'var(--urgente)';
          feedback.textContent = `Erro ao gerar Jira: ${err.message}`;
        }
      } finally {
        if (spinner) spinner.style.display = 'none';
      }
    });

    // Jira Sync Status Button
    document.getElementById('sla-proto-jira-sync-btn')?.addEventListener('click', async () => {
      if (!currentSLACase) return;
      const spinner = document.getElementById('sla-proto-jira-spinner');
      const feedback = document.getElementById('sla-proto-jira-feedback');
      const numInput = document.getElementById('sla-proto-jira-num')?.value.trim();
      const board = document.getElementById('sla-proto-jira-board')?.value || 'ADB';
      const targetKey = numInput || currentSLACase.protocols?.jira?.[0]?.issue_key;

      if (!targetKey) {
        if (feedback) {
          feedback.style.color = 'var(--urgente)';
          feedback.textContent = 'Informe ou gere a chave do ticket Jira antes de sincronizar.';
        }
        return;
      }

      const fullKey = targetKey.includes('-') ? targetKey : `${board}-${targetKey}`;

      if (spinner) spinner.style.display = 'inline-block';
      if (feedback) {
        feedback.style.color = 'var(--amber)';
        feedback.textContent = `Sincronizando status de [${fullKey}] com Jira Cloud...`;
      }

      try {
        const res = await fetch(`/api/jira/issue/${encodeURIComponent(fullKey)}/sync`, {
          method: 'POST'
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to sync Jira ticket');

        const issue = data.issue;
        if (!currentSLACase.protocols) currentSLACase.protocols = {};
        if (!Array.isArray(currentSLACase.protocols.jira)) currentSLACase.protocols.jira = [];

        const jIdx = currentSLACase.protocols.jira.findIndex(j => j.issue_key === fullKey || j.issue_key === targetKey);
        if (jIdx >= 0) {
          currentSLACase.protocols.jira[jIdx].status = issue.status;
          currentSLACase.protocols.jira[jIdx].last_synced = new Date().toISOString();
        } else {
          currentSLACase.protocols.jira.push({
            board: board,
            issue_key: fullKey,
            status: issue.status,
            summary: issue.summary,
            last_synced: new Date().toISOString()
          });
        }

        saveSLACaseApi(currentSLACase);
        renderProtocolsPanel(currentSLACase);
        renderSLADashboard();

        if (feedback) {
          feedback.style.color = 'var(--teal)';
          feedback.textContent = `✅ Status atualizado via Jira: ${issue.status} (${issue.statusCategory || ''})`;
        }
      } catch (err) {
        if (feedback) {
          feedback.style.color = 'var(--urgente)';
          feedback.textContent = `Erro ao sincronizar Jira: ${err.message}`;
        }
      } finally {
        if (spinner) spinner.style.display = 'none';
      }
    });

    // TARS Run Analysis button
    document.getElementById('sla-run-tars-btn')?.addEventListener('click', () => {
      if (currentSLACase) runTarsSLAAnalysis(currentSLACase);
    });

    // Manufacturer Parser button
    document.getElementById('sla-mfr-parse-btn')?.addEventListener('click', () => {
      if (!currentSLACase) return;
      const msg = document.getElementById('sla-mfr-msg-input')?.value.trim();
      if (!msg) {
        alert('Please paste message received from manufacturer technical support.');
        return;
      }
      parseManufacturerMessage(currentSLACase, msg);
    });

    // Dropzone upload simulation
    const dropzone = document.getElementById('sla-files-dropzone');
    const fileInput = document.getElementById('sla-file-input');
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        if (!currentSLACase || !e.target.files.length) return;
        const file = e.target.files[0];
        if (!currentSLACase.files) currentSLACase.files = [];
        currentSLACase.files.push({
          name: file.name,
          size: `${Math.round(file.size / 1024)} KB`,
          type: file.type,
          url: '#'
        });
        addTimelineEvent(currentSLACase.id, {
          type: 'technical_action',
          title: 'Arquivo Anexado',
          detail: `Arquivo "${file.name}" anexado à documentação técnica do caso.`
        });
        saveSLACaseApi(currentSLACase);
        renderFilesPanel(currentSLACase);
        alert(`Arquivo "${file.name}" anexado com sucesso!`);
      });
    }

    // Initial Load
    loadSLACases();
  }

  // Expose API on window
  window.SLAHub = {
    init: initSLAHub,
    load: loadSLACases,
    refresh: loadSLACases,
    render: renderSLACasesGrid,
    openCase: openSLACaseModal,
    openNew: openNewSLAModal,
    openIntake: openBridgeIntakeModal,
    runTarsSLAAnalysis: runTarsSLAAnalysis,
    SNEngine: SNEngine,
    computeHealth: computeSLAHealth,
    getStages: () => SLA_STAGES
  };

  // Auto initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSLAHub);
  } else {
    initSLAHub();
  }

})(window);
