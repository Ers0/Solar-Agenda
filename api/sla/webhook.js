import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function readStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
  } catch (e) {}
  return { contacts: null, smtpConfig: null, slaCases: null, jiraConfig: null, jiraWebhookLogs: [], slaWebhookLogs: [] };
}

function writeStorage(data) {
  try {
    const current = readStorage();
    const merged = {
      contacts: data.contacts !== undefined ? data.contacts : current.contacts,
      smtpConfig: data.smtpConfig !== undefined ? data.smtpConfig : current.smtpConfig,
      slaCases: data.slaCases !== undefined ? data.slaCases : current.slaCases,
      jiraConfig: data.jiraConfig !== undefined ? data.jiraConfig : current.jiraConfig,
      jiraWebhookLogs: data.jiraWebhookLogs !== undefined ? data.jiraWebhookLogs : (current.jiraWebhookLogs || []),
      slaWebhookLogs: data.slaWebhookLogs !== undefined ? data.slaWebhookLogs : (current.slaWebhookLogs || []),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(merged, null, 2), "utf-8");
    return merged;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const data = readStorage();
    return sendResponse(res, 200, { ok: true, logs: data.slaWebhookLogs || [] });
  }

  if (req.method === "POST") {
    try {
      const payload = await parseJsonBody(req);
      const eventType = payload.event || "sla.generic.event";
      const occurredAt = payload.occurredAt || new Date().toISOString();
      const conversationId = (payload.conversationId || "").trim();
      const source = payload.source || "tars-vision-bridge";
      const bridgeVersion = payload.bridgeVersion || "1.2.37";
      const eventStatus = payload.status || "COMPLETED";

      const customerObj = payload.customer || {};
      const orgObj = payload.organization || {};
      const accountObj = payload.account || {};

      const customerName = (customerObj.name || orgObj.name || "Cliente Solar").trim();
      const customerEmail = (customerObj.email || accountObj.loginEmail || "").trim();
      const customerPhone = (customerObj.phone || "").trim();
      const customerState = (customerObj.state || "").trim();

      const orgName = (orgObj.name || "").trim();
      const parentOrg = (orgObj.parentOrganization || "APItest").trim();
      const orgRole = (orgObj.role || "Installer").trim();
      const loginEmail = (accountObj.loginEmail || customerEmail).trim().toLowerCase();

      const storage = readStorage();
      const list = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      let matchedCaseId = null;
      let isNewCase = false;

      // 1. Look for matching case
      for (let i = 0; i < list.length; i++) {
        const c = { ...list[i] };
        const cEmail = (c.customer?.email || "").toLowerCase();
        const cPhone = (c.customer?.phone || "").replace(/\D/g, "");
        const searchPhone = customerPhone.replace(/\D/g, "");

        const matchesConv = conversationId && Array.isArray(c.protocols?.hyperflow) && c.protocols.hyperflow.includes(conversationId);
        const matchesEmail = loginEmail && cEmail && (cEmail === loginEmail);
        const matchesPhone = searchPhone.length >= 8 && cPhone && (cPhone === searchPhone || cPhone.endsWith(searchPhone) || searchPhone.endsWith(cPhone));
        const matchesHoymilesProto = Array.isArray(c.protocols?.hoymiles) && c.protocols.hoymiles.some(h => (h.account_email || "").toLowerCase() === loginEmail);

        if (matchesConv || matchesEmail || matchesPhone || matchesHoymilesProto) {
          matchedCaseId = c.id;
          c.protocols = c.protocols || {};
          c.protocols.hoymiles = Array.isArray(c.protocols.hoymiles) ? [...c.protocols.hoymiles] : [];

          if (!c.protocols.hoymiles.some(h => (h.account_email || "").toLowerCase() === loginEmail)) {
            c.protocols.hoymiles.push({
              account_email: loginEmail,
              org_name: orgName,
              parent_org: parentOrg,
              role: orgRole,
              created_at: occurredAt,
              conversation_id: conversationId,
              status: eventStatus
            });
          }

          if (conversationId && Array.isArray(c.protocols.hyperflow) && !c.protocols.hyperflow.includes(conversationId)) {
            c.protocols.hyperflow.push(conversationId);
          }

          if (!Array.isArray(c.timeline)) c.timeline = [];
          c.timeline.push({
            id: `tl-wh-${Date.now()}`,
            type: "hoymiles_account_created",
            title: `Conta Hoymiles Criada: ${loginEmail}`,
            detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Credenciais entregues via Hyperflow.`,
            author: `TARS Vision Bridge v${bridgeVersion}`,
            timestamp: occurredAt
          });

          if (["aberto", "em_analise", "aguardando_terceiros"].includes(c.status)) {
            c.status = "concluido";
            c.resolved_at = occurredAt;
          }

          c.updated_at = new Date().toISOString();
          list[i] = c;
          break;
        }
      }

      // 2. If no case exists, auto-create documented SLA case
      if (!matchedCaseId) {
        isNewCase = true;
        const caseNum = Math.floor(1000 + Math.random() * 9000);
        matchedCaseId = `SLA-HOY-${caseNum}`;

        const newCase = {
          id: matchedCaseId,
          title: `Criação de Conta Hoymiles — ${orgName || customerName}`,
          priority: "media",
          status: "concluido",
          created_at: occurredAt,
          resolved_at: occurredAt,
          sla_limit_hours: 24,
          responsible_tech: "TARS Vision Bridge",
          customer: {
            name: customerName,
            email: customerEmail || loginEmail,
            phone: customerPhone,
            state: customerState,
            company: orgName
          },
          equipment: {
            manufacturer: "Hoymiles",
            model: "S-Miles Cloud (Portal do Instalador)",
            serial_numbers: ["N/A - Conta Web/App"]
          },
          problem_summary: `Criação automatizada de conta de Instalador Hoymiles para ${customerName} (${orgName}). Login: ${loginEmail}. Senha padrão configurada e entregue via Hyperflow.`,
          protocols: {
            hoymiles: [{
              account_email: loginEmail,
              org_name: orgName,
              parent_org: parentOrg,
              role: orgRole,
              created_at: occurredAt,
              conversation_id: conversationId,
              status: eventStatus
            }],
            hyperflow: conversationId ? [conversationId] : []
          },
          timeline: [
            {
              id: `tl-sla-init-${Date.now()}`,
              type: "hoymiles_account_created",
              title: "Conta Hoymiles Criada & Entregue",
              detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Status: ${eventStatus}. Credenciais e links de treinamento repassados via chat Hyperflow.`,
              author: `TARS Vision Bridge v${bridgeVersion}`,
              timestamp: occurredAt
            }
          ],
          notes: `Evento recebido via Webhook SLA (${eventType}) da extensão TARS Vision Bridge v${bridgeVersion}. Senhas não são armazenadas no Solar Agenda por segurança.`
        };

        list.unshift(newCase);
      }

      // 3. Log event
      const logs = Array.isArray(storage.slaWebhookLogs) ? [...storage.slaWebhookLogs] : [];
      const logEntry = {
        id: `sla-wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        receivedAt: new Date().toISOString(),
        event: eventType,
        source,
        bridgeVersion,
        status: eventStatus,
        customer: customerName,
        email: loginEmail,
        company: orgName,
        conversationId: conversationId || null,
        matchedCaseId,
        isNewCase
      };
      logs.unshift(logEntry);

      writeStorage({
        slaCases: list,
        slaWebhookLogs: logs.slice(0, 50)
      });

      return sendResponse(res, 200, {
        ok: true,
        message: "SLA webhook event successfully processed and persisted.",
        caseId: matchedCaseId,
        isNewCase,
        event: eventType,
        logId: logEntry.id
      });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
