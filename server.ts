import express from "express";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { JiraService, JiraConfig, CreateJiraIssueParams } from "./server/jira";
import { runTARSIntakeDisambiguation } from "./server/tars-sn";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

interface SmtpOptions {
  host?: string;
  port?: number | string;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

function getTransporter(customConfig?: SmtpOptions) {
  const user = customConfig?.user || process.env.SMTP_USER || "";
  const pass = customConfig?.pass || process.env.SMTP_PASS || "";
  const host = customConfig?.host || process.env.SMTP_HOST || (user.toLowerCase().endsWith("@gmail.com") ? "smtp.gmail.com" : "mail.mailcorp.com.br");
  const port = parseInt(String(customConfig?.port || process.env.SMTP_PORT || (host.includes("gmail") ? "465" : "587")), 10);
  const secure = customConfig?.secure !== undefined
    ? customConfig.secure
    : (process.env.SMTP_SECURE === "true" || port === 465 || host.includes("gmail"));

  if (!user || !pass) {
    throw new Error("Credentials missing: Email and Password (or App Password) are required to send emails.");
  }

  // Gmail special transport
  if (host.includes("gmail") || user.toLowerCase().endsWith("@gmail.com")) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user,
        pass,
      },
    });
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

function formatSmtpError(err: any, user?: string): string {
  const msg = err?.message || String(err);
  if (msg.includes("535") || msg.includes("BadCredentials") || msg.includes("Username and Password not accepted")) {
    if (user?.toLowerCase().endsWith("@gmail.com") || msg.includes("gmail")) {
      return "Gmail rejected the login (Error 535). For testing with Gmail: If your test account has 2-Step Verification enabled, Google requires a 16-character App Password (go to: myaccount.google.com/apppasswords). If 2-Step Verification is disabled, ensure 'Less secure app access' or basic auth is permitted.";
    }
    return "Invalid username or password. Please verify your credentials.";
  }
  return msg;
}

// --- API: Send Email ---
app.post("/api/send-email", async (req, res) => {
  try {
    const { to, cc, subject, text, html, smtpConfig } = req.body;

    if (!to) {
      return res.status(400).json({ ok: false, error: "Recipient ('to') email address is required." });
    }
    if (!subject) {
      return res.status(400).json({ ok: false, error: "Email subject is required." });
    }

    const transporter = getTransporter(smtpConfig);
    const fromAddr = smtpConfig?.from || smtpConfig?.user || process.env.SMTP_FROM || process.env.SMTP_USER;

    const info = await transporter.sendMail({
      from: fromAddr ? `Solar Agenda <${fromAddr}>` : undefined,
      to,
      cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
      subject,
      text: text || undefined,
      html: html || (text ? `<div style="font-family: sans-serif; line-height: 1.6; color: #1f2937;">${String(text).replace(/\n/g, "<br/>")}</div>` : undefined),
    });

    console.log("[SMTP] Email sent:", info.messageId, "to:", to, "cc:", cc || "none");
    return res.json({ ok: true, messageId: info.messageId, accepted: info.accepted });
  } catch (err: any) {
    console.error("[SMTP Error]", err);
    return res.status(500).json({ ok: false, error: formatSmtpError(err, req.body?.smtpConfig?.user) });
  }
});

// --- API: Test SMTP Connection ---
app.post("/api/test-smtp", async (req, res) => {
  try {
    const { smtpConfig } = req.body;
    const transporter = getTransporter(smtpConfig);
    await transporter.verify();
    return res.json({ ok: true, message: "Connection to email server verified successfully! Ready to dispatch messages." });
  } catch (err: any) {
    console.error("[SMTP Verify Error]", err);
    return res.status(400).json({ ok: false, error: formatSmtpError(err, req.body?.smtpConfig?.user) });
  }
});

// --- Persistent Local App Storage (Contacts & Email Dispatcher state across sessions) ---
const STORAGE_FILE = path.join(process.cwd(), ".app_storage.json");

function readAppStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[Storage] Error reading app storage:", e);
  }
  return { contacts: null, smtpConfig: null, slaCases: null, jiraConfig: null, jiraWebhookLogs: [], slaWebhookLogs: [] };
}

function writeAppStorage(data: any) {
  try {
    const current = readAppStorage();
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
    console.warn("[Storage] Error writing app storage:", e);
    return null;
  }
}

// Helper to get configured JiraService instance
function getJiraServiceInstance(): JiraService {
  const storage = readAppStorage();
  return new JiraService(storage.jiraConfig || undefined);
}

// --- API: Get App Data (Contacts, SMTP configuration & SLA Cases) ---
app.get("/api/app-data", (req, res) => {
  const data = readAppStorage();
  res.json({ ok: true, contacts: data.contacts, smtpConfig: data.smtpConfig, slaCases: data.slaCases });
});

