import fs from "fs";
import path from "path";

const CWD_STORAGE = path.join(process.cwd(), ".app_storage.json");
const TMP_STORAGE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function getStoragePath() {
  try {
    if (fs.existsSync(CWD_STORAGE)) {
      // Test writability
      fs.accessSync(CWD_STORAGE, fs.constants.R_OK | fs.constants.W_OK);
      return CWD_STORAGE;
    }
  } catch (_) {}
  return TMP_STORAGE;
}

export function readAppStorage() {
  const target = getStoragePath();
  try {
    if (fs.existsSync(target)) {
      return JSON.parse(fs.readFileSync(target, "utf-8"));
    }
  } catch (_) {}
  // Fallback to reading CWD if TMP was empty
  if (target !== CWD_STORAGE && fs.existsSync(CWD_STORAGE)) {
    try {
      return JSON.parse(fs.readFileSync(CWD_STORAGE, "utf-8"));
    } catch (_) {}
  }
  return {};
}

export function writeAppStorage(partial) {
  const target = getStoragePath();
  const current = readAppStorage();
  const merged = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(target, JSON.stringify(merged, null, 2), "utf-8");
  } catch (err) {
    try {
      fs.writeFileSync(TMP_STORAGE, JSON.stringify(merged, null, 2), "utf-8");
    } catch (_) {}
  }
  return merged;
}

export function computeConfidenceLevel(confidence) {
  if (confidence >= 0.85) return "HIGH";
  if (confidence >= 0.60) return "MEDIUM";
  return "LOW";
}

