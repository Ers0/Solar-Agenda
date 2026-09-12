import { sendResponse, handleCors, parseJsonBody } from "./_smtp.js";
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function readStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
  } catch (e) {}
  return { contacts: null, smtpConfig: null, slaCases: null, jiraConfig: null, jiraWebhookLogs: [] };
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
    return sendResponse(res, 200, { ok: true, logs: data.jiraWebhookLogs || [] });
  }

  if (req.method === "POST") {
    try {
      const payload = await parseJsonBody(req);
      const eventType = payload.webhookEvent || payload.eventType || "jira:issue_updated";
      const issueObj = payload.issue || {};
      const issueKey = (issueObj.key || payload.key || payload.issueKey || "").trim();
      const statusObj = issueObj.fields?.status || {};
      const statusName = (statusObj.name || "").trim();
      const userName = payload.user?.displayName || payload.user?.name || "Jira Cloud";

      const storage = readStorage();
      const list = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      let updatedCount = 0;

      if (issueKey) {
        const normKey = issueKey.toUpperCase();
        for (let i = 0; i < list.length; i++) {
          const item = { ...list[i] };
          if (Array.isArray(item.protocols?.jira)) {
            const jIdx = item.protocols.jira.findIndex(j => String(j.issue_key).toUpperCase() === normKey);
            if (jIdx >= 0) {
              item.protocols.jira[jIdx].status = statusName || item.protocols.jira[jIdx].status;
              item.protocols.jira[jIdx].last_synced = new Date().toISOString();
              if (!Array.isArray(item.timeline)) item.timeline = [];
              item.timeline.push({
                id: `evt-wh-${Date.now()}`,
                type: "jira_update",
                title: `Webhook Jira: [${issueKey}] ➔ ${statusName}`,
                detail: `Sincronização automática recebida via Jira Webhook por ${userName}.`,
                author: "Jira Webhook",
                timestamp: new Date().toISOString()
              });
              item.updated_at = new Date().toISOString();
              list[i] = item;
              updatedCount++;
            }
          }
        }
      }

      const logs = Array.isArray(storage.jiraWebhookLogs) ? [...storage.jiraWebhookLogs] : [];
      logs.unshift({
        id: `wh-${Date.now()}`,
        receivedAt: new Date().toISOString(),
        eventType,
        issueKey,
        newStatus: statusName,
        user: userName,
        matchedCasesCount: updatedCount
      });

      writeStorage({ slaCases: list, jiraWebhookLogs: logs.slice(0, 25) });
      return sendResponse(res, 200, { ok: true, issueKey, matchedCasesCount: updatedCount });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