// --- API: Save App Data (Contacts, SMTP configuration & SLA Cases) ---
app.post("/api/app-data", (req, res) => {
  const { contacts, smtpConfig, slaCases } = req.body || {};
  const saved = writeAppStorage({ contacts, smtpConfig, slaCases });
  res.json({ ok: true, data: saved });
});

// --- API: SLA Cases direct endpoints ---
app.get("/api/sla-cases", (req, res) => {
  const data = readAppStorage();
  const cases = Array.isArray(data.slaCases) ? data.slaCases : [];
  res.json({ ok: true, cases });
});

app.post("/api/sla-cases", (req, res) => {
  const body = req.body || {};
  const current = readAppStorage();
  let list: any[] = Array.isArray(current.slaCases) ? [...current.slaCases] : [];

  if (Array.isArray(body)) {
    list = body;
  } else if (Array.isArray(body.cases)) {
    list = body.cases;
  } else if (body.case && typeof body.case === "object") {
    const item = body.case;
    const idx = list.findIndex(c => c.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
  } else if (body.id || body.problem_summary || body.customer) {
    const item = {
      id: body.id || `SLA-${Date.now().toString().slice(-4)}`,
      created_at: body.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: body.status || 'OPEN_TRIAGE',
      priority: body.priority || 'alta',
      ...body
    };
    const idx = list.findIndex(c => c.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
  } else {
    return res.status(400).json({ ok: false, error: "Expected 'cases' array or SLA case object in request body." });
  }

  const saved = writeAppStorage({ slaCases: list });
  res.json({ ok: true, count: list.length, cases: saved?.slaCases || list });
});

app.patch("/api/sla-cases/:id/status", (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body || {};
  const current = readAppStorage();
  let list: any[] = Array.isArray(current.slaCases) ? [...current.slaCases] : [];
  const idx = list.findIndex(c => String(c.id).toLowerCase() === String(id).toLowerCase());
  if (idx < 0) {
    return res.status(404).json({ ok: false, error: `SLA case ${id} not found.` });
  }
  const item = { ...list[idx] };
  const prevStatus = item.status;
  item.status = status || item.status;
  item.updated_at = new Date().toISOString();
  if (!Array.isArray(item.timeline)) item.timeline = [];
  item.timeline.push({
    id: `evt-${Date.now()}`,
    type: "status_change",
    title: `Status alterado para ${status}`,
    detail: note || `Transição de ${prevStatus} para ${status}.`,
    author: "Sistema TARS",
    timestamp: new Date().toISOString()
  });
  list[idx] = item;
  writeAppStorage({ slaCases: list });
  res.json({ ok: true, case: item, cases: list });
});

app.delete("/api/sla-cases/:id", (req, res) => {
  const { id } = req.params;
  const current = readAppStorage();
  let list: any[] = Array.isArray(current.slaCases) ? [...current.slaCases] : [];
  list = list.filter(c => String(c.id).toLowerCase() !== String(id).toLowerCase());
  writeAppStorage({ slaCases: list });
  res.json({ ok: true, cases: list });
});

// --- API: TARS Contextual Serial Number Disambiguation & Case Intake ---
app.post("/api/sla-cases/extract-sn", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ ok: false, error: "Text or transcript is required for extraction." });
    }
    const result = await runTARSIntakeDisambiguation(text);
    res.json(result);
  } catch (err: any) {
    console.error("[TARS-SN API Error]", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to extract and disambiguate serial numbers." });
  }
});

