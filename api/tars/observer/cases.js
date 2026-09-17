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
  let queryId = url.searchParams.get("id") || req.query?.id;
  let action = url.searchParams.get("action") || req.query?.action;

  // Extract from path if formatted like /api/tars/observer/cases/:id or /api/tars/observer/cases/:id/:action
  const pathParts = url.pathname.split("/").filter(Boolean);
  const casesIdx = pathParts.indexOf("cases");
  if (casesIdx >= 0 && pathParts.length > casesIdx + 1) {
    const nextPart = decodeURIComponent(pathParts[casesIdx + 1]);
    if (!queryId && nextPart && !["all", "active", "closed", "human_review", "candidates"].includes(nextPart.toLowerCase())) {
      queryId = nextPart;
    }
    if (pathParts.length > casesIdx + 2 && !action) {
      action = decodeURIComponent(pathParts[casesIdx + 2]);
    }
  }

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
      const normStatus = (queryStatus || "").toLowerCase().trim();

      if (normStatus && normStatus !== "all") {
        if (normStatus === "active") {
          filtered = filtered.filter(c => c.status !== "CLOSED" && c.status !== "RESOLVED");
        } else if (normStatus === "closed") {
          filtered = filtered.filter(c => c.status === "CLOSED" || c.status === "RESOLVED");
        } else if (normStatus === "human_review") {
          filtered = filtered.filter(c => c.status === "HUMAN_REVIEW" || c.needsHumanReview);
        } else if (normStatus === "candidates") {
          filtered = filtered.filter(c => c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated);
        } else {
          filtered = filtered.filter(c => (c.status || "").toLowerCase() === normStatus);
        }
      }

      if (queryQ) {
        const needle = queryQ.toLowerCase().trim();
        filtered = filtered.filter(c =>
          (c.protocol && c.protocol.toLowerCase().includes(needle)) ||
          (c.conversationId && c.conversationId.toLowerCase().includes(needle)) ||
          (c.customer?.name && c.customer.name.toLowerCase().includes(needle)) ||
          (c.customer?.phone && c.customer.phone.toLowerCase().includes(needle)) ||
          (c.equipment?.manufacturer && c.equipment.manufacturer.toLowerCase().includes(needle)) ||
          (c.equipment?.model && c.equipment.model.toLowerCase().includes(needle)) ||
          (c.equipment?.sn && c.equipment.sn.toLowerCase().includes(needle)) ||
          (c.finalDiagnosis && c.finalDiagnosis.toLowerCase().includes(needle))
        );
      }

      return sendResponse(res, 200, {
        ok: true,
        count: filtered.length,
        cases: filtered,
        safetyBoundary: "PASSIVE_OBSERVER_ACTIVE"
      });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message || "Internal error" });
    }
  }

  if (req.method === "POST") {
    try {
      const body = (await parseJsonBody(req)) || {};
      const act = (action || body?.action || "").toLowerCase();
      const targetCaseId = queryId || body?.caseId || body?.id;

      if (!targetCaseId) {
        return sendResponse(res, 400, { ok: false, error: "caseId is required" });
      }

      const cases = getObserverCases();
      const idx = cases.findIndex(c => c.id === targetCaseId || c.protocol === targetCaseId);
      if (idx < 0) {
        return sendResponse(res, 404, { ok: false, error: "Case not found" });
      }

      const item = cases[idx];
      const now = new Date().toISOString();

      if (act === "close") {
        item.status = "CLOSED";
        item.closedAt = now;
        item.updatedAt = now;
        if (body.finalDiagnosis) item.finalDiagnosis = body.finalDiagnosis;
        if (body.finalResolution) item.finalResolution = body.finalResolution;
        if (body.markAsCandidate) {
          item.learningMetadata.isTrainingCandidate = true;
          item.learningMetadata.candidateReason = body.candidateReason || "Caso de ouro validado no encerramento.";
        }
        if (Array.isArray(body.tags) && body.tags.length > 0) {
          item.learningMetadata.tags = Array.from(new Set([...(item.learningMetadata.tags || []), ...body.tags]));
        }
        item.timeline.push({
          id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          eventType: "CASE_CLOSED",
          timestamp: now,
          title: "Caso Fechado & Arquivado",
          detail: `Diagnóstico: ${item.finalDiagnosis || "Atendimento concluído."}. Resolução: ${item.finalResolution || "Procedimento aplicado."}`,
          author: body.technician || body.technicianName || "Técnico Solar"
        });
      } else if (act === "validate-observation") {
        const obs = (item.aiObservations || []).find(o => o.id === body.observationId);
        if (!obs) return sendResponse(res, 404, { ok: false, error: "Observation not found" });
        obs.isValidated = true;
        obs.validatedAt = now;
        obs.validatedBy = body.validatedBy || body.technician || "Técnico Solar";
      } else if (act === "correction" || act === "correct-observation") {
        if (!Array.isArray(item.humanCorrections)) item.humanCorrections = [];
        item.humanCorrections.push({
          id: `cor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          observationId: body.observationId || null,
          correctedBy: body.correctedBy || body.technician || "Técnico Solar",
          originalValue: body.originalValue || "",
          correctedValue: body.correctedValue || "",
          reason: body.reason || "Correção técnica de campo"
        });
      } else if (act === "human-analysis") {
        item.humanAnalysis = {
          visualNotes: body.visualNotes || item.humanAnalysis?.visualNotes || "",
          technicianConclusion: body.technicianConclusion || item.humanAnalysis?.technicianConclusion || "",
          electricalConformity: body.electricalConformity || item.humanAnalysis?.electricalConformity || "",
          analyzedBy: body.updatedBy || body.analyzedBy || body.technician || "Técnico Solar",
          analyzedAt: now
        };
      } else if (act === "learning-candidate") {
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
