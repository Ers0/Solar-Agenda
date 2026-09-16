import express from "express";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { JiraService, JiraConfig, CreateJiraIssueParams } from "./server/jira";
import { runTARSIntakeDisambiguation } from "./server/tars-sn";
import {
  TARSCase,
  TARSObserverEvent,
  IngestEventsBatchPayload,
  getDefaultObserverCases,
  processObserverEventsBatch,
  exportLearningCandidatesJSONL,
  computeConfidenceLevel
} from "./server/tars-observer";

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
    const { to, cc, subject, text, html, smtpConfig, attachments } = req.body;

    if (!to) {
      return res.status(400).json({ ok: false, error: "Recipient ('to') email address is required." });
    }
    if (!subject) {
      return res.status(400).json({ ok: false, error: "Email subject is required." });
    }

    const transporter = getTransporter(smtpConfig);
    const fromAddr = smtpConfig?.from || smtpConfig?.user || process.env.SMTP_FROM || process.env.SMTP_USER;

    const mailOptions: any = {
      from: fromAddr ? `Solar Agenda <${fromAddr}>` : undefined,
      to,
      cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
      subject,
      text: text || undefined,
      html: html || (text ? `<div style="font-family: sans-serif; line-height: 1.6; color: #1f2937;">${String(text).replace(/\n/g, "<br/>")}</div>` : undefined),
    };

    if (Array.isArray(attachments) && attachments.length > 0) {
      mailOptions.attachments = attachments.map((att: any) => ({
        filename: att.filename || "technical-report.pdf",
        content: att.content,
        encoding: att.encoding || (typeof att.content === "string" && !att.path ? "base64" : undefined),
        contentType: att.contentType || "application/pdf",
      }));
    }

    const info = await transporter.sendMail(mailOptions);

    console.log("[SMTP] Email sent:", info.messageId, "to:", to, "cc:", cc || "none", "attachments:", mailOptions.attachments?.length || 0);
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
  return { 
    contacts: null, 
    smtpConfig: null, 
    slaCases: null, 
    jiraConfig: null, 
    jiraWebhookLogs: [], 
    slaWebhookLogs: [],
    tarsObserverCases: null,
    tarsProcessedEvents: []
  };
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
      tarsObserverCases: data.tarsObserverCases !== undefined ? data.tarsObserverCases : current.tarsObserverCases,
      tarsProcessedEvents: data.tarsProcessedEvents !== undefined ? data.tarsProcessedEvents : (current.tarsProcessedEvents || []),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(merged, null, 2), "utf-8");
    return merged;
  } catch (e) {
    console.warn("[Storage] Error writing app storage:", e);
    return null;
  }
}

// Helper to get active TARS Observer cases (with default seeds if empty)
function getObserverCases(): TARSCase[] {
  const storage = readAppStorage();
  if (Array.isArray(storage.tarsObserverCases) && storage.tarsObserverCases.length > 0) {
    return storage.tarsObserverCases;
  }
  const defaults = getDefaultObserverCases();
  writeAppStorage({ tarsObserverCases: defaults });
  return defaults;
}

