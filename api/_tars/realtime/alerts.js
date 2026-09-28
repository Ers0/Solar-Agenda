import { sendResponse, handleCors, parseJsonBody } from "../../_smtp.js";

// In-memory alert store for serverless environment
let alertsCache = [];

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const since = req.query?.since;
    let filtered = alertsCache;
    if (since) {
      const sinceTime = new Date(since).getTime();
      filtered = alertsCache.filter(a => new Date(a.timestamp).getTime() > sinceTime);
    }
    return sendResponse(res, 200, {
      ok: true,
      alerts: filtered,
      count: filtered.length
    });
  }

  if (req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const alert = {
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        problemTitle: body.problemTitle || "Anomalia Detectada em Atendimento",
        severity: body.severity || "HIGH",
        equipment: body.equipment || { manufacturer: "Deye", model: "SUN-5K" },
        messageSnippet: body.messageSnippet || "Alarme reportado",
        solution: body.solution || "1. Verificar conexões elétricas.\n2. Reiniciar equipamento.",
        solutionSteps: body.solutionSteps || ["1. Verificar conexões elétricas.", "2. Reiniciar equipamento."],
        timestamp: new Date().toISOString(),
        read: false
      };
      alertsCache.unshift(alert);
      if (alertsCache.length > 50) alertsCache.pop();

      return sendResponse(res, 201, {
        ok: true,
        alert
      });
    } catch (e) {
      return sendResponse(res, 500, { ok: false, error: "Failed to record alert" });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
