import { sendResponse, handleCors, parseJsonBody } from "../../_smtp.js";
import {
  getObserverCases,
  writeAppStorage
} from "../_observer-engine.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const url = new URL(req.url, "http://localhost");
  const queryStatus = url.searchParams.get("status") || req.query?.status;
  const queryQ = url.searchParams.get("q") || req.query?.q;
  const queryId = url.searchParams.get("id") || req.query?.id;

  if (req.method === "GET") {
    try {
      const cases = getObserverCases();

      if (queryId) {
        const item = cases.find(c => c.id === queryId || c.protocol === queryId);
        if (!item) {
          return sendResponse(res, 404, { ok: false, error: "Case not found" });
        }
        return sendResponse(res, 200, { ok: true, case: item });
      }

      let filtered = [...cases];
      if (queryStatus && queryStatus !== "ALL") {
        filtered = filtered.filter(c => c.status === queryStatus);
      }
      if (queryQ) {
        const needle = queryQ.toLowerCase().trim();
        filtered = filtered.filter(c =>
          (c.protocol && c.protocol.toLowerCase().includes(needle)) ||
          (c.customer?.name && c.customer.name.toLowerCase().includes(needle)) ||
          (c.equipment?.manufacturer && c.equipment.manufacturer.toLowerCase().includes(needle)) ||
          (c.equipment?.sn && c.equipment.sn.toLowerCase().includes(needle))
        );
      }

      return sendResponse(res, 200, {
        ok: true,
        count: filtered.length,
        cases: filtered
      });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message || "Internal error" });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const action = url.searchParams.get("action") || body?.action;
      const caseId = url.searchParams.get("caseId") || body?.caseId;

      if (!caseId) {
        return sendResponse(res, 400, { ok: false, error: "caseId is required" });
      }

      const cases = getObserverCases();
      const idx = cases.findIndex(c => c.id === caseId || c.protocol === caseId);
      if (idx < 0) {
        return sendResponse(res, 404, { ok: false, error: "Case not found" });
      }

      const item = cases[idx];
      const now = new Date().toISOString();

      if (action === "close") {
        item.status = "CLOSED";
        item.closedAt = now;
        item.updatedAt = now;
        if (body.finalDiagnosis) item.finalDiagnosis = body.finalDiagnosis;
        if (body.finalResolution) item.finalResolution = body.finalResolution;
        item.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventType: "CASE_CLOSED",
          timestamp: now,
          title: "Caso Fechado & Arquivado",
          detail: `Diagnóstico: ${item.finalDiagnosis || "Atendimento concluído."}. Resolução: ${item.finalResolution || "Procedimento aplicado."}`,
          author: body.technicianName || "Técnico Solar"
        });
      } else if (action === "validate-observation") {
        const obs = item.aiObservations.find(o => o.id === body.observationId);
        if (!obs) return sendResponse(res, 404, { ok: false, error: "Observation not found" });
        obs.isValidated = true;
        obs.validatedAt = now;
        obs.validatedBy = body.validatedBy || "Técnico Solar";
      } else if (action === "correction") {
        item.humanCorrections.push({
          id: `cor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          observationId: body.observationId || null,
          correctedBy: body.correctedBy || "Técnico Solar",
          originalValue: body.originalValue || "",
          correctedValue: body.correctedValue || "",
          reason: body.reason || ""
        });
      } else if (action === "human-analysis") {
        item.humanAnalysis = {
          technicianConclusion: body.technicianConclusion || item.humanAnalysis?.technicianConclusion || "",
          electricalConformity: body.electricalConformity || item.humanAnalysis?.electricalConformity || "",
          analyzedBy: body.analyzedBy || "Técnico Solar",
          analyzedAt: now
        };
      } else if (action === "learning-candidate") {
        item.learningMetadata.isTrainingCandidate = Boolean(body.isTrainingCandidate);
        item.learningMetadata.candidateReason = body.candidateReason || "";
        if (Array.isArray(body.tags)) item.learningMetadata.tags = body.tags;
      }

      item.updatedAt = now;
      cases[idx] = item;
      writeAppStorage({ tarsObserverCases: cases });

      return sendResponse(res, 200, { ok: true, case: item });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message || "Internal error" });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
