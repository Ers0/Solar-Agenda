// server/tars-search.ts - TARS Google Search Grounded Intelligence Engine
import { GoogleGenAI } from "@google/genai";
import { SolarRAGEngine, HybridSearchResult } from "./rag-engine";

export interface GroundedWebSource {
  title: string;
  url: string;
  snippet?: string;
  domain?: string;
  source: string;
}

export interface GroundedSearchResult {
  ok: boolean;
  query: string;
  answer?: string;
  sources: GroundedWebSource[];
  searchQueries: string[];
  searchEntryPoint?: string;
  model?: string;
  latency_ms: number;
  results: Array<{
    title: string;
    content: string;
    snippet: string;
    url?: string;
    source: string;
    domain?: string;
    score?: number;
    isWebGrounded?: boolean;
  }>;
  error?: string;
}

let cachedGenAI: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  if (!apiKey) return null;
  if (!cachedGenAI) {
    cachedGenAI = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
  }
  return cachedGenAI;
}

/**
 * Executes a real-time Google Search Grounded query using Gemini 3 series models.
 * Grounding pulls the latest documentation, inverter error manuals, datasheets,
 * and electrical grid guidelines from the live web with verified source URLs.
 */
export async function performGroundedWebSearch(
  query: string,
  options?: { lang?: string; filterDomain?: string; systemPrompt?: string }
): Promise<GroundedSearchResult> {
  const t0 = Date.now();
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return {
      ok: true,
      query: "",
      answer: "Nenhum termo de busca fornecido.",
      sources: [],
      searchQueries: [],
      latency_ms: 0,
      results: []
    };
  }

  const ai = getGenAI();
  if (!ai) {
    // Fallback if no API key is available
    return {
      ok: false,
      query: cleanQuery,
      error: "GEMINI_API_KEY não configurada para pesquisa web com Google Search Grounding.",
      sources: [],
      searchQueries: [],
      latency_ms: Date.now() - t0,
      results: []
    };
  }

  const isEnglish = (options?.lang === "en" || /^[a-zA-Z0-9\s.,!?'"-_]+$/.test(cleanQuery)) &&
    (cleanQuery.toLowerCase().includes("how") || cleanQuery.toLowerCase().includes("what") || cleanQuery.toLowerCase().includes("manual") || cleanQuery.toLowerCase().includes("datasheet") || cleanQuery.toLowerCase().includes("error") || cleanQuery.toLowerCase().includes("inverter"));

  const defaultSystemPrompt = isEnglish
    ? `You are TARS Grounded Web Intelligence Engine, a specialized technical research assistant for Solar Energy systems, PV Inverters (Deye, Hoymiles, Growatt, Solis, Fronius, FoxESS, Huawei, Sungrow), grid standards (ABNT NBR 16149 / 16274, IEEE 1547, IEC 62109), manufacturer documentation, datasheets, firmware notes, and warranty RMA procedures.
Use Google Search Grounding to find accurate, up-to-date information. Summarize the answer in direct, professional technical bullet points, noting error definitions, troubleshooting steps, and verified hardware parameters.`
    : `Você é o TARS Grounded Web Intelligence Engine, o assistente técnico de pesquisa web e engenharia solar fotovoltaica da Belenergy / Solar Agenda.
Você pesquisa informações atualizadas na web com Google Search Grounding sobre inversores solares (Deye, Hoymiles, Growatt, Solis, Fronius, FoxESS, Huawei, Sungrow), microinversores, baterias, normas elétricas (ABNT NBR 16149, NBR 16274, NBR 5410, IEC 62109), manuais de serviço, códigos de falha/alarme, procedimentos de garantia e novidades do setor.
Estruture sua resposta de forma clara, técnica e objetiva em português, citando causas prováveis, procedimentos de medição em campo e soluções recomendadas pelos fabricantes.`;

  const candidateModels = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"];
  let response: any = null;
  let usedModel = "gemini-3.8-flash";
  let lastErr: any = null;

  for (const modelCandidate of candidateModels) {
    try {
      response = await ai.models.generateContent({
        model: modelCandidate,
        contents: cleanQuery,
        config: {
          systemInstruction: options?.systemPrompt || defaultSystemPrompt,
          tools: [{ googleSearch: {} }],
          temperature: 0.2
        }
      });
      if (response) {
        usedModel = modelCandidate;
        break;
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`[TARS Web Search] Model ${modelCandidate} failed:`, err?.message || err);
    }
  }

  if (!response) {
    return {
      ok: false,
      query: cleanQuery,
      error: lastErr?.message || "Falha ao conectar com o serviço de pesquisa web Google.",
      sources: [],
      searchQueries: [],
      latency_ms: Date.now() - t0,
      results: []
    };
  }

  const answerText = response.text || "";
  const candidate = response.candidates?.[0];
  const groundingMeta = candidate?.groundingMetadata;

  const rawChunks = groundingMeta?.groundingChunks || [];
  const searchQueries = groundingMeta?.webSearchQueries || [];
  const searchEntryPoint = groundingMeta?.searchEntryPoint?.renderedContent || undefined;

  const sources: GroundedWebSource[] = [];
  const seenUrls = new Set<string>();

  for (const chunk of rawChunks) {
    if (chunk.web && chunk.web.uri) {
      const uri = chunk.web.uri;
      if (!seenUrls.has(uri)) {
        seenUrls.add(uri);
        let domain = "web";
        try {
          domain = new URL(uri).hostname.replace(/^www\./, "");
        } catch (e) {}

        sources.push({
          title: chunk.web.title || domain,
          url: uri,
          snippet: chunk.web.title || uri,
          domain,
          source: "Google Search Grounding"
        });
      }
    }
  }

  // Generate structured result cards for UI and tools
  const results = sources.map((s, idx) => ({
    title: s.title,
    content: s.title,
    snippet: s.title + (s.domain ? ` (${s.domain})` : ""),
    url: s.url,
    domain: s.domain,
    source: `Google Search Grounding (${s.domain || "web"})`,
    score: 1 - idx * 0.05,
    isWebGrounded: true
  }));

  // If we have an answer but no chunk items, construct an answer card
  if (results.length === 0 && answerText) {
    results.push({
      title: `Resultado TARS para: ${cleanQuery}`,
      content: answerText,
      snippet: answerText.slice(0, 300),
      source: "Google Search Grounding (Gemini)",
      score: 0.95,
      isWebGrounded: true
    });
  }

  return {
    ok: true,
    query: cleanQuery,
    answer: answerText,
    sources,
    searchQueries,
    searchEntryPoint,
    model: usedModel,
    latency_ms: Date.now() - t0,
    results
  };
}

/**
 * Unified Search: Combines Real-Time Google Search Grounding with Local Solar RAG Engine.
 */
export async function performUnifiedSearch(
  query: string,
  options?: { mode?: "all" | "web" | "kb"; topK?: number; lang?: string }
): Promise<{
  ok: boolean;
  query: string;
  mode: "all" | "web" | "kb";
  answer?: string;
  webSources: GroundedWebSource[];
  webSearchQueries: string[];
  kbResults: Array<{
    title: string;
    content: string;
    snippet: string;
    source: string;
    score?: number;
    isTable?: boolean;
    metadata?: any;
  }>;
  totalResults: number;
  latency_ms: number;
}> {
  const t0 = Date.now();
  const mode = options?.mode || "all";
  const cleanQuery = String(query || "").trim();

  let webResult: GroundedSearchResult | null = null;
  let kbResults: any[] = [];

  const promises: Promise<any>[] = [];

  if (mode === "all" || mode === "web") {
    promises.push(
      performGroundedWebSearch(cleanQuery, { lang: options?.lang })
        .then(res => { webResult = res; })
        .catch(err => {
          console.warn("[Unified Search] Web search error:", err);
          webResult = {
            ok: false,
            query: cleanQuery,
            sources: [],
            searchQueries: [],
            latency_ms: 0,
            results: [],
            error: String(err)
          };
        })
    );
  }

  if (mode === "all" || mode === "kb") {
    promises.push(
      (async () => {
        try {
          const rag = SolarRAGEngine.getInstance();
          const hits: HybridSearchResult[] = await rag.search(cleanQuery, options?.topK || 6);
          kbResults = hits.map(h => ({
            title: h.chunk.title,
            content: h.chunk.text,
            snippet: h.chunk.text.slice(0, 260),
            source: h.chunk.source,
            isTable: h.chunk.isTable,
            score: h.rerankScore || h.rrfScore,
            matchReasons: h.matchReasons,
            metadata: h.chunk.metadata
          }));
        } catch (e) {
          console.warn("[Unified Search] RAG search error:", e);
        }
      })()
    );
  }

  await Promise.all(promises);

  return {
    ok: true,
    query: cleanQuery,
    mode,
    answer: webResult?.answer,
    webSources: webResult?.sources || [],
    webSearchQueries: webResult?.searchQueries || [],
    kbResults,
    totalResults: (webResult?.sources.length || 0) + kbResults.length,
    latency_ms: Date.now() - t0
  };
}
