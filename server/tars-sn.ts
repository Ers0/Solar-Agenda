// server/tars-sn.ts - TARS Contextual Serial Number Disambiguation Engine
// Extensible architecture: Pattern/Regex -> Contextual AI/ML -> Manufacturer Validation -> Confidence -> Technician Confirmation

import { GoogleGenAI } from "@google/genai";

export interface CandidateSN {
  value: string;
  confidence: number;
  reason: string;
  manufacturer?: string;
  isConfirmed?: boolean;
}

export interface DisambiguationItem {
  token: string;
  classified_as: "serial_number" | "phone" | "protocol" | "measurement" | "cep" | "model" | "other";
  reason: string;
}

export interface TARSIntakeResult {
  ok: boolean;
  source: "gemini_ai" | "heuristic_engine";
  customer: {
    name: string;
    phone: string;
  };
  equipment: {
    manufacturer: string;
    model: string;
    serial_number: string;
    candidates: CandidateSN[];
  };
  protocols: {
    protocol_number?: string;
    hyperflow_id?: string;
    jira_key?: string;
  };
  problem_summary: string;
  disambiguation_log: DisambiguationItem[];
  confidence: {
    overall: number;
    sn: number;
    manufacturer: number;
    customer: number;
  };
  raw_response?: string;
}

let genAIClient: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return genAIClient;
}

/**
 * Stage 2: Contextual AI/ML Disambiguation with Gemini 3.8 Flash
 */
async function extractWithGemini(transcript: string): Promise<TARSIntakeResult | null> {
  const ai = getGenAI();
  if (!ai) return null;

  const systemInstruction = `You are TARS, the specialized AI diagnostic intake and Serial Number (SN) disambiguation engine for Solar Agenda (photovoltaic inverter technical support).
Your goal is to parse raw conversation transcripts (from Hyperflow, WhatsApp, or field technician notes) and extract technical SLA case information with rigorous Serial Number disambiguation.

CRITICAL DISAMBIGUATION RULES:
1. DISTINGUISH Serial Numbers (SN) from:
   - Phone numbers: e.g., (11) 98765-4321, 11999998888, +55 19 98888-7777 (must be classified as phone, NOT serial number).
   - Protocols / Ticket IDs: e.g., 458921, #SOL-9901, ADB-123456, HF-8821, protocolo 123456 (classified as protocol).
   - Electrical measurements: e.g., 220V, 380V, 12.5A, 5000W, 60Hz, 3.4kW (classified as measurement).
   - Postal codes (CEP) & Tax IDs (CPF, CNPJ): e.g., 13000-000, 123.456.789-00 (classified as cep/cpf).
   - Dates & times: e.g., 10/09/2026, 14:30.
   - Model numbers without serial identifiers: e.g., SUN-8K-SG01LP1, SUN2000-10KTL-M1 (classified as model).

2. EXTENSIBLE SERIAL NUMBER IDENTIFICATION & MANUFACTURER FORMAT PROFILES:
   - Do NOT rely on a closed list of serial numbers. Solar equipment from any manufacturer will have unique serial number formats.
   - Use these manufacturer signatures and format guidelines:
     * Deye: 10-14 digits, typically starts with 2x (e.g. 230123456789, 2405001234).
     * FoxESS: Starts with 'FE' or 'GABEF', 12-16 characters alphanumeric (e.g. FE240189012345, GABEF123456789).
     * Huawei: 16-20 alphanumeric characters, typically starts with '21' (e.g. 2101072938102345, FusionSolar SUN2000).
     * Solis (Ginlong): 10-16 alphanumeric or numeric sequence (e.g. 110D230491823, 160129038291).
     * Growatt: 10-16 characters, often starts with letters (e.g. AL20349182, MIN3000TL, BR102938472).
     * Hoymiles: Microinverter serials are 12 digits, often starting with 10, 11, 12 or 14 (e.g. 114173129841).
     * Sungrow: 10-18 alphanumeric characters, often starting with letters like A23... or B21... (e.g. A23049182391).
     * GoodWe: 16 characters alphanumeric, often starting with 9 (e.g. 91000ESN12345678).
     * Fronius: 8 digits purely numeric (e.g. 28123456).
     * SMA: 10 digits purely numeric (e.g. 1930012345).
     * SAJ: 12-14 characters, frequently starts with H2, S2, or C2.
     * Sofar Solar: 10-14 digits starting with SF or pure numeric series.
   - Pay close attention to contextual triggers: "SN", "S/N", "serial", "número de série", "etiqueta", "placa", "leitura", "inversor", "código de barras".

3. OUTPUT FORMAT:
   Return ONLY valid JSON matching this exact structure:
   {
     "customer": { "name": "Customer Name", "phone": "11999998888" },
     "equipment": {
       "manufacturer": "Deye",
       "model": "SUN-8K",
       "serial_number": "230123456789",
       "candidates": [
         {
           "value": "230123456789",
           "confidence": 0.98,
           "reason": "12-digit hardware identifier adjacent to 'inversor Deye'; matches Deye 23x signature.",
           "manufacturer": "Deye"
         }
       ]
     },
     "protocols": {
       "protocol_number": "458921",
       "hyperflow_id": "",
       "jira_key": ""
     },
     "problem_summary": "Inverter showing Grid Overvoltage Alarm 21",
     "disambiguation_log": [
       { "token": "11999998888", "classified_as": "phone", "reason": "11-digit Brazilian mobile number format with valid DDD 11." },
       { "token": "458921", "classified_as": "protocol", "reason": "Preceded by 'protocolo' keyword." },
       { "token": "230123456789", "classified_as": "serial_number", "reason": "Valid inverter hardware serial number with high confidence." }
     ],
     "confidence": {
       "overall": 0.96,
       "sn": 0.98,
       "manufacturer": 0.95,
       "customer": 0.92
     }
   }`;

  try {
    const prompt = `Please extract and disambiguate the following technical support transcript:\n\n"""\n${transcript}\n"""`;

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Gemini request timed out after 8500ms")), 8500)
    );

    const callPromise = ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const response = await Promise.race([callPromise, timeoutPromise]);

    const responseText = response.text;
    if (!responseText) return null;

    const parsed = JSON.parse(responseText);
    return {
      ok: true,
      source: "gemini_ai",
      customer: {
        name: parsed.customer?.name || "Cliente Solar",
        phone: parsed.customer?.phone || "",
      },
      equipment: {
        manufacturer: parsed.equipment?.manufacturer || "Other",
        model: parsed.equipment?.model || "Solar Inverter",
        serial_number: parsed.equipment?.serial_number || (parsed.equipment?.candidates?.[0]?.value || ""),
        candidates: Array.isArray(parsed.equipment?.candidates) ? parsed.equipment.candidates : [],
      },
      protocols: {
        protocol_number: parsed.protocols?.protocol_number || "",
        hyperflow_id: parsed.protocols?.hyperflow_id || "",
        jira_key: parsed.protocols?.jira_key || "",
      },
      problem_summary: parsed.problem_summary || "Anomalia técnica em equipamento solar.",
      disambiguation_log: Array.isArray(parsed.disambiguation_log) ? parsed.disambiguation_log : [],
      confidence: {
        overall: Number(parsed.confidence?.overall || 0.9),
        sn: Number(parsed.confidence?.sn || 0.9),
        manufacturer: Number(parsed.confidence?.manufacturer || 0.85),
        customer: Number(parsed.confidence?.customer || 0.85),
      },
    };
  } catch (err: any) {
    console.warn("[TARS-SN] Gemini AI extraction encountered error, falling back to heuristics:", err.message);
    return null;
  }
}

