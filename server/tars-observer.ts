// server/tars-observer.ts - TARS Passive Observer Backend & Event-Sourced Case Engine
// Solar Agenda - Enterprise Solar Inverter Operations

import { GoogleGenAI } from "@google/genai";

export type TARSCaseStatus = 
  | "NEW" 
  | "ACTIVE" 
  | "WAITING_FOR_CUSTOMER" 
  | "PROCESSING" 
  | "HUMAN_REVIEW" 
  | "RESOLVED" 
  | "CLOSED";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export interface TARSObserverEvent {
  eventId: string;
  eventType: 
    | "OBSERVER_ATTACHED" 
    | "HYPERFLOW_MESSAGE" 
    | "TARS_OBSERVER_CASE_ACTIVE" 
    | "TECHNICIAN_UI_ACTION" 
    | "PAGE_NAVIGATION" 
    | "HUMAN_REVIEW_REQUIRED" 
    | string;
  observedAt: string;
  origin?: string;
  page?: string;
  title?: string;
  tabId?: number | string;
  case?: {
    protocol?: string;
    conversationId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    equipmentModel?: string;
    manufacturer?: string;
    serialNumber?: string;
  };
  data?: any;
}

export interface TARSMessage {
  messageId: string;
  direction: "inbound" | "outbound" | "internal";
  speaker: "customer" | "technician" | "system";
  timestamp: string;
  capturedAt: string;
  text: string;
  attachmentCount: number;
}

export interface TARSObservation {
  id: string;
  timestamp: string;
  category: "equipment_identification" | "fault_diagnosis" | "protocol_extraction" | "recommendation" | "visual_evidence" | string;
  title: string;
  detail: string;
  suggestedAction?: string;
  confidence: number; // 0–1
  confidenceLevel: ConfidenceLevel;
  needsHumanReview: boolean;
  uncertainties: string[];
  isValidated?: boolean;
  validatedAt?: string | null;
  validatedBy?: string | null;
  humanCorrection?: string | null;
}

export interface TARSHumanCorrection {
  id: string;
  observationId?: string;
  field?: string;
  originalValue: string;
  correctedValue: string;
  correctedBy: string;
  timestamp: string;
  reason: string;
}

export interface TARSTechnicianAction {
  id: string;
  action: string;
  timestamp: string;
  details?: any;
  page?: string;
}

export interface TARSTechnicalEvidence {
  id: string;
  type: "measurement" | "alarm_code" | "photo" | "video" | "multimeter" | "screenshot" | "log";
  value: string;
  timestamp: string;
  source: string;
  notes?: string;
  reviewedByHuman?: boolean;
}

export interface TARSHumanAnalysis {
  visualNotes?: string;
  mediaEvaluation?: string;
  technicianConclusion?: string;
  updatedAt?: string;
  updatedBy?: string;
  analyzedBy?: string;
  analyzedAt?: string;
}

export interface TARSLearningMetadata {
  isValidated: boolean;
  validatedAt?: string | null;
  validatedBy?: string | null;
  isTrainingCandidate: boolean;
  candidateReason?: string | null;
  tags: string[];
}

export interface TARSCase {
  id: string;
  protocol: string;
  conversationId: string;
  status: TARSCaseStatus;
  customer: {
    name: string;
    phone: string;
    email?: string;
    protocol?: string;
  };
  equipment: {
    manufacturer: string;
    model: string;
    serialNumbers: string[];
    sn: string;
  };
  timeline: Array<{
    id: string;
    eventId?: string;
    eventType: string;
    timestamp: string;
    title: string;
    detail: string;
    author?: string;
    data?: any;
  }>;
  messages: TARSMessage[];
  technicianActions: TARSTechnicianAction[];
  technicalEvidence: TARSTechnicalEvidence[];
  aiObservations: TARSObservation[];
  confidence: number; // 0–1
  confidenceLevel: ConfidenceLevel;
  needsHumanReview: boolean;
  uncertainties: string[];
  humanCorrections: TARSHumanCorrection[];
  humanAnalysis: TARSHumanAnalysis;
  finalDiagnosis: string;
  finalResolution: string;
  attachments: Array<{
    id: string;
    title: string;
    url?: string;
    type?: string;
  }>;
  learningMetadata: TARSLearningMetadata;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface IngestEventsBatchPayload {
  version?: string;
  source?: string;
  bridgeVersion?: string;
  events: TARSObserverEvent[];
}

// Global in-memory cache synchronized with storage
let genAIClient: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });
  }
  return genAIClient;
}

