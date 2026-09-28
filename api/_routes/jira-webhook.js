import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import { readAppStorage, writeAppStorage } from "../_storage.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const data = readAppStorage();
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

      const storage = readAppStorage();
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

      writeAppStorage({ slaCases: list, jiraWebhookLogs: logs.slice(0, 25) });
      return sendResponse(res, 200, { ok: true, issueKey, matchedCasesCount: updatedCount });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
