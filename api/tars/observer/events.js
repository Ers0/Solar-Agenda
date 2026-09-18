import { sendResponse, handleCors, parseJsonBody } from "../../_smtp.js";
import {
  getDefaultObserverCases,
  processObserverEventsBatch
} from "../_observer-engine.js";
import {
  initializeObserverState,
  writeObserverState
} from "./_observer-db.js";

const MAX_RETRIES = 5;

async function ingest(batchPayload) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const state = await initializeObserverState(
      getDefaultObserverCases()
    );

    const cases =
      Array.isArray(state.cases) && state.cases.length
        ? state.cases
        : getDefaultObserverCases();

    const processedSet = new Set(
      Array.isArray(state.processed_event_ids)
        ? state.processed_event_ids
        : []
    );

    const result = processObserverEventsBatch(
      batchPayload,
      cases,
      processedSet
    );

    try {
      const persisted = await writeObserverState({
        cases: result.updatedCases,
        processedEventIds: Array.from(processedSet),
        expectedVersion: Number(state.version || 1)
      });

      return {
        ...result,
        totalCases: result.updatedCases.length,
        storageVersion: persisted.version,
        storageAttempt: attempt
      };
    } catch (error) {
      if (error?.code !== "OBSERVER_STORAGE_CONFLICT") {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError || new Error("Observer storage retry limit exceeded.");
}

function buildSimulation(payload) {
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

  return {
    version: "1.0",
    source: "tars-vision-bridge",
    bridgeVersion: "1.2.84",
    events: [
      {
        eventId: `sim-ev-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)}`,
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

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    try {
      const state = await initializeObserverState(
        getDefaultObserverCases()
      );

      const cases = Array.isArray(state.cases)
        ? state.cases
        : [];

      return sendResponse(res, 200, {
        ok: true,
        service: "Solar Agenda TARS Observer Events API",
        status: "ACTIVE",
        mode: "PASSIVE_OBSERVER",
        safetyBoundary:
          "ZERO_CUSTOMER_INTERACTION_ENFORCED",
        endpoint: "/api/tars/observer/events",
        methods: ["POST", "GET", "OPTIONS"],
        casesCount: cases.length,
        storage: "SUPABASE",
        storageVersion: state.version,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error(
        "[TARS Observer Events GET Error]",
        err
      );

      return sendResponse(res, 500, {
        ok: false,
        error: err?.message || "Observer storage read failed"
      });
    }
  }

  if (req.method === "POST") {
    try {
      const payload = (await parseJsonBody(req)) || {};
      const url = new URL(req.url, "http://localhost");
      const action =
        url.searchParams.get("action") ||
        payload?.action;

      const batchPayload =
        action === "simulate" || payload?.simulate
          ? buildSimulation(payload)
          : payload;

      if (!Array.isArray(batchPayload?.events)) {
        return sendResponse(res, 400, {
          ok: false,
          error: "Invalid payload: 'events' array is required."
        });
      }

      const result = await ingest(batchPayload);

      return sendResponse(res, 200, {
        ok: true,
        mode: "PASSIVE_OBSERVER",
        safetyBoundary:
          "ZERO_CUSTOMER_INTERACTION_ENFORCED",
        version: batchPayload.version || "1.0",
        bridgeVersion:
          batchPayload.bridgeVersion || "1.2.84",
        processedCount: result.processedCount,
        duplicateCount: result.duplicateCount,
        affectedCaseIds: result.affectedCaseIds,
        totalCases: result.totalCases,
        storage: "SUPABASE",
        storageVersion: result.storageVersion,
        storageAttempt: result.storageAttempt
      });
    } catch (err) {
      console.error("[TARS Observer Events Error]", err);

      return sendResponse(res, 500, {
        ok: false,
        error: err?.message || "Internal error"
      });
    }
  }

  return sendResponse(res, 405, {
    ok: false,
    error: "Method not allowed"
  });
}