// Compute confidence level helper
export function computeConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.85) return "HIGH";
  if (confidence >= 0.60) return "MEDIUM";
  return "LOW";
}

// Seed default demonstration cases if none exist
export function getDefaultObserverCases(): TARSCase[] {
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
          detail: "Bridge v1.2.81 attached to Hyperflow tab. Passive monitoring active (Zero Customer Interaction safety boundary enforced).",
          author: "TARS Vision Bridge v1.2.81"
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
          detail: "Foto da placa com iluminação com reflexo: número de série 230419824102 parcialmente obstruído no último dígito. Incerteza registrada; exigida validação técnica antes do RMA.",
          author: "TARS AI Diagnostic Engine"
        }
      ],
      messages: [
        {
          messageId: "msg-hf-101",
          direction: "inbound",
          speaker: "customer",
          timestamp: tMinus30m,
          capturedAt: tMinus30m,
          text: "Boa tarde! O inversor Deye SUN-8K está apresentando erro F30 no display e os relés ficam batendo sem sincronizar com a rede.",
          attachmentCount: 1
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
          direction: "inbound",
          speaker: "customer",
          timestamp: tMinus15m,
          capturedAt: tMinus15m,
          text: "Tensão AC está em 223V estável. Segue a foto da placa (está meio apagada pelo sol).",
          attachmentCount: 1
        }
      ],
      technicianActions: [
        {
          id: "act-1",
          action: "VIEW_RUNBOOK",
          timestamp: tMinus18m,
          details: { runbook: "Deye F30 Relay/Internal Bus Fault Diagnostic" },
          page: "https://solar-agenda.vercel.app/#galaxy"
        }
      ],
      technicalEvidence: [
        {
          id: "ev-1",
          type: "alarm_code",
          value: "F30 (Internal Bus/Relay Failure)",
          timestamp: tMinus30m,
          source: "Hyperflow Transcript",
          notes: "Relé batendo continuamente sob 223 Vac"
        },
        {
          id: "ev-2",
          type: "measurement",
          value: "Vac = 223 V (Fase-Neutro)",
          timestamp: tMinus15m,
          source: "Customer Multimeter",
          notes: "Rede dentro dos parâmetros normais (220V +/- 5%)"
        }
      ],
      aiObservations: [
        {
          id: "obs-1",
          timestamp: tMinus12m,
          category: "fault_diagnosis",
          title: "Falha de Hardware - Bloco de Potência/Relé (F30)",
          detail: "Alarme F30 com tensão de rede em 223V confirma falha interna de disparo dos contatores da ponte IGBT ou fuga de barramento.",
          suggestedAction: "Solicitar abertura de protocolo Jira ADB e autorização de troca de placa controladora.",
          confidence: 0.88,
          confidenceLevel: "HIGH",
          needsHumanReview: false,
          uncertainties: []
        },
        {
          id: "obs-2",
          timestamp: tMinus10m,
          category: "visual_evidence",
          title: "Leitura OCR da Etiqueta de Número de Série",
          detail: "Dígito terminal com reflexo especular na foto enviada. Leitura provável: 230419824102, alternativo: 230419824108.",
          suggestedAction: "Técnico deve confirmar os 2 últimos dígitos na foto ampliada antes de submeter o formulário de garantia.",
          confidence: 0.52,
          confidenceLevel: "LOW",
          needsHumanReview: true,
          uncertainties: [
            "Reflexo solar sobre o código de barras e caracteres alfanuméricos finais",
            "Divergência entre 230419824102 e 230419824108 no OCR"
          ]
        }
      ],
      confidence: 0.58,
      confidenceLevel: "LOW",
      needsHumanReview: true,
      uncertainties: [
        "Número de série requer validação visual humana (confiança OCR 52%)",
        "Medição de resistência de isolamento (Riso) dos módulos ainda não enviada"
      ],
      humanCorrections: [],
      humanAnalysis: {
        visualNotes: "A foto enviada está cortada na borda superior. Solicitar ao instalador confirmação via foto do painel de leitura ou print do app Solarman.",
        mediaEvaluation: "Vídeo do relé estalando comprova disparo defeituoso.",
        technicianConclusion: "Caso típico de substituição de placa mãe Deye após surto.",
        updatedAt: tMinus5m,
        updatedBy: "Eng. Lucas"
      },
      finalDiagnosis: "",
      finalResolution: "",
      attachments: [
        {
          id: "att-1",
          title: "etiqueta_deye_sun8k.jpg",
          url: "https://conversas.hyperflow.global/media/att-101.jpg",
          type: "image/jpeg"
        }
      ],
      learningMetadata: {
        isValidated: false,
        validatedAt: null,
        validatedBy: null,
        isTrainingCandidate: false,
        candidateReason: null,
        tags: ["deye", "f30", "low-confidence-sn", "hardware-fault"]
      },
      createdAt: tMinus1h,
      updatedAt: tNow
    },
    {
      id: "TARS-OBS-HF-1988",
      protocol: "HF-1988",
      conversationId: "conv_hf_88129",
      status: "CLOSED",
      customer: {
        name: "Marcos Vinicius (Energia Limpa Soluções)",
        phone: "+55 31 99123-4567",
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
          id: "tl-cl-1",
          eventType: "OBSERVER_ATTACHED",
          timestamp: new Date(now.getTime() - 86400000).toISOString(),
          title: "Observer Conectado",
          detail: "Extensão TARS Vision Bridge monitorando atendimento passivamente.",
          author: "TARS Vision Bridge v1.2.81"
        },
        {
          id: "tl-cl-2",
          eventType: "TECHNICIAN_UI_ACTION",
          timestamp: new Date(now.getTime() - 82000000).toISOString(),
          title: "Criação de Conta Instalador Hoymiles",
          detail: "Técnico acionou automação no portal global.hoymiles.com para vinculação à organização pai.",
          author: "Técnico Solar"
        },
        {
          id: "tl-cl-3",
          eventType: "CASE_CLOSED",
          timestamp: new Date(now.getTime() - 72000000).toISOString(),
          title: "Atendimento Concluído & Validado",
          detail: "Conta entregue ao cliente e microinversor sincronizado. Marcado como candidato de aprendizado TARS.",
          author: "Técnico Solar"
        }
      ],
      messages: [
        {
          messageId: "msg-hf-201",
          direction: "inbound",
          speaker: "customer",
          timestamp: new Date(now.getTime() - 86400000).toISOString(),
          capturedAt: new Date(now.getTime() - 86400000).toISOString(),
          text: "Preciso liberar acesso de instalador para a conta marcos@energialimpa.com no S-Miles Cloud.",
          attachmentCount: 0
        },
        {
          messageId: "msg-hf-202",
          direction: "outbound",
          speaker: "technician",
          timestamp: new Date(now.getTime() - 82000000).toISOString(),
          capturedAt: new Date(now.getTime() - 82000000).toISOString(),
          text: "Conta criada com sucesso e vinculada à sua distribuidora! Senha temporária enviada via email.",
          attachmentCount: 0
        }
      ],
      technicianActions: [
        {
          id: "act-cl-1",
          action: "CREATE_HOYMILES_ACCOUNT",
          timestamp: new Date(now.getTime() - 82000000).toISOString(),
          details: { email: "marcos@energialimpa.com", role: "Installer" }
        }
      ],
      technicalEvidence: [],
      aiObservations: [
        {
          id: "obs-cl-1",
          timestamp: new Date(now.getTime() - 86000000).toISOString(),
          category: "protocol_extraction",
          title: "Demanda Operacional de Credenciamento Hoymiles",
          detail: "Cliente solicita criação de conta de instalador para a organização 'Energia Limpa'. Procedimento padrão via S-Miles Cloud API/Portal.",
          suggestedAction: "Cadastrar instalador e fornecer credenciais seguras.",
          confidence: 0.98,
          confidenceLevel: "HIGH",
          needsHumanReview: false,
          uncertainties: [],
          isValidated: true,
          validatedAt: new Date(now.getTime() - 81000000).toISOString(),
          validatedBy: "Técnico Solar"
        }
      ],
      confidence: 0.98,
      confidenceLevel: "HIGH",
      needsHumanReview: false,
      uncertainties: [],
      humanCorrections: [],
      humanAnalysis: {
        visualNotes: "Nenhuma inconsistência.",
        technicianConclusion: "Processo concluído com êxito em 15 minutos.",
        updatedAt: new Date(now.getTime() - 72000000).toISOString(),
        updatedBy: "Técnico Solar"
      },
      finalDiagnosis: "Solicitação administrativa de criação e vinculação de conta de instalador Hoymiles no S-Miles Cloud.",
      finalResolution: "Conta criada no portal global.hoymiles.com vinculada com sucesso. Credenciais de acesso enviadas ao cliente e caso finalizado.",
      attachments: [],
      learningMetadata: {
        isValidated: true,
        validatedAt: new Date(now.getTime() - 72000000).toISOString(),
        validatedBy: "Técnico Solar",
        isTrainingCandidate: true,
        candidateReason: "Exemplo padrão de alta qualidade para criação e entrega de credenciais de instalador Hoymiles",
        tags: ["hoymiles", "s-miles-cloud", "account-creation", "golden-case"]
      },
      createdAt: new Date(now.getTime() - 86400000).toISOString(),
      updatedAt: new Date(now.getTime() - 72000000).toISOString(),
      closedAt: new Date(now.getTime() - 72000000).toISOString()
    }
  ];
}

