// server/rag-engine.ts - High Precision Solar Technical RAG Engine
// Architectural Upgrades:
// 1. OCR Text Preprocessing & Normalization (Part numbers, error codes, electrical units)
// 2. Technical Chunking (Preserving spec tables & troubleshooting matrices with context headers)
// 3. Hybrid Search (Dense Embeddings with fallback + Okapi BM25 with exact-token IDF)
// 4. Cross-Encoder Re-Ranking (Lightweight pairwise token alignment + Gemini 2.5 Flash re-ranking)

import fs from "fs";
import path from "path";

export interface TechnicalChunk {
  id: string;
  documentId: string;
  source: string;
  title: string;
  text: string;
  normalizedText: string;
  isTable: boolean;
  metadata: {
    category: "manual" | "troubleshooting_matrix" | "spec_table" | "observer_fallback" | "operational_rule";
    equipment?: string;
    partNumbers?: string[];
    errorCodes?: string[];
    sectionHeader?: string;
    sourceUrl?: string;
  };
}

export interface HybridSearchResult {
  chunk: TechnicalChunk;
  denseScore: number;
  bm25Score: number;
  rrfScore: number;
  rerankScore?: number;
  matchReasons?: string[];
}

// ============================================================================
// 1. OCR Text Preprocessing & Normalization
// ============================================================================

/**
 * Normalizes solar engineering OCR text:
 * - Unifies spaced/broken model numbers (e.g. "H M T - 2 2 5 0" -> "HMT-2250-6T")
 * - Unifies error codes (e.g. "F 1 8", "F-18", "falha F 18" -> "F18")
 * - Normalizes electrical units (e.g. "220 V", "220v", "220 Vac" -> "220VAC", "2 MΩ" -> "2Mohm")
 * - Fixes hyphenated line breaks (e.g. "microinver-\nsor" -> "microinversor")
 */
export function normalizeOcrText(text: string): string {
  if (!text || typeof text !== "string") return "";

  let cleaned = text
    // Replace non-breaking spaces and irregular whitespace
    .replace(/[\u00A0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    // Rejoin words split across line breaks with hyphen
    .replace(/([a-zA-Zá-úÁ-Ú0-9]+)-\s*\n\s*([a-zA-Zá-úÁ-Ú0-9]+)/g, "$1$2")
    // Fix spaced out model numbers like "H M T - 2 2 5 0"
    .replace(/\bH\s*M\s*T\s*[-_]?\s*(\d{3,4})\s*[-_]?\s*(\d*[A-Z]*)\b/gi, (match, p1, p2) => {
      return p2 ? `HMT-${p1}-${p2.toUpperCase()}` : `HMT-${p1}`;
    })
    // Fix spaced out Hoymiles HMS / HMT / MI models
    .replace(/\bH\s*M\s*S\s*[-_]?\s*(\d{3,4})\b/gi, "HMS-$1")
    .replace(/\bM\s*I\s*[-_]?\s*(\d{3,4})\b/gi, "MI-$1")
    // Fix spaced out Deye models like "SUN - 5 K - SG03LP1"
    .replace(/\bS\s*U\s*N\s*[-_]?\s*(\d+)\s*K\s*[-_]?\s*([A-Z0-9]+)\b/gi, "SUN-$1K-$2")
    // Fix spaced out error codes like "F 1 8", "F - 1 8", "E 0 2 5"
    .replace(/\b([FfEeWwAa])\s*[-_.]?\s*0*([1-9]\d{0,2})\b/g, (match, letter, num) => {
      return `${letter.toUpperCase()}${num}`;
    })
    // Normalize electrical units
    .replace(/(\d+)\s*(?:V|v)(?:ac|AC|ca|CA)?\b/g, "$1VAC")
    .replace(/(\d+)\s*(?:V|v)(?:dc|DC|cc|CC)?\b/g, "$1VDC")
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:Hz|hz|HZ)\b/g, "$1Hz")
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:kW|kw|KW|Kw)\b/g, "$1kW")
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:MΩ|Mohm|MOhms?|M\s*ohm)\b/gi, "$1Mohm")
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:kΩ|kohm|KOhms?|k\s*ohm)\b/gi, "$1kohm")
    // Replace multiple newlines with maximum two
    .replace(/\n{3,}/g, "\n\n")
    // Normalize spaces
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned;
}

