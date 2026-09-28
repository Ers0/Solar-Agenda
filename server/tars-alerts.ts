import { Response } from "express";
import { GoogleGenAI } from "@google/genai";

export interface ChatbotProblemAlert {
  id: string;
  protocol: string;
  conversationId: string;
  customerName: string;
  customerPhone?: string;
  equipment: {
    manufacturer: string;
    model: string;
    sn?: string;
  };
  problemTitle: string;
  errorCode?: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  messageSnippet: string;
  fullCustomerMessage: string;
  solution: string;
  solutionSteps: string[];
  technicalDetails: string;
  timestamp: string;
  read: boolean;
  acknowledgedAt?: string;
  source: string;
}

// In-memory queue of recent alerts
const alertQueue: ChatbotProblemAlert[] = [];
// Active Server-Sent Events subscribers
const sseClients: Set<Response> = new Set();

let genAIClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({ apiKey: key });
  }
  return genAIClient;
}

// Predefined high-precision solutions for known solar equipment faults
const KNOWN_SOLAR_SOLUTIONS: Record<string, {
  title: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  steps: string[];
  details: string;
}> = {
  F30: {
    title: "Falha de Relé Interno / Barramento CC (Deye F30)",
    severity: "HIGH",
    steps: [
      "1. Desligar a chave seccionadora CC e o disjuntor CA por 5 minutos completos para descarregar o barramento capacitivo.",
      "2. Ligar primeiro apenas o disjuntor CA (sem CC) e aferir com multímetro: Fase-Neutro (220V/127V) e Neutro-Terra (< 5V).",
      "3. Ligar a seccionadora CC. Se o relé voltar a estalar repetidamente com erro F30 em display, a placa de controle de relé está avariada.",
      "4. Procedimento de contingência: abrir protocolo de RMA Deye com foto da tela e do multímetro para troca imediata da placa."
    ],
    details: "Alarme de travamento ou colagem de contato no relé interno de acoplamento à rede CA ou impedância instável no barramento."
  },
  ERRO_21: {
    title: "Sobretensão na Rede CA (Grid Volt High / Erro 21 FoxESS)",
    severity: "HIGH",
    steps: [
      "1. Medir Vca fase-neutro nos bornes do inversor durante o pico de geração (11h-13h).",
      "2. Se a rede da concessionária ultrapassar 253V (limite NBR 16149), fotografar o multímetro e acionar a distribuidora local para adequação de tap de transformador.",
      "3. Contingência técnica: acessar menu com senha de instalador (0000) e ajustar temporariamente 'Volt-Watt' ou limite superior de tensão CA para 254V com tempo de reconexão de 180s.",
      "4. Conferir aperto e bitola do condutor CA até o quadro geral para eliminar queda de tensão resistiva."
    ],
    details: "A tensão da rede pública ou elevação de tensão por impedância de cabeamento ultrapassou os parâmetros de proteção da NBR 16149."
  },
  RISO_LOW: {
    title: "Baixa Resistência de Isolamento das Strings CC (Riso Low)",
    severity: "CRITICAL",
    steps: [
      "1. Desconectar todas as strings fotovoltaicas do inversor com a seccionadora CC aberta.",
      "2. Com megômetro configurado para 1000V DC, medir a resistência de isolamento de cada polo (+ e -) em relação ao condutor de aterramento (PE). Mínimo exigido: > 1,0 MΩ.",
      "3. Isolar a string com leitura baixa (< 1 MΩ). Inspecionar visualmente cabos sob as telhas e conectores MC4 com umidade ou oxidação.",
      "4. Refazer conectores MC4 danificados com prensa-cabo estanque e manter apenas strings íntegras ligadas até a manutenção."
    ],
    details: "Fuga de corrente contínua para o aterramento através de cabo danificado, conector com infiltração de água ou microfissura de módulo."
  },
  F18_F20: {
    title: "Fuga de Corrente Residual Excessiva (F18 / F20 / GFCI Trip)",
    severity: "CRITICAL",
    steps: [
      "1. Desligar o inversor e verificar se há acúmulo de água ou condensação no interior da Stringbox CA e nos prensa-cabos.",
      "2. Inspecionar o condutor de equipotencialização (PE) dos módulos e da estrutura de alumínio.",
      "3. Em dias de chuva torrencial, verificar se a capacitância parasita dos módulos excede 300mA. Ajustar limite de fuga no inversor se recomendado pelo fabricante."
    ],
    details: "Corrente de fuga diferencial residual para o terra acima do limite seguro de proteção humana da norma NBR 16149."
  },
  DTU_OFFLINE: {
    title: "Comunicação DTU / Microinversores Interrompida (Hoymiles S-Miles)",
    severity: "MEDIUM",
    steps: [
      "1. Verificar o LED de status da DTU: Verde piscando rápido indica perda de sinal Wi-Fi com o roteador do cliente.",
      "2. Reposicionar a DTU a menos de 15 metros dos microinversores, fora de quadros metálicos ou cômodos isolados por laje maciça.",
      "3. Conectar na rede Wi-Fi da DTU (DTUBI-...) e reconfigurar credenciais de rede Wi-Fi 2.4GHz pelo app S-Miles Installer.",
      "4. Executar comando 'Pesquisar Microinversores' e sincronizar com o portal S-Miles Cloud."
    ],
    details: "Perda de conectividade RF Sub-1GHz entre a DTU e os microinversores ou desconexão Wi-Fi com a nuvem de monitoramento."
  },
  THERMAL_DERATING: {
    title: "Superaquecimento Interno / Redução Térmica de Potência",
    severity: "MEDIUM",
    steps: [
      "1. Verificar se o dissipador de calor traseiro está com espaçamento mínimo de 30cm nas laterais e 50cm vertical.",
      "2. Limpar aletas do dissipador com ar comprimido ou pincel seco.",
      "3. Se o inversor estiver exposto ao sol direto vespertino, providenciar cobertura de proteção solar com ventilação natural desimpedida."
    ],
    details: "Temperatura interna do inversor atingiu o limiar de proteção térmica, reduzindo propositalmente a geração para evitar queima de semicondutores."
  },
  BREAKER_TRIP: {
    title: "Disjuntor CA / Interruptor DR Desarmando ao Iniciar Geração",
    severity: "HIGH",
    steps: [
      "1. Verificar a curva do disjuntor CA: deve ser Curva C dimensionado para 1,25x a corrente nominal máxima de saída do inversor.",
      "2. Se houver DR (Diferencial Residual), verificar se é do Tipo B ou superimunizado (disjuntores DR tipo AC comuns desarmam com filtros de inversor).",
      "3. Inspecionar aperto das conexões no quadro elétrico com torquímetro (conexões frouxas geram aquecimento e desarme térmico)."
    ],
    details: "Desarme por pico de corrente de partida (inrush) ou incompatibilidade de seletividade com DR tipo AC convencional."
  }
};

