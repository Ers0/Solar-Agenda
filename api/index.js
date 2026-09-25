import { handleCors, sendResponse } from "./_smtp.js";
import authLoginHandler from "./_auth/login.js";
import authUsersHandler from "./_auth/users.js";
import jiraStatusHandler from "./_jira/status.js";
import jiraWebhookHandler from "./_routes/jira-webhook.js";
import healthHandler from "./_routes/health.js";
import appDataHandler from "./_routes/app-data.js";
import sendEmailHandler from "./_routes/send-email.js";
import slaCasesHandler from "./_routes/sla-cases.js";
import slaWebhookHandler from "./_sla/webhook.js";
import mlExportDatasetHandler from "./_routes/ml-export-dataset.js";
import tarsAlertsHandler from "./_tars/realtime/alerts.js";
import tarsStreamHandler from "./_tars/realtime/stream.js";
import tarsEventsHandler from "./_tars/observer/events.js";
import tarsCasesHandler from "./_tars/observer/cases.js";
import tarsExportHandler from "./_tars/learning/export.js";
import { aiAssistantHandler, agendaAiHandler } from "./_routes/ai-assistant.js";
import { agendaCompatHandler } from "./_routes/agenda-compat.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const host = req.headers.host || "localhost";
  let urlObj;
  try {
    urlObj = new URL(req.url, `http://${host}`);
  } catch (e) {
    urlObj = new URL(req.url || "/", "http://localhost");
  }

  // Extract route either from rewrite query __route, or slug, or url pathname
  let routePath = urlObj.searchParams.get("__route") || "";
  if (!routePath && req.query?.slug) {
    const slugParts = Array.isArray(req.query.slug) ? req.query.slug : [req.query.slug];
    routePath = "/" + slugParts.join("/");
  }
  if (!routePath) {
    routePath = urlObj.pathname;
  }
  // Strip leading /api if present: e.g. /api/sla-cases -> /sla-cases, /api/agenda-vault -> /agenda-vault
  routePath = routePath.replace(/^\/?api(\/|$)/, "/");
  routePath = "/" + routePath.replace(/^\/+/, "");

  // Populate req.query
  if (!req.query) req.query = {};
  for (const [k, v] of urlObj.searchParams.entries()) {
    if (k !== "__route") {
      req.query[k] = v;
    }
  }

  // 1. Health check
  if (routePath === "/" || routePath === "/health") {
    return healthHandler(req, res);
  }

  // 2. Authentication
  if (routePath === "/auth/login") {
    return authLoginHandler(req, res);
  }
  if (routePath.startsWith("/auth/users")) {
    return authUsersHandler(req, res);
  }

  // 3. Jira integration
  if (routePath === "/jira/status" || routePath === "/jira/config" || routePath === "/jira/projects") {
    return jiraStatusHandler(req, res);
  }
  if (routePath.startsWith("/jira/webhook") || routePath === "/jira-webhook" || routePath === "/jira/issue") {
    return jiraWebhookHandler(req, res);
  }

  // 4. Email dispatch & SMTP check
  if (routePath === "/send-email" || routePath === "/smtp-status" || routePath === "/test-smtp") {
    return sendEmailHandler(req, res);
  }

  // 5. SLA Cases & Webhook
  if (routePath.startsWith("/sla-cases")) {
    return slaCasesHandler(req, res);
  }
  if (routePath.startsWith("/sla/webhook")) {
    return slaWebhookHandler(req, res);
  }
  if (routePath.startsWith("/sla-notes/rephrase")) {
    return sendResponse(res, 200, {
      ok: true,
      rephrased: "Observação técnica documentada com sucesso."
    });
  }

  // 6. App persistent storage (Contacts, SMTP, SLA)
  if (routePath === "/app-data") {
    return appDataHandler(req, res);
  }

  // 7. ML Dataset Export
  if (routePath === "/ml-export-dataset") {
    return mlExportDatasetHandler(req, res);
  }

  // 8. TARS Real-time Sentinel
  if (routePath.startsWith("/tars/realtime/alerts")) {
    return tarsAlertsHandler(req, res);
  }
  if (routePath === "/tars/realtime/stream") {
    return tarsStreamHandler(req, res);
  }

  // 9. TARS Learning Exports
  if (routePath.startsWith("/tars/learning/export")) {
    const format = routePath.replace("/tars/learning/export", "").replace(/^\/+/, "");
    if (format) {
      req.query.format = format;
    }
    return tarsExportHandler(req, res);
  }

  // 10. TARS Observer Events
  if (routePath === "/tars/observer/events" || routePath === "/tars/observer/simulate-event") {
    if (routePath.includes("simulate")) {
      req.query.action = "simulate";
    }
    return tarsEventsHandler(req, res);
  }

  // 11. TARS Observer Cases
  if (routePath.startsWith("/tars/observer/cases") || routePath === "/tars/observer/purge-empty") {
    if (routePath === "/tars/observer/purge-empty") {
      req.query.action = "purge-empty";
    } else {
      const caseMatch = routePath.match(/^\/tars\/observer\/cases\/([^/]+)(?:\/([^/]+))?$/);
      if (caseMatch) {
        req.query.caseId = caseMatch[1];
        req.query.id = caseMatch[1];
        if (caseMatch[2]) {
          req.query.action = caseMatch[2] === "correct-observation" ? "correction" : caseMatch[2];
        }
      }
    }
    return tarsCasesHandler(req, res);
  }

  // 12. TARS AI Assistant, Workflow Learning & RAG Debug/Inspector
  if (routePath.startsWith("/tars/assistant") || routePath.startsWith("/tars/rag")) {
    return aiAssistantHandler(req, res);
  }

  // 13. Agenda AI (Extension Intent Classification & Chat)
  if (routePath === "/agenda-ai" || routePath.startsWith("/agenda-ai")) {
    return agendaAiHandler(req, res);
  }

  // 14. Agenda Compat (Vault, TTS, Learn, KB, Handwriting)
  if (routePath.startsWith("/agenda-") || routePath.startsWith("/agenda/")) {
    const subRoute = routePath.replace(/^\/agenda[-/]/, "");
    return agendaCompatHandler(req, res, subRoute);
  }

  // Fallback 404
  return sendResponse(res, 404, {
    ok: false,
    error: `Endpoint not found: ${routePath}`
  });
}