/**
 * Stage 1 & Fallback: Heuristic Disambiguation Engine
 * Employs pattern matching, proximity weighting, and false-positive elimination
 */
function extractWithHeuristics(text: string): TARSIntakeResult {
  const disambiguationLog: DisambiguationItem[] = [];
  const candidates: CandidateSN[] = [];
  const lower = text.toLowerCase();

  // 1. Phone extraction & disambiguation
  let detectedPhone = "";
  const phoneRegex = /(?:\+?55\s?)?(?:\(?([1-9][0-9])\)?\s?)?(9\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4})\b/g;
  let phoneMatch;
  while ((phoneMatch = phoneRegex.exec(text)) !== null) {
    const raw = phoneMatch[0].trim();
    const cleanDigits = raw.replace(/\D/g, "");
    if (cleanDigits.length >= 10 && cleanDigits.length <= 13) {
      detectedPhone = cleanDigits;
      disambiguationLog.push({
        token: raw,
        classified_as: "phone",
        reason: `Matched Brazilian telephone pattern (DDD ${phoneMatch[1] || "local"}). Excluded from SN candidates.`,
      });
      break;
    }
  }

  // 2. Protocols extraction
  let detectedProtocol = "";
  const protocolRegex = /(?:protocolo(?:\s+(?:de\s+)?(?:garantia|atendimento|suporte|chamado|rma))?|ticket|chamado|atendimento|ordem|jira|rma)\s*[:#\-]?\s*([A-Za-z0-9\-]+)/gi;
  let protoMatch;
  while ((protoMatch = protocolRegex.exec(text)) !== null) {
    const token = protoMatch[1];
    if (token.length >= 3 && token.length <= 20) {
      detectedProtocol = token;
      disambiguationLog.push({
        token,
        classified_as: "protocol",
        reason: `Preceded by protocol/ticket indicator word. Excluded from hardware serial numbers.`,
      });
      break;
    }
  }

  // 3. Electrical measurements extraction
  const measureRegex = /\b(\d+(?:\.\d+)?\s*(?:v|volts|a|amperes|w|kw|kwh|hz|mhz|kvar))\b/gi;
  let measMatch;
  while ((measMatch = measureRegex.exec(text)) !== null) {
    disambiguationLog.push({
      token: measMatch[1],
      classified_as: "measurement",
      reason: "Identified as electrical metric/measurement unit.",
    });
  }

  // 4. CEP extraction
  const cepRegex = /\b\d{5}[-]\d{3}\b/g;
  let cepMatch;
  while ((cepMatch = cepRegex.exec(text)) !== null) {
    disambiguationLog.push({
      token: cepMatch[0],
      classified_as: "cep",
      reason: "Brazilian postal code (CEP) format.",
    });
  }

  // 5. Detect Manufacturer
  const mfrKeywords = [
    { name: "Deye", keys: ["deye", "sun-", "sg01", "sg03", "sg04", "sg05"] },
    { name: "FoxESS", keys: ["foxess", "fox-ess", "fox ess", "gabef", "t-series", "f-series"] },
    { name: "Huawei", keys: ["huawei", "fusionsolar", "sun2000"] },
    { name: "Solis", keys: ["solis", "ginlong"] },
    { name: "Growatt", keys: ["growatt", "min ", "mic ", "sph ", "mid "] },
    { name: "Sungrow", keys: ["sungrow", "sg110", "sg5", "sg125"] },
    { name: "Hoymiles", keys: ["hoymiles", "hms-", "hm-", "hmt-"] },
    { name: "GoodWe", keys: ["goodwe", "gw-", "dns", "eh-"] },
    { name: "Fronius", keys: ["fronius", "primo", "symo", "galvo"] },
    { name: "SMA", keys: ["sma", "sunny boy", "sunny tripower"] },
    { name: "SAJ", keys: ["saj", "suntuno", "r5-", "plus-"] },
    { name: "Sofar", keys: ["sofar", "hyd ", "g3"] },
  ];

  let detectedMfr = "Other";
  let mfrConfidence = 0.5;
  for (const m of mfrKeywords) {
    if (m.keys.some((k) => lower.includes(k))) {
      detectedMfr = m.name;
      mfrConfidence = 0.92;
      break;
    }
  }

  // 6. Detect Model
  let detectedModel = "";
  const directModel = text.match(/\b(SUN-[0-9A-Z\-]+|SUN2000-[0-9A-Z\-]+|FOX-[0-9A-Z\-]+|HMS-[0-9A-Z\-]+|MIN\s*[0-9]+[A-Z\-]+)\b/i);
  if (directModel) {
    detectedModel = directModel[1].trim();
  } else {
    detectedModel = detectedMfr !== "Other" ? `${detectedMfr} Inverter` : "Solar Inverter";
  }

  // 7. Token Candidate Extraction for Serial Numbers
  const snTokenRegex = /\b([A-Za-z0-9\-]{8,24})\b/g;
  const seen = new Set<string>();
  let tokenMatch;

  while ((tokenMatch = snTokenRegex.exec(text)) !== null) {
    const token = tokenMatch[1];
    if (seen.has(token)) continue;

    // Check if previously disambiguated as phone, protocol, measurement, or cep
    const alreadyDisambiguated = disambiguationLog.some((d) => d.token.toLowerCase() === token.toLowerCase());
    if (alreadyDisambiguated) continue;

    // Photovoltaic hardware serial numbers MUST contain numbers
    if (!/[0-9]/.test(token)) continue;

    // Skip phone fragments if matched
    const digitsOnly = token.replace(/\D/g, "");
    if (detectedPhone && digitsOnly.length >= 6 && detectedPhone.includes(digitsOnly)) {
      continue;
    }

    // Skip if it matches the detected protocol
    if (detectedProtocol && token.toLowerCase() === detectedProtocol.toLowerCase()) {
      continue;
    }

    // Skip pure common English/Portuguese words
    const commonWords = [
      "inversor", "equipamento", "cliente", "garantia", "protocolo",
      "suporte", "atendimento", "instalacao", "mensagem", "documento",
      "tensao", "corrente", "potencia", "geracao", "relatorio",
    ];
    if (commonWords.includes(token.toLowerCase())) continue;

    const startIdx = Math.max(0, tokenMatch.index - 50);
    const endIdx = Math.min(text.length, tokenMatch.index + token.length + 50);
    const context = text.slice(startIdx, endIdx).toLowerCase();

    let score = 0.50;
    const reasons: string[] = [];

    // Alphanumeric bonus
    if (/[0-9]/.test(token) && /[A-Za-z]/.test(token)) {
      score += 0.25;
      reasons.push("Alphanumeric hardware pattern");
    } else if (/^\d{10,16}$/.test(token)) {
      score += 0.20;
      reasons.push("10-16 digit sequence");
    }

    // Context bonus
    if (context.includes("inversor") || context.includes("sn") || context.includes("s/n") || context.includes("serial")) {
      score += 0.20;
      reasons.push("Adjacent to hardware/serial keywords");
    }

    // Manufacturer signatures
    if (detectedMfr === "Deye" && /^2[0-5]\d{8,12}$/.test(token)) {
      score += 0.25;
      reasons.push("Conforms to Deye 23x/24x serial format");
    } else if (detectedMfr === "FoxESS" && (/^FE/i.test(token) || /^GABEF/i.test(token) || token.length >= 12)) {
      score += 0.25;
      reasons.push("Conforms to FoxESS hardware format");
    } else if (detectedMfr === "Huawei" && (/^21[0-9A-Za-z]{14,18}$/.test(token) || token.length >= 16)) {
      score += 0.25;
      reasons.push("Conforms to Huawei FusionSolar 16-20 char serial format");
    } else if (detectedMfr === "Hoymiles" && (/^1[0-4]\d{10}$/.test(token) || /^\d{12}$/.test(token))) {
      score += 0.25;
      reasons.push("Conforms to Hoymiles 12-digit microinverter format");
    } else if (detectedMfr === "Fronius" && /^\d{8}$/.test(token)) {
      score += 0.25;
      reasons.push("Conforms to Fronius 8-digit serial format");
    } else if (detectedMfr === "SMA" && /^\d{10}$/.test(token)) {
      score += 0.25;
      reasons.push("Conforms to SMA 10-digit serial format");
    } else if (detectedMfr === "GoodWe" && (/^9\d{15}$/.test(token) || token.length === 16)) {
      score += 0.25;
      reasons.push("Conforms to GoodWe 16-char serial format");
    } else if (detectedMfr === "Solis" && (/^[A-Za-z0-9]{10,16}$/.test(token))) {
      score += 0.20;
      reasons.push("Conforms to Solis hardware identifier");
    } else if (detectedMfr === "Growatt" && (/^[A-Za-z0-9]{10,16}$/.test(token))) {
      score += 0.20;
      reasons.push("Conforms to Growatt hardware identifier");
    } else if (detectedMfr === "Sungrow" && (/^[A-Za-z0-9]{10,18}$/.test(token))) {
      score += 0.20;
      reasons.push("Conforms to Sungrow hardware identifier");
    }

    score = Math.min(0.98, score);

    if (score >= 0.55) {
      seen.add(token);
      candidates.push({
        value: token,
        confidence: score,
        reason: reasons.join("; "),
        manufacturer: detectedMfr,
      });

      disambiguationLog.push({
        token,
        classified_as: "serial_number",
        reason: reasons.join("; ") || "Identified as inverter serial number candidate.",
      });
    }
  }

  // Sort candidates by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  const primarySN = candidates[0]?.value || "";

  // 8. Detect Customer Name
  let detectedName = "Cliente Solar";
  const nameRegex = /(?:cliente|sr\.|sra\.|nome)\s*[:=]?\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){1,3})/i;
  const nameMatch = text.match(nameRegex);
  if (nameMatch && nameMatch[1].length > 4) {
    detectedName = nameMatch[1].trim();
  }

  // 9. Problem Summary
  let problem = "Anomalia técnica em equipamento solar.";
  const alarmMatch = text.match(/(?:alarme|erro|falha|defeito|código|code)\s*[:#\-]?\s*([^\n\.,;]{3,60})/i);
  if (alarmMatch) {
    problem = `Alarme/Falha reportada: ${alarmMatch[0].trim()}`;
  }

  const snConfidence = candidates[0]?.confidence || 0.4;
  const overallConfidence = (snConfidence * 0.5 + mfrConfidence * 0.3 + 0.2);

  return {
    ok: true,
    source: "heuristic_engine",
    customer: {
      name: detectedName,
      phone: detectedPhone,
    },
    equipment: {
      manufacturer: detectedMfr,
      model: detectedModel,
      serial_number: primarySN,
      candidates,
    },
    protocols: {
      protocol_number: detectedProtocol,
      hyperflow_id: "",
      jira_key: "",
    },
    problem_summary: problem,
    disambiguation_log: disambiguationLog,
    confidence: {
      overall: Math.round(overallConfidence * 100) / 100,
      sn: snConfidence,
      manufacturer: mfrConfidence,
      customer: 0.75,
    },
  };
}

/**
 * Public Orchestrator: Calls Gemini AI first, falls back smoothly to heuristics
 */
export async function runTARSIntakeDisambiguation(transcript: string): Promise<TARSIntakeResult> {
  const geminiResult = await extractWithGemini(transcript);
  if (geminiResult) {
    return geminiResult;
  }
  return extractWithHeuristics(transcript);
}
