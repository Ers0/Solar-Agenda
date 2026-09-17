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
      const url = new URL(req.url, "http://localhost");
      const payload = (await parseJsonBody(req)) || {};
      const action = url.searchParams.get("action") || payload?.action;

      let batchPayload = payload;

      // Support simulation call
      if (action === "simulate" || payload?.simulate) {
        const {
          eventType = "HYPERFLOW_MESSAGE",
          text = "Cliente informa que inversor Deye SUN-8K está apresentando alarme F30 com 225 Vac.",
          protocol = "HF-3001",
          conversationId = "conv_sim_01",
          customerName = "João Instalador",
          manufacturer = "Deye",
          model = "SUN-8K",
          sn = "230499881122"
        } = payload;

        batchPayload = {
          version: "1.0",
          source: "tars-vision-bridge",
          bridgeVersion: "1.2.83",
          events: [
            {
              eventId: `sim-ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              eventType,
              observedAt: new Date().toISOString(),
              origin: "https://conversas.hyperflow.global",
              page: `https://conversas.hyperflow.global/chat/${conversationId}`,
              title: `Atendimento ${protocol}`,
              tabId: 99,
              case: {
                protocol,
                conversationId,
                customerName,
                manufacturer,
                equipmentModel: model,
                serialNumber: sn
              },
              data: {
                text,
                speaker: "customer",
                direction: "inbound",
                attachmentCount: 1
              }
            }
          ]
        };
      }

      const version = batchPayload?.version || "1.0";
      const source = batchPayload?.source || "tars-vision-bridge";
      const bridgeVersion = batchPayload?.bridgeVersion || "1.2.83";

      if (!batchPayload || !Array.isArray(batchPayload.events)) {
        return sendResponse(res, 400, {
          ok: false,
          error: "Invalid payload: 'events' array is required."
        });
      }

      const currentCases = getObserverCases();
      const processedSet = getProcessedEventIdsSet();

      const result = processObserverEventsBatch(batchPayload, currentCases, processedSet);

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
