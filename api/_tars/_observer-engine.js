import fs from "fs";
import path from "path";

const CWD_STORAGE = path.join(process.cwd(), ".app_storage.json");
const TMP_STORAGE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function getStoragePath() {
  try {
    if (fs.existsSync(CWD_STORAGE)) {
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

export function isMeaningfulCase(c) {
  if (!c) return false;
  // Has meaningful messages
  if (Array.isArray(c.messages) && c.messages.some(m => m && m.text && String(m.text).trim().length > 0)) {
    return true;
  }
  // Has technical evidence
  if (Array.isArray(c.technicalEvidence) && c.technicalEvidence.length > 0) {
    return true;
  }
  // Has technician actions
  if (Array.isArray(c.technicianActions) && c.technicianActions.length > 0) {
    return true;
  }
  // Has AI observations
  if (Array.isArray(c.aiObservations) && c.aiObservations.length > 0) {
    return true;
  }
  // Has a real protocol or recognized customer
  if (c.protocol && c.protocol !== "PENDING" && !c.protocol.startsWith("TARS-OBS-")) {
    return true;
  }
  return false;
}

export function getDefaultObserverCases() {
  const now = new Date();
  const tMinus1h = new Date(now.getTime() - 3600000).toISOString();
  const tMinus30m = new Date(now.getTime() - 1800000).toISOString();
  const tMinus20m = new Date(now.getTime() - 1200000).toISOString();
  const tMinus18m = new Date(now.getTime() - 1080000).toISOString();
  const tMinus15m = new Date(now.getTime() - 900000).toISOString();
  const tMinus10m = new Date(now.getTime() - 600000).toISOString();
  const tMinus5m = new Date(now.getTime() - 300000).toISOString();

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
    // Purge ghost/empty cases automatically
    const validCases = data.tarsObserverCases.filter(isMeaningfulCase);
    if (validCases.length > 0) {
      if (validCases.length !== data.tarsObserverCases.length) {
        writeAppStorage({ tarsObserverCases: validCases });
      }
      return validCases;
    }
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

// ------------------------------------------------------------
// HOYMILES SLA CASE AUTOMATION
// ------------------------------------------------------------
export function registerHoymilesCompletedSlaCase(eventOrData) {
  try {
    const storage = readAppStorage();
    const list = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    const occurredAt = eventOrData.observedAt || eventOrData.occurredAt || new Date().toISOString();

    const rawData = eventOrData.data || eventOrData;
    const accountObj = rawData.account || eventOrData.account || {};
    const orgObj = rawData.organization || eventOrData.organization || {};
    const customerObj = rawData.customer || eventOrData.customer || {};

    const loginEmail = (accountObj.loginEmail || rawData.loginEmail || eventOrData.loginEmail || rawData.email || customerObj.email || "").trim().toLowerCase();
    const orgName = (orgObj.name || rawData.company || rawData.orgName || eventOrData.company || "Instalador Hoymiles").trim();
    const parentOrg = (orgObj.parentOrganization || rawData.parentOrg || eventOrData.parentOrg || "APItest").trim();
    const customerName = (customerObj.name || rawData.customerName || eventOrData.customerName || orgName).trim();
    const customerPhone = (customerObj.phone || rawData.phone || eventOrData.phone || "").trim();
    const conversationId = (eventOrData.conversationId || rawData.conversationId || "").trim();

    // Check if case already registered for this login / conversation
    const existingIndex = list.findIndex(c => {
      const hoymilesList = c.protocols?.hoymiles || [];
      const matchesEmail = Boolean(loginEmail && hoymilesList.some(h => (h.account_email || "").toLowerCase() === loginEmail));
      const matchesConv = Boolean(conversationId && (
        c.protocols?.hyperflow_id === conversationId ||
        (Array.isArray(c.protocols?.hyperflow) && c.protocols.hyperflow.includes(conversationId))
      ));
      return matchesEmail || matchesConv;
    });

    if (existingIndex >= 0) {
      const c = { ...list[existingIndex] };
      c.status = "concluido";
      c.resolved_at = occurredAt;
      c.updated_at = occurredAt;
      c.protocols = c.protocols || {};
      c.protocols.hoymiles = Array.isArray(c.protocols.hoymiles) ? [...c.protocols.hoymiles] : [];
      if (loginEmail && !c.protocols.hoymiles.some(h => (h.account_email || "").toLowerCase() === loginEmail)) {
        c.protocols.hoymiles.push({
          account_email: loginEmail,
          org_name: orgName,
          parent_org: parentOrg,
          role: "Installer",
          created_at: occurredAt,
          conversation_id: conversationId,
          status: "COMPLETED"
        });
      }
      c.timeline = Array.isArray(c.timeline) ? [...c.timeline] : [];
      c.timeline.push({
        id: `tl-hoy-${Date.now()}`,
        type: "hoymiles_account_created",
        title: `Conta Hoymiles Criada: ${loginEmail || orgName}`,
        detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). SLA Concluído com sucesso via extensão TARS.`,
        author: "TARS Vision Bridge v1.2.84",
        timestamp: occurredAt
      });
      list[existingIndex] = c;
      writeAppStorage({ slaCases: list });
      return c;
    }

    const caseNum = Math.floor(1000 + Math.random() * 9000);
    const newCaseId = `SLA-HOY-${caseNum}`;
    const newCase = {
      id: newCaseId,
      title: `Criação de Conta Hoymiles — ${orgName || customerName}`,
      priority: "media",
      status: "concluido",
      created_at: occurredAt,
      resolved_at: occurredAt,
      sla_limit_hours: 24,
      responsible_tech: "TARS Vision Bridge",
      customer: {
        name: customerName,
        email: loginEmail || customerObj.email || "",
        phone: customerPhone,
        state: customerObj.state || rawData.state || "",
        company: orgName
      },
      equipment: {
        manufacturer: "Hoymiles",
        model: "S-Miles Cloud (Portal do Instalador)",
        serial_numbers: ["N/A - Conta Web/App"]
      },
      problem_summary: `Criação automatizada de conta de Instalador Hoymiles para ${customerName} (${orgName}). Login: ${loginEmail || "N/A"}. Conta vinculada a ${parentOrg} e credenciais entregues via Hyperflow.`,
      protocols: {
        hoymiles: [{
          account_email: loginEmail,
          org_name: orgName,
          parent_org: parentOrg,
          role: "Installer",
          created_at: occurredAt,
          conversation_id: conversationId,
          status: "COMPLETED"
        }],
        hyperflow: conversationId ? [conversationId] : []
      },
      timeline: [
        {
          id: `tl-sla-init-${Date.now()}`,
          type: "hoymiles_account_created",
          title: "Conta Hoymiles Criada & Entregue",
          detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Atendimento concluído com sucesso via TARS Bridge.`,
          author: "TARS Vision Bridge v1.2.84",
          timestamp: occurredAt
        }
      ],
      notes: "Registrado automaticamente como caso de SLA Concluído a partir da criação de conta Hoymiles pela extensão TARS Vision Bridge."
    };

    list.unshift(newCase);
    writeAppStorage({ slaCases: list });
    return newCase;
  } catch (err) {
    console.error("[registerHoymilesCompletedSlaCase error]", err);
    return null;
  }
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
    const rawData = ev.data || ev.event?.data || ev.event || {};

    // ------------------------------------------------------------
    // HOYMILES SLA AUTO-REGISTRATION DETECTION
    // ------------------------------------------------------------
    const isHoymilesAccountEvent =
      ev.eventType === "HOYMILES_ACCOUNT_CREATED" ||
      ev.eventType === "ACCOUNT_CREATION" ||
      ev.event === "hoymiles.account.created" ||
      rawData.event === "hoymiles.account.created" ||
      rawData.type === "hoymiles_account_created" ||
      (ev.eventType === "TECHNICIAN_UI_ACTION" && (
        rawData.actionType === "ACCOUNT_CREATION" ||
        (String(rawData.target || "").includes("hoymiles") && String(rawData.notes || rawData.action || "").toLowerCase().includes("conta")) ||
        (String(ev.page || "").includes("hoymiles") && String(rawData.actionType || "").toLowerCase().includes("account"))
      )) ||
      Boolean(rawData.account?.loginEmail && String(rawData.target || ev.page || "").includes("hoymiles"));

    if (isHoymilesAccountEvent) {
      registerHoymilesCompletedSlaCase({
        ...ev,
        ...rawData,
        observedAt: eventDate,
        customer: caseData.customer || (caseData.customerName ? { name: caseData.customerName, phone: caseData.customerPhone } : null)
      });
    }

    // ------------------------------------------------------------
    // CASE CREATION GUARD (Anti-empty cases)
    // ------------------------------------------------------------
    const requiresCase = [
      "HYPERFLOW_MESSAGE",
      "TECHNICIAN_UI_ACTION",
      "CASE_STATUS_CHANGED",
      "HUMAN_REVIEW_REQUIRED",
      "LEARNING_SIGNAL",
      "HOYMILES_ACCOUNT_CREATED"
    ].includes(ev.eventType);

    if (!convId && !protocol) {
      if (!requiresCase) {
        continue;
      }
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
          manufacturer: caseData.manufacturer || (isHoymilesAccountEvent ? "Hoymiles" : "Desconhecido"),
          model: caseData.equipmentModel || (isHoymilesAccountEvent ? "S-Miles Cloud" : ""),
          serialNumbers: caseData.serialNumber ? [caseData.serialNumber] : [],
          sn: caseData.serialNumber || ""
        },
        timeline: [],
        messages: [],
        technicianActions: [],
        technicalEvidence: [],
        aiObservations: [],
        confidence: isHoymilesAccountEvent ? 0.95 : 0.5,
        confidenceLevel: isHoymilesAccountEvent ? "HIGH" : "MEDIUM",
        needsHumanReview: false,
        uncertainties: [],
        humanCorrections: [],
        humanAnalysis: {},
        attachments: [],
        learningMetadata: {
          isValidated: isHoymilesAccountEvent,
          validatedAt: isHoymilesAccountEvent ? eventDate : null,
          validatedBy: isHoymilesAccountEvent ? "TARS Vision Bridge" : null,
          isTrainingCandidate: isHoymilesAccountEvent,
          candidateReason: isHoymilesAccountEvent ? "Criação de conta Hoymiles finalizada via extensão TARS." : null,
          tags: isHoymilesAccountEvent ? ["hoymiles", "account-creation", "golden-case"] : []
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

  // Filter out any ghost/empty cases before returning
  const filteredCases = updatedCases.filter(isMeaningfulCase);

  return {
    updatedCases: filteredCases,
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

    case "HOYMILES_ACCOUNT_CREATED":
    case "ACCOUNT_CREATION": {
      tarsCase.equipment.manufacturer = "Hoymiles";
      tarsCase.equipment.model = "S-Miles Cloud";
      tarsCase.finalDiagnosis = "Criação de conta instalador Hoymiles no portal S-Miles Cloud";
      tarsCase.finalResolution = "Conta de instalador criada e vinculada com sucesso. Credenciais fornecidas.";
      tarsCase.status = "CLOSED";
      tarsCase.confidence = 0.98;
      tarsCase.confidenceLevel = "HIGH";
      tarsCase.learningMetadata = {
        isValidated: true,
        validatedAt: timestamp,
        validatedBy: "TARS Vision Bridge",
        isTrainingCandidate: true,
        candidateReason: "Exemplo validado de criação ágil de conta de instalador Hoymiles",
        tags: ["hoymiles", "s-miles-cloud", "account-creation", "golden-case"]
      };

      tarsCase.timeline.push({
        id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        eventId: ev.eventId,
        eventType: "ACCOUNT_CREATION",
        timestamp,
        title: "Conta Hoymiles Criada",
        detail: `Conta de Instalador Hoymiles criada com sucesso via extensão TARS. Caso arquivado e SLA concluído.`,
        author: "TARS Vision Bridge",
        data
      });
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

  const modelMatch = text.match(/\b(SUN-[0-9A-Z.-]+|HMS-[0-9A-Z.-]+|HMT-[0-9A-Z.-]+|SUN2000-[0-9A-Z.-]+|MIN\s*[0-9A-Z.-]+)\b/i);
  if (modelMatch) {
    tarsCase.equipment.model = modelMatch[1].toUpperCase();
  }

  const snMatch = text.match(/\b([0-9]{10,16}|[A-Z0-9]{12,18})\b/);
  if (snMatch && !snMatch[1].startsWith("202") && !snMatch[1].startsWith("199")) {
    const snCandidate = snMatch[1];
    if (!tarsCase.equipment.serialNumbers.includes(snCandidate)) {
      tarsCase.equipment.serialNumbers.push(snCandidate);
      tarsCase.equipment.sn = snCandidate;
    }
  }

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

// ------------------------------------------------------------
// SMART LEARNING WITH TARS AI (Gemini Synthesis)
// ------------------------------------------------------------
export async function runTarsSmartLearningAnalysis(caseItem) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "GEMINI_API_KEY is not configured.",
      suggestedTags: ["solar", "analise-manual"],
      isGoldenCandidate: true,
      goldenReason: "Caso fechado com resolução técnica consistente."
    };
  }

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `Você é o TARS AI Deep Learning Engine, especialista sênior em suporte técnico, RMA e diagnóstico de inversores solares fotovoltaicos (Deye, Hoymiles, FoxESS, Huawei, Solis, Growatt).
Analise os dados deste atendimento e gere metadados estruturados de aprendizado para treinar nosso modelo de Deep Learning local.

DADOS DO CASO:
Protocolo: ${caseItem.protocol}
Cliente: ${caseItem.customer?.name || "N/A"}
Fabricante: ${caseItem.equipment?.manufacturer || "N/A"}
Modelo: ${caseItem.equipment?.model || "N/A"}
S/N: ${caseItem.equipment?.sn || "N/A"}
Status: ${caseItem.status}
Diagnóstico Atual: ${caseItem.finalDiagnosis || "Pendente"}
Resolução Atual: ${caseItem.finalResolution || "Pendente"}

EVIDÊNCIAS TÉCNICAS:
${(caseItem.technicalEvidence || []).map(e => `- ${e.type}: ${e.value} (${e.notes || ''})`).join("\n") || "Nenhuma evidência estruturada."}

MENSAGENS DO ATENDIMENTO:
${(caseItem.messages || []).map(m => `[${m.speaker?.toUpperCase()}]: ${m.text}`).join("\n") || "Sem histórico de mensagens."}

RETORNE APENAS UM JSON VÁLIDO no seguinte formato exato (sem markdown ou texto extra):
{
  "conclusiveDiagnosis": "diagnóstico técnico detalhado",
  "conclusiveResolution": "passo a passo de resolução definitivo",
  "technicalConformity": "conforme normas ABNT NBR 16149 / critérios de garantia",
  "isGoldenCandidate": true,
  "goldenReason": "justificativa de por que este caso serve para treinar e ajustar modelos de Deep Learning",
  "tags": ["fabricante", "codigo_falha", "tipo_procedimento", "golden-case"],
  "fineTuningInstruction": "instrução ideal de fine-tuning derivada deste caso",
  "fineTuningOutput": "resposta modelo ideal que a IA deve aprender a responder"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt
    });

    const text = response.text || "";
    const cleanJson = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanJson);

    return {
      success: true,
      data: parsed
    };
  } catch (err) {
    console.error("[runTarsSmartLearningAnalysis Error]", err);
    return {
      success: false,
      error: err.message || "Smart Learning analysis failed."
    };
  }
}

// ------------------------------------------------------------
// DATASET EXPORTS FOR LOCAL DEEP LEARNING (SFT, Alpaca, DPO)
// ------------------------------------------------------------
export function exportLearningCandidates(cases, format = "jsonl") {
  const candidates = cases.filter(c =>
    isMeaningfulCase(c) &&
    (c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated || c.status === "CLOSED")
  );

  const systemPrompt = "Você é o TARS, especialista sênior em diagnóstico, pós-venda e laudos de inversores solares fotovoltaicos (Deye, FoxESS, Hoymiles, Huawei, Solis, Growatt). Responda com rigor técnico baseado nas normas ABNT NBR 16149 e critérios contratuais de garantia.";

  if (format === "alpaca") {
    const dataset = candidates.map(c => {
      const input = [
        `Protocolo: ${c.protocol} | Cliente: ${c.customer?.name || "N/A"}`,
        `Equipamento: ${c.equipment?.manufacturer} ${c.equipment?.model || ""} (S/N: ${c.equipment?.sn || "N/A"})`,
        `Evidências: ${(c.technicalEvidence || []).map(e => `${e.type}: ${e.value}`).join("; ") || "Telemetria padrão"}`,
        `Mensagens: ${(c.messages || []).map(m => `[${m.speaker}]: ${m.text}`).join(" | ")}`
      ].join("\n");

      const output = [
        `DIAGNÓSTICO: ${c.finalDiagnosis || "Diagnóstico validado tecnicamente."}`,
        `RESOLUÇÃO: ${c.finalResolution || "Procedimento aplicado com sucesso."}`,
        c.humanAnalysis?.technicianConclusion ? `ANÁLISE DO ENGENHEIRO: ${c.humanAnalysis.technicianConclusion}` : ""
      ].filter(Boolean).join("\n");

      return {
        instruction: `Analise a solicitação técnica do cliente e forneça o diagnóstico conclusivo, resolução e orientações de conformidade solar fotovoltaica.`,
        input,
        output
      };
    });
    return JSON.stringify(dataset, null, 2);
  }

  if (format === "dpo") {
    const pairs = candidates.map(c => {
      const prompt = `[CASO SOLAR] Equipamento: ${c.equipment?.manufacturer} ${c.equipment?.model || ''}. Relato: ${(c.messages || []).map(m => m.text).join(' ')}`;
      const chosen = `[RESOLUÇÃO CONFIRMADA] ${c.finalDiagnosis || 'Diagnóstico validado'}. Ação: ${c.finalResolution || 'Procedimento executado e homologado.'}`;
      const rejected = `Caso genérico sem validação de telemetria ou medição de grandezas elétricas.`;
      return JSON.stringify({ prompt, chosen, rejected });
    });
    return pairs.join("\n");
  }

  // Default: JSONL (Chat SFT format for Gemini Tuning / Axolotl / Unsloth / LLaMA-Factory)
  return exportLearningCandidatesJSONL(cases);
}

export function exportLearningCandidatesJSONL(cases) {
  const candidates = cases.filter(c =>
    isMeaningfulCase(c) &&
    (c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated || c.status === "CLOSED")
  );
  const lines = [];

  for (const c of candidates) {
    const systemPrompt = "Você é o TARS, especialista sênior em diagnóstico, pós-venda e laudos de inversores solares fotovoltaicos (Deye, FoxESS, Hoymiles, Huawei, Solis, Growatt). Responda com rigor técnico baseado nas normas ABNT NBR 16149 e critérios contratuais de garantia.";

    const userPrompt = [
      `CASO VALIDADO: Protocolo ${c.protocol} (${c.customer?.name || "Cliente"})`,
      `EQUIPAMENTO: Fabricante ${c.equipment?.manufacturer || "N/A"} - Modelo ${c.equipment?.model || "N/A"} - S/N ${c.equipment?.sn || "N/A"}`,
      `EVIDÊNCIAS TÉCNICAS:`,
      ...(c.technicalEvidence || []).map(e => `- ${e.type.toUpperCase()}: ${e.value} (${e.notes || "Aferido"})`),
      `TRANSCRIÇÃO / HISTÓRICO:`,
      ...(c.messages || []).map(m => `[${m.speaker?.toUpperCase()}]: ${m.text}`)
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