// --- API: Jira Formal Protocol & Warranty Integration (Backend) ---
app.get("/api/jira/status", async (req, res) => {
  try {
    const jira = getJiraServiceInstance();
    const summary = jira.getConfigSummary();

    let connection: any = null;
    if (summary.configured) {
      connection = await jira.testConnection();
    } else {
      connection = {
        ok: false,
        message: "Jira Cloud credentials are not configured yet. Define JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN in environment or settings.",
      };
    }

    res.json({
      ok: true,
      ...summary,
      connection,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jira/config", (req, res) => {
  try {
    const { host, email, apiToken, defaultProjectKey, defaultIssueType } = req.body || {};
    const storage = readAppStorage();
    const currentJira = storage.jiraConfig || {};

    const updatedJira = {
      host: host !== undefined ? host : currentJira.host,
      email: email !== undefined ? email : currentJira.email,
      apiToken: apiToken !== undefined ? apiToken : currentJira.apiToken,
      defaultProjectKey: defaultProjectKey !== undefined ? defaultProjectKey : currentJira.defaultProjectKey,
      defaultIssueType: defaultIssueType !== undefined ? defaultIssueType : currentJira.defaultIssueType,
    };

    writeAppStorage({ jiraConfig: updatedJira });
    const jira = new JiraService(updatedJira);
    res.json({ ok: true, summary: jira.getConfigSummary() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/jira/projects", async (req, res) => {
  try {
    const jira = getJiraServiceInstance();
    const projects = await jira.getProjects();
    res.json({ ok: true, projects });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/jira/issue/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const jira = getJiraServiceInstance();
    const issue = await jira.getIssue(key);
    res.json({ ok: true, issue });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jira/issue", async (req, res) => {
  try {
    const { slaCaseId, summary, description, priority, issueType, projectKey, customerName, customerPhone, serialNumber, equipmentModel, manufacturer } = req.body || {};
    if (!summary && !slaCaseId) {
      return res.status(400).json({ ok: false, error: "summary or slaCaseId is required." });
    }

    const jira = getJiraServiceInstance();
    const created = await jira.createIssue({
      slaCaseId: slaCaseId || "SLA-DEMO",
      summary: summary || `[${slaCaseId}] Defeito Inversor ${manufacturer || ""} - ${customerName || "Suporte"}`,
      description,
      priority,
      issueType,
      projectKey,
      customerName,
      customerPhone,
      serialNumber,
      equipmentModel,
      manufacturer,
    });

    // If slaCaseId is present, automatically register into matching SLA case protocols
    if (slaCaseId) {
      const storage = readAppStorage();
      const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      const idx = list.findIndex(c => String(c.id).toLowerCase() === String(slaCaseId).toLowerCase());
      if (idx >= 0) {
        const item = { ...list[idx] };
        if (!item.protocols) item.protocols = {};
        if (!Array.isArray(item.protocols.jira)) item.protocols.jira = [];

        const existingJira = item.protocols.jira.find((j: any) => j.issue_key === created.key);
        if (!existingJira) {
          item.protocols.jira.push({
            board: created.key.split("-")[0] || "SOL",
            issue_key: created.key,
            summary: created.summary || summary,
            status: created.status || "Open",
            url: created.url,
            isSimulated: created.isSimulated,
            created_at: new Date().toISOString(),
          });
        }

        if (!Array.isArray(item.timeline)) item.timeline = [];
        item.timeline.push({
          id: `evt-${Date.now()}`,
          type: "jira_update",
          title: `Protocolo Jira Criado: ${created.key}`,
          detail: `Protocolo formal de garantia ${created.key} vinculado ao caso SLA.`,
          author: "Jira Integration",
          timestamp: new Date().toISOString(),
        });

        item.updated_at = new Date().toISOString();
        list[idx] = item;
        writeAppStorage({ slaCases: list });
      }
    }

    res.json({ ok: true, issue: created });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jira/issue/:key/comment", async (req, res) => {
  try {
    const { key } = req.params;
    const { comment, slaCaseId } = req.body || {};
    if (!comment) {
      return res.status(400).json({ ok: false, error: "comment text is required." });
    }

    const jira = getJiraServiceInstance();
    const result = await jira.addComment(key, comment);

    // Optionally append note to SLA case timeline
    if (slaCaseId) {
      const storage = readAppStorage();
      const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      const idx = list.findIndex(c => String(c.id).toLowerCase() === String(slaCaseId).toLowerCase());
      if (idx >= 0) {
        const item = { ...list[idx] };
        if (!Array.isArray(item.timeline)) item.timeline = [];
        item.timeline.push({
          id: `evt-${Date.now()}`,
          type: "jira_update",
          title: `Comentário postado no Jira (${key})`,
          detail: comment,
          author: "Jira Integration",
          timestamp: new Date().toISOString(),
        });
        item.updated_at = new Date().toISOString();
        list[idx] = item;
        writeAppStorage({ slaCases: list });
      }
    }

    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jira/issue/:key/sync", async (req, res) => {
  try {
    const { key } = req.params;
    const { slaCaseId } = req.body || {};
    const jira = getJiraServiceInstance();
    const issue = await jira.getIssue(key);

    let updatedCase = null;
    if (slaCaseId) {
      const storage = readAppStorage();
      const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      const idx = list.findIndex(c => String(c.id).toLowerCase() === String(slaCaseId).toLowerCase());
      if (idx >= 0) {
        const item = { ...list[idx] };
        if (item.protocols?.jira) {
          const jIdx = item.protocols.jira.findIndex((j: any) => j.issue_key === key);
          if (jIdx >= 0) {
            item.protocols.jira[jIdx].status = issue.status;
            item.protocols.jira[jIdx].last_synced = new Date().toISOString();
          }
        }
        if (!Array.isArray(item.timeline)) item.timeline = [];
        item.timeline.push({
          id: `evt-${Date.now()}`,
          type: "jira_update",
          title: `Jira Sincronizado: ${key}`,
          detail: `Status atual no Jira: ${issue.status} (${issue.statusCategory || ""})`,
          author: "Jira Integration",
          timestamp: new Date().toISOString(),
        });
        item.updated_at = new Date().toISOString();
        list[idx] = item;
        writeAppStorage({ slaCases: list });
        updatedCase = item;
      }
    }

    res.json({ ok: true, issue, case: updatedCase });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: Jira Cloud Incoming Webhook Endpoint ---
app.post("/api/jira/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const eventType = payload.webhookEvent || payload.eventType || "jira:issue_updated";
    const issueObj = payload.issue || {};
    const issueKey = (issueObj.key || payload.key || payload.issueKey || "").trim();
    const changelogItems = Array.isArray(payload.changelog?.items) ? payload.changelog.items : [];
    
    // Status identification
    const statusObj = issueObj.fields?.status || {};
    const statusName = (statusObj.name || "").trim();
    const statusCategory = (statusObj.statusCategory?.name || statusObj.statusCategory?.key || "").toLowerCase();
    const userName = payload.user?.displayName || payload.user?.name || "Jira Cloud";
    
    // Check if status changed in changelog
    const statusChange = changelogItems.find((i: any) => String(i.field).toLowerCase() === "status");
    const oldStatus = statusChange ? statusChange.fromString : null;
    const newStatus = statusChange ? statusChange.toString : statusName;

    // Log the event
    const storage = readAppStorage();
    const logs: any[] = Array.isArray(storage.jiraWebhookLogs) ? [...storage.jiraWebhookLogs] : [];
    const logEntry = {
      id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      receivedAt: new Date().toISOString(),
      eventType,
      issueKey: issueKey || "N/A",
      oldStatus,
      newStatus: newStatus || statusName || "Updated",
      user: userName,
      summary: issueObj.fields?.summary || payload.summary || null,
      matchedCasesCount: 0
    };

    if (!issueKey) {
      logs.unshift(logEntry);
      writeAppStorage({ jiraWebhookLogs: logs.slice(0, 25) });
      return res.json({ ok: true, message: "Webhook acknowledged, no issue key provided.", entry: logEntry });
    }

    // Match against SLA cases in storage
    const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    let updatedCount = 0;
    const affectedCaseIds: string[] = [];

    const normKey = issueKey.toUpperCase();
    for (let i = 0; i < list.length; i++) {
      const item = { ...list[i] };
      let matched = false;

      // Check protocols.jira
      if (Array.isArray(item.protocols?.jira)) {
        for (let j = 0; j < item.protocols.jira.length; j++) {
          const proto = { ...item.protocols.jira[j] };
          const pKey = String(proto.issue_key || "").toUpperCase();
          const pFull = proto.board ? `${proto.board}-${proto.issue_key}`.toUpperCase() : pKey;

          if (pKey === normKey || pFull === normKey || normKey.endsWith(pKey)) {
            matched = true;
            proto.status = newStatus || proto.status;
            proto.last_synced = new Date().toISOString();
            item.protocols.jira[j] = proto;
          }
        }
      }

      // Also check if issueKey is referenced in problem_summary or case ID
      if (!matched && (
        String(item.id).toUpperCase() === normKey ||
        String(item.problem_summary || "").toUpperCase().includes(normKey)
      )) {
        matched = true;
        if (!item.protocols) item.protocols = {};
        if (!Array.isArray(item.protocols.jira)) item.protocols.jira = [];
        item.protocols.jira.push({
          issue_key: issueKey,
          status: newStatus,
          last_synced: new Date().toISOString()
        });
      }

      if (matched) {
        // Automatic stage progression based on Jira status
        const sLower = String(newStatus || statusName).toLowerCase();
        let autoNote = "";

        if (sLower.includes("done") || sLower.includes("resolved") || sLower.includes("conclu") || sLower.includes("resolv") || statusCategory.includes("done")) {
          item.status = "RESOLVED";
          autoNote = `Caso marcado como RESOLVIDO automaticamente via conclusão no Jira (${newStatus})`;
        } else if (sLower.includes("waiting for customer") || sLower.includes("aguardando cliente")) {
          item.status = "WAITING CUSTOMER INFO / TEST";
          autoNote = `SLA pausado temporariamente: ticket no Jira aguarda informações do cliente.`;
        } else if (sLower.includes("waiting on vendor") || sLower.includes("aguardando fabricante") || sLower.includes("fabricante")) {
          item.status = "WAITING MANUFACTURER RESPONSE";
          autoNote = `Protocolo em análise pelo fabricante / RMA (${newStatus}).`;
        } else if (sLower.includes("in progress") || sLower.includes("em andamento") || sLower.includes("investig") || sLower.includes("análise")) {
          if (item.status === "NEW" || item.status === "PENDING MANUFACTURER CONTACT") {
            item.status = "WAITING MANUFACTURER RESPONSE";
            autoNote = `Atendimento iniciado no Jira (${newStatus}).`;
          }
        }

        // Add timeline entry
        if (!Array.isArray(item.timeline)) item.timeline = [];
        item.timeline.push({
          id: `evt-wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "jira_update",
          title: `Webhook Jira: [${issueKey}] ${oldStatus ? `${oldStatus} ➔ ` : ''}${newStatus}`,
          detail: autoNote || `Atualização automática disparada via Webhook Atlassian por ${userName}. Status: ${newStatus}`,
          author: "Jira Webhook",
          timestamp: new Date().toISOString(),
        });

        item.updated_at = new Date().toISOString();
        list[i] = item;
        updatedCount++;
        affectedCaseIds.push(item.id);
      }
    }

    logEntry.matchedCasesCount = updatedCount;
    logs.unshift(logEntry);

    writeAppStorage({
      slaCases: list,
      jiraWebhookLogs: logs.slice(0, 25)
    });

    res.json({
      ok: true,
      received: true,
      issueKey,
      newStatus,
      matchedCasesCount: updatedCount,
      affectedCaseIds,
      logEntry
    });
  } catch (err: any) {
    console.error("[JiraWebhook] Error processing webhook:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/jira/webhook/logs - Returns recent webhook events
app.get("/api/jira/webhook/logs", (req, res) => {
  const storage = readAppStorage();
  res.json({ ok: true, logs: storage.jiraWebhookLogs || [] });
});

// POST /api/jira/webhook/test - Simulates a Jira Webhook ping for testing
app.post("/api/jira/webhook/test", async (req, res) => {
  try {
    const { issueKey = "ADB-102", status = "In Progress", eventType = "jira:issue_updated", user = "Tech Test" } = req.body || {};
    const mockPayload = {
      webhookEvent: eventType,
      issue: {
        key: issueKey,
        fields: {
          summary: `Simulated Webhook Update for ${issueKey}`,
          status: { name: status, statusCategory: { name: status } }
        }
      },
      changelog: {
        items: [
          { field: "status", fromString: "Open", toString: status }
        ]
      },
      user: { displayName: user }
    };

    // Forward to internal webhook handler
    const storage = readAppStorage();
    const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    let matched = 0;
    const affected: string[] = [];

    for (let i = 0; i < list.length; i++) {
      const item = { ...list[i] };
      const hasProto = item.protocols?.jira?.some((j: any) => String(j.issue_key).toUpperCase() === issueKey.toUpperCase());
      if (hasProto) {
        matched++;
        affected.push(item.id);
        const jIdx = item.protocols.jira.findIndex((j: any) => String(j.issue_key).toUpperCase() === issueKey.toUpperCase());
        item.protocols.jira[jIdx].status = status;
        item.protocols.jira[jIdx].last_synced = new Date().toISOString();
        if (!Array.isArray(item.timeline)) item.timeline = [];
        item.timeline.push({
          id: `evt-wh-${Date.now()}`,
          type: "jira_update",
          title: `Teste de Webhook Jira: [${issueKey}] ➔ ${status}`,
          detail: `Simulação de evento Webhook executada com sucesso via painel Solar Agenda.`,
          author: "Webhook Test Engine",
          timestamp: new Date().toISOString(),
        });
        item.updated_at = new Date().toISOString();
        list[i] = item;
      }
    }

    const logs: any[] = Array.isArray(storage.jiraWebhookLogs) ? [...storage.jiraWebhookLogs] : [];
    const testLog = {
      id: `wh-test-${Date.now()}`,
      receivedAt: new Date().toISOString(),
      eventType: `${eventType} (TEST)`,
      issueKey,
      oldStatus: "Open",
      newStatus: status,
      user,
      matchedCasesCount: matched
    };
    logs.unshift(testLog);

    writeAppStorage({ slaCases: list, jiraWebhookLogs: logs.slice(0, 25) });
    res.json({ ok: true, tested: true, issueKey, status, matchedCasesCount: matched, affectedCases: affected, log: testLog });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// API: Solar Agenda SLA Webhook Endpoints
// Receives TARS Vision Bridge events (e.g. hoymiles.account.created)
// =============================================================================
app.post("/api/sla/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
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

    console.info(`[SLA Webhook] Received event: ${eventType} for ${loginEmail || orgName} (source: ${source})`);

    const storage = readAppStorage();
    const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    let matchedCaseId: string | null = null;
    let isNewCase = false;

    // 1. Look for existing case matching email, phone, org, or conversationId
    for (let i = 0; i < list.length; i++) {
      const c = { ...list[i] };
      const cEmail = (c.customer?.email || "").toLowerCase();
      const cPhone = (c.customer?.phone || "").replace(/\D/g, "");
      const searchPhone = customerPhone.replace(/\D/g, "");

      const matchesConv = conversationId && Array.isArray(c.protocols?.hyperflow) && c.protocols.hyperflow.includes(conversationId);
      const matchesEmail = loginEmail && cEmail && (cEmail === loginEmail);
      const matchesPhone = searchPhone.length >= 8 && cPhone && (cPhone === searchPhone || cPhone.endsWith(searchPhone) || searchPhone.endsWith(cPhone));
      const matchesHoymilesProto = Array.isArray(c.protocols?.hoymiles) && c.protocols.hoymiles.some((h: any) => (h.account_email || "").toLowerCase() === loginEmail);

      if (matchesConv || matchesEmail || matchesPhone || matchesHoymilesProto) {
        matchedCaseId = c.id;
        c.protocols = c.protocols || {};
        c.protocols.hoymiles = Array.isArray(c.protocols.hoymiles) ? [...c.protocols.hoymiles] : [];
        
        // Add protocol record if not present
        if (!c.protocols.hoymiles.some((h: any) => (h.account_email || "").toLowerCase() === loginEmail)) {
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

        // Timeline entry
        if (!Array.isArray(c.timeline)) c.timeline = [];
        c.timeline.push({
          id: `tl-wh-${Date.now()}`,
          type: "hoymiles_account_created",
          title: `Conta Hoymiles Criada: ${loginEmail}`,
          detail: `Conta de Instalador criada com sucesso no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Credenciais e tutoriais entregues via Hyperflow.`,
          author: `TARS Vision Bridge v${bridgeVersion}`,
          timestamp: occurredAt
        });

        // Mark resolved if was pending/in_progress and this completes the service
        if (["aberto", "em_analise", "aguardando_terceiros"].includes(c.status)) {
          c.status = "concluido";
          c.resolved_at = occurredAt;
        }

        c.updated_at = new Date().toISOString();
        list[i] = c;
        break;
      }
    }

    // 2. If no matching case exists, auto-create a documented SLA Case
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
            detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Status: ${eventStatus}. Credenciais e links de treinamento repassados ao cliente via chat Hyperflow.`,
            author: `TARS Vision Bridge v${bridgeVersion}`,
            timestamp: occurredAt
          }
        ],
        notes: `Evento recebido via Webhook SLA (${eventType}) da extensão TARS Vision Bridge v${bridgeVersion}. Senhas não são armazenadas no Solar Agenda por segurança.`
      };

      list.unshift(newCase);
    }

    // 3. Log webhook event
    const logs: any[] = Array.isArray(storage.slaWebhookLogs) ? [...storage.slaWebhookLogs] : [];
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

    writeAppStorage({
      slaCases: list,
      slaWebhookLogs: logs.slice(0, 50)
    });

    return res.json({
      ok: true,
      message: "SLA webhook event successfully processed and persisted.",
      caseId: matchedCaseId,
      isNewCase,
      event: eventType,
      logId: logEntry.id
    });
  } catch (err: any) {
    console.error("[SLA Webhook] Error processing incoming event:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sla/webhook/logs - Returns recent SLA webhook events
app.get("/api/sla/webhook/logs", (req, res) => {
  const storage = readAppStorage();
  res.json({ ok: true, logs: storage.slaWebhookLogs || [] });
});

// POST /api/sla/webhook/test - Simulates an SLA Webhook ping from TARS Vision Bridge
app.post("/api/sla/webhook/test", async (req, res) => {
  try {
    const {
      company = "SolarTech Brasil Teste",
      name = "Engenheiro Marcelo Rocha",
      email = "marcelo.solar@teste.com.br",
      phone = "11988776655",
      state = "São Paulo",
      conversationId = "hyperflow-test-conv-99"
    } = req.body || {};

    const mockPayload = {
      event: "hoymiles.account.created",
      version: "1.0",
      source: "tars-vision-bridge",
      bridgeVersion: "1.2.37",
      occurredAt: new Date().toISOString(),
      status: "COMPLETED",
      conversationId,
      customer: {
        name,
        email,
        phone,
        state
      },
      organization: {
        name: company,
        parentOrganization: "APItest",
        type: "Installer",
        role: "Installer"
      },
      account: {
        loginEmail: email,
        passwordSharedWithCustomer: true
      },
      reporting: { ok: true, method: "test" }
    };

    // Forward to internal webhook handler by calling fetch or executing internally
    const storage = readAppStorage();
    const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    const caseNum = Math.floor(1000 + Math.random() * 9000);
    const caseId = `SLA-HOY-${caseNum}`;

    const newCase = {
      id: caseId,
      title: `Criação de Conta Hoymiles — ${company}`,
      priority: "media",
      status: "concluido",
      created_at: mockPayload.occurredAt,
      resolved_at: mockPayload.occurredAt,
      sla_limit_hours: 24,
      responsible_tech: "TARS Vision Bridge",
      customer: {
        name,
        email,
        phone,
        state,
        company
      },
      equipment: {
        manufacturer: "Hoymiles",
        model: "S-Miles Cloud (Portal do Instalador)",
        serial_numbers: ["N/A - Conta Web/App"]
      },
      problem_summary: `[TESTE SIMULADO] Criação de conta Hoymiles para ${name} (${company}). Login: ${email}. Senha entregue via Hyperflow.`,
      protocols: {
        hoymiles: [{
          account_email: email,
          org_name: company,
          parent_org: "APItest",
          role: "Installer",
          created_at: mockPayload.occurredAt,
          conversation_id: conversationId,
          status: "COMPLETED"
        }],
        hyperflow: [conversationId]
      },
      timeline: [
        {
          id: `tl-sim-${Date.now()}`,
          type: "hoymiles_account_created",
          title: "Teste de Webhook SLA Executado",
          detail: `Simulação de criação de conta Hoymiles via painel Solar Agenda. Conta vinculada a APItest (${company}).`,
          author: "TARS Webhook Simulator",
          timestamp: mockPayload.occurredAt
        }
      ],
      notes: "Caso de teste gerado pelo simulador de webhook SLA."
    };

    list.unshift(newCase);

    const logs: any[] = Array.isArray(storage.slaWebhookLogs) ? [...storage.slaWebhookLogs] : [];
    const testLog = {
      id: `sla-wh-test-${Date.now()}`,
      receivedAt: new Date().toISOString(),
      event: "hoymiles.account.created (TEST)",
      source: "tars-vision-bridge-test",
      bridgeVersion: "1.2.37",
      status: "COMPLETED",
      customer: name,
      email,
      company,
      conversationId,
      matchedCaseId: caseId,
      isNewCase: true
    };
    logs.unshift(testLog);

    writeAppStorage({
      slaCases: list,
      slaWebhookLogs: logs.slice(0, 50)
    });

    res.json({
      ok: true,
      tested: true,
      caseId,
      event: "hoymiles.account.created",
      customer: name,
      email,
      company,
      log: testLog
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: Get Server SMTP Status ---
app.get("/api/smtp-status", (req, res) => {
  const storage = readAppStorage();
  const savedSmtp = storage.smtpConfig;
  const host = savedSmtp?.host || process.env.SMTP_HOST || "mail.mailcorp.com.br";
  const port = savedSmtp?.port || process.env.SMTP_PORT || "587";
  const user = savedSmtp?.user || process.env.SMTP_USER || "";
  const from = savedSmtp?.from || savedSmtp?.user || process.env.SMTP_FROM || user || "";
  const configured = !!((user && (savedSmtp?.pass || process.env.SMTP_PASS)) || (process.env.SMTP_USER && process.env.SMTP_PASS));

  res.json({
    configured,
    host,
    port,
    from,
    hasServerCredentials: configured,
    savedUser: user || undefined
  });
});

// --- API: Machine Learning Fine-Tuning Dataset Generator ---
// Converts saved cases and runbooks into JSONL training format for Gemini / OpenAI / LoRA fine-tuning
app.post("/api/ml-export-dataset", (req, res) => {
  try {
    const { cases = [], notes = [], rules = [] } = req.body;

    const dataset: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    // System prompt baseline for TARS
    const systemPrompt = "You are TARS, an expert technical solar inverter support agent specializing in on-grid, microinverter, and hybrid systems (Deye, Foxess, Growatt). You analyze alarm codes, guide PAC diagnostics, and provide actionable technical runbooks.";

    // 1. Convert resolved cases with notes into training pairs
    cases.forEach((c: any) => {
      if (!c.titulo) return;
      const alarmCode = (c.tags || []).join(", ");
      const userQuery = `Inverter issue reported: ${c.titulo}. Tags: ${alarmCode}. What is the diagnosis and recommended procedure?`;
      
      let resolution = "";
      if (Array.isArray(c.notes_log) && c.notes_log.length > 0) {
        resolution = c.notes_log.map((n: any) => n.text).join("\n");
      } else if (c.actual_end) {
        resolution = `Resolved case within priority ${c.prioridade}. Followed standard manufacturer isolation and verification checklist.`;
      }

      if (resolution) {
        dataset.push({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userQuery },
            { role: "assistant", content: `Diagnostic assessment: ${c.titulo}.\n\nField Procedures:\n${resolution}` }
          ]
        });
      }
    });

    // 2. Convert learned rules into training pairs
    rules.forEach((r: any) => {
      if (!r.pattern || !r.action) return;
      dataset.push({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `How should I handle this scenario: ${r.pattern}?` },
          { role: "assistant", content: `Technical rule: ${r.action}` }
        ]
      });
    });

    // 3. Convert technical notes
    notes.forEach((n: any) => {
      if (!n.title || !n.content) return;
      const cleanContent = n.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      dataset.push({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Explain runbook guidelines for: ${n.title}` },
          { role: "assistant", content: cleanContent }
        ]
      });
    });

    // 4. Conversational Serial Number Identification & Disambiguation Training Pairs
    const snConversationalExamples = [
      {
        user: "Cliente João Silva, telefone 11999998888, inversor Deye SUN-8K, SN 230123456789, protocolo 458921.",
        assistant: JSON.stringify({
          customer: "João Silva",
          phone: "11999998888",
          equipment: "SUN-8K",
          serial_number: "230123456789",
          manufacturer: "Deye",
          protocol: "458921",
          confidence: { sn: 0.98, manufacturer: 0.97, equipment: 0.95 }
        }, null, 2)
      },
      {
        user: "o SN do inversor é 230123456789, modelo SUN-5K-SG01HP3",
        assistant: JSON.stringify({
          serial_number: "230123456789",
          manufacturer: "Deye",
          model: "SUN-5K-SG01HP3",
          confidence: { sn: 0.99, manufacturer: 0.96 }
        }, null, 2)
      },
      {
        user: "inversor FoxESS modelo T10-G3, serial number: FE240189012345, alarme 21 na rede",
        assistant: JSON.stringify({
          serial_number: "FE240189012345",
          manufacturer: "FoxESS",
          model: "T10-G3",
          problem: "Alarme 21 sobretensão de rede",
          confidence: { sn: 0.98, manufacturer: 0.99, equipment: 0.96 }
        }, null, 2)
      },
      {
        user: "Inversor Huawei SUN2000-10KTL-M1, S/N 2101072938102345, cliente Carlos Mendes tel (19) 98765-4321, ticket #SOL-9901.",
        assistant: JSON.stringify({
          customer: "Carlos Mendes",
          phone: "19987654321",
          serial_number: "2101072938102345",
          manufacturer: "Huawei",
          model: "SUN2000-10KTL-M1",
          protocol: "#SOL-9901",
          confidence: { sn: 0.99, manufacturer: 0.98, equipment: 0.97 }
        }, null, 2)
      },
      {
        user: "segue foto da etiqueta, SN 1234567890 do Solis S6 trifásico",
        assistant: JSON.stringify({
          serial_number: "1234567890",
          manufacturer: "Solis",
          model: "S6",
          confidence: { sn: 0.94, manufacturer: 0.95 }
        }, null, 2)
      },
      {
        user: "meu telefone é 11987654321 e o protocolo de atendimento é 123456, tensão medida em 220V e CEP 13000000",
        assistant: JSON.stringify({
          serial_number: null,
          phone: "11987654321",
          protocol: "123456",
          voltage: "220V",
          cep: "13000000",
          note: "No valid serial number present in message.",
          confidence: { sn: 0.0 }
        }, null, 2)
      }
    ];

    snConversationalExamples.forEach(ex => {
      dataset.push({
        messages: [
          { role: "system", content: "You are TARS contextual NER and Serial Number classification engine. Extract serial numbers, manufacturer, customer, and disambiguate from phones, protocols, CEPs, and voltages." },
          { role: "user", content: ex.user },
          { role: "assistant", content: ex.assistant }
        ]
      });
    });

    res.json({
      ok: true,
      count: dataset.length,
      dataset,
      jsonl: dataset.map(item => JSON.stringify(item)).join("\n"),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Extension Download ---
app.get(["/tars-vision-bridge.zip", "/api/download-extension"], (req, res) => {
  const zipPath = path.join(process.cwd(), "public", "tars-vision-bridge.zip");
  res.download(zipPath, "tars-vision-bridge.zip", (err) => {
    if (err) {
      res.status(404).send("Extension package not found");
    }
  });
});

// --- Health Check ---
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "Solar Agenda Full-Stack Server" });
});

// --- Vite Middleware / Static Serving ---
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Solar Agenda] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