function getProcessedEventIdsSet(): Set<string> {
  const storage = readAppStorage();
  const ids = Array.isArray(storage.tarsProcessedEvents) ? storage.tarsProcessedEvents : [];
  return new Set<string>(ids);
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

// --- API: TARS AI SLA Note Professional Rephraser ---
app.post("/api/sla-notes/rephrase", async (req, res) => {
  try {
    const body = req.body || {};
    const note = body.note || {};
    const caseItem = body.caseItem || body.case || {};
    const checklist = body.checklist || note.checklist || [];
    const measurements = body.measurements || note.measurements || {};
    const draftNotes = body.draftNotes || note.text || body.text || '';
    const category = body.category || note.category_label || note.category || 'Parecer de Engenharia SLA';
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Você é o TARS, assistente técnico e de engenharia especializado em sistemas solares fotovoltaicos, inversores de alta/baixa potência e garantias (Deye, Hoymiles, FoxESS, Huawei).
Reescreva e formate as anotações técnicas do técnico em um Laudo Técnico / Parecer de SLA formal, conciso, objetivo e conforme as normas técnicas ABNT NBR 16149 / NBR 16274 e requisitos dos fabricantes.

DADOS DO CASO:
- Caso ID: ${caseItem?.id || 'N/A'}
- Cliente: ${caseItem?.customer?.name || 'Cliente'}
- Equipamento: ${caseItem?.equipment?.manufacturer || ''} ${caseItem?.equipment?.model || ''}
- Número de Série: ${(caseItem?.equipment?.serial_numbers || []).join(', ') || 'N/A'}
- Falha Relatada: ${caseItem?.problem_summary || 'N/A'}
- Categoria da Nota: ${category || 'Diagnóstico Técnico'}

MEDIÇÕES REGISTRADAS:
- Tensão CA: ${measurements?.vac || 'Conforme padrão'}
- Tensão CC Strings: ${measurements?.vdc || 'Conforme arranjo'}
- Resistência Isolamento: ${measurements?.riso || '> 1 MΩ'}
- Código de Erro no Display: ${measurements?.errorCode || measurements?.error_code || 'Registrado'}

VERIFICAÇÕES CUMPRIDAS:
${Array.isArray(checklist) ? checklist.map((c: any) => typeof c === 'string' ? `- [X] ${c}` : `- [${c.checked ? 'X' : ' '}] ${c.label}`).join('\n') : 'Verificações padrão de campo executadas.'}

OBSERVAÇÕES DO TÉCNICO:
"${draftNotes || 'Verificações elétricas e inspeção física realizadas.'}"

INSTRUÇÕES:
Retorne um texto técnico estruturado e direto em Markdown com:
1. Resumo Executivo da Ocorrência
2. Medições e Ensaios em Conformidade
3. Parecer Técnico & Causa Raiz Provável
4. Ação Recomendada / Próximo Passo do SLA`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });
      const textOut = response.text || '';
      return res.json({ ok: true, rephrased: textOut, rephrasedText: textOut });
    } else {
      // Heuristic engineering standard formatting
      const checkedCount = Array.isArray(checklist) ? checklist.filter((c: any) => typeof c === 'string' || c.checked).length : 0;
      const totalCount = Array.isArray(checklist) ? checklist.length : 9;
      const fallback = `### PARECER TÉCNICO DE ENGENHARIA — ${caseItem?.id || 'SLA'}
**Equipamento:** ${caseItem?.equipment?.manufacturer || 'Fabricante'} ${caseItem?.equipment?.model || ''} (SN: ${(caseItem?.equipment?.serial_numbers || []).join(', ') || 'N/A'})
**Fase Operacional:** ${category || 'Diagnóstico Técnico em Campo'}
**Conformidade de Procedimentos:** ${checkedCount}/${totalCount} verificações obrigatórias validadas.

#### 1. Ensaios Elétricos e Medições de Campo
- **Tensão de Rede CA (Fase-Neutro):** ${measurements?.vac || '220V (Em conformidade com ABNT NBR 16149)'}
- **Tensão de Entrada CC (Strings):** ${measurements?.vdc || 'Compatível com a curva de operação do MPPT sob irradiação solar'}
- **Resistência de Isolamento (Riso):** ${measurements?.riso || '> 50 MΩ (Isolamento dielétrico aprovado)'}
- **Alarme no Display / App:** ${measurements?.errorCode || measurements?.error_code || 'Código de falha validado contra o manual de serviço'}

#### 2. Diagnóstico & Ações Executadas
${draftNotes || 'Realizada inspeção minuciosa dos cabos solares, aperto de terminais MC4 e validação de continuidade do aterramento e DPS. Sem indícios de sobretensão externa.'}

#### 3. Parecer & Próxima Ação do SLA
${caseItem?.next_action || 'Prosseguir com o acionamento do suporte técnico do fabricante ou homologação da solução com o cliente final.'}`;
      return res.json({ ok: true, rephrased: fallback, rephrasedText: fallback });
    }
  } catch (err: any) {
    console.error("[SLA Note Rephrase Error]", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to rephrase note." });
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

    const customerName = (customerObj.name || orgObj.name || payload.customerName || "Cliente Solar").trim();
    const customerEmail = (customerObj.email || accountObj.loginEmail || payload.email || "").trim();
    const customerPhone = (customerObj.phone || payload.phone || "").trim();
    const customerState = (customerObj.state || payload.state || "").trim();

    // Hyperflow specific fields
    const conversationUrl = (payload.conversationUrl || payload.conversationLink || payload.url || "").trim();
    const hyperflowProtocol = (payload.protocol || payload.hyperflowProtocol || (conversationId ? `HF-${conversationId.replace(/^hyperflow:/, '').slice(0, 8)}` : "")).trim();
    const isHyperflowEvent = eventType.startsWith("hyperflow") || !!conversationUrl || !!payload.protocol || !!payload.messages;

    const orgName = (orgObj.name || payload.company || "").trim();
    const parentOrg = (orgObj.parentOrganization || "APItest").trim();
    const orgRole = (orgObj.role || "Installer").trim();
    const loginEmail = (accountObj.loginEmail || customerEmail).trim().toLowerCase();

    console.info(`[SLA Webhook] Received event: ${eventType} for ${loginEmail || customerName || orgName} (source: ${source})`);

    const storage = readAppStorage();
    const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    let matchedCaseId: string | null = null;
    let isNewCase = false;

    // 1. Look for existing case matching caseId, conversationId, conversationUrl, email, phone, or SN
    const targetCaseId = (payload.caseId || payload.slaCaseId || "").trim();
    for (let i = 0; i < list.length; i++) {
      const c = { ...list[i] };
      const cEmail = (c.customer?.email || "").toLowerCase();
      const cPhone = (c.customer?.phone || "").replace(/\D/g, "");
      const searchPhone = customerPhone.replace(/\D/g, "");

      const matchesDirectId = Boolean(targetCaseId && c.id.toLowerCase() === targetCaseId.toLowerCase());
      const matchesProtocol = Boolean(
        hyperflowProtocol && (
          (c.protocols?.hyperflow_id && String(c.protocols.hyperflow_id).toLowerCase() === hyperflowProtocol.toLowerCase()) ||
          (c.protocols?.hyperflow?.protocol && String(c.protocols.hyperflow.protocol).toLowerCase() === hyperflowProtocol.toLowerCase()) ||
          (c.conversation?.protocol && String(c.conversation.protocol).toLowerCase() === hyperflowProtocol.toLowerCase())
        )
      );
      const matchesConv = Boolean(conversationId && (
        (c.protocols?.hyperflow_id && String(c.protocols.hyperflow_id).includes(conversationId)) ||
        (c.protocols?.hyperflow?.conversation_id === conversationId) ||
        (Array.isArray(c.protocols?.hyperflow) && c.protocols.hyperflow.includes(conversationId))
      ));
      const matchesConvUrl = Boolean(conversationUrl && (
        (c.protocols?.hyperflow_url && c.protocols.hyperflow_url === conversationUrl) ||
        (c.protocols?.hyperflow?.conversation_url === conversationUrl) ||
        (c.conversation?.conversation_url === conversationUrl)
      ));
      const matchesEmail = Boolean(loginEmail && cEmail && (cEmail === loginEmail));
      const matchesPhone = Boolean(searchPhone.length >= 8 && cPhone && (cPhone === searchPhone || cPhone.endsWith(searchPhone) || searchPhone.endsWith(cPhone)));
      const matchesHoymilesProto = Boolean(loginEmail && Array.isArray(c.protocols?.hoymiles) && c.protocols.hoymiles.some((h: any) => (h.account_email || "").toLowerCase() === loginEmail));

      if (matchesDirectId || matchesProtocol || matchesConv || matchesConvUrl || matchesEmail || matchesPhone || matchesHoymilesProto) {
        matchedCaseId = c.id;
        c.protocols = c.protocols || {};

        if (isHyperflowEvent) {
          // Hyperflow is a dedicated separate protocol with conversation link
          const protoCode = hyperflowProtocol || c.protocols.hyperflow_id || (conversationId ? `HF-${conversationId}` : "HF-AUTO");
          c.protocols.hyperflow = {
            protocol: protoCode,
            conversation_url: conversationUrl || c.protocols.hyperflow_url || (conversationId ? `https://conversas.hyperflow.global/chat/${conversationId}` : ""),
            conversation_id: conversationId || c.protocols.hyperflow?.conversation_id || "",
            status: "LINKED",
            synced_at: occurredAt,
            customer_name: customerName,
            customer_phone: customerPhone
          };
          c.protocols.hyperflow_id = protoCode;
          c.protocols.hyperflow_url = c.protocols.hyperflow.conversation_url;

          c.conversation = c.conversation || {};
          c.conversation.source = "Hyperflow";
          c.conversation.channel = "WhatsApp";
          c.conversation.conversation_url = c.protocols.hyperflow.conversation_url;
          c.conversation.protocol = protoCode;

          if (Array.isArray(payload.messages) && payload.messages.length > 0) {
            c.conversation.messages = payload.messages;
          }

          if (!Array.isArray(c.timeline)) c.timeline = [];
          c.timeline.push({
            id: `tl-hf-${Date.now()}`,
            type: "hyperflow_protocol_linked",
            title: `Protocolo Hyperflow Vinculado: ${protoCode}`,
            detail: `Conversa sincronizada via TARS Bridge. Link da Conversa: ${c.protocols.hyperflow.conversation_url || 'N/A'}. Total de mensagens: ${c.conversation.messages?.length || 0}.`,
            author: `TARS Vision Bridge v${bridgeVersion}`,
            timestamp: occurredAt
          });
        } else {
          // Hoymiles account event
          c.protocols.hoymiles = Array.isArray(c.protocols.hoymiles) ? [...c.protocols.hoymiles] : [];
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

          if (!Array.isArray(c.timeline)) c.timeline = [];
          c.timeline.push({
            id: `tl-wh-${Date.now()}`,
            type: "hoymiles_account_created",
            title: `Conta Hoymiles Criada: ${loginEmail}`,
            detail: `Conta de Instalador criada com sucesso no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Credenciais entregues via Hyperflow.`,
            author: `TARS Vision Bridge v${bridgeVersion}`,
            timestamp: occurredAt
          });

          if (["aberto", "em_analise", "aguardando_terceiros"].includes(c.status)) {
            c.status = "concluido";
            c.resolved_at = occurredAt;
          }
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

      if (isHyperflowEvent) {
        matchedCaseId = `SLA-HF-${caseNum}`;
        const protoCode = hyperflowProtocol || `HF-${caseNum}`;
        const hfUrl = conversationUrl || (conversationId ? `https://conversas.hyperflow.global/chat/${conversationId}` : "");

        const newCase = {
          id: matchedCaseId,
          title: `Atendimento Hyperflow — ${customerName}`,
          priority: payload.priority || "alta",
          status: payload.status || "aberto",
          created_at: occurredAt,
          updated_at: occurredAt,
          sla_deadline: new Date(Date.now() + 24 * 3600000).toISOString(),
          sla_limit_hours: 24,
          responsible_tech: "Suporte Solar (TARS Bridge)",
          customer: {
            name: customerName,
            email: customerEmail,
            phone: customerPhone,
            state: customerState,
            site_location: payload.site_location || ""
          },
          equipment: payload.equipment || {
            manufacturer: payload.manufacturer || "Inversor Solar",
            model: payload.model || "Equipamento em Diagnóstico",
            serial_numbers: payload.serial_number ? [payload.serial_number] : (payload.serial_numbers || [])
          },
          problem_summary: payload.problem_summary || (payload.messages?.[0]?.text ? `Conversa Hyperflow: ${payload.messages[0].text.slice(0, 180)}` : "Atendimento importado via TARS Bridge."),
          next_action: "Avaliar protocolo e histórico do cliente via conversa Hyperflow vinculada.",
          protocols: {
            hyperflow: {
              protocol: protoCode,
              conversation_url: hfUrl,
              conversation_id: conversationId,
              status: "LINKED",
              synced_at: occurredAt,
              customer_name: customerName,
              customer_phone: customerPhone
            },
            hyperflow_id: protoCode,
            hyperflow_url: hfUrl,
            jira: [],
            hoymiles: []
          },
          conversation: {
            source: "Hyperflow",
            channel: "WhatsApp",
            conversation_url: hfUrl,
            protocol: protoCode,
            messages: Array.isArray(payload.messages) ? payload.messages : []
          },
          timeline: [
            {
              id: `tl-hf-init-${Date.now()}`,
              type: "hyperflow_protocol_linked",
              title: `Caso Aberto via Hyperflow Protocol: ${protoCode}`,
              detail: `Atendimento recebido via TARS Bridge Webhook com link direto da conversa: ${hfUrl || 'N/A'}.`,
              author: `TARS Vision Bridge v${bridgeVersion}`,
              timestamp: occurredAt
            }
          ]
        };
        list.unshift(newCase);
      } else {
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

// GET /api/sla/webhook/logs (and alias /api/sla/logs) - Returns recent SLA webhook events
app.get(["/api/sla/webhook/logs", "/api/sla/logs"], (req, res) => {
  const storage = readAppStorage();
  res.json({ ok: true, logs: storage.slaWebhookLogs || [] });
});

// POST /api/sla/webhook/test (and alias /api/sla/test) - Simulates an SLA Webhook ping from TARS Vision Bridge
app.post(["/api/sla/webhook/test", "/api/sla/test"], async (req, res) => {
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

// =============================================================================
// TARS OBSERVER BACKEND & EVENT-SOURCED CASE ENGINE
// Passive Observer Mode (v1.2.81): Zero Customer Interaction Hard Safety Boundary
// Ingestion Endpoint: POST /api/tars/observer/events
// =============================================================================

// 1. Ingest Batched Events from TARS Vision Bridge
app.get("/api/tars/observer/events", (req, res) => {
  const currentCases = getObserverCases();
  return res.json({
    ok: true,
    service: "Solar Agenda TARS Observer Events API",
    status: "ACTIVE",
    mode: "PASSIVE_OBSERVER",
    safetyBoundary: "ZERO_CUSTOMER_INTERACTION_ENFORCED",
    endpoint: "/api/tars/observer/events",
    methods: ["POST", "GET"],
    casesCount: currentCases.length,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/tars/observer/events", async (req, res) => {
  try {
    const payload: IngestEventsBatchPayload = req.body || { events: [] };
    const version = payload.version || "1.0";
    const source = payload.source || "tars-vision-bridge";
    const bridgeVersion = payload.bridgeVersion || "1.2.81";

    if (!Array.isArray(payload.events)) {
      return res.status(400).json({ ok: false, error: "Invalid payload: 'events' array is required." });
    }

    const currentCases = getObserverCases();
    const processedSet = getProcessedEventIdsSet();

    const result = processObserverEventsBatch(payload, currentCases, processedSet);

    // Persist updated cases and tracked event IDs
    writeAppStorage({
      tarsObserverCases: result.updatedCases,
      tarsProcessedEvents: Array.from(processedSet).slice(-2000) // retain last 2000 event IDs for idempotency
    });

    console.log(`[TARS Observer] Ingested ${result.processedCount} events (${result.duplicateCount} duplicates skipped) from ${source} v${bridgeVersion}. Affected cases:`, result.affectedCaseIds);

    return res.json({
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
  } catch (err: any) {
    console.error("[TARS Observer Error]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. List Observer Cases (with filtering by status & query)
app.get("/api/tars/observer/cases", (req, res) => {
  try {
    const cases = getObserverCases();
    const { status, q } = req.query as { status?: string; q?: string };

    let filtered = [...cases];

    if (status && status !== "all") {
      if (status === "active") {
        filtered = filtered.filter(c => c.status !== "CLOSED" && c.status !== "RESOLVED");
      } else if (status === "closed") {
        filtered = filtered.filter(c => c.status === "CLOSED" || c.status === "RESOLVED");
      } else if (status === "human_review") {
        filtered = filtered.filter(c => c.status === "HUMAN_REVIEW" || c.needsHumanReview);
      } else if (status === "candidates") {
        filtered = filtered.filter(c => c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated);
      } else {
        filtered = filtered.filter(c => c.status.toLowerCase() === status.toLowerCase());
      }
    }

    if (q && q.trim()) {
      const term = q.trim().toLowerCase();
      filtered = filtered.filter(c => 
        (c.protocol && c.protocol.toLowerCase().includes(term)) ||
        (c.conversationId && c.conversationId.toLowerCase().includes(term)) ||
        (c.customer.name && c.customer.name.toLowerCase().includes(term)) ||
        (c.customer.phone && c.customer.phone.includes(term)) ||
        (c.equipment.manufacturer && c.equipment.manufacturer.toLowerCase().includes(term)) ||
        (c.equipment.model && c.equipment.model.toLowerCase().includes(term)) ||
        (c.equipment.sn && c.equipment.sn.toLowerCase().includes(term)) ||
        (c.finalDiagnosis && c.finalDiagnosis.toLowerCase().includes(term))
      );
    }

    return res.json({
      ok: true,
      count: filtered.length,
      cases: filtered,
      safetyBoundary: "PASSIVE_OBSERVER_ACTIVE"
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. Get Single Observer Case Deep-Dive
app.get("/api/tars/observer/cases/:caseId", (req, res) => {
  try {
    const cases = getObserverCases();
    const item = cases.find(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (!item) {
      return res.status(404).json({ ok: false, error: "Case not found." });
    }
    return res.json({ ok: true, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. Update Observer Case fields
app.patch("/api/tars/observer/cases/:caseId", (req, res) => {
  try {
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (idx < 0) {
      return res.status(404).json({ ok: false, error: "Case not found." });
    }

    const updates = req.body || {};
    const item = cases[idx];

    if (updates.status) item.status = updates.status;
    if (updates.equipment) item.equipment = { ...item.equipment, ...updates.equipment };
    if (updates.customer) item.customer = { ...item.customer, ...updates.customer };
    if (updates.finalDiagnosis !== undefined) item.finalDiagnosis = updates.finalDiagnosis;
    if (updates.finalResolution !== undefined) item.finalResolution = updates.finalResolution;
    if (updates.humanAnalysis) item.humanAnalysis = { ...item.humanAnalysis, ...updates.humanAnalysis };
    if (updates.learningMetadata) item.learningMetadata = { ...item.learningMetadata, ...updates.learningMetadata };
    if (updates.needsHumanReview !== undefined) item.needsHumanReview = Boolean(updates.needsHumanReview);

    item.updatedAt = new Date().toISOString();
    cases[idx] = item;
    writeAppStorage({ tarsObserverCases: cases });

    return res.json({ ok: true, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. Validate AI Observation
app.post("/api/tars/observer/cases/:caseId/validate-observation", (req, res) => {
  try {
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Case not found." });

    const { observationId, validated = true, validatedBy = "Técnico Solar" } = req.body || {};
    const item = cases[idx];
    const obs = item.aiObservations.find(o => o.id === observationId);
    if (!obs) return res.status(404).json({ ok: false, error: "Observation not found." });

    obs.isValidated = Boolean(validated);
    obs.validatedAt = new Date().toISOString();
    obs.validatedBy = validatedBy;

    // Check if all observations are validated
    const allValidated = item.aiObservations.every(o => o.isValidated);
    if (allValidated) {
      item.learningMetadata.isValidated = true;
      item.learningMetadata.validatedAt = new Date().toISOString();
      item.learningMetadata.validatedBy = validatedBy;
      item.needsHumanReview = false;
      if (item.status === "HUMAN_REVIEW") {
        item.status = "PROCESSING";
      }
    }

    item.timeline.push({
      id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      eventType: "OBSERVATION_VALIDATED",
      timestamp: new Date().toISOString(),
      title: `Observação Validada: ${obs.title}`,
      detail: `Técnico (${validatedBy}) confirmou a interpretação da IA como precisa e conforme.`,
      author: validatedBy
    });

    item.updatedAt = new Date().toISOString();
    cases[idx] = item;
    writeAppStorage({ tarsObserverCases: cases });

    return res.json({ ok: true, observation: obs, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 6. Correct AI Interpretation (Human Correction)
app.post("/api/tars/observer/cases/:caseId/correct-observation", (req, res) => {
  try {
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Case not found." });

    const { observationId, correctedValue, reason = "Correção técnica de campo", correctedBy = "Técnico Solar" } = req.body || {};
    const item = cases[idx];
    const obs = item.aiObservations.find(o => o.id === observationId);

    const originalText = obs ? obs.detail : "N/A";
    const correctionId = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const correctionItem = {
      id: correctionId,
      observationId,
      originalValue: originalText,
      correctedValue: String(correctedValue),
      correctedBy,
      timestamp: new Date().toISOString(),
      reason
    };

    item.humanCorrections.push(correctionItem);

    if (obs) {
      obs.humanCorrection = correctedValue;
      obs.isValidated = true;
      obs.validatedAt = new Date().toISOString();
      obs.validatedBy = correctedBy;
    }

    item.timeline.push({
      id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      eventType: "HUMAN_CORRECTION",
      timestamp: new Date().toISOString(),
      title: `Correção Humana Registrada (${correctedBy})`,
      detail: `De: "${originalText.slice(0, 80)}..." Para: "${correctedValue}". Motivo: ${reason}`,
      author: correctedBy
    });

    item.updatedAt = new Date().toISOString();
    cases[idx] = item;
    writeAppStorage({ tarsObserverCases: cases });

    return res.json({ ok: true, correction: correctionItem, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 7. Human Analysis for Media / Images / Videos
app.post("/api/tars/observer/cases/:caseId/human-analysis", (req, res) => {
  try {
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Case not found." });

    const { visualNotes, mediaEvaluation, technicianConclusion, updatedBy = "Técnico Solar" } = req.body || {};
    const item = cases[idx];

    item.humanAnalysis = {
      visualNotes: visualNotes !== undefined ? visualNotes : item.humanAnalysis.visualNotes,
      mediaEvaluation: mediaEvaluation !== undefined ? mediaEvaluation : item.humanAnalysis.mediaEvaluation,
      technicianConclusion: technicianConclusion !== undefined ? technicianConclusion : item.humanAnalysis.technicianConclusion,
      updatedAt: new Date().toISOString(),
      updatedBy
    };

    // If human analysis is documented, resolve human review flag
    if (visualNotes || technicianConclusion) {
      item.needsHumanReview = false;
      if (item.status === "HUMAN_REVIEW") {
        item.status = "PROCESSING";
      }
      item.confidence = Math.max(item.confidence, 0.88);
      item.confidenceLevel = computeConfidenceLevel(item.confidence);
    }

    item.timeline.push({
      id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      eventType: "HUMAN_MEDIA_ANALYSIS",
      timestamp: new Date().toISOString(),
      title: `Análise Humana de Mídia / Evidências (${updatedBy})`,
      detail: visualNotes ? `Notas visuais: ${visualNotes.slice(0, 120)}` : "Análise técnica concluída pelo especialista.",
      author: updatedBy
    });

    item.updatedAt = new Date().toISOString();
    cases[idx] = item;
    writeAppStorage({ tarsObserverCases: cases });

    return res.json({ ok: true, humanAnalysis: item.humanAnalysis, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 8. Close Case & optionally mark as Training Candidate
app.post("/api/tars/observer/cases/:caseId/close", (req, res) => {
  try {
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Case not found." });

    const {
      finalDiagnosis = "",
      finalResolution = "",
      markAsCandidate = false,
      candidateReason = "",
      tags = [],
      technician = "Técnico Solar"
    } = req.body || {};

    const item = cases[idx];
    item.status = "CLOSED";
    item.closedAt = new Date().toISOString();
    item.finalDiagnosis = finalDiagnosis || item.finalDiagnosis || "Atendimento concluído e resolvido.";
    item.finalResolution = finalResolution || item.finalResolution || "Procedimento técnico aplicado e validado com o cliente.";

    if (markAsCandidate) {
      item.learningMetadata = {
        isValidated: true,
        validatedAt: new Date().toISOString(),
        validatedBy: technician,
        isTrainingCandidate: true,
        candidateReason: candidateReason || "Caso exemplar de resolução e análise técnica",
        tags: Array.isArray(tags) && tags.length > 0 ? tags : (item.learningMetadata?.tags || ["solar", "resolved"])
      };
    }

    item.timeline.push({
      id: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      eventType: "CASE_CLOSED",
      timestamp: new Date().toISOString(),
      title: "Caso Fechado & Arquivado",
      detail: `Diagnóstico: ${item.finalDiagnosis}. Resolução: ${item.finalResolution}.${markAsCandidate ? " (Marcado como candidato a dataset de treinamento de IA)" : ""}`,
      author: technician
    });

    item.updatedAt = new Date().toISOString();
    cases[idx] = item;
    writeAppStorage({ tarsObserverCases: cases });

    return res.json({ ok: true, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 9. Mark / Unmark Case as Training Candidate
app.post("/api/tars/observer/cases/:caseId/candidate", (req, res) => {
  try {
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === req.params.caseId || c.protocol === req.params.caseId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Case not found." });

    const { isTrainingCandidate = true, candidateReason = "", tags = [] } = req.body || {};
    const item = cases[idx];

    item.learningMetadata.isTrainingCandidate = Boolean(isTrainingCandidate);
    if (candidateReason) item.learningMetadata.candidateReason = candidateReason;
    if (Array.isArray(tags) && tags.length > 0) item.learningMetadata.tags = tags;
    if (isTrainingCandidate) {
      item.learningMetadata.isValidated = true;
      item.learningMetadata.validatedAt = new Date().toISOString();
    }

    item.updatedAt = new Date().toISOString();
    cases[idx] = item;
    writeAppStorage({ tarsObserverCases: cases });

    return res.json({ ok: true, learningMetadata: item.learningMetadata, case: item });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 10. List Learning Candidates (Validated Closed Cases Pool)
app.get("/api/tars/learning/candidates", (req, res) => {
  try {
    const cases = getObserverCases();
    const candidates = cases.filter(c => c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated);
    return res.json({
      ok: true,
      count: candidates.length,
      candidates,
      info: "Casos validados armazenados separadamente para consumo do pipeline de aprendizado."
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 11. Export Learning Dataset (.JSONL)
app.get("/api/tars/learning/export", (req, res) => {
  try {
    const cases = getObserverCases();
    const jsonlContent = exportLearningCandidatesJSONL(cases);
    
    res.setHeader("Content-Disposition", "attachment; filename=\"tars-validated-cases.jsonl\"");
    res.setHeader("Content-Type", "application/x-jsonlines; charset=utf-8");
    return res.send(jsonlContent);
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 12. Helper Endpoint to Simulate Bridge Event for testing/demo
app.post("/api/tars/observer/simulate-event", (req, res) => {
  try {
    const {
      eventType = "HYPERFLOW_MESSAGE",
      text = "Cliente informa que inversor Deye SUN-8K está apresentando alarme F30 com 225 Vac.",
      protocol = "HF-3001",
      conversationId = "conv_sim_01",
      customerName = "João Instalador",
      manufacturer = "Deye",
      model = "SUN-8K",
      sn = "230499881122"
    } = req.body || {};

    const payload: IngestEventsBatchPayload = {
      version: "1.0",
      source: "tars-vision-bridge",
      bridgeVersion: "1.2.81",
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

    const currentCases = getObserverCases();
    const processedSet = getProcessedEventIdsSet();
    const result = processObserverEventsBatch(payload, currentCases, processedSet);

    writeAppStorage({
      tarsObserverCases: result.updatedCases,
      tarsProcessedEvents: Array.from(processedSet).slice(-2000)
    });

    return res.json({
      ok: true,
      simulated: true,
      affectedCaseIds: result.affectedCaseIds,
      cases: result.updatedCases
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
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