export function getDefaultObserverCases() {
  const now = new Date();
  const tMinus1h = new Date(now.getTime() - 3600000).toISOString();
  const tMinus30m = new Date(now.getTime() - 1800000).toISOString();
  const tMinus20m = new Date(now.getTime() - 1200000).toISOString();
  const tMinus18m = new Date(now.getTime() - 1080000).toISOString();
  const tMinus15m = new Date(now.getTime() - 900000).toISOString();
  const tMinus12m = new Date(now.getTime() - 720000).toISOString();
  const tMinus10m = new Date(now.getTime() - 600000).toISOString();
  const tMinus5m = new Date(now.getTime() - 300000).toISOString();
  const tNow = now.toISOString();

  return [
    {
      id: "TARS-OBS-HF-2041",
      protocol: "HF-2041",
      conversationId: "conv_hf_98412",
      status: "HUMAN_REVIEW",
      customer: {
        name: "Carlos Eduardo Ribeiro (SolarTech Campinas)",
        phone: "+55 19 98741-2099",
        email: "carlos@solartechcampinas.com.br",
        protocol: "HF-2041"
      },
      equipment: {
        manufacturer: "Deye",
        model: "SUN-8K-SG01LP1-EU",
        serialNumbers: ["230419824102"],
        sn: "230419824102"
      },
      timeline: [
        {
          id: "tl-obs-init",
          eventType: "OBSERVER_ATTACHED",
          timestamp: tMinus1h,
          title: "TARS Observer Attached",
          detail: "Bridge v1.2.83 attached to Hyperflow tab. Passive monitoring active (Zero Customer Interaction safety boundary enforced).",
          author: "TARS Vision Bridge v1.2.83"
        },
        {
          id: "tl-obs-msg1",
          eventType: "HYPERFLOW_MESSAGE",
          timestamp: tMinus30m,
          title: "Cliente enviou foto e relato de alarme F30",
          detail: "Mensagem recebida com foto da tela do inversor exibindo erro F30 e relé estalando.",
          author: "Carlos Eduardo Ribeiro"
        },
        {
          id: "tl-obs-hr",
          eventType: "HUMAN_REVIEW_REQUIRED",
          timestamp: tMinus10m,
          title: "Revisão Humana Necessária (Baixa Confiança Visual)",
          detail: "Foto da etiqueta do equipamento apresentando reflexo intenso. Código de falha F30 detectado com ambiguidade de rede CA.",
          author: "TARS AI Diagnostic Engine"
        }
      ],
      messages: [
        {
          messageId: "msg-hf-101",
          direction: "incoming",
          speaker: "customer",
          timestamp: tMinus30m,
          capturedAt: tMinus30m,
          text: "Boa tarde suporte! Nosso inversor Deye 8kW está piscando luz vermelha de falha F30 e não injeta nada na rede. Segue foto da tela e medições.",
          attachmentCount: 2
        },
        {
          messageId: "msg-hf-102",
          direction: "outbound",
          speaker: "technician",
          timestamp: tMinus20m,
          capturedAt: tMinus20m,
          text: "Olá Carlos! Por gentileza, nos envie a foto da etiqueta lateral com o número de série e a medição de tensão AC entre fase e neutro.",
          attachmentCount: 0
        },
        {
          messageId: "msg-hf-103",
          direction: "incoming",
          speaker: "customer",
          timestamp: tMinus15m,
          capturedAt: tMinus15m,
          text: "Medição deu 223V estável na entrada. O serial é 230419824102. O relé estala 3 vezes e desliga.",
          attachmentCount: 1
        }
      ],
      technicianActions: [
        {
          id: "act-1",
          actionType: "LOOKUP_PORTAL",
          timestamp: tMinus18m,
          target: "Deye Cloud Solarman Monitoring Portal",
          notes: "Técnico consultou telemetria remota do inversor"
        }
      ],
      technicalEvidence: [
        {
          id: "ev-1",
          type: "alarm_code",
          value: "F30 (AC Overcurrent / Relay Failure)",
          timestamp: tMinus30m,
          source: "Foto da tela do LCD Deye",
          notes: "Alarme persistente durante tentativa de sincronismo à rede"
        },
        {
          id: "ev-2",
          type: "measurement",
          value: "Vac = 223V (Fase-Neutro)",
          timestamp: tMinus15m,
          source: "Multímetro Fluke enviado pelo integrador",
          notes: "Tensão dentro dos limites aceitáveis da concessionária (220V ± 5%)"
        }
      ],
      aiObservations: [
        {
          id: "obs-1",
          timestamp: tMinus30m,
          category: "fault_diagnosis",
          title: "Detecção de Alarme F30 - Deye Híbrido",
          detail: "Alarme F30 indica acoplamento com falha no relé de injeção ou sobrecorrente instantânea CA.",
          suggestedAction: "Solicitar laudo de medição de impedância de aterramento e isolamento CC (Riso).",
          confidence: 0.88,
          confidenceLevel: "HIGH",
          needsHumanReview: false,
          uncertainties: []
        },
        {
          id: "obs-2",
          timestamp: tMinus15m,
          category: "photo_ocr",
          title: "Identificação do Serial Number",
          detail: "OCR identificou S/N 230419824102 na etiqueta lateral com 85% de nitidez.",
          confidence: 0.85,
          confidenceLevel: "HIGH",
          needsHumanReview: false,
          uncertainties: []
        },
        {
          id: "obs-3",
          timestamp: tMinus10m,
          category: "warranty_assessment",
          title: "Incerteza: Reflexo na foto do medidor CA",
          detail: "Imagem de medição contém reflexo solar obstruindo visualização parcial da frequência em Hertz.",
          suggestedAction: "Técnico humano deve checar visualmente se a frequência está em 60Hz antes de aprovar garantia.",
          confidence: 0.45,
          confidenceLevel: "LOW",
          needsHumanReview: true,
          uncertainties: ["Reflexo óptico na escala Hz do multímetro"]
        }
      ],
      confidence: 0.45,
      confidenceLevel: "LOW",
      needsHumanReview: true,
      uncertainties: [
        "Inconsistência visual na confirmação de frequência da rede CA",
        "Necessidade de validar integridade dos varistores DPS internos"
      ],
      humanCorrections: [],
      humanAnalysis: {
        technicianConclusion: "Aguardando confirmação técnica de 60Hz pelo integrador.",
        electricalConformity: "Tensão 223V compatível. Pendente conferência de frequência.",
        analyzedBy: "Eng. Rafael Costa",
        analyzedAt: tMinus5m
      },
      finalDiagnosis: "Possível dano no contator de acoplamento CA após surto atmosférico.",
      finalResolution: "",
      attachments: [],
      learningMetadata: {
        isValidated: false,
        validatedAt: null,
        validatedBy: null,
        isTrainingCandidate: false,
        candidateReason: null,
        tags: ["deye", "alarme-f30", "rele-ac", "baixa-confianca-foto"]
      },
      createdAt: tMinus1h,
      updatedAt: tMinus5m
    },
    {
      id: "TARS-OBS-HF-1988",
      protocol: "HF-1988",
      conversationId: "conv_hf_77192",
      status: "CLOSED",
      customer: {
        name: "Marcos Vinicius (Energia Limpa Soluções)",
        phone: "+55 31 99123-5500",
        email: "marcos@energialimpa.com",
        protocol: "HF-1988"
      },
      equipment: {
        manufacturer: "Hoymiles",
        model: "HMS-2000-4T",
        serialNumbers: ["112182049581"],
        sn: "112182049581"
      },
      timeline: [
        {
          id: "tl-2",
          eventType: "CASE_CREATED",
          timestamp: tMinus1h,
          title: "Atendimento Iniciado - Cadastro Hoymiles",
          detail: "Solicitação de cadastro de instalador no portal S-Miles Cloud.",
          author: "Marcos Vinicius"
        },
        {
          id: "tl-3",
          eventType: "CASE_CLOSED",
          timestamp: tMinus10m,
          title: "Caso Validado & Concluído",
          detail: "Conta instalador criada com sucesso e credenciais enviadas.",
          author: "Suporte Solar"
        }
      ],
      messages: [
        {
          messageId: "msg-201",
          direction: "incoming",
          speaker: "customer",
          timestamp: tMinus1h,
          capturedAt: tMinus1h,
          text: "Preciso liberar acesso de instalador para a conta marcos@energialimpa.com no S-Miles Cloud.",
          attachmentCount: 0
        },
        {
          messageId: "msg-202",
          direction: "outbound",
          speaker: "technician",
          timestamp: tMinus10m,
          capturedAt: tMinus10m,
          text: "Conta criada com sucesso e vinculada à sua distribuidora! Senha temporária enviada via email.",
          attachmentCount: 0
        }
      ],
      technicianActions: [
        {
          id: "act-hoy",
          actionType: "ACCOUNT_CREATION",
          timestamp: tMinus10m,
          target: "global.hoymiles.com (S-Miles Cloud)",
          notes: "Criada organização instaladora e usuário vinculado."
        }
      ],
      technicalEvidence: [],
      aiObservations: [
        {
          id: "obs-hoy-1",
          timestamp: tMinus1h,
          category: "account_workflow",
          title: "Fluxo Automatizado Hoymiles",
          detail: "Solicitação padrão de criação de conta de instalador Hoymiles identificada com alta confiança.",
          confidence: 0.98,
          confidenceLevel: "HIGH",
          needsHumanReview: false,
          uncertainties: []
        }
      ],
      confidence: 0.98,
      confidenceLevel: "HIGH",
      needsHumanReview: false,
      uncertainties: [],
      humanCorrections: [],
      humanAnalysis: {
        technicianConclusion: "Processo concluído com êxito em 15 minutos.",
        analyzedBy: "Lucas Santos",
        analyzedAt: tMinus10m
      },
      finalDiagnosis: "Solicitação administrativa de criação e vinculação de conta de instalador Hoymiles no S-Miles Cloud.",
      finalResolution: "Conta criada no portal global.hoymiles.com vinculada com sucesso. Credenciais de acesso enviadas ao cliente e caso finalizado.",
      attachments: [],
      learningMetadata: {
        isValidated: true,
        validatedAt: tMinus10m,
        validatedBy: "Lucas Santos",
        isTrainingCandidate: true,
        candidateReason: "Exemplo padrão de finalização ágil com satisfação do cliente para modelo de IA",
        tags: ["hoymiles", "s-miles-cloud", "account-creation", "golden-case"]
      },
      createdAt: tMinus1h,
      updatedAt: tMinus10m,
      closedAt: tMinus10m
    }
  ];
}