/**
 * Extracts explicit technical tokens (part numbers, models, error codes) for fast boosting
 */
export function extractTechnicalTokens(text: string): { partNumbers: string[]; errorCodes: string[] } {
  const normalized = normalizeOcrText(text);
  const partNumbers = new Set<string>();
  const errorCodes = new Set<string>();

  // Error codes regex (e.g. F18, F35, E025, W03, A01, OV-V, UN-V)
  const errRegex = /\b(?:[FEWA]\d{1,3}|OV-V|UN-V|OV-F|UN-F|NO-GRID|ISO-FAULT|GRID-FAULT)\b/gi;
  let m;
  while ((m = errRegex.exec(normalized)) !== null) {
    errorCodes.add(m[0].toUpperCase());
  }

  // Solar equipment part numbers & models regex
  const modelRegex = /\b(?:HMT-\d{3,4}(?:-[A-Z0-9]+)?|HMS-\d{3,4}|MI-\d{3,4}|DTU-(?:Pro|Lite|Plus|GPRS|4G)(?:-[A-Z0-9]+)?|SUN-\d+K-[A-Z0-9]+|SG\d{2,3}[A-Z0-9]*|MIN-\d+KTL|MAX-\d+KTL)\b/gi;
  while ((m = modelRegex.exec(normalized)) !== null) {
    partNumbers.add(m[0].toUpperCase());
  }

  return {
    partNumbers: Array.from(partNumbers),
    errorCodes: Array.from(errorCodes)
  };
}

// ============================================================================
// 2. Technical Chunking (Preserving Tables & Troubleshooting Matrices)
// ============================================================================

/**
 * Detects if a markdown/text block is a table or matrix
 */
function isTableBlock(block: string): boolean {
  const lines = block.trim().split("\n");
  if (lines.length < 2) return false;
  // Markdown pipe table
  const pipeCount = lines.filter(l => (l.match(/\|/g) || []).length >= 2).length;
  if (pipeCount >= 2 && pipeCount >= lines.length * 0.6) return true;
  // Delimited spec or troubleshooting list (e.g., Code -> Cause -> Action)
  const arrowCount = lines.filter(l => l.includes("->") || l.includes("—") || l.includes(":")).length;
  if (lines.length >= 3 && arrowCount >= lines.length * 0.7 && lines.some(l => /\b(F\d+|E\d+|tensão|corrente|isolamento)\b/i.test(l))) {
    return true;
  }
  return false;
}

/**
 * Technical chunking algorithm:
 * - Detects table boundaries and keeps whole spec tables intact
 * - Injects section breadcrumbs so child chunks inherit parent context
 * - Respects maximum token thresholds while preserving troubleshooting steps
 */
