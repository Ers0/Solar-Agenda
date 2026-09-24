import { sendResponse, handleCors, parseJsonBody } from "../../_smtp.js";
import {
  getDefaultObserverCases,
  isMeaningfulCase,
  runTarsSmartLearningAnalysis
} from "../_observer-engine.js";
import {
  initializeObserverState,
  writeObserverState
} from "./_observer-db.js";

const MAX_RETRIES = 5;

function findCase(cases, id) {
  return cases.find(
    (c) => c.id === id || c.protocol === id
  );
}

async function mutateCase(mutator) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const state = await initializeObserverState(
      getDefaultObserverCases()
    );

    const cases = Array.isArray(state.cases)
      ? state.cases
      : [];

    const index = cases.findIndex(
      (c) =>
        c.id === mutator.caseId ||
        c.protocol === mutator.caseId
    );

    if (index < 0) {
      return { notFound: true };
    }

    const item = cases[index];

    const changed = await mutator.apply(item);

    if (changed === false) {
      return {
        item,
        storageVersion: state.version,
        storageAttempt: attempt
      };
    }

    item.updatedAt = new Date().toISOString();
    cases[index] = item;

    try {
      const persisted = await writeObserverState({
        cases,
        processedEventIds: Array.isArray(
          state.processed_event_ids
        )
          ? state.processed_event_ids
          : [],
        expectedVersion: Number(state.version || 1)
      });

      return {
        item,
        storageVersion: persisted.version,
        storageAttempt: attempt
      };
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
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const url = new URL(req.url, "http://localhost");

  const queryStatus =
    url.searchParams.get("status") ||
    req.query?.status;

  const queryQ =
    url.searchParams.get("q") ||
    req.query?.q;

  let queryId =
    url.searchParams.get("id") ||
    req.query?.id;

  let action =
    url.searchParams.get("action") ||
    req.query?.action;

  const pathParts = url.pathname
    .split("/")
    .filter(Boolean);

  const casesIndex = pathParts.indexOf("cases");

  if (
    casesIndex >= 0 &&
    pathParts.length > casesIndex + 1
  ) {
    const nextPart = decodeURIComponent(
      pathParts[casesIndex + 1]
    );

    if (
      !queryId &&
      nextPart &&
      ![
        "all",
        "active",
        "closed",
        "human_review",
        "candidates"
      ].includes(nextPart.toLowerCase())
    ) {
      queryId = nextPart;
    }

    if (
      pathParts.length > casesIndex + 2 &&
      !action
    ) {
      action = decodeURIComponent(
        pathParts[casesIndex + 2]
      );
    }
  }

  // ============================================================
  // GET — READ OBSERVER CASES (Cleaned of empty/ghost records)
  // ============================================================

  if (req.method === "GET") {
    try {
      const state =
        await initializeObserverState(
          getDefaultObserverCases()
        );

      const rawCases = Array.isArray(state.cases)
        ? state.cases
        : [];

      // Filter out empty cases automatically so UI is always pristine
      const cases = rawCases.filter(isMeaningfulCase);

      // Single case
      if (queryId) {
        const item = findCase(
          cases,
          queryId
        );

        if (!item) {
          return sendResponse(res, 404, {
            ok: false,
            error: "Case not found"
          });
        }

        return sendResponse(res, 200, {
          ok: true,
          case: item,
          storageVersion: state.version
        });
      }

      // Filtering
      let filtered = [...cases];

      const normalizedStatus = String(
        queryStatus || ""
      )
        .toLowerCase()
        .trim();

      if (
        normalizedStatus &&
        normalizedStatus !== "all"
      ) {
        if (normalizedStatus === "active") {
          filtered = filtered.filter(
            (c) =>
              c.status !== "CLOSED" &&
              c.status !== "RESOLVED"
          );
        } else if (
          normalizedStatus === "closed"
        ) {
          filtered = filtered.filter(
            (c) =>
              c.status === "CLOSED" ||
              c.status === "RESOLVED"
          );
        } else if (
          normalizedStatus === "human_review"
        ) {
          filtered = filtered.filter(
            (c) =>
              c.status === "HUMAN_REVIEW" ||
              c.needsHumanReview === true
          );
        } else if (
          normalizedStatus === "candidates"
        ) {
          filtered = filtered.filter(
            (c) =>
              c.learningMetadata
                ?.isTrainingCandidate ||
              c.learningMetadata?.isValidated
          );
        } else {
          filtered = filtered.filter(
            (c) =>
              String(c.status || "")
                .toLowerCase() ===
              normalizedStatus
          );
        }
      }

      // Search
      if (queryQ) {
        const needle = String(queryQ)
          .toLowerCase()
          .trim();

        filtered = filtered.filter((c) => {
          return (
            String(c.protocol || "")
              .toLowerCase()
              .includes(needle) ||
            String(c.conversationId || "")
              .toLowerCase()
              .includes(needle) ||
            String(c.customer?.name || "")
              .toLowerCase()
              .includes(needle) ||
            String(c.customer?.phone || "")
              .toLowerCase()
              .includes(needle) ||
            String(
              c.customer?.email || ""
            )
              .toLowerCase()
              .includes(needle) ||
            String(
              c.equipment?.manufacturer || ""
            )
              .toLowerCase()
              .includes(needle) ||
            String(
              c.equipment?.model || ""
            )
              .toLowerCase()
              .includes(needle) ||
            String(
              c.equipment?.sn || ""
            )
              .toLowerCase()
              .includes(needle) ||
            String(
              c.finalDiagnosis || ""
            )
              .toLowerCase()
              .includes(needle) ||
            String(
              c.finalResolution || ""
            )
              .toLowerCase()
              .includes(needle)
          );
        });
      }

      return sendResponse(res, 200, {
        ok: true,
        count: filtered.length,
        cases: filtered,
        safetyBoundary:
          "PASSIVE_OBSERVER_ACTIVE",
        storageVersion: state.version
      });
    } catch (err) {
      console.error(
        "[TARS Observer Cases GET Error]",
        err
      );

      return sendResponse(res, 500, {
        ok: false,
        error:
          err?.message ||
          "Observer storage read failed"
      });
    }
  }

  // ============================================================
  // POST — OBSERVER CASE ACTIONS
  // ============================================================

  if (req.method === "POST") {
    try {
      const body =
        (await parseJsonBody(req)) || {};

      const act = String(
        action ||
          body?.action ||
          ""
      )
        .toLowerCase()
        .trim();

      const targetCaseId =
        queryId ||
        body?.caseId ||
        body?.id;

      // Special action: purge empty cases across whole storage
      if (act === "purge-empty") {
        const state = await initializeObserverState(getDefaultObserverCases());
        const beforeCount = (state.cases || []).length;
        const validCases = (state.cases || []).filter(isMeaningfulCase);
        const nextCases = validCases.length > 0 ? validCases : getDefaultObserverCases();
        const persisted = await writeObserverState({
          cases: nextCases,
          processedEventIds: state.processed_event_ids || [],
          expectedVersion: Number(state.version || 1)
        });
        return sendResponse(res, 200, {
          ok: true,
          purgedCount: beforeCount - nextCases.length,
          remainingCount: nextCases.length,
          storageVersion: persisted.version
        });
      }

      if (!targetCaseId) {
        return sendResponse(res, 400, {
          ok: false,
          error: "caseId is required"
        });
      }

      const result =
        await mutateCase({
          caseId: targetCaseId,

          async apply(item) {
            const now =
              new Date().toISOString();

            // ----------------------------------------------------
            // SMART LEARNING ANALYSIS WITH TARS AI (Gemini)
            // ----------------------------------------------------
            if (act === "smart-learning") {
              const aiResult = await runTarsSmartLearningAnalysis(item);
              if (aiResult.success && aiResult.data) {
                const d = aiResult.data;
                if (d.conclusiveDiagnosis) item.finalDiagnosis = d.conclusiveDiagnosis;
                if (d.conclusiveResolution) item.finalResolution = d.conclusiveResolution;
                item.humanAnalysis = {
                  ...item.humanAnalysis,
                  technicianConclusion: d.technicalConformity || item.humanAnalysis?.technicianConclusion || "Conforme diretrizes TARS AI",
                  analyzedBy: "TARS AI Smart Learning Engine",
                  analyzedAt: now
                };
                if (!item.learningMetadata) {
                  item.learningMetadata = {
                    isValidated: true,
                    validatedAt: now,
                    validatedBy: "TARS AI",
                    isTrainingCandidate: true,
                    candidateReason: d.goldenReason || "Caso de ouro validado por IA",
                    tags: d.tags || []
                  };
                } else {
                  item.learningMetadata.isValidated = true;
                  item.learningMetadata.validatedAt = now;
                  item.learningMetadata.validatedBy = "TARS AI";
                  item.learningMetadata.isTrainingCandidate = true;
                  item.learningMetadata.candidateReason = d.goldenReason || item.learningMetadata.candidateReason;
                  if (Array.isArray(d.tags)) {
                    item.learningMetadata.tags = Array.from(new Set([...(item.learningMetadata.tags || []), ...d.tags]));
                  }
                }
                item.timeline.push({
                  id: `tl-ai-${Date.now()}`,
                  eventType: "SMART_LEARNING_SYNTHESIS",
                  timestamp: now,
                  title: "TARS Smart Learning Concluído",
                  detail: `Síntese de aprendizado gerada: ${d.goldenReason || "Caso otimizado para fine-tuning local."}`,
                  author: "TARS AI Deep Learning Engine"
                });
              } else {
                // Fallback smart tags
                if (!item.learningMetadata) {
                  item.learningMetadata = {
                    isValidated: true,
                    validatedAt: now,
                    validatedBy: "TARS AI",
                    isTrainingCandidate: true,
                    candidateReason: "Caso validado para fine-tuning.",
                    tags: ["solar", "tars-smart-learning"]
                  };
                } else {
                  item.learningMetadata.isTrainingCandidate = true;
                }
              }
              return true;
            }

            // ----------------------------------------------------
            // CLOSE CASE
            // ----------------------------------------------------
            if (act === "close") {
              item.status = "CLOSED";
              item.closedAt = now;

              if (body.finalDiagnosis) {
                item.finalDiagnosis = body.finalDiagnosis;
              }

              if (body.finalResolution) {
                item.finalResolution = body.finalResolution;
              }

              if (!item.learningMetadata) {
                item.learningMetadata = {
                  isValidated: false,
                  validatedAt: null,
                  validatedBy: null,
                  isTrainingCandidate: false,
                  candidateReason: null,
                  tags: []
                };
              }

              if (body.markAsCandidate) {
                item.learningMetadata.isTrainingCandidate = true;
                item.learningMetadata.candidateReason =
                  body.candidateReason || "Caso de ouro validado no encerramento.";
              }

              if (Array.isArray(body.tags) && body.tags.length > 0) {
                item.learningMetadata.tags = Array.from(
                  new Set([
                    ...(item.learningMetadata.tags || []),
                    ...body.tags
                  ])
                );
              }

              if (!Array.isArray(item.timeline)) {
                item.timeline = [];
              }

              item.timeline.push({
                id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                eventType: "CASE_CLOSED",
                timestamp: now,
                title: "Caso Fechado & Arquivado",
                detail: `Diagnóstico: ${item.finalDiagnosis || "Atendimento concluído."}. Resolução: ${item.finalResolution || "Procedimento aplicado."}`,
                author: body.technician || body.technicianName || "Técnico Solar"
              });

              return true;
            }

            // ----------------------------------------------------
            // VALIDATE AI OBSERVATION
            // ----------------------------------------------------
            if (act === "validate-observation") {
              const observation = (item.aiObservations || []).find(
                (o) => o.id === body.observationId
              );

              if (!observation) {
                throw new Error("Observation not found");
              }

              observation.isValidated = true;
              observation.validatedAt = now;
              observation.validatedBy =
                body.validatedBy || body.technician || "Técnico Solar";

              return true;
            }

            // ----------------------------------------------------
            // HUMAN CORRECTION
            // ----------------------------------------------------
            if (act === "correction" || act === "correct-observation") {
              if (!Array.isArray(item.humanCorrections)) {
                item.humanCorrections = [];
              }

              item.humanCorrections.push({
                id: `cor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                timestamp: now,
                observationId: body.observationId || null,
                correctedBy: body.correctedBy || body.technician || "Técnico Solar",
                originalValue: body.originalValue || "",
                correctedValue: body.correctedValue || "",
                reason: body.reason || "Correção técnica de campo"
              });

              return true;
            }

            // ----------------------------------------------------
            // HUMAN ANALYSIS
            // ----------------------------------------------------
            if (act === "human-analysis") {
              item.humanAnalysis = {
                visualNotes:
                  body.visualNotes || item.humanAnalysis?.visualNotes || "",
                technicianConclusion:
                  body.technicianConclusion || item.humanAnalysis?.technicianConclusion || "",
                electricalConformity:
                  body.electricalConformity || item.humanAnalysis?.electricalConformity || "",
                analyzedBy:
                  body.updatedBy || body.analyzedBy || body.technician || "Técnico Solar",
                analyzedAt: now
              };

              return true;
            }

            // ----------------------------------------------------
            // LEARNING CANDIDATE
            // ----------------------------------------------------
            if (act === "learning-candidate") {
              if (!item.learningMetadata) {
                item.learningMetadata = {
                  isValidated: false,
                  validatedAt: null,
                  validatedBy: null,
                  isTrainingCandidate: false,
                  candidateReason: null,
                  tags: []
                };
              }

              item.learningMetadata.isTrainingCandidate = Boolean(body.isTrainingCandidate);
              item.learningMetadata.candidateReason = body.candidateReason || "";
              if (Array.isArray(body.tags)) {
                item.learningMetadata.tags = body.tags;
              }

              return true;
            }

            throw new Error(`Unsupported observer case action: ${act || "none"}`);
          }
        });

      if (result.notFound) {
        return sendResponse(res, 404, {
          ok: false,
          error: "Case not found"
        });
      }

      return sendResponse(res, 200, {
        ok: true,
        case: result.item,
        storageVersion: result.storageVersion,
        storageAttempt: result.storageAttempt
      });
    } catch (err) {
      console.error("[TARS Observer Cases POST Error]", err);

      const status =
        err?.message === "Observation not found"
          ? 404
          : 500;

      return sendResponse(res, status, {
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