export function getObserverCases() {
  const data = readAppStorage();
  if (Array.isArray(data.tarsObserverCases) && data.tarsObserverCases.length > 0) {
    return data.tarsObserverCases;
  }
  const defaults = getDefaultObserverCases();
  writeAppStorage({ tarsObserverCases: defaults });
  return defaults;
}

export function getProcessedEventIdsSet() {
  const data = readAppStorage();
  const list = Array.isArray(data.tarsProcessedEvents) ? data.tarsProcessedEvents : [];
  return new Set(list);
}

// Ingestion Engine: applies batched events to matching TARS Case
export function processObserverEventsBatch(payload, existingCases, processedEventIds) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const updatedCases = [...existingCases];
  let processedCount = 0;
  let duplicateCount = 0;
  const affectedCaseIds = new Set();

  for (const ev of events) {
    if (!ev || !ev.eventId) continue;

    // Idempotency check: NEVER process the same eventId twice
    if (processedEventIds.has(ev.eventId)) {
      duplicateCount++;
      continue;
    }
    processedEventIds.add(ev.eventId);
    processedCount++;

    const eventDate = ev.observedAt || new Date().toISOString();
    const caseData = ev.case || ev.data?.case || ev.event?.case || {};
    const convId = (caseData.conversationId || ev.conversationId || ev.event?.conversationId || ev.data?.conversationId || "").trim();
    const protocol = (caseData.protocol || ev.protocol || ev.event?.protocol || ev.data?.protocol || "").trim();

    // ------------------------------------------------------------
// CASE CREATION GUARD
// ------------------------------------------------------------
// Observer events are not automatically cases.
// Navigation, SITE_ACCESSED, observer attachment, etc.
// may legitimately exist without an active Hyperflow conversation.
//
// NEVER create an Observer Case unless we have a real
// conversation identity.
const requiresCase = [
  "HYPERFLOW_MESSAGE",
  "TECHNICIAN_UI_ACTION",
  "CASE_STATUS_CHANGED",
  "HUMAN_REVIEW_REQUIRED",
  "LEARNING_SIGNAL"
].includes(ev.eventType);

if (!convId && !protocol) {
  if (!requiresCase) {
    // Event can still be accepted/processed as telemetry,
    // but it must not materialize into a case.
    continue;
  }

  // Even case-relevant events cannot create an anonymous case.
  // They need a real Hyperflow conversation.
  continue;
}
    
    let matchedCaseIndex = -1;

    if (protocol) {
      matchedCaseIndex = updatedCases.findIndex(c =>
        (c.protocol && c.protocol.toLowerCase() === protocol.toLowerCase()) ||
        (c.id && c.id.toLowerCase() === `tars-obs-${protocol.toLowerCase()}`) ||
        (c.customer?.protocol && c.customer.protocol.toLowerCase() === protocol.toLowerCase())
      );
    }
    if (matchedCaseIndex < 0 && convId) {
      matchedCaseIndex = updatedCases.findIndex(c => c.conversationId === convId || (c.id && c.id.includes(convId)));
    }

    let targetCase;

    if (matchedCaseIndex >= 0) {
      targetCase = updatedCases[matchedCaseIndex];
      if ((!targetCase.protocol || targetCase.protocol === "PENDING") && protocol) {
        targetCase.protocol = protocol;
      }
      if ((!targetCase.conversationId || targetCase.conversationId.startsWith("conv_anon_")) && convId) {
        targetCase.conversationId = convId;
      }
      if (caseData.customerName && (!targetCase.customer?.name || targetCase.customer.name === "Cliente em Atendimento")) {
        targetCase.customer.name = caseData.customerName;
      }
      if (caseData.customerPhone && !targetCase.customer?.phone) {
        targetCase.customer.phone = caseData.customerPhone;
      }
      if (caseData.manufacturer && (targetCase.equipment.manufacturer === "Desconhecido" || !targetCase.equipment.manufacturer)) {
        targetCase.equipment.manufacturer = caseData.manufacturer;
      }
      if (caseData.equipmentModel && !targetCase.equipment.model) {
        targetCase.equipment.model = caseData.equipmentModel;
      }
      if (caseData.serialNumber && !targetCase.equipment.sn) {
        targetCase.equipment.sn = caseData.serialNumber;
        if (Array.isArray(targetCase.equipment.serialNumbers) && !targetCase.equipment.serialNumbers.includes(caseData.serialNumber)) {
          targetCase.equipment.serialNumbers.push(caseData.serialNumber);
        }
      }
    } else {
      const newCaseId = `TARS-OBS-${protocol || (convId ? convId.replace(/^conv_/, '') : '') || Date.now().toString(36).toUpperCase()}`;
      targetCase = {
        id: newCaseId,
        protocol: protocol || "PENDING",
        conversationId: convId || `conv_anon_${Date.now()}`,
        status: "NEW",
        customer: {
          name: caseData.customerName || (caseData.customer && caseData.customer.name) || "Cliente em Atendimento",
          phone: caseData.customerPhone || (caseData.customer && caseData.customer.phone) || "",
          email: caseData.customerEmail || "",
          protocol: protocol || "PENDING"
        },
        equipment: {
          manufacturer: caseData.manufacturer || "Desconhecido",
          model: caseData.equipmentModel || "",
          serialNumbers: caseData.serialNumber ? [caseData.serialNumber] : [],
          sn: caseData.serialNumber || ""
        },
        timeline: [],
        messages: [],
        technicianActions: [],
        technicalEvidence: [],
        aiObservations: [],
        confidence: 0.5,
        confidenceLevel: "MEDIUM",
        needsHumanReview: false,
        uncertainties: [],
        humanCorrections: [],
        humanAnalysis: {},
        attachments: [],
        learningMetadata: {
          isValidated: false,
          validatedAt: null,
          validatedBy: null,
          isTrainingCandidate: false,
          candidateReason: null,
          tags: []
        },
        createdAt: eventDate,
        updatedAt: eventDate
      };
      updatedCases.unshift(targetCase);
      matchedCaseIndex = 0;
    }

    affectedCaseIds.add(targetCase.id);

    // Apply event mutations
    applyObserverEvent(targetCase, ev);
    targetCase.updatedAt = new Date().toISOString();
    updatedCases[matchedCaseIndex] = targetCase;
  }

  return {
    updatedCases,
    processedCount,
    duplicateCount,
    affectedCaseIds: Array.from(affectedCaseIds)
  };
}