export function isMeaningfulCase(c: TARSCase): boolean {
  if (!c) return false;
  if (Array.isArray(c.messages) && c.messages.some(m => m && m.text && m.text.trim().length > 0)) {
    return true;
  }
  if (Array.isArray(c.technicalEvidence) && c.technicalEvidence.length > 0) {
    return true;
  }
  if (Array.isArray(c.technicianActions) && c.technicianActions.length > 0) {
    return true;
  }
  if (Array.isArray(c.aiObservations) && c.aiObservations.length > 0) {
    return true;
  }
  if (c.protocol && c.protocol !== "PENDING" && !c.protocol.startsWith("TARS-OBS-")) {
    return true;
  }
  return false;
}

// Ingestion Engine: applies batched events to matching TARS Case
export function processObserverEventsBatch(
  payload: IngestEventsBatchPayload,
  existingCases: TARSCase[],
  processedEventIds: Set<string>
): {
  updatedCases: TARSCase[];
  processedCount: number;
  duplicateCount: number;
  affectedCaseIds: string[];
} {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const updatedCases = [...existingCases];
  let processedCount = 0;
  let duplicateCount = 0;
  const affectedCaseIds = new Set<string>();

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
    const caseData = ev.case || ev.data?.case || (ev as any).event?.case || {};
    const convId = (caseData.conversationId || (ev as any).conversationId || (ev as any).event?.conversationId || (ev as any).data?.conversationId || "").trim();
    const protocol = (caseData.protocol || (ev as any).protocol || (ev as any).event?.protocol || (ev as any).data?.protocol || "").trim();
    const rawData = ev.data || (ev as any).event?.data || (ev as any).event || {};

    // ------------------------------------------------------------
    // CASE CREATION GUARD (Anti-empty cases)
    // ------------------------------------------------------------
    const requiresCase = [
      "HYPERFLOW_MESSAGE",
      "TECHNICIAN_UI_ACTION",
      "CASE_STATUS_CHANGED",
      "HUMAN_REVIEW_REQUIRED",
      "LEARNING_SIGNAL",
      "HOYMILES_ACCOUNT_CREATED",
      "ACCOUNT_CREATION"
    ].includes(ev.eventType);

    if (!convId && !protocol) {
      if (!requiresCase) {
        continue;
      }
      continue;
    }

    // Match by protocol first (authoritative support protocol), then fallback to conversation ID
    let matchedCaseIndex = -1;

    if (protocol) {
      matchedCaseIndex = updatedCases.findIndex(c =>
        (c.protocol && c.protocol.toLowerCase() === protocol.toLowerCase()) ||
        (c.id && c.id.toLowerCase() === `tars-obs-${protocol.toLowerCase()}`) ||
        (c.customer?.protocol && c.customer.protocol.toLowerCase() === protocol.toLowerCase())
      );
    }
    if (matchedCaseIndex < 0 && convId) {
      matchedCaseIndex = updatedCases.findIndex(c =>
        c.conversationId === convId || (c.id && c.id.includes(convId))
      );
    }

    let targetCase: TARSCase;

    if (matchedCaseIndex >= 0) {
      targetCase = updatedCases[matchedCaseIndex];
    } else {
      // Create brand new case for this conversation
      const newCaseId = `TARS-OBS-${protocol || (convId ? convId.replace(/^conv_/, '') : '') || Date.now().toString(36).toUpperCase()}`;
      targetCase = {
        id: newCaseId,
        protocol: protocol || "PENDING",
        conversationId: convId || `conv_anon_${Date.now()}`,
        status: "NEW",
        customer: {
          name: caseData.customerName || "Cliente em Atendimento",
          phone: caseData.customerPhone || "",
          email: caseData.customerEmail || "",
          protocol: protocol || undefined
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
        finalDiagnosis: "",
        finalResolution: "",
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
    }

    // Update customer / equipment info if newly available in event
    if (caseData.customerName && targetCase.customer.name === "Cliente em Atendimento") {
      targetCase.customer.name = caseData.customerName;
    }
    if (caseData.customerPhone && !targetCase.customer.phone) {
      targetCase.customer.phone = caseData.customerPhone;
    }
    if (caseData.customerEmail && !targetCase.customer.email) {
      targetCase.customer.email = caseData.customerEmail;
    }
    if (protocol && (!targetCase.protocol || targetCase.protocol === "PENDING")) {
      targetCase.protocol = protocol;
    }
    if (convId && !targetCase.conversationId) {
      targetCase.conversationId = convId;
    }
    if (caseData.manufacturer && (!targetCase.equipment.manufacturer || targetCase.equipment.manufacturer === "Desconhecido")) {
      targetCase.equipment.manufacturer = caseData.manufacturer;
    }
    if (caseData.equipmentModel && !targetCase.equipment.model) {
      targetCase.equipment.model = caseData.equipmentModel;
    }
    if (caseData.serialNumber && !targetCase.equipment.serialNumbers.includes(caseData.serialNumber)) {
      targetCase.equipment.serialNumbers.push(caseData.serialNumber);
      if (!targetCase.equipment.sn) targetCase.equipment.sn = caseData.serialNumber;
    }

    // Process specific event type
    switch (ev.eventType) {
      case "OBSERVER_ATTACHED": {
        if (targetCase.status === "NEW") {
          targetCase.status = "ACTIVE";
        }
        targetCase.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventId: ev.eventId,
          eventType: ev.eventType,
          timestamp: eventDate,
          title: "TARS Observer Conectado",
          detail: `Observador passivo v${payload.bridgeVersion || "1.2.81"} monitorando aba (${ev.title || ev.origin || "Hyperflow"}). Modo de segurança estrito: sem interação com cliente.`,
          author: `TARS Vision Bridge v${payload.bridgeVersion || "1.2.81"}`,
          data: ev.data
        });
        break;
      }

      case "HYPERFLOW_MESSAGE": {
        const rawData = ev.data || (ev as any).event?.data || (ev as any).event || {};
        const msgData = rawData.text !== undefined ? rawData : (rawData.data || rawData);
        const msgText = String(msgData.text || ev.title || "").trim();
        const speaker = (msgData.speaker === "technician" || msgData.direction === "outbound") ? "technician" : "customer";
        const direction = msgData.direction || (speaker === "technician" ? "outbound" : "inbound");

        const newMsg: TARSMessage = {
          messageId: msgData.messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          direction,
          speaker,
          timestamp: msgData.timestamp || eventDate,
          capturedAt: eventDate,
          text: msgText,
          attachmentCount: Number(msgData.attachmentCount || 0)
        };

        targetCase.messages.push(newMsg);

        // State Machine Transition
        if (targetCase.status === "NEW") {
          targetCase.status = "ACTIVE";
        } else if (speaker === "technician" && msgText.includes("?")) {
          targetCase.status = "WAITING_FOR_CUSTOMER";
        } else if (speaker === "customer" && targetCase.status === "WAITING_FOR_CUSTOMER") {
          targetCase.status = "PROCESSING";
        }

        // Timeline entry
        targetCase.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventId: ev.eventId,
          eventType: ev.eventType,
          timestamp: eventDate,
          title: speaker === "technician" ? "Mensagem do Técnico enviada" : "Mensagem do Cliente recebida",
          detail: msgText.length > 180 ? `${msgText.slice(0, 180)}…` : msgText,
          author: speaker === "technician" ? "Técnico Solar" : targetCase.customer.name,
          data: { messageId: newMsg.messageId, attachmentCount: newMsg.attachmentCount }
        });

        // Run smart heuristic interpretation on text to detect equipment, SN, and fault codes
        analyzeTextHeuristics(msgText, targetCase, eventDate);
        break;
      }

      case "TARS_OBSERVER_CASE_ACTIVE": {
        if (targetCase.status === "NEW") {
          targetCase.status = "ACTIVE";
        }
        targetCase.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventId: ev.eventId,
          eventType: ev.eventType,
          timestamp: eventDate,
          title: "Conversa em Foco no Hyperflow",
          detail: `Conversa ${targetCase.conversationId} ativa no operador. Protocolo: ${targetCase.protocol}.`,
          author: "TARS Vision Bridge",
          data: ev.data
        });
        break;
      }

      case "TECHNICIAN_UI_ACTION": {
        const actionData = ev.data || {};
        const actionDesc = actionData.action || actionData.description || "Ação do Técnico no Navegador";

        targetCase.technicianActions.push({
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          action: actionDesc,
          timestamp: eventDate,
          details: actionData,
          page: ev.page || ev.origin
        });

        targetCase.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventId: ev.eventId,
          eventType: ev.eventType,
          timestamp: eventDate,
          title: `Ação Operacional: ${actionDesc}`,
          detail: `Técnico executou '${actionDesc}' na página ${ev.title || ev.page || "S-Miles/Portal"}.`,
          author: "Técnico Solar",
          data: ev.data
        });
        break;
      }

      case "PAGE_NAVIGATION": {
        targetCase.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventId: ev.eventId,
          eventType: ev.eventType,
          timestamp: eventDate,
          title: "Navegação Observada",
          detail: `Aba navegou para: ${ev.page || ev.title || "Nova Página"}.`,
          author: "TARS Observer",
          data: ev.data
        });
        break;
      }

      default: {
        targetCase.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventId: ev.eventId,
          eventType: ev.eventType,
          timestamp: eventDate,
          title: `Evento: ${ev.eventType}`,
          detail: typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data || {}),
          author: "TARS Observer",
          data: ev.data
        });
      }
    }

    targetCase.updatedAt = eventDate;
    affectedCaseIds.add(targetCase.id);
  }

  const filteredCases = updatedCases.filter(isMeaningfulCase);

  return {
    updatedCases: filteredCases,
    processedCount,
    duplicateCount,
    affectedCaseIds: Array.from(affectedCaseIds)
  };
}