/**
 * Fast intelligent analyzer that identifies problems in customer messages and formulates solutions
 */
export async function analyzeChatMessageForProblems(
  text: string,
  context?: {
    customerName?: string;
    protocol?: string;
    manufacturer?: string;
    model?: string;
    sn?: string;
    conversationId?: string;
  }
): Promise<{
  hasProblem: boolean;
  problemTitle: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  errorCode?: string;
  equipment: { manufacturer: string; model: string; sn?: string };
  messageSnippet: string;
  fullCustomerMessage: string;
  solution: string;
  solutionSteps: string[];
  technicalDetails: string;
} | null> {
  if (!text || typeof text !== "string") return null;
  const rawText = text.trim();
  const lower = rawText.toLowerCase();

  // Detect manufacturer & model
  let mfr = context?.manufacturer || "Inversor Solar";
  if (/deye/i.test(lower)) mfr = "Deye";
  else if (/fox\s*ess|foxess/i.test(lower)) mfr = "FoxESS";
  else if (/hoymiles/i.test(lower)) mfr = "Hoymiles";
  else if (/huawei/i.test(lower)) mfr = "Huawei";
  else if (/solis/i.test(lower)) mfr = "Solis";
  else if (/growatt/i.test(lower)) mfr = "Growatt";
  else if (/sungrow/i.test(lower)) mfr = "Sungrow";

  let model = context?.model || "";
  const modelMatch = rawText.match(/\b(SUN-\d+K[A-Z0-9-]*|H\d+-\d+[A-Z0-9-]*|HMS-\d+[A-Z0-9-]*|SUN2000-\d+[A-Z0-9-]*|MIC\s*\d+[A-Z0-9-]*)\b/i);
  if (modelMatch) model = modelMatch[0].toUpperCase();

  // Heuristic error matching
  let matchedKey: string | null = null;
  let detectedCode: string | undefined = undefined;

  if (/\b(f30|erro\s*30|falha\s*30|rele|estalo|rele\s*estalan)/i.test(lower)) {
    matchedKey = "F30";
    detectedCode = "F30";
  } else if (/\b(erro\s*21|alarme\s*21|grid\s*volt\s*high|sobretens[aã]o|tens[aã]o\s*alta|25\d\s*v)/i.test(lower)) {
    matchedKey = "ERRO_21";
    detectedCode = "Erro 21";
  } else if (/\b(riso|isolamento|fuga\s*cc|resistencia\s*de\s*isolamento|choque)/i.test(lower)) {
    matchedKey = "RISO_LOW";
    detectedCode = "Riso Low";
  } else if (/\b(f18|f20|f24|corrente\s*de\s*fuga|fuga\s*ca|rcmu)/i.test(lower)) {
    matchedKey = "F18_F20";
    detectedCode = "F18/F20";
  } else if (/\b(dtu|microinversor\s*n[aã]o|s-miles|offline|dtu\s*apagad)/i.test(lower)) {
    matchedKey = "DTU_OFFLINE";
    detectedCode = "DTU-OFF";
  } else if (/\b(esquentando|muito\s*quente|derating|aquecendo|temperatura\s*alta)/i.test(lower)) {
    matchedKey = "THERMAL_DERATING";
    detectedCode = "Overheat";
  } else if (/\b(disjuntor|dr\s*desarmando|desarmou|caiu\s*o\s*disjuntor)/i.test(lower)) {
    matchedKey = "BREAKER_TRIP";
    detectedCode = "Trip CA/DR";
  } else if (/\b(n[aã]o\s*liga|parou\s*de\s*gerar|apagou|n[aã]o\s*gera|alarme|falha|defeito|queimou)/i.test(lower)) {
    // General fault condition that warrants AI solution analysis
    matchedKey = "GENERAL_FAULT";
  }

  if (!matchedKey) {
    return null;
  }

  const snippet = rawText.length > 120 ? rawText.slice(0, 117) + "..." : rawText;

  // 1. Fast path: Known equipment fault with structured checklist
  if (matchedKey !== "GENERAL_FAULT" && KNOWN_SOLAR_SOLUTIONS[matchedKey]) {
    const info = KNOWN_SOLAR_SOLUTIONS[matchedKey];
    const fullSolution = info.steps.join("\n");
    return {
      hasProblem: true,
      problemTitle: `[${mfr}${model ? " " + model : ""}] ${info.title}`,
      severity: info.severity,
      errorCode: detectedCode,
      equipment: {
        manufacturer: mfr,
        model: model || mfr,
        sn: context?.sn
      },
      messageSnippet: snippet,
      fullCustomerMessage: rawText,
      solution: fullSolution,
      solutionSteps: info.steps,
      technicalDetails: info.details
    };
  }

  // 2. Dynamic AI path: Consult Gemini to formulate instant practical solar technician solution
  const ai = getGenAI();
  if (ai) {
    try {
      const prompt = `Você é o TARS, o engenheiro sênior de suporte técnico fotovoltaico (Solar Agenda).
Um cliente/instalador acabou de enviar a seguinte mensagem no chatbot de atendimento:
"${rawText}"

Equipamento informado: Fabricante: ${mfr}, Modelo: ${model || "Padrão"}, Protocolo: ${context?.protocol || "Geral"}.

Identifique o problema e forneça uma solução técnica imediata, prática e objetiva para o técnico aplicar em campo (conformidade ABNT NBR 16149 / NBR 5410).
Responda em formato JSON estrito:
{
  "problemTitle": "Título do problema detectado (ex: [Fabricante] Falha X)",
  "severity": "HIGH" ou "CRITICAL" ou "MEDIUM",
  "errorCode": "Código se detectado ou nulo",
  "solutionSteps": [
    "1. Passo 1 de ação técnica...",
    "2. Passo 2 de medição ou teste...",
    "3. Passo 3 de contingência ou resolução..."
  ],
  "technicalDetails": "Explicação técnica sucinta de 1 linha sobre a causa raiz"
}`;

      const res = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      const parsed = JSON.parse(res.text || "{}");
      const steps: string[] = Array.isArray(parsed.solutionSteps) && parsed.solutionSteps.length > 0
        ? parsed.solutionSteps
        : ["1. Verificar conexões elétricas e tensões CC/CA com multímetro.", "2. Reiniciar o equipamento conforme procedimento de segurança.", "3. Inspecionar logs no aplicativo do inversor."];

      return {
        hasProblem: true,
        problemTitle: parsed.problemTitle || `[${mfr}] Anomalia Detectada em Atendimento`,
        severity: parsed.severity === "CRITICAL" ? "CRITICAL" : (parsed.severity === "MEDIUM" ? "MEDIUM" : "HIGH"),
        errorCode: parsed.errorCode || undefined,
        equipment: {
          manufacturer: mfr,
          model: model || mfr,
          sn: context?.sn
        },
        messageSnippet: snippet,
        fullCustomerMessage: rawText,
        solution: steps.join("\n"),
        solutionSteps: steps,
        technicalDetails: parsed.technicalDetails || "Análise em tempo real formulada pelo motor neural TARS."
      };
    } catch (aiErr) {
      console.warn("[TARS Alerts AI fallback]", aiErr);
    }
  }

  // Fallback if AI unavailable
  const fallbackSteps = [
    "1. Orientar o cliente a aferir se a chave CC e o disjuntor CA estão na posição LIGADO.",
    "2. Medir com multímetro a tensão CA nos bornes do quadro (Fase-Neutro e Fase-Fase).",
    "3. Solicitar foto do display do inversor ou print da tela inicial do aplicativo de monitoramento para diagnóstico detalhado."
  ];

  return {
    hasProblem: true,
    problemTitle: `[${mfr}] Anomalia Operacional Detectada`,
    severity: "HIGH",
    equipment: {
      manufacturer: mfr,
      model: model || mfr,
      sn: context?.sn
    },
    messageSnippet: snippet,
    fullCustomerMessage: rawText,
    solution: fallbackSteps.join("\n"),
    solutionSteps: fallbackSteps,
    technicalDetails: "Problema identificado pelo analisador passivo em atendimento ao cliente."
  };
}