function applyObserverEvent(tarsCase, ev) {
  const evType = ev.eventType;
  const timestamp = ev.observedAt || new Date().toISOString();
  const rawData = ev.data || ev.event?.data || ev.event || {};
  const data = rawData.text !== undefined ? rawData : (rawData.data || rawData);

  // Status transitions
  if (tarsCase.status === "NEW") {
    tarsCase.status = "ACTIVE";
  }

  switch (evType) {
    case "OBSERVER_ATTACHED": {
      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: "OBSERVER_ATTACHED",
        timestamp,
        title: "TARS Observer Conectado",
        detail: `Monitoramento passivo ativo na página ${ev.page || ""}. Modo passivo garantido (Zero Customer Interaction).`,
        author: ev.source || "TARS Vision Bridge",
        data
      });
      break;
    }

    case "HYPERFLOW_MESSAGE": {
      const msgId = data.messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const speaker = (data.speaker === "agent" || data.speaker === "technician") ? "technician" : "customer";
      const direction = data.direction || (speaker === "technician" ? "outbound" : "incoming");
      const text = String(data.text || "").trim();

      const existingMsgIdx = tarsCase.messages.findIndex(m => m.messageId === msgId);
      if (existingMsgIdx >= 0) {
        tarsCase.messages[existingMsgIdx].text = text;
      } else {
        tarsCase.messages.push({
          messageId: msgId,
          direction,
          speaker,
          timestamp: data.timestamp || timestamp,
          capturedAt: data.capturedAt || timestamp,
          text,
          attachmentCount: Number(data.attachmentCount || 0)
        });
      }

      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: "HYPERFLOW_MESSAGE",
        timestamp,
        title: speaker === "technician" ? "Mensagem enviada pelo Técnico" : "Mensagem do Cliente recebida",
        detail: text.length > 180 ? text.slice(0, 180) + "…" : text,
        author: speaker === "technician" ? "Técnico de Suporte" : (tarsCase.customer.name || "Cliente"),
        data: { messageId: msgId, attachmentCount: data.attachmentCount }
      });

      if (speaker === "technician") {
        tarsCase.status = "WAITING_FOR_CUSTOMER";
      } else {
        tarsCase.status = "PROCESSING";
        analyzeCustomerMessageAI(tarsCase, text, timestamp);
      }
      break;
    }

    case "TECHNICIAN_UI_ACTION": {
      const actionTitle = data.action || data.target || "Ação de Interface";
      tarsCase.technicianActions.push({
        id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        actionType: String(data.actionType || "UI_INTERACTION"),
        timestamp,
        target: String(data.target || ev.page || "Interface"),
        notes: String(data.notes || data.detail || `Ação: ${data.action || "clique"} em ${data.targetRole || "controle"}`)
      });

      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: "TECHNICIAN_UI_ACTION",
        timestamp,
        title: `Ação do Técnico: ${actionTitle}`,
        detail: `Técnico interagiu com elemento '${data.target || ""}' na página ${ev.page || ""}.`,
        author: "Técnico Solar",
        data
      });
      break;
    }

    case "PAGE_NAVIGATION": {
      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: "PAGE_NAVIGATION",
        timestamp,
        title: "Navegação Observada",
        detail: `Navegou de '${data.previousPage || ""}' para '${ev.page || data.page || ""}'.`,
        author: "TARS Vision Bridge",
        data
      });
      break;
    }

    case "DOM_STRUCTURE_SNAPSHOT": {
      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: "WORKFLOW_OBSERVATION",
        timestamp,
        title: "Estrutura de Tela Capturada",
        detail: `Workflow Learning registrou snapshot da interface em '${ev.page || ""}'.`,
        author: "Workflow Learning Engine",
        data
      });
      break;
    }

    default: {
      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: evType,
        timestamp,
        title: `Evento Observado: ${evType}`,
        detail: `Origem: ${ev.origin || ""} | Página: ${ev.page || ""}`,
        author: ev.source || "TARS Vision Bridge",
        data
      });
      break;
    }
  }
}