// In-depth text analyzer for inverter alarms, equipment and confidence
function analyzeTextHeuristics(text: string, tarsCase: TARSCase, timestamp: string) {
  if (!text) return;
  const lower = text.toLowerCase();

  // 1. Manufacturer check
  const mfrList = ["Deye", "FoxESS", "Huawei", "Solis", "Growatt", "Hoymiles", "Sungrow", "Sofar"];
  for (const mfr of mfrList) {
    if (lower.includes(mfr.toLowerCase()) && (!tarsCase.equipment.manufacturer || tarsCase.equipment.manufacturer === "Desconhecido")) {
      tarsCase.equipment.manufacturer = mfr;
    }
  }

  // 2. Error codes & alarms
  const errorMatches: Array<{ code: string; desc: string }> = [];
  if (/\b(f30|erro\s*30|falha\s*30)\b/i.test(text)) {
    errorMatches.push({ code: "F30", desc: "Falha de Relé Interno / Barramento CC-CA Deye" });
  }
  if (/\b(f18|f20|f24)\b/i.test(text)) {
    errorMatches.push({ code: text.match(/\b(f18|f20|f24)\b/i)![0].toUpperCase(), desc: "Alarme de Corrente de Fuga ou Sobretensão" });
  }
  if (/\b(alarme\s*21|erro\s*21|falha\s*21)\b/i.test(text)) {
    errorMatches.push({ code: "Erro 21", desc: "Sobretensão na Rede CA (Grid Volt High) FoxESS" });
  }
  if (/\b(riso|resistencia\s*de\s*isolamento|isolamento\s*baixo)\b/i.test(text)) {
    errorMatches.push({ code: "Riso Low", desc: "Baixa Resistência de Isolamento nas Strings Fotovoltaicas" });
  }

  for (const err of errorMatches) {
    const exists = tarsCase.technicalEvidence.some(e => e.value.includes(err.code));
    if (!exists) {
      tarsCase.technicalEvidence.push({
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "alarm_code",
        value: `${err.code}: ${err.desc}`,
        timestamp,
        source: "Hyperflow Message",
        notes: "Identificado automaticamente pelo analisador passivo TARS"
      });

      // Add observation
      tarsCase.aiObservations.push({
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp,
        category: "fault_diagnosis",
        title: `Detecção de Código de Falha: ${err.code}`,
        detail: `Alarme '${err.code}' detectado na mensagem do cliente. ${err.desc}.`,
        suggestedAction: "Verificar medição de tensões AC e isolamento Riso antes de acionar RMA.",
        confidence: 0.85,
        confidenceLevel: "HIGH",
        needsHumanReview: false,
        uncertainties: []
      });
    }
  }

  // 3. Multimeter / Voltage measurements
  const voltMatch = text.match(/(\d{2,3}(?:[.,]\d+)?)\s*(?:v(?:ac|dc)?|volts?)/i);
  if (voltMatch) {
    const vVal = voltMatch[0];
    const exists = tarsCase.technicalEvidence.some(e => e.value.includes(vVal));
    if (!exists) {
      tarsCase.technicalEvidence.push({
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "measurement",
        value: `Tensão registrada: ${vVal}`,
        timestamp,
        source: "Mensagem do Cliente / Multímetro",
        notes: "Parâmetro elétrico aferido"
      });
    }
  }

  // 4. Low-confidence visual / technical detection rule:
  // If customer mentions photos or images, or if text has vague complaints ("não liga", "está queimado"),
  // trigger HUMAN_REVIEW_REQUIRED rather than inventing an answer!
  const mentionsMedia = /(foto|imagem|video|anexo|etiqueta|placa\s*apagada)/i.test(text);
  const isVagueComplaint = /(parou|nao\s*funciona|nao\s*liga|estranho|apagou\s*tudo)/i.test(text) && errorMatches.length === 0;

  if (mentionsMedia || isVagueComplaint) {
    tarsCase.needsHumanReview = true;
    tarsCase.status = "HUMAN_REVIEW";
    const uncertaintyMsg = mentionsMedia 
      ? "Evidência de mídia (foto/vídeo) recebida: requer inspeção visual humana pelo técnico antes de emitir laudo."
      : "Relato do cliente impreciso sem código de erro explícito: requer triagem técnica humana.";

    if (!tarsCase.uncertainties.includes(uncertaintyMsg)) {
      tarsCase.uncertainties.push(uncertaintyMsg);
    }

    tarsCase.confidence = Math.min(tarsCase.confidence, 0.48);
    tarsCase.confidenceLevel = "LOW";

    // Push HUMAN_REVIEW_REQUIRED to timeline if not recently pushed
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
export function exportLearningCandidatesJSONL(cases: TARSCase[]): string {
  const candidates = cases.filter(c => c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated);
  const lines: string[] = [];

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

export function exportLearningCandidates(cases: TARSCase[], format = "jsonl"): string {
  const candidates = cases.filter(c =>
    isMeaningfulCase(c) &&
    (c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated || c.status === "CLOSED")
  );

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

  return exportLearningCandidatesJSONL(cases);
}

// ------------------------------------------------------------
// SMART LEARNING WITH TARS AI (Gemini Synthesis)
// ------------------------------------------------------------
export async function runTarsSmartLearningAnalysis(caseItem: TARSCase): Promise<{
  success: boolean;
  data?: any;
  error?: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "GEMINI_API_KEY is not configured.",
      data: {
        conclusiveDiagnosis: caseItem.finalDiagnosis || "Diagnóstico validado com sucesso.",
        conclusiveResolution: caseItem.finalResolution || "Atendimento executado.",
        technicalConformity: "ABNT NBR 16149 / Critérios de Garantia",
        isGoldenCandidate: true,
        goldenReason: "Caso fechado com resolução técnica consistente.",
        tags: ["solar", "tars-smart-learning"]
      }
    };
  }

  try {
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
  } catch (err: any) {
    console.error("[runTarsSmartLearningAnalysis Error]", err);
    return {
      success: false,
      error: err?.message || "Smart Learning analysis failed."
    };
  }
}

