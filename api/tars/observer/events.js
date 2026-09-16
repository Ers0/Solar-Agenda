import { sendResponse, handleCors, parseJsonBody } from "../../_smtp.js";
import {
  getObserverCases,
  getProcessedEventIdsSet,
  processObserverEventsBatch,
  writeAppStorage
} from "../_observer-engine.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const cases = getObserverCases();
    return sendResponse(res, 200, {
      ok: true,
      service: "Solar Agenda TARS Observer Events API",
      status: "ACTIVE",
      mode: "PASSIVE_OBSERVER",
      safetyBoundary: "ZERO_CUSTOMER_INTERACTION_ENFORCED",
      endpoint: "/api/tars/observer/events",
      methods: ["POST", "GET", "OPTIONS"],
      casesCount: cases.length,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === "POST") {
    try {
      const payload = await parseJsonBody(req);
      const version = payload?.version || "1.0";
      const source = payload?.source || "tars-vision-bridge";
      const bridgeVersion = payload?.bridgeVersion || "1.2.83";

      if (!payload || !Array.isArray(payload.events)) {
        return sendResponse(res, 400, {
          ok: false,
          error: "Invalid payload: 'events' array is required."
        });
      }

      const currentCases = getObserverCases();
      const processedSet = getProcessedEventIdsSet();

      const result = processObserverEventsBatch(payload, currentCases, processedSet);

      writeAppStorage({
        tarsObserverCases: result.updatedCases,
        tarsProcessedEvents: Array.from(processedSet).slice(-2000)
      });

      return sendResponse(res, 200, {
        ok: true,
        mode: "PASSIVE_OBSERVER",
        safetyBoundary: "ZERO_CUSTOMER_INTERACTION_ENFORCED",
        version,
        bridgeVersion,
        processedCount: result.processedCount,
        duplicateCount: result.duplicateCount,
        affectedCaseIds: result.affectedCaseIds,
        totalCases: result.updatedCases.length
      });
    } catch (err) {
      console.error("[TARS Observer Events Error]", err);
      return sendResponse(res, 500, { ok: false, error: err.message || "Internal error" });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