function analyzeCustomerMessageAI(tarsCase, text, timestamp) {
  const norm = text.toLowerCase();

  // Inverter manufacturer matching
  const manufacturers = [
    { name: "Deye", patterns: [/\bdeye\b/i, /\bsun-\d+k/i, /\bsg01\b/i, /\bsg03\b/i, /\bsg04\b/i] },
    { name: "Hoymiles", patterns: [/\bhoymiles\b/i, /\bmicroinversor\b/i, /\bhms-\d+/i, /\bhmt-\d+/i, /\bmi-\d+/i, /\bs-miles\b/i] },
    { name: "FoxESS", patterns: [/\bfoxess\b/i, /\bfox-ess\b/i, /\bfox\s*ess\b/i, /\bh1-\d+/i, /\bt\d+/i] },
    { name: "Huawei", patterns: [/\bhuawei\b/i, /\bfusionsolar\b/i, /\bsun2000/i] },
    { name: "Solis", patterns: [/\bsolis\b/i, /\bginlong\b/i] },
    { name: "Growatt", patterns: [/\bgrowatt\b/i, /\bmin\s*\d+k/i, /\bmid\s*\d+k/i] }
  ];

  for (const m of manufacturers) {
    if (m.patterns.some(p => p.test(norm))) {
      tarsCase.equipment.manufacturer = m.name;
      break;
    }
  }

  // Model Extraction
  const modelMatch = text.match(/\b(SUN-[0-9A-Z.-]+|HMS-[0-9A-Z.-]+|HMT-[0-9A-Z.-]+|SUN2000-[0-9A-Z.-]+|MIN\s*[0-9A-Z.-]+)\b/i);
  if (modelMatch) {
    tarsCase.equipment.model = modelMatch[1].toUpperCase();
  }

  // Serial Number Extraction
  const snMatch = text.match(/\b([0-9]{10,16}|[A-Z0-9]{12,18})\b/);
  if (snMatch && !snMatch[1].startsWith("202") && !snMatch[1].startsWith("199")) {
    const snCandidate = snMatch[1];
    if (!tarsCase.equipment.serialNumbers.includes(snCandidate)) {
      tarsCase.equipment.serialNumbers.push(snCandidate);
      tarsCase.equipment.sn = snCandidate;
    }
  }

  // Electrical parameter extraction
  const voltMatch = text.match(/([0-9]{2,3}(?:[.,][0-9]+)?)\s*(?:V|volts|vac|vca)\b/i);
  if (voltMatch) {
    const vVal = voltMatch[1].replace(",", ".");
    tarsCase.technicalEvidence.push({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "measurement",
      value: `Tensão registrada: ${vVal}V`,
      timestamp,
      source: "Mensagem do Cliente / Multímetro",
      notes: "Parâmetro elétrico aferido"
    });
  }

  // Alarm Code Extraction
  const alarmPatterns = [
    { code: "F30", desc: "Falha de Relé Interno / Barramento CC-CA Deye", regex: /\b(f30|f-30|alarme\s*30)\b/i },
    { code: "F18", desc: "Corrente de Fuga Excessiva / Isolamento CA Deye", regex: /\b(f18|f-18)\b/i },
    { code: "F56", desc: "Sobretensão Barramento CC Deye", regex: /\b(f56|f-56)\b/i },
    { code: "E01", desc: "Sobretensão de Rede CA (Grid Overvoltage)", regex: /\b(e01|e-01|grid\s*overvoltage)\b/i },
    { code: "E02", desc: "Subtensão de Rede CA (Grid Undervoltage)", regex: /\b(e02|e-02)\b/i }
  ];

  const errorMatches = [];
  for (const a of alarmPatterns) {
    if (a.regex.test(norm)) {
      errorMatches.push(a);
      tarsCase.technicalEvidence.push({
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "alarm_code",
        value: `${a.code}: ${a.desc}`,
        timestamp,
        source: "Hyperflow Message",
        notes: "Identificado automaticamente pelo analisador passivo TARS"
      });

      tarsCase.aiObservations.push({
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp,
        category: "fault_diagnosis",
        title: `Detecção de Código de Falha: ${a.code}`,
        detail: `Alarme '${a.code}' detectado na mensagem do cliente. ${a.desc}.`,
        suggestedAction: "Verificar medição de tensões AC e isolamento Riso antes de acionar RMA.",
        confidence: 0.85,
        confidenceLevel: "HIGH",
        needsHumanReview: false,
        uncertainties: []
      });
    }
  }

  // Ambiguity / Low confidence check
  const isAmbiguousPhoto = /foto.*(ruim|escura|reflexo|embaçada|borrada|ilegivel)/i.test(norm);
  const conflictingData = (voltMatch && parseFloat(voltMatch[1]) > 260) || norm.includes("estalo") || norm.includes("cheiro de queimado");

  if (isAmbiguousPhoto || (conflictingData && errorMatches.length > 0)) {
    tarsCase.status = "HUMAN_REVIEW";
    tarsCase.needsHumanReview = true;
    const uncertaintyMsg = isAmbiguousPhoto
      ? "Evidência visual reportada como com baixa nitidez ou reflexo óptico."
      : "Relato de estalo elétrico / anomalia física grave associada a código de erro.";
    tarsCase.uncertainties.push(uncertaintyMsg);

    tarsCase.aiObservations.push({
      id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp,
      category: "confidence_guard",
      title: "Alerta de Confiança Crítica - Encaminhado para Análise Técnica",
      detail: uncertaintyMsg,
      suggestedAction: "Obrigatória revisão por técnico humano certificado.",
      confidence: 0.42,
      confidenceLevel: "LOW",
      needsHumanReview: true,
      uncertainties: [uncertaintyMsg]
    });

    tarsCase.confidence = Math.min(tarsCase.confidence, 0.48);
    tarsCase.confidenceLevel = "LOW";

    const recentHr = tarsCase.timeline.find(t => t.eventType === "HUMAN_REVIEW_REQUIRED" && (Date.now() - new Date(t.timestamp).getTime()) < 300000);
    if (!recentHr) {
      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventType: "HUMAN_REVIEW_REQUIRED",
        timestamp,
        title: "Revisão Humana Obrigatória",
        detail: uncertaintyMsg,
        author: "TARS AI Safety Boundary"
      });
    }
  } else if (errorMatches.length > 0 && tarsCase.equipment.manufacturer !== "Desconhecido") {
    tarsCase.confidence = 0.92;
    tarsCase.confidenceLevel = "HIGH";
    tarsCase.needsHumanReview = false;
  }
}