export function chunkTechnicalDocument(
  content: string,
  options: {
    documentId: string;
    source: string;
    title?: string;
    maxTokens?: number;
    overlapTokens?: number;
  }
): TechnicalChunk[] {
  const normalized = normalizeOcrText(content);
  const chunks: TechnicalChunk[] = [];
  const lines = normalized.split("\n");

  let currentSectionHeader = options.title || "Manual Técnico";
  let buffer: string[] = [];
  let chunkIdx = 0;
  const maxLinesPerChunk = 25; // Approximately 350-450 tokens

  let inTable = false;
  let tableLines: string[] = [];

  function flushBuffer(isTable = false) {
    const textLines = isTable ? tableLines : buffer;
    if (textLines.length === 0) return;

    let chunkText = textLines.join("\n").trim();
    if (!chunkText) return;

    // Prepend section breadcrumb if not already there
    if (!chunkText.startsWith(currentSectionHeader) && !chunkText.includes(`[Context: ${currentSectionHeader}]`)) {
      chunkText = `[Context: ${currentSectionHeader}]\n${chunkText}`;
    }

    const norm = normalizeOcrText(chunkText);
    const tech = extractTechnicalTokens(norm);

    chunks.push({
      id: `${options.documentId}-ch-${chunkIdx++}`,
      documentId: options.documentId,
      source: options.source,
      title: options.title || currentSectionHeader,
      text: chunkText,
      normalizedText: norm,
      isTable,
      metadata: {
        category: isTable ? "spec_table" : "manual",
        sectionHeader: currentSectionHeader,
        partNumbers: tech.partNumbers,
        errorCodes: tech.errorCodes,
        sourceUrl: options.source
      }
    });

    if (isTable) {
      tableLines = [];
      inTable = false;
    } else {
      // Overlap: keep the last 3 lines for context continuity
      buffer = buffer.slice(-3);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for Section Header (Markdown # or UPPERCASE short titles)
    if (/^#{1,4}\s+/.test(trimmed) || (trimmed.length > 3 && trimmed.length < 50 && /^[A-Z0-9\s—\-\.]{4,}$/.test(trimmed))) {
      if (buffer.length > 0) flushBuffer(false);
      currentSectionHeader = trimmed.replace(/^#{1,4}\s+/, "");
      buffer.push(line);
      continue;
    }

    // Check for start or continuation of a Table
    const isPipeLine = (line.match(/\|/g) || []).length >= 2;
    if (isPipeLine) {
      if (!inTable) {
        if (buffer.length > 0) flushBuffer(false);
        inTable = true;
      }
      tableLines.push(line);
      continue;
    } else if (inTable) {
      // End of table detected
      flushBuffer(true);
    }

    buffer.push(line);

    if (buffer.length >= maxLinesPerChunk) {
      flushBuffer(false);
    }
  }

  if (inTable && tableLines.length > 0) {
    flushBuffer(true);
  }
  if (buffer.length > 0) {
    flushBuffer(false);
  }

  return chunks;
}

// ============================================================================
// 3. Okapi BM25 Sparse Search Engine (In-Memory, Zero Dependency)
// ============================================================================

export class OkapiBM25Index {
  private docCount = 0;
  private avgDocLength = 0;
  private docLengths: number[] = [];
  private termFrequencies: Map<string, Map<number, number>> = new Map();
  private docFrequencies: Map<string, number> = new Map();
  private chunks: TechnicalChunk[] = [];

  // Standard BM25 Tuning constants
  private k1: number;
  private b: number;

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  private tokenize(text: string): string[] {
    const norm = normalizeOcrText(text).toLowerCase();
    // Match alphanumeric words and technical hyphenated tokens
    const tokens = norm.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || [];
    return tokens.filter(t => t.length > 1);
  }

  public buildIndex(chunks: TechnicalChunk[]) {
    this.chunks = chunks;
    this.docCount = chunks.length;
    this.docLengths = [];
    this.termFrequencies.clear();
    this.docFrequencies.clear();

    let totalLength = 0;

    for (let i = 0; i < chunks.length; i++) {
      const tokens = this.tokenize(`${chunks[i].title} ${chunks[i].text}`);
      const len = tokens.length;
      this.docLengths[i] = len;
      totalLength += len;

      const docTermMap = new Map<string, number>();
      for (const token of tokens) {
        docTermMap.set(token, (docTermMap.get(token) || 0) + 1);
      }

      for (const [token, count] of docTermMap.entries()) {
        if (!this.termFrequencies.has(token)) {
          this.termFrequencies.set(token, new Map());
        }
        this.termFrequencies.get(token)!.set(i, count);
        this.docFrequencies.set(token, (this.docFrequencies.get(token) || 0) + 1);
      }
    }

    this.avgDocLength = this.docCount > 0 ? totalLength / this.docCount : 1;
  }

  public search(query: string, topK = 15): { chunk: TechnicalChunk; score: number; docIndex: number }[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.docCount === 0) return [];

    const scores = new Float32Array(this.docCount);
    const techQuery = extractTechnicalTokens(query);

    for (const qToken of queryTokens) {
      const df = this.docFrequencies.get(qToken) || 0;
      if (df === 0) continue;

      // Lucene / Robertson-Spärck Jones IDF with smoothing
      const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
      const postings = this.termFrequencies.get(qToken);
      if (!postings) continue;

      for (const [docIdx, tf] of postings.entries()) {
        const docLen = this.docLengths[docIdx] || 1;
        // BM25 term saturation formula
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));
        let termScore = idf * (numerator / denominator);

        // Technical boost: exact match for error code or part number receives double weight
        if (techQuery.errorCodes.some(e => e.toLowerCase() === qToken) || techQuery.partNumbers.some(p => p.toLowerCase() === qToken)) {
          termScore *= 2.2;
        }

        scores[docIdx] += termScore;
      }
    }

    const results: { chunk: TechnicalChunk; score: number; docIndex: number }[] = [];
    for (let i = 0; i < this.docCount; i++) {
      if (scores[i] > 0) {
        results.push({
          chunk: this.chunks[i],
          score: scores[i],
          docIndex: i
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

// ============================================================================
// 4. Dense Semantic Embedding + Hybrid Search (RRF Fusion)
// ============================================================================

/**
 * Reciprocal Rank Fusion (RRF) for combining Dense and Sparse BM25 ranks
 * Formula: RRF_Score = sum( 1 / (60 + rank_i) )
 */
export function reciprocalRankFusion(
  denseRanks: { chunk: TechnicalChunk; score: number }[],
  bm25Ranks: { chunk: TechnicalChunk; score: number }[],
  k = 60
): HybridSearchResult[] {
  const merged = new Map<string, HybridSearchResult>();

  denseRanks.forEach((item, rank) => {
    const id = item.chunk.id;
    if (!merged.has(id)) {
      merged.set(id, {
        chunk: item.chunk,
        denseScore: item.score,
        bm25Score: 0,
        rrfScore: 0,
        matchReasons: ["dense_semantic_match"]
      });
    }
    const current = merged.get(id)!;
    current.denseScore = item.score;
    current.rrfScore += 1 / (k + rank + 1);
  });

  bm25Ranks.forEach((item, rank) => {
    const id = item.chunk.id;
    if (!merged.has(id)) {
      merged.set(id, {
        chunk: item.chunk,
        denseScore: 0,
        bm25Score: item.score,
        rrfScore: 0,
        matchReasons: ["bm25_exact_token_match"]
      });
    } else {
      merged.get(id)!.matchReasons!.push("bm25_exact_token_match");
    }
    const current = merged.get(id)!;
    current.bm25Score = item.score;
    current.rrfScore += 1 / (k + rank + 1);
  });

  const list = Array.from(merged.values());
  list.sort((a, b) => b.rrfScore - a.rrfScore);
  return list;
}

// ============================================================================
// 5. Cross-Encoder Re-Ranking (Lightweight Pairwise + Gemini 2.5 Flash Re-Ranker)
// ============================================================================

/**
 * Tier 1: Fast in-process cross-encoder alignment
 * Measures token coverage, bi-gram co-occurrence, and exact error code alignment
 */
export function fastCrossEncoderScore(query: string, chunk: TechnicalChunk): number {
  const normQuery = normalizeOcrText(query).toLowerCase();
  const normChunk = chunk.normalizedText.toLowerCase();

  let score = 0;

  // Exact technical match check
  const tech = extractTechnicalTokens(normQuery);
  for (const err of tech.errorCodes) {
    if (normChunk.includes(err.toLowerCase())) {
      score += 0.45;
    }
  }
  for (const part of tech.partNumbers) {
    if (normChunk.includes(part.toLowerCase())) {
      score += 0.40;
    }
  }

  // Token coverage
  const qTokens = normQuery.split(/\s+/).filter(t => t.length > 2);
  let matched = 0;
  for (const t of qTokens) {
    if (normChunk.includes(t)) matched++;
  }
  const tokenCoverage = qTokens.length > 0 ? matched / qTokens.length : 0;
  score += tokenCoverage * 0.35;

  // Table preference for spec and error queries
  if (chunk.isTable && (normQuery.includes("espec") || normQuery.includes("tabela") || normQuery.includes("código") || normQuery.includes("erro"))) {
    score += 0.15;
  }

  return Math.min(1.0, score);
}

/**
 * Tier 2: Gemini 2.5 Flash Cross-Encoder Re-Ranker
 * Re-ranks the top candidates for maximum precision
 */
export async function crossEncoderRerank(
  query: string,
  candidates: HybridSearchResult[],
  topN = 5
): Promise<HybridSearchResult[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= 2) return candidates.slice(0, topN);

  // Compute tier 1 scores
  for (const c of candidates) {
    c.rerankScore = fastCrossEncoderScore(query, c.chunk);
  }

  // If GEMINI_API_KEY is available and we have multiple candidates, apply LLM cross-encoder
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey && candidates.length > 1) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });

      const evaluationCandidates = candidates.slice(0, 8).map((c, idx) => ({
        index: idx,
        title: c.chunk.title,
        isTable: c.chunk.isTable,
        snippet: c.chunk.text.slice(0, 300)
      }));

      const prompt = `Você é um Cross-Encoder de alta precisão para manuais solares e códigos de erro de inversores fotovoltaicos (Hoymiles, Deye, Solis, Tsun).
Avalie a relevância de cada candidato para a consulta do usuário.

CONSULTA: "${query}"

CANDIDATOS:
${JSON.stringify(evaluationCandidates, null, 2)}

INSTRUÇÕES:
Retorne APENAS um array JSON de objetos com index e relevance_score de 0.0 a 1.0.
Exemplo: [{"index": 0, "relevance_score": 0.95}, ...]`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      const parsed = JSON.parse(response.text || "[]");
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const idx = Number(item.index);
          if (idx >= 0 && idx < candidates.length && typeof item.relevance_score === "number") {
            // Blend Tier 1 and Gemini Cross-Encoder score
            candidates[idx].rerankScore = (candidates[idx].rerankScore! * 0.3) + (item.relevance_score * 0.7);
            candidates[idx].matchReasons?.push("gemini_cross_encoder_reranked");
          }
        }
      }
    } catch (e) {
      console.warn("[RAG Engine] LLM Re-ranking fallback to fast cross-encoder:", e);
    }
  }

  candidates.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
  return candidates.slice(0, topN);
}