/**
 * Registers an alert, notifies all connected SSE clients, and maintains bounded memory queue
 */
export function pushChatbotAlert(alert: Omit<ChatbotProblemAlert, "id" | "timestamp" | "read">): ChatbotProblemAlert {
  const fullAlert: ChatbotProblemAlert = {
    ...alert,
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    read: false
  };

  alertQueue.unshift(fullAlert);
  if (alertQueue.length > 100) {
    alertQueue.pop();
  }

  // Broadcast to all active browser tabs via SSE
  const sseData = `data: ${JSON.stringify({ type: "PROBLEM_DETECTED", alert: fullAlert })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(sseData);
    } catch (e) {
      sseClients.delete(client);
    }
  }

  console.log(`[TARS Realtime Alert] Broadcasted: "${fullAlert.problemTitle}" (Protocol: ${fullAlert.protocol}) to ${sseClients.size} tabs.`);
  return fullAlert;
}

export function getAlerts(since?: string): ChatbotProblemAlert[] {
  if (!since) return alertQueue;
  const sinceTime = new Date(since).getTime();
  return alertQueue.filter(a => new Date(a.timestamp).getTime() > sinceTime);
}

export function markAlertRead(alertId: string): boolean {
  const alert = alertQueue.find(a => a.id === alertId);
  if (alert) {
    alert.read = true;
    alert.acknowledgedAt = new Date().toISOString();
    return true;
  }
  return false;
}

export function subscribeSSE(res: Response): void {
  sseClients.add(res);
  res.on("close", () => {
    sseClients.delete(res);
  });
}
