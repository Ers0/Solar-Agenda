import { sendResponse, handleCors, parseJsonBody } from "../../_smtp.js";
import {
  processObserverEventsBatch,
  getDefaultObserverCases
} from "../_observer-engine.js";
import {
  initializeObserverState,
  writeObserverState
} from "./_observer-db.js";

const MAX_RETRIES = 5;

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    return sendResponse(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const payload = (await parseJsonBody(req)) || {};
    const events = Array.isArray(payload.events) ? payload.events : [];

    if (!events.length) {
      return sendResponse(res, 400, {
        ok: false,
        error: "No events provided in batch"
      });
    }

    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const state = await initializeObserverState(
        getDefaultObserverCases()
      );

      const existingCases = Array.isArray(state.cases)
        ? state.cases
        : [];

      const processedEventIds = new Set(
        Array.isArray(state.processed_event_ids)
          ? state.processed_event_ids
          : []
      );

      const result = processObserverEventsBatch(
        payload,
        existingCases,
        processedEventIds
      );

      try {
        const persisted = await writeObserverState({
          cases: result.updatedCases,
          processedEventIds: Array.from(processedEventIds),
          expectedVersion: Number(state.version || 1)
        });

        return sendResponse(res, 200, {
          ok: true,
          processed: result.processedCount,
          duplicates: result.duplicateCount,
          affectedCases: result.affectedCaseIds,
          totalCases: result.updatedCases.length,
          safetyBoundary: "PASSIVE_OBSERVER_ACTIVE",
          storageVersion: persisted.version,
          storageAttempt: attempt
        });
      } catch (error) {
        if (
          error?.code !==
          "OBSERVER_STORAGE_CONFLICT"
        ) {
          throw error;
        }

        lastError = error;
      }
    }

    throw (
      lastError ||
      new Error(
        "Observer storage retry limit exceeded."
      )
    );
  } catch (err) {
    console.error("[TARS Observer Ingest Error]", err);

    return sendResponse(res, 500, {
      ok: false,
      error: err?.message || "Observer ingestion failed"
    });
  }
}