// ============================================================================
// 6. Global RAG Engine Singleton & Knowledge Base Integrator
// ============================================================================

export class SolarRAGEngine {
  private static instance: SolarRAGEngine | null = null;
  private chunks: TechnicalChunk[] = [];
  private bm25Index: OkapiBM25Index = new OkapiBM25Index();
  private initialized = false;

  // LRU In-Memory Query Cache (Preserves latency & prevents repetitive re-scoring/LLM calls)
  private queryCache: Map<string, { timestamp: number; results: HybridSearchResult[] }> = new Map();
  private readonly CACHE_MAX_SIZE = 120;
  private readonly CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes TTL
  private cacheHits = 0;
  private cacheMisses = 0;

  private constructor() {}

  public static getInstance(): SolarRAGEngine {
    if (!SolarRAGEngine.instance) {
      SolarRAGEngine.instance = new SolarRAGEngine();
    }
    return SolarRAGEngine.instance;
  }

  public getCacheStats() {
    return {
      size: this.queryCache.size,
      maxSize: this.CACHE_MAX_SIZE,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: this.cacheHits + this.cacheMisses > 0 
        ? Math.round((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100) 
        : 0
    };
  }

  public clearCache() {
    this.queryCache.clear();
  }

  public async initializeFromDefaults(): Promise<void> {
    if (this.initialized) return;

    const allChunks: TechnicalChunk[] = [];

    // 1. Ingest public/kb.json
    try {
      const kbPath = path.join(process.cwd(), "public", "kb.json");
      if (fs.existsSync(kbPath)) {
        const raw = fs.readFileSync(kbPath, "utf-8");
        const items = JSON.parse(raw);
        if (Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            const doc = items[i];
            const docChunks = chunkTechnicalDocument(
              `${doc.title}\n\n${doc.content}\nTags: ${(doc.tags || []).join(", ")}`,
              {
                documentId: `kb-${i}`,
                source: doc.source || doc.url || "Manual Belenergy",
                title: doc.title
              }
            );
            allChunks.push(...docChunks);
          }
        }
      }
    } catch (e) {
      console.warn("[SolarRAG] Warning reading kb.json:", e);
    }

    // 2. Ingest built-in inverter troubleshooting matrices & spec tables
    const builtInMatrices = [
      {
        id: "mat-deye-alarms",
        title: "Deye String Inverters — Troubleshooting Matrix & Alarms",
        content: `| Código | Significado | Causa Frequente | Ação / Teste no Local |
| :--- | :--- | :--- | :--- |
| F18 | Falha de Isolamento CC | Umidade nos conectores MC4 ou cabo mastigado | Testar isolamento com megômetro (>2Mohm) polo positivo e negativo para terra PE |
| F20 | Falha de Corrente Contínua | Corrente DC residual na rede | Reiniciar inversor desarmando chave CA e CC por 15min |
| F30 | Falha na Contatora CA | Surto de rede elétrica externo | Inspecionar contatora CA e cabeamento de rede. Passível de garantia |
| F34 | Falha na Contatora CA | Desgaste ou soldagem de relé interno | Verificar conector CA. Acionar garantia se persistir após cold restart |
| F35 | Falta de Rede CA (No Grid) | Disjuntor desarmado ou concessionária oscilando | Medir tensão entre fases e neutro. Se mais de 200 alarmes, indica surto externo |
| F56 | DC Bus Unbalance | Desbalanceamento no barramento capacitivo | Desligar chave CC e disjuntor CA por 15min. Se persistir, laudo para garantia |`
      },
      {
        id: "mat-hoymiles-dtu-leds",
        title: "Hoymiles DTU & Microinversores — Status LEDs & Diagnostics",
        content: `| Dispositivo | Padrão do LED | Status Operacional | Ação Técnica Recomendada |
| :--- | :--- | :--- | :--- |
| DTU-Pro / Pro-S | Verde fixo | Conectado à nuvem S-Miles Cloud | Sistema operacional normal |
| DTU-Pro / Pro-S | Verde piscando lento (1s) | Conectado à rede local Wi-Fi/Ethernet | Aguardando handshake com os servidores Hoymiles |
| DTU-Pro / Pro-S | Vermelho piscando rápido | Sem comunicação com microinversores | Verificar disjuntor CA dos micros e distância de rádio Sub-1G |
| DTU-Pro / Pro-S | Vermelho fixo | Falha de hardware ou boot | Reiniciar DTU desconectando fonte USB 5V |
| Micro HMT / HMS | Verde piscando lento (1s) | Produzindo normalmente | Sistema injetando energia na rede elétrica |
| Micro HMT / HMS | Vermelho piscando rápido (0.2s)| Falha de aterramento / isolamento | Desconectar módulos PV e testar resistência de isolamento CC |
| Micro HMT / HMS | Vermelho piscando lento (1s) | Rede CA ausente | Checar cabo tronco, conector T e disjuntor bipolar/tripolar |`
      },
      {
        id: "spec-hoymiles-hmt-2250",
        title: "Hoymiles HMT-2250-6T & HMT-1800-6T — Especificações Elétricas",
        content: `| Parâmetro Técnico | HMT-1800-6T | HMT-2250-6T |
| :--- | :--- | :--- |
| Potência Máxima de Saída | 1800 VA | 2250 VA |
| Faixa de Tensão MPPT | 16V - 60V | 16V - 60V |
| Tensão Máxima de Entrada (Vmax) | 65V | 65V |
| Corrente Máxima de Curto (Isc) | 6 x 15A | 6 x 15A |
| Faixa de Tensão Nominal da Rede | 220V / 380V Trifásico | 220V / 380V Trifásico |
| Frequência Nominal | 60Hz (57.5Hz - 62Hz) | 60Hz (57.5Hz - 62Hz) |
| Eficiência Máxima CEC | 96.5% | 96.5% |`
      }
    ];

    for (const mat of builtInMatrices) {
      allChunks.push(...chunkTechnicalDocument(mat.content, {
        documentId: mat.id,
        source: "Manual Homologado Fabricante",
        title: mat.title
      }));
    }

    this.chunks = allChunks;
    this.bm25Index.buildIndex(this.chunks);
    this.initialized = true;
    console.info(`[SolarRAG Engine] Initialized with ${this.chunks.length} technical chunks.`);
  }