// Generate training candidate export format (JSONL pairs for Gemini SFT or local fine-tuning)
export function exportLearningCandidatesJSONL(cases) {
  const candidates = cases.filter(c => c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated);
  const lines = [];

  for (const c of candidates) {
    const systemPrompt = "Você é o TARS, especialista sênior em diagnóstico, pós-venda e laudos de inversores solares fotovoltaicos (Deye, FoxESS, Hoymiles, Huawei, Solis, Growatt). Responda com rigor técnico baseado nas normas ABNT NBR 16149 e critérios contratuais de garantia.";
    
    const userPrompt = [
      `CASO VALIDADO: Protocolo ${c.protocol} (${c.customer.name})`,
      `EQUIPAMENTO: Fabricante ${c.equipment.manufacturer} - Modelo ${c.equipment.model || "N/A"} - S/N ${c.equipment.sn || "N/A"}`,
      `EVIDÊNCIAS TÉCNICAS:`,
      ...c.technicalEvidence.map(e => `- ${e.type.toUpperCase()}: ${e.value} (${e.notes || "Aferido"})`),
      `TRANSCRIÇÃO / HISTÓRICO:`,
      ...c.messages.map(m => `[${m.speaker.toUpperCase()}]: ${m.text}`)
    ].join("\n");

    const assistantResponse = [
      `DIAGNÓSTICO TÉCNICO CONCLUSIVO:`,
      c.finalDiagnosis || "Diagnóstico confirmado com base em telemetria e análise visual.",
      ``,
      `RESOLUÇÃO E AÇÕES APLICADAS:`,
      c.finalResolution || "Procedimento de suporte e garantia concluído conforme diretrizes do fabricante.",
      ``,
      `ANÁLISE HUMANA ESPECIALIZADA:`,
      c.humanAnalysis?.technicianConclusion || "Caso validado sem divergências pelo corpo técnico.",
      `TAGS: ${(c.learningMetadata?.tags || []).join(", ")}`
    ].join("\n");

    const record = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: assistantResponse }
      ]
    };

    lines.push(JSON.stringify(record));
  }

  return lines.join("\n");
}