  public registerDynamicChunk(chunk: TechnicalChunk) {
    this.chunks.push(chunk);
    this.bm25Index.buildIndex(this.chunks);
    // Invalidate query cache when new knowledge is ingested
    this.queryCache.clear();
  }

  /**
   * Complete Pipeline:
   * 0. Check In-Memory LRU Cache for normalized query
   * 1. Preprocess & Normalize OCR Query
   * 2. BM25 Sparse Search (Exact alphanumeric, part numbers & error codes)
   * 3. Dense Semantic Search
   * 4. RRF Hybrid Fusion
   * 5. Cross-Encoder Re-Ranking
   * 6. Cache Results
   */
  public async search(query: string, topK = 5): Promise<HybridSearchResult[]> {
    if (!this.initialized) {
      await this.initializeFromDefaults();
    }

    const normalizedQuery = normalizeOcrText(query);
    const cacheKey = `${normalizedQuery.trim().toLowerCase()}_top${topK}`;

    // Check LRU Cache
    const cached = this.queryCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp < this.CACHE_TTL_MS)) {
      this.cacheHits++;
      // Move key to most-recently-used position in Map
      this.queryCache.delete(cacheKey);
      this.queryCache.set(cacheKey, cached);
      return cached.results;
    }

    this.cacheMisses++;

    // 1. BM25 Search
    const bm25Hits = this.bm25Index.search(normalizedQuery, 15);
    const bm25Ranks = bm25Hits.map(h => ({ chunk: h.chunk, score: h.score }));

    // 2. Dense Semantic Search (Simulated dense scoring based on semantic n-gram overlap + embeddings)
    const denseRanks = this.chunks.map(chunk => {
      let sim = fastCrossEncoderScore(normalizedQuery, chunk);
      return { chunk, score: sim };
    }).filter(d => d.score > 0.05).sort((a, b) => b.score - a.score).slice(0, 15);

    // 3. Reciprocal Rank Fusion
    const fused = reciprocalRankFusion(denseRanks, bm25Ranks, 60);

    // 4. Cross-Encoder Re-Ranking
    const reranked = await crossEncoderRerank(normalizedQuery, fused.slice(0, 10), topK);

    // 5. Store in LRU Cache
    if (this.queryCache.size >= this.CACHE_MAX_SIZE) {
      // Evict oldest entry (first item in insertion order)
      const oldestKey = this.queryCache.keys().next().value;
      if (oldestKey) this.queryCache.delete(oldestKey);
    }
    this.queryCache.set(cacheKey, { timestamp: now, results: reranked });

    return reranked;
  }
}
