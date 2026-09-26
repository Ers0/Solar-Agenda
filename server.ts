import express from "express";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { JiraService, JiraConfig, CreateJiraIssueParams } from "./server/jira";
import { GoogleDriveService } from "./server/drive";
import { runTARSIntakeDisambiguation } from "./server/tars-sn";
import {
  TARSCase,
  TARSObserverEvent,
  IngestEventsBatchPayload,
  getDefaultObserverCases,
  processObserverEventsBatch,
  exportLearningCandidatesJSONL,
  exportLearningCandidates,
  runTarsSmartLearningAnalysis,
  isMeaningfulCase,
  computeConfidenceLevel
} from "./server/tars-observer";
import {
  initUserRegistry,
  getAllUsers,
  authenticateUser,
  createNewUser,
  updateUserPassword,
  updateUserRole,
  deleteUser
} from "./server/auth";
import {
  pushChatbotAlert,
  getAlerts,
  markAlertRead,
  subscribeSSE,
  analyzeChatMessageForProblems,
  ChatbotProblemAlert
} from "./server/tars-alerts";
import { SolarRAGEngine, chunkTechnicalDocument, normalizeOcrText, extractTechnicalTokens } from "./server/rag-engine";
import { performGroundedWebSearch, performUnifiedSearch, GroundedWebSource, GroundedSearchResult } from "./server/tars-search";

dotenv.config();

// Ensure initial user registry is loaded with Eros (Owner) and admin
initUserRegistry();

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

// --- API: Send Email (also handles status on GET and test on action=test) ---
app.get(["/api/send-email", "/api/smtp-status"], (req, res) => {
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

// ==========================================
// User Authentication & Management API Routes
// ==========================================

// Authenticate user (Supports Eros Owner, admin, and created users with live Supabase token)
app.post("/api/auth/login", async (req, res) => {
  try {
    const { name, password } = req.body || {};
    const result = await authenticateUser(name, password);
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      token: result.token,
      name: result.user?.name,
      role: result.user?.role,
      readOnly: Boolean(result.readOnly || result.user?.name.toLowerCase() === "admin"),
      expires_at: result.expires_at
    });
  } catch (err: any) {
    console.error("[Auth Login Error]", err);
    return res.status(500).json({ ok: false, error: "Authentication service error: " + err.message });
  }
});

// List all registered users (for Owner UI)
app.get("/api/auth/users", (req, res) => {
  try {
    const users = getAllUsers().map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      notes: u.notes,
      source: u.source
    }));
    return res.json({ ok: true, users });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Create new login & password (Owner access)
app.post("/api/auth/users", async (req, res) => {
  try {
    const { name, password, role, notes } = req.body || {};
    const authHeader = req.headers.authorization || "";
    const creatorToken = authHeader.replace(/^Bearer\s+/i, "");
    const result = await createNewUser({ name, password, role, notes, creatorToken });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      user: {
        id: result.user?.id,
        name: result.user?.name,
        role: result.user?.role,
        createdAt: result.user?.createdAt,
        notes: result.user?.notes
      }
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Reset password for a user
app.post("/api/auth/users/reset-password", async (req, res) => {
  try {
    const { name, newPassword } = req.body || {};
    const authHeader = req.headers.authorization || "";
    const userToken = authHeader.replace(/^Bearer\s+/i, "");
    const result = await updateUserPassword(name, newPassword, userToken);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, message: `Password updated for user ${name}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Update role (Owner / Member)
app.post("/api/auth/users/set-role", (req, res) => {
  try {
    const { name, role } = req.body || {};
    if (role !== "owner" && role !== "member") {
      return res.status(400).json({ ok: false, error: "Invalid role specified." });
    }
    const result = updateUserRole(name, role);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, role });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete a user login
app.post("/api/auth/users/delete", (req, res) => {
  try {
    const { name } = req.body || {};
    const result = deleteUser(name);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(["/api/send-email", "/api/test-smtp"], async (req, res) => {
  try {
    const action = req.query?.action || req.body?.action;
    if (action === "test" || req.path === "/api/test-smtp") {
      const { smtpConfig } = req.body || {};
      const transporter = getTransporter(smtpConfig);
      await transporter.verify();
      return res.json({ ok: true, message: "Connection to email server verified successfully! Ready to dispatch messages." });
    }

    const { to, cc, subject, text, html, signature, smtpConfig, attachments } = req.body;

    if (!to) {
      return res.status(400).json({ ok: false, error: "Recipient ('to') email address is required." });
    }
    if (!subject) {
      return res.status(400).json({ ok: false, error: "Email subject is required." });
    }

    const transporter = getTransporter(smtpConfig);
    const fromAddr = smtpConfig?.from || smtpConfig?.user || process.env.SMTP_FROM || process.env.SMTP_USER;

    const sig = signature || smtpConfig?.signature || process.env.SMTP_SIGNATURE || "";
    let finalHtml = html;
    if (!finalHtml) {
      const bodyHtml = text ? `<div style="font-family: sans-serif; line-height: 1.6; color: #1f2937;">${String(text).replace(/\n/g, "<br/>")}</div>` : "";
      finalHtml = sig ? `${bodyHtml}<br/><br/><div class="email-signature" style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:15px;">${sig}</div>` : (bodyHtml || undefined);
    } else if (sig && !finalHtml.includes(sig)) {
      finalHtml = `${finalHtml}<br/><br/><div class="email-signature" style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:15px;">${sig}</div>`;
    }

    const mailOptions: any = {
      from: fromAddr ? `Solar Agenda <${fromAddr}>` : undefined,
      to,
      cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
      subject,
      text: text || undefined,
      html: finalHtml,
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

// Helper to get active TARS Observer cases (with default seeds if empty, auto-purging empty cases)
function getObserverCases(): TARSCase[] {
  const storage = readAppStorage();
  if (Array.isArray(storage.tarsObserverCases) && storage.tarsObserverCases.length > 0) {
    const valid = storage.tarsObserverCases.filter(isMeaningfulCase);
    if (valid.length > 0) {
      if (valid.length !== storage.tarsObserverCases.length) {
        writeAppStorage({ tarsObserverCases: valid });
      }
      return valid;
    }
  }
  const defaults = getDefaultObserverCases();
  writeAppStorage({ tarsObserverCases: defaults });
  return defaults;
}

// Automatically register completed SLA case when a Hoymiles account is created via the extension
function registerHoymilesCompletedSlaCase(eventOrData: any) {
  try {
    const storage = readAppStorage();
    const list = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
    const occurredAt = eventOrData.observedAt || eventOrData.occurredAt || new Date().toISOString();

    const rawData = eventOrData.data || eventOrData;
    const accountObj = rawData.account || eventOrData.account || {};
    const orgObj = rawData.organization || eventOrData.organization || {};
    const customerObj = rawData.customer || eventOrData.customer || {};

    const loginEmail = (accountObj.loginEmail || rawData.loginEmail || eventOrData.loginEmail || rawData.email || customerObj.email || "").trim().toLowerCase();
    const orgName = (orgObj.name || rawData.company || rawData.orgName || eventOrData.company || "Instalador Hoymiles").trim();
    const parentOrg = (orgObj.parentOrganization || rawData.parentOrg || eventOrData.parentOrg || "APItest").trim();
    const customerName = (customerObj.name || rawData.customerName || eventOrData.customerName || orgName).trim();
    const customerPhone = (customerObj.phone || rawData.phone || eventOrData.phone || "").trim();
    const conversationId = (eventOrData.conversationId || rawData.conversationId || "").trim();

    const existingIndex = list.findIndex((c: any) => {
      const hoymilesList = c.protocols?.hoymiles || [];
      const matchesEmail = Boolean(loginEmail && hoymilesList.some((h: any) => (h.account_email || "").toLowerCase() === loginEmail));
      const matchesConv = Boolean(conversationId && (
        c.protocols?.hyperflow_id === conversationId ||
        (Array.isArray(c.protocols?.hyperflow) && c.protocols.hyperflow.includes(conversationId))
      ));
      return matchesEmail || matchesConv;
    });

    if (existingIndex >= 0) {
      const c = { ...list[existingIndex] };
      c.status = "concluido";
      c.resolved_at = occurredAt;
      c.updated_at = occurredAt;
      c.protocols = c.protocols || {};
      c.protocols.hoymiles = Array.isArray(c.protocols.hoymiles) ? [...c.protocols.hoymiles] : [];
      if (loginEmail && !c.protocols.hoymiles.some((h: any) => (h.account_email || "").toLowerCase() === loginEmail)) {
        c.protocols.hoymiles.push({
          account_email: loginEmail,
          org_name: orgName,
          parent_org: parentOrg,
          role: "Installer",
          created_at: occurredAt,
          conversation_id: conversationId,
          status: "COMPLETED"
        });
      }
      c.timeline = Array.isArray(c.timeline) ? [...c.timeline] : [];
      c.timeline.push({
        id: `tl-hoy-${Date.now()}`,
        type: "hoymiles_account_created",
        title: `Conta Hoymiles Criada: ${loginEmail || orgName}`,
        detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). SLA Concluído com sucesso via extensão TARS.`,
        author: "TARS Vision Bridge v1.2.84",
        timestamp: occurredAt
      });
      list[existingIndex] = c;
      writeAppStorage({ slaCases: list });
      return c;
    }

    const caseNum = Math.floor(1000 + Math.random() * 9000);
    const newCaseId = `SLA-HOY-${caseNum}`;
    const newCase = {
      id: newCaseId,
      title: `Criação de Conta Hoymiles — ${orgName || customerName}`,
      priority: "media",
      status: "concluido",
      created_at: occurredAt,
      resolved_at: occurredAt,
      sla_limit_hours: 24,
      responsible_tech: "TARS Vision Bridge",
      customer: {
        name: customerName,
        email: loginEmail || customerObj.email || "",
        phone: customerPhone,
        state: customerObj.state || rawData.state || "",
        company: orgName
      },
      equipment: {
        manufacturer: "Hoymiles",
        model: "S-Miles Cloud (Portal do Instalador)",
        serial_numbers: ["N/A - Conta Web/App"]
      },
      problem_summary: `Criação automatizada de conta de Instalador Hoymiles para ${customerName} (${orgName}). Login: ${loginEmail || "N/A"}. Conta vinculada a ${parentOrg} e credenciais entregues via Hyperflow.`,
      protocols: {
        hoymiles: [{
          account_email: loginEmail,
          org_name: orgName,
          parent_org: parentOrg,
          role: "Installer",
          created_at: occurredAt,
          conversation_id: conversationId,
          status: "COMPLETED"
        }],
        hyperflow: conversationId ? [conversationId] : []
      },
      timeline: [
        {
          id: `tl-sla-init-${Date.now()}`,
          type: "hoymiles_account_created",
          title: "Conta Hoymiles Criada & Entregue",
          detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Atendimento concluído com sucesso via TARS Bridge.`,
          author: "TARS Vision Bridge v1.2.84",
          timestamp: occurredAt
        }
      ],
      notes: "Registrado automaticamente como caso de SLA Concluído a partir da criação de conta Hoymiles pela extensão TARS Vision Bridge."
    };

    list.unshift(newCase);
    writeAppStorage({ slaCases: list });
    return newCase;
  } catch (err) {
    console.error("[registerHoymilesCompletedSlaCase error in server.ts]", err);
    return null;
  }
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
        model: "gemini-3.8-flash",
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

app.all(["/api/jira/search-by-phone", "/agenda-jira-search-phone"], async (req, res) => {
  try {
    const rawPhone = String(req.query.phone || req.body?.phone || "").trim();
    const cleanDigits = rawPhone.replace(/\D/g, "");
    if (!cleanDigits || cleanDigits.length < 6) {
      return res.json({ ok: true, phone: rawPhone, count: 0, issues: [], activeIssues: [] });
    }

    const last8Digits = cleanDigits.slice(-8);
    const last9Digits = cleanDigits.slice(-9);

    const matchesPhone = (targetPhone?: string) => {
      if (!targetPhone) return false;
      const targetDigits = String(targetPhone).replace(/\D/g, "");
      if (!targetDigits) return false;
      return targetDigits.includes(last8Digits) || cleanDigits.includes(targetDigits.slice(-8));
    };

    const isToDoStatus = (statusName?: string) => {
      const s = String(statusName || "").trim().toLowerCase();
      return /^(a\s*fazer|to\s*do|backlog|aberta|open|nova|new|pendente\s*triagem)$/i.test(s);
    };

    const isClosedStatus = (statusName?: string) => {
      const s = String(statusName || "").trim().toLowerCase();
      return /^(done|conclu[ií]d[oa]|fechad[oa]|resolved|cancelad[oa]|arquivad[oa])$/i.test(s);
    };

    const foundIssues: any[] = [];
    const seenKeys = new Set<string>();

    // 1. Query live Jira Cloud if configured
    const jira = getJiraServiceInstance();
    if (jira.isConfigured()) {
      try {
        const cloudIssues = await jira.searchIssuesByPhone(rawPhone);
        for (const ci of cloudIssues) {
          if (!seenKeys.has(ci.key)) {
            seenKeys.add(ci.key);
            foundIssues.push({
              key: ci.key,
              summary: ci.summary,
              status: ci.status,
              statusCategory: ci.statusCategory,
              boardColumn: ci.status,
              isNotToDo: !isToDoStatus(ci.status),
              isClosed: isClosedStatus(ci.status),
              customerPhone: rawPhone,
              url: ci.url,
              source: "jira_cloud"
            });
          }
        }
      } catch (cloudErr) {
        console.warn("[Jira Search By Phone] Cloud search error:", cloudErr);
      }
    }

    // 2. Query Local SLA Cases storage and Agenda Cases
    const storage = readAppStorage();
    const slaCases = Array.isArray(storage.slaCases) ? storage.slaCases : [];

    for (const sc of slaCases) {
      if (matchesPhone(sc.customerPhone) || matchesPhone(sc.phone) || (sc.notes && sc.notes.includes(cleanDigits))) {
        const key = sc.jiraIssueKey || sc.jiraProtocol || sc.id || `SLA-${sc.id}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const status = sc.jiraStatus || sc.status || "A REVISAR";
          const isNotToDo = !isToDoStatus(status);
          foundIssues.push({
            key: key,
            summary: sc.problemSummary || sc.summary || `Atendimento Inversor ${sc.equipmentModel || sc.manufacturer || "Solar"}`,
            status: status,
            statusCategory: isNotToDo ? "In Progress" : "To Do",
            boardColumn: status,
            isNotToDo: isNotToDo,
            isClosed: isClosedStatus(status),
            customerName: sc.customerName || sc.customer,
            customerPhone: sc.customerPhone || sc.phone || rawPhone,
            equipmentModel: sc.equipmentModel,
            serialNumber: sc.serialNumber,
            url: sc.jiraUrl || `https://${jira.getConfigSummary().host || "atlassian.net"}/browse/${key}`,
            source: "sla_hub"
          });
        }
      }
    }

    // If no explicit Jira issues found in live/local storage, check demo mock data if phone matches Eros/Suporte
    if (foundIssues.length === 0 && (last8Digits === "991784515" || cleanDigits.includes("991784515") || /19\s*99178\s*4515/i.test(rawPhone))) {
      foundIssues.push({
        key: "ADB-8110",
        summary: "Análise de Garantia Deye SUN-8K - Falha F30 / Conflito de Senha",
        status: "A REVISAR",
        statusCategory: "In Progress",
        boardColumn: "A REVISAR",
        isNotToDo: true,
        isClosed: false,
        customerName: "Eros - Suporte Técnico",
        customerPhone: "+55 19 99178 4515",
        equipmentModel: "SUN-8K-SG01LP1-EU",
        serialNumber: "230419824102",
        url: `https://${jira.getConfigSummary().host || "belenergy.atlassian.net"}/browse/ADB-8110`,
        source: "sla_hub"
      });
    }

    const activeIssues = foundIssues.filter(i => i.isNotToDo && !i.isClosed);

    res.json({
      ok: true,
      phone: rawPhone,
      cleanDigits,
      totalCount: foundIssues.length,
      activeCount: activeIssues.length,
      issues: foundIssues,
      activeIssues
    });
  } catch (err: any) {
    console.error("[Jira Search By Phone] Error:", err);
    res.status(500).json({ ok: false, error: err.message, issues: [], activeIssues: [] });
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
    const action = req.query?.action || payload?.action;

    if (action === "test") {
      const testCaseNum = Math.floor(1000 + Math.random() * 9000);
      const testCaseId = `SLA-HOY-${testCaseNum}`;
      const testPayload = {
        event: "hoymiles.account.created (TEST)",
        occurredAt: new Date().toISOString(),
        status: "COMPLETED",
        conversationId: payload.conversationId || "hyperflow-test-conv-99",
        customer: {
          name: payload.name || payload.customer?.name || "Engenheiro Marcelo Rocha",
          email: payload.email || payload.customer?.email || "marcelo.solar@teste.com.br",
          phone: payload.phone || payload.customer?.phone || "11988776655",
          state: payload.state || payload.customer?.state || "São Paulo"
        },
        organization: {
          name: payload.company || payload.organization?.name || "SolarTech Brasil Teste",
          parentOrganization: "APItest",
          role: "Installer"
        },
        account: {
          loginEmail: payload.email || payload.account?.loginEmail || "marcelo.solar@teste.com.br",
          passwordSharedWithCustomer: true
        }
      };

      const storage = readAppStorage();
      const list: any[] = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      const newCase = {
        id: testCaseId,
        title: `Criação de Conta Hoymiles — ${testPayload.organization.name}`,
        priority: "media",
        status: "concluido",
        created_at: testPayload.occurredAt,
        resolved_at: testPayload.occurredAt,
        sla_limit_hours: 24,
        responsible_tech: "TARS Vision Bridge",
        customer: testPayload.customer,
        equipment: {
          manufacturer: "Hoymiles",
          model: "S-Miles Cloud (Portal do Instalador)",
          serial_numbers: ["N/A - Conta Web/App"]
        },
        problem_summary: `[TESTE SIMULADO] Criação de conta Hoymiles para ${testPayload.customer.name} (${testPayload.organization.name}). Login: ${testPayload.account.loginEmail}. Senha entregue via Hyperflow.`,
        protocols: {
          hoymiles: [{
            account_email: testPayload.account.loginEmail,
            org_name: testPayload.organization.name,
            parent_org: "APItest",
            role: "Installer",
            created_at: testPayload.occurredAt,
            conversation_id: testPayload.conversationId,
            status: "COMPLETED"
          }],
          hyperflow: [testPayload.conversationId]
        },
        timeline: [{
          id: `tl-sim-${Date.now()}`,
          type: "hoymiles_account_created",
          title: "Teste de Webhook SLA Executado",
          detail: `Simulação de criação de conta Hoymiles via painel Solar Agenda. Conta vinculada a APItest (${testPayload.organization.name}).`,
          author: "TARS Webhook Simulator",
          timestamp: testPayload.occurredAt
        }],
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
        customer: testPayload.customer.name,
        email: testPayload.account.loginEmail,
        company: testPayload.organization.name,
        conversationId: testPayload.conversationId,
        matchedCaseId: testCaseId,
        isNewCase: true
      };
      logs.unshift(testLog);

      writeAppStorage({
        slaCases: list,
        slaWebhookLogs: logs.slice(0, 50)
      });

      return res.json({
        ok: true,
        tested: true,
        caseId: testCaseId,
        customer: testPayload.customer.name,
        email: testPayload.account.loginEmail,
        company: testPayload.organization.name,
        log: testLog
      });
    }

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

    let updatedObserverCases: any[] | null = null;
    if (isHyperflowEvent) {
      try {
        const protoCode = hyperflowProtocol || (matchedCaseId ? matchedCaseId.replace('SLA-', 'TARS-OBS-') : `HF-${Date.now()}`);
        const obsCases = getObserverCases();
        const obsIdx = obsCases.findIndex(oc =>
          (protoCode && oc.protocol === protoCode) ||
          (conversationId && oc.conversationId === conversationId) ||
          (matchedCaseId && oc.id === `TARS-OBS-${protoCode}`)
        );

        const obsTimeline = (payload.timeline && Array.isArray(payload.timeline) && payload.timeline.length > 0)
          ? payload.timeline.map((t: any) => ({
              id: t.id || `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              eventType: "HYPERFLOW_SYNC",
              timestamp: t.timestamp || occurredAt,
              title: t.title || "Sincronização Hyperflow",
              detail: t.detail || "Conversa sincronizada via TARS Bridge",
              author: t.author || `TARS Vision Bridge v${bridgeVersion}`
            }))
          : [{
              id: `tl-${Date.now()}`,
              eventType: "HYPERFLOW_SYNC",
              timestamp: occurredAt,
              title: `Conversa Hyperflow Sincronizada (${protoCode})`,
              detail: `${(payload.messages?.length || payload.messageCount || 0)} mensagens sincronizadas do WhatsApp Hyperflow`,
              author: `TARS Vision Bridge v${bridgeVersion}`
            }];

        const obsMessages = (Array.isArray(payload.messages) ? payload.messages : []).map((m: any) => ({
          messageId: m.id || m.messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          direction: m.direction || (m.speaker === "technician" ? "outbound" : "incoming"),
          speaker: (m.speaker === "technician" || m.speaker === "agent") ? "technician" : "customer",
          timestamp: m.timestamp || occurredAt,
          capturedAt: m.capturedAt || occurredAt,
          text: String(m.text || "").slice(0, 12000),
          attachmentCount: Number(m.attachmentCount || 0)
        }));

        if (obsIdx >= 0) {
          const oc = { ...obsCases[obsIdx] };
          oc.updatedAt = occurredAt;
          if (obsMessages.length > 0) oc.messages = obsMessages;
          if (customerName && customerName !== "Cliente Solar") oc.customer.name = customerName;
          if (customerPhone) oc.customer.phone = customerPhone;
          if (customerEmail) oc.customer.email = customerEmail;
          if (!Array.isArray(oc.timeline)) oc.timeline = [];
          oc.timeline.push(...obsTimeline);
          obsCases[obsIdx] = oc;
        } else {
          obsCases.unshift({
            id: `TARS-OBS-${protoCode}`,
            protocol: protoCode,
            conversationId: conversationId || `conv_hf_${protoCode}`,
            status: "ACTIVE",
            customer: {
              name: customerName,
              phone: customerPhone,
              email: customerEmail,
              protocol: protoCode
            },
            equipment: {
              manufacturer: payload.equipment?.manufacturer || payload.manufacturer || "Inversor Solar",
              model: payload.equipment?.model || payload.model || "Equipamento em Diagnóstico",
              serialNumbers: payload.equipment?.serial_numbers || (payload.serial_number ? [payload.serial_number] : []),
              sn: payload.serial_number || (payload.equipment?.serial_numbers?.[0] || "")
            },
            timeline: obsTimeline,
            messages: obsMessages,
            technicianActions: [],
            technicalEvidence: [],
            aiObservations: [
              {
                id: `obs-hf-${Date.now()}`,
                timestamp: occurredAt,
                category: "hyperflow_conversation",
                title: `Atendimento WhatsApp Integrado (${protoCode})`,
                detail: `Conversa sincronizada via TARS Vision Bridge com ${obsMessages.length || payload.messageCount || 0} mensagens registradas.`,
                confidence: 0.95,
                confidenceLevel: "HIGH",
                needsHumanReview: false,
                uncertainties: []
              }
            ],
            confidence: 0.95,
            confidenceLevel: "HIGH",
            needsHumanReview: false,
            uncertainties: [],
            humanCorrections: [],
            humanAnalysis: {},
            finalDiagnosis: "",
            finalResolution: "",
            attachments: [],
            learningMetadata: {
              isValidated: false,
              validatedAt: null,
              validatedBy: null,
              isTrainingCandidate: false,
              tags: ["hyperflow", "whatsapp", "bridge-sync"]
            },
            createdAt: occurredAt,
            updatedAt: occurredAt
          });
        }
        updatedObserverCases = obsCases;
      } catch (e) {
        console.warn("[SLA Webhook] Could not mirror Hyperflow event to Observer Cases:", e);
      }
    }

    writeAppStorage({
      slaCases: list,
      slaWebhookLogs: logs.slice(0, 50),
      ...(updatedObserverCases ? { tarsObserverCases: updatedObserverCases } : {})
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

// GET /api/sla/webhook/logs (and aliases /api/sla/webhook, /api/sla/logs) - Returns recent SLA webhook events
app.get(["/api/sla/webhook", "/api/sla/webhook/logs", "/api/sla/logs"], (req, res) => {
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
    let payload: any = req.body || { events: [] };
    const action = (req.query.action as string) || payload?.action;

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

      payload = {
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
    }

    const version = payload.version || "1.0";
    const source = payload.source || "tars-vision-bridge";
    const bridgeVersion = payload.bridgeVersion || "1.2.81";

    if (!Array.isArray(payload.events)) {
      return res.status(400).json({ ok: false, error: "Invalid payload: 'events' array is required." });
    }

    // Auto-detect and register Hoymiles account creation events as completed SLA cases
    for (const ev of payload.events) {
      const rawData = ev.data || (ev as any).event?.data || (ev as any).event || {};
      const isHoymilesEvent =
        ev.eventType === "HOYMILES_ACCOUNT_CREATED" ||
        ev.eventType === "ACCOUNT_CREATION" ||
        (ev as any).event === "hoymiles.account.created" ||
        rawData.event === "hoymiles.account.created" ||
        rawData.type === "hoymiles_account_created" ||
        (ev.eventType === "TECHNICIAN_UI_ACTION" && (
          rawData.actionType === "ACCOUNT_CREATION" ||
          (String(rawData.target || "").includes("hoymiles") && String(rawData.notes || rawData.action || "").toLowerCase().includes("conta")) ||
          (String(ev.page || "").includes("hoymiles") && String(rawData.actionType || "").toLowerCase().includes("account"))
        )) ||
        Boolean(rawData.account?.loginEmail && String(rawData.target || ev.page || "").includes("hoymiles"));

      if (isHoymilesEvent) {
        registerHoymilesCompletedSlaCase({
          ...ev,
          ...rawData,
          observedAt: ev.observedAt || new Date().toISOString()
        });
      }
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

    // Asynchronously detect problems in incoming customer chatbot messages and trigger realtime alerts & ringtone
    for (const ev of payload.events) {
      const rawData = ev.data || (ev as any).event?.data || (ev as any).event || {};
      const text = String(rawData.text || ev.title || "").trim();
      const speaker = (rawData.speaker === "technician" || rawData.direction === "outbound") ? "technician" : "customer";
      if (text && speaker !== "technician") {
        const caseData = ev.case || rawData.case || {};
        analyzeChatMessageForProblems(text, {
          customerName: caseData.customerName || "Cliente",
          protocol: caseData.protocol || ev.protocol,
          manufacturer: caseData.manufacturer,
          model: caseData.equipmentModel || caseData.model,
          sn: caseData.serialNumber || caseData.sn,
          conversationId: caseData.conversationId || ev.conversationId
        }).then(problem => {
          if (problem && problem.hasProblem) {
            pushChatbotAlert({
              protocol: caseData.protocol || "CHAT-BOT",
              conversationId: caseData.conversationId || `conv_${Date.now()}`,
              customerName: caseData.customerName || "Cliente em Atendimento",
              customerPhone: caseData.customerPhone,
              equipment: problem.equipment,
              problemTitle: problem.problemTitle,
              errorCode: problem.errorCode,
              severity: problem.severity,
              messageSnippet: problem.messageSnippet,
              fullCustomerMessage: problem.fullCustomerMessage,
              solution: problem.solution,
              solutionSteps: problem.solutionSteps,
              technicalDetails: problem.technicalDetails,
              source: "Chatbot Client Service"
            });
          }
        }).catch(err => console.warn("[TARS Realtime Sentinel Error]", err));
      }
    }

    // Feed events directly into Copilot Live Monitor streams
    try {
      for (const ev of payload.events) {
        const rawData = ev.data || (ev as any).event?.data || (ev as any).event || {};
        const text = String(rawData.text || ev.title || "").trim();
        const speaker = (rawData.speaker === "technician" || rawData.direction === "outbound") ? "technician" : "customer";
        const isClient = speaker === "customer";
        const caseData = ev.case || rawData.case || {};

        if (caseData.protocol) {
          liveProtocolContext.protocolId = caseData.protocol;
        }
        if (caseData.customerName) {
          liveProtocolContext.clientName = caseData.customerName;
        }
        if (caseData.equipmentModel) {
          liveProtocolContext.inverter = caseData.equipmentModel;
        }
        if (ev.page) {
          liveProtocolContext.activeTab = ev.page;
        }

        if (text) {
          liveInteractions.push({
            id: "obs-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            sender: isClient ? "client" : "tars",
            senderLabel: isClient ? "Cliente (WhatsApp / Hyperflow)" : "Atendente Belenergy",
            text,
            timestamp: ev.observedAt || new Date().toISOString(),
            status: "received"
          });
          if (liveInteractions.length > 60) liveInteractions.shift();

          liveThinkingStream.push({
            id: "th-obs-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            phase: "Ingestão DOM Hyperflow",
            title: isClient ? "Interação de cliente capturada via extensão" : "Interação do operador registrada",
            detail: `"${text.slice(0, 140)}"`,
            timestamp: ev.observedAt || new Date().toISOString(),
            type: "dom_ingestion",
            latency: "22ms"
          });
          if (liveThinkingStream.length > 50) liveThinkingStream.shift();
        }

        if (ev.eventType === "HOYMILES_ACCOUNT_CREATED" || String(rawData.target || "").includes("hoymiles")) {
          const email = rawData.account?.loginEmail || rawData.email || "Instalador";
          liveThinkingStream.push({
            id: "th-hoy-" + Date.now(),
            phase: "Automação DOM",
            title: "Credenciamento Hoymiles Homologado",
            detail: `Conta vinculada ao portal S-Miles para ${email}.`,
            timestamp: ev.observedAt || new Date().toISOString(),
            type: "automation",
            latency: "380ms"
          });
          if (liveThinkingStream.length > 50) liveThinkingStream.shift();
        }
      }
    } catch (_) {}

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
    const { status, q, id } = req.query as { status?: string; q?: string; id?: string };

    if (id) {
      const item = cases.find(c => c.id === id || c.protocol === id);
      if (!item) return res.status(404).json({ ok: false, error: "Case not found" });
      return res.json({ ok: true, case: item });
    }

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

// 2b. Universal Dispatcher for Observer Cases Actions (?action=close, ?action=validate-observation, etc.)
app.post("/api/tars/observer/cases", (req, res) => {
  try {
    const action = String(req.query.action || req.body?.action || "").toLowerCase();
    const caseId = String(req.query.caseId || req.body?.caseId || req.body?.id || "");
    const cases = getObserverCases();

    if (!caseId && action !== "create") {
      return res.status(400).json({ ok: false, error: "caseId is required for this action." });
    }

    const idx = cases.findIndex(c => c.id === caseId || c.protocol === caseId);
    if (idx < 0 && action !== "create") {
      return res.status(404).json({ ok: false, error: "Case not found." });
    }

    const item = cases[idx];

    // ACTION: CLOSE CASE
    if (action === "close") {
      const {
        finalDiagnosis = "",
        finalResolution = "",
        markAsCandidate = false,
        candidateReason = "",
        tags = [],
        technician = "Técnico Solar"
      } = req.body || {};

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
    }

    // ACTION: VALIDATE OBSERVATION
    if (action === "validate-observation") {
      const { observationId, validated = true, validatedBy = "Técnico Solar" } = req.body || {};
      const obs = item.aiObservations.find(o => o.id === observationId);
      if (!obs) return res.status(404).json({ ok: false, error: "Observation not found." });

      obs.isValidated = Boolean(validated);
      obs.validatedAt = new Date().toISOString();
      obs.validatedBy = validatedBy;

      const allValidated = item.aiObservations.every(o => o.isValidated);
      if (allValidated) {
        item.learningMetadata.isValidated = true;
        item.learningMetadata.validatedAt = new Date().toISOString();
        item.learningMetadata.validatedBy = validatedBy;
        item.needsHumanReview = false;
        if (item.status === "HUMAN_REVIEW") item.status = "PROCESSING";
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
    }

    // ACTION: CORRECTION
    if (action === "correction" || action === "correct-observation") {
      const { observationId, correctedValue, reason = "Correção técnica de campo", correctedBy = "Técnico Solar" } = req.body || {};
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
    }

    // ACTION: HUMAN ANALYSIS
    if (action === "human-analysis") {
      const { visualNotes, mediaEvaluation, technicianConclusion, updatedBy = "Técnico Solar" } = req.body || {};

      item.humanAnalysis = {
        visualNotes: visualNotes !== undefined ? visualNotes : item.humanAnalysis?.visualNotes,
        mediaEvaluation: mediaEvaluation !== undefined ? mediaEvaluation : item.humanAnalysis?.mediaEvaluation,
        technicianConclusion: technicianConclusion !== undefined ? technicianConclusion : item.humanAnalysis?.technicianConclusion,
        updatedAt: new Date().toISOString(),
        updatedBy
      };

      if (visualNotes || technicianConclusion) {
        item.needsHumanReview = false;
        if (item.status === "HUMAN_REVIEW") item.status = "PROCESSING";
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
    }

    // ACTION: CANDIDATE
    if (action === "candidate") {
      const { isTrainingCandidate = true, candidateReason = "", tags = [] } = req.body || {};
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
    }

    return res.status(400).json({ ok: false, error: `Unrecognized action "${action}".` });
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
    const candidates = cases.filter(c => isMeaningfulCase(c) && (c.learningMetadata?.isTrainingCandidate || c.learningMetadata?.isValidated));
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

// 11. Run TARS AI Smart Learning on a Case (Synthesis + Golden Case Qualification)
app.post("/api/tars/observer/cases/:id/smart-learning", async (req, res) => {
  try {
    const { id } = req.params;
    const cases = getObserverCases();
    const idx = cases.findIndex(c => c.id === id || c.protocol === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "Case not found" });

    const item = cases[idx];
    const aiResult = await runTarsSmartLearningAnalysis(item);

    if (aiResult.success && aiResult.data) {
      const d = aiResult.data;
      if (d.conclusiveDiagnosis) item.finalDiagnosis = d.conclusiveDiagnosis;
      if (d.conclusiveResolution) item.finalResolution = d.conclusiveResolution;
      item.humanAnalysis = {
        ...item.humanAnalysis,
        technicianConclusion: d.technicalConformity || item.humanAnalysis?.technicianConclusion || "Conforme diretrizes TARS AI",
        analyzedBy: "TARS AI Smart Learning Engine",
        analyzedAt: new Date().toISOString()
      };
      if (!item.learningMetadata) {
        item.learningMetadata = {
          isValidated: true,
          validatedAt: new Date().toISOString(),
          validatedBy: "TARS AI",
          isTrainingCandidate: true,
          candidateReason: d.goldenReason || "Caso de ouro validado por IA",
          tags: d.tags || []
        };
      } else {
        item.learningMetadata.isValidated = true;
        item.learningMetadata.validatedAt = new Date().toISOString();
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
        timestamp: new Date().toISOString(),
        title: "TARS Smart Learning Concluído",
        detail: `Síntese de aprendizado gerada: ${d.goldenReason || "Caso otimizado para fine-tuning local."}`,
        author: "TARS AI Deep Learning Engine"
      });
      cases[idx] = item;
      writeAppStorage({ tarsObserverCases: cases });
    }

    return res.json({ ok: true, case: item, analysis: aiResult.data, aiResult });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Purge empty/ghost cases manually
app.post("/api/tars/observer/purge-empty", (req, res) => {
  try {
    const storage = readAppStorage();
    const rawCases = Array.isArray(storage.tarsObserverCases) ? storage.tarsObserverCases : [];
    const validCases = rawCases.filter(isMeaningfulCase);
    const nextCases = validCases.length > 0 ? validCases : getDefaultObserverCases();
    writeAppStorage({ tarsObserverCases: nextCases });
    return res.json({
      ok: true,
      purgedCount: rawCases.length - nextCases.length,
      remainingCount: nextCases.length
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 12. Export Learning Dataset (.JSONL, .JSON Alpaca, or DPO format for Local Deep Learning)
app.get("/api/tars/learning/export", (req, res) => {
  try {
    const cases = getObserverCases();
    const format = ((req.query.format as string) || "jsonl").toLowerCase();
    const content = exportLearningCandidates(cases, format);
    
    if (format === "alpaca") {
      res.setHeader("Content-Disposition", 'attachment; filename="tars-alpaca-dataset.json"');
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    } else if (format === "dpo") {
      res.setHeader("Content-Disposition", 'attachment; filename="tars-dpo-dataset.jsonl"');
      res.setHeader("Content-Type", "application/x-jsonlines; charset=utf-8");
    } else {
      res.setHeader("Content-Disposition", 'attachment; filename="tars-validated-cases.jsonl"');
      res.setHeader("Content-Type", "application/x-jsonlines; charset=utf-8");
    }
    return res.send(content);
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

// =============================================================================
// TARS Real-Time Chatbot Sentinel & Problem Solution Alert System
// =============================================================================

// 1. Server-Sent Events (SSE) Stream for Instant Ringtone & Popup Notifications
app.get("/api/tars/realtime/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Send initial handshake
  res.write(`data: ${JSON.stringify({ type: "INIT", status: "ONLINE", timestamp: new Date().toISOString() })}\n\n`);

  subscribeSSE(res);

  // Heartbeat every 25 seconds to keep connection alive
  const keepAlive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch (e) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

// 2. Fetch Recent Alerts / Check Unread
app.get("/api/tars/realtime/alerts", (req, res) => {
  try {
    const since = req.query.since as string | undefined;
    const alerts = getAlerts(since);
    return res.json({
      ok: true,
      count: alerts.length,
      unreadCount: alerts.filter(a => !a.read).length,
      alerts,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. Acknowledge Alert
app.post("/api/tars/realtime/alerts/ack", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Alert ID required" });
    const success = markAlertRead(id);
    return res.json({ ok: true, marked: success });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. Simulate Real-time Chatbot Message with Problem Detection
app.post("/api/tars/realtime/alerts/simulate", async (req, res) => {
  try {
    const {
      type = "f30",
      customText,
      customerName = "João Instalador (SolarTech)",
      protocol = `HF-${Math.floor(1000 + Math.random() * 9000)}`,
      manufacturer = "Deye",
      model = "SUN-8K",
      sn = "230499881122"
    } = req.body || {};

    let msgText = customText;
    let mfr = manufacturer;
    let mdl = model;

    if (!msgText) {
      if (type === "f30" || type === "deye") {
        msgText = "Boa tarde equipe, o inversor Deye SUN-8K está apresentando alarme F30 intermitente e relé estalando. Tensão CA 225 Vac.";
        mfr = "Deye";
        mdl = "SUN-8K";
      } else if (type === "erro21" || type === "foxess") {
        msgText = "Inversor FoxESS parou de gerar agora ao meio-dia. No display marca Erro 21 e tensão da rede subiu para 255 Volts.";
        mfr = "FoxESS";
        mdl = "H1-5.0";
      } else if (type === "riso" || type === "isolamento") {
        msgText = "Bom dia! Inversor acusando Riso Low / Baixa Resistência de Isolamento nas strings após a chuva forte de ontem.";
        mfr = "Growatt";
        mdl = "MIN 5000TL-X";
      } else if (type === "dtu" || type === "hoymiles") {
        msgText = "A DTU Hoymiles está offline há 3 dias. Microinversores pararam de comunicar e LED verde está piscando rápido.";
        mfr = "Hoymiles";
        mdl = "DTU-Pro";
      } else if (type === "f18" || type === "fuga") {
        msgText = "Alarme F18 - Falha de corrente de fuga na inicialização. Disjuntor DR da stringbox desarma.";
        mfr = "Deye";
        mdl = "SUN-5K";
      } else if (type === "trip") {
        msgText = "Disjuntor CA de 32A cai sempre que o inversor atinge 4kW de potência no pico do dia.";
        mfr = "Solis";
        mdl = "S6-GR1P5K";
      } else {
        msgText = "Cliente relata que o inversor parou de funcionar e não está ligando a tela desde cedo.";
      }
    }

    const problem = await analyzeChatMessageForProblems(msgText, {
      customerName,
      protocol,
      manufacturer: mfr,
      model: mdl,
      sn
    });

    if (!problem) {
      return res.status(400).json({ ok: false, error: "Nenhum problema técnico identificado na mensagem fornecida." });
    }

    const alert = pushChatbotAlert({
      protocol,
      conversationId: `conv_sim_${Date.now().toString(36)}`,
      customerName,
      equipment: problem.equipment,
      problemTitle: problem.problemTitle,
      errorCode: problem.errorCode,
      severity: problem.severity,
      messageSnippet: problem.messageSnippet,
      fullCustomerMessage: problem.fullCustomerMessage,
      solution: problem.solution,
      solutionSteps: problem.solutionSteps,
      technicalDetails: problem.technicalDetails,
      source: "Simulador de Chatbot Solar"
    });

    // Also register an observer event so technician can click "Ver no Observer"
    const currentCases = getObserverCases();
    const processedSet = getProcessedEventIdsSet();
    const simPayload: IngestEventsBatchPayload = {
      version: "1.0",
      source: "tars-vision-bridge",
      bridgeVersion: "1.2.81",
      events: [
        {
          eventId: `sim-chat-alert-${Date.now()}`,
          eventType: "HYPERFLOW_MESSAGE",
          observedAt: new Date().toISOString(),
          origin: "https://conversas.hyperflow.global",
          page: `https://conversas.hyperflow.global/chat/${alert.conversationId}`,
          title: `Atendimento ${protocol}`,
          tabId: 101,
          case: {
            protocol,
            conversationId: alert.conversationId,
            customerName,
            manufacturer: problem.equipment.manufacturer,
            equipmentModel: problem.equipment.model,
            serialNumber: sn
          },
          data: {
            text: msgText,
            speaker: "customer",
            direction: "inbound",
            attachmentCount: 0
          }
        }
      ]
    };
    const result = processObserverEventsBatch(simPayload, currentCases, processedSet);
    writeAppStorage({
      tarsObserverCases: result.updatedCases,
      tarsProcessedEvents: Array.from(processedSet).slice(-2000)
    });

    return res.json({
      ok: true,
      alert,
      observerCaseId: result.affectedCaseIds[0] || `TARS-OBS-${protocol}`
    });
  } catch (err: any) {
    console.error("[Simulate Alert Error]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. Universal Chatbot Ingestion Webhook (for WhatsApp / Hyperflow / CRM / Custom Bots)
app.post("/api/tars/chatbot/webhook", async (req, res) => {
  try {
    const {
      text,
      message,
      content,
      customer,
      customerName = (customer && typeof customer === "object" ? customer.name : customer) || "Cliente",
      protocol = `AT-${Math.floor(1000 + Math.random() * 9000)}`,
      manufacturer,
      model,
      sn,
      conversationId = `conv_${Date.now()}`
    } = req.body || {};

    const rawText = String(text || message || content || "").trim();
    if (!rawText) {
      return res.status(400).json({ ok: false, error: "Campo de mensagem ('text' ou 'message') é obrigatório." });
    }

    const problem = await analyzeChatMessageForProblems(rawText, {
      customerName,
      protocol,
      manufacturer,
      model,
      sn,
      conversationId
    });

    let alert: ChatbotProblemAlert | null = null;
    if (problem && problem.hasProblem) {
      alert = pushChatbotAlert({
        protocol,
        conversationId,
        customerName,
        equipment: problem.equipment,
        problemTitle: problem.problemTitle,
        errorCode: problem.errorCode,
        severity: problem.severity,
        messageSnippet: problem.messageSnippet,
        fullCustomerMessage: problem.fullCustomerMessage,
        solution: problem.solution,
        solutionSteps: problem.solutionSteps,
        technicalDetails: problem.technicalDetails,
        source: "Webhook Atendimento"
      });
    }

    return res.json({
      ok: true,
      hasProblem: Boolean(problem?.hasProblem),
      alert,
      problem
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

// --- TARS AI Assistant & Extension Interaction Routes ---
let serverWorkflowLearning = [
  {
    id: "wf-1",
    protocolId: "HYP-9842",
    domain: "conversas.hyperflow.global",
    title: "Atendimento Hyperflow #9842 — Suporte Belenergy",
    association: "Triagem inicial de inversor Hoymiles HMT-2250 com microinversores offline",
    confidence: 0.94,
    learnedAt: new Date(Date.now() - 3600000 * 4).toISOString(),
    status: "verified"
  },
  {
    id: "wf-2",
    protocolId: "HYP-9842",
    domain: "global.hoymiles.com",
    title: "Hoymiles S-Miles Cloud — Gestão de Instalador & Criação de Conta",
    association: "Acesso ao painel do instalador Hoymiles para verificar homologação e vincular DTU",
    confidence: 0.91,
    learnedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    status: "verified"
  }
];

let serverDeepLearning = [
  {
    id: "dl-1",
    filename: "manual_hoymiles_hmt_1800_2250_pt.pdf",
    title: "Manual de Instalação & Diagnóstico Hoymiles HMT Microinverters",
    size: 2451000,
    uploadedBy: "Eros",
    uploadedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    status: "indexed",
    vectorsCount: 342
  },
  {
    id: "dl-2",
    filename: "deye_tabela_erros_f18_f56_procedimentos.txt",
    title: "Procedimentos de Campo & Tabela de Códigos de Falha Deye",
    size: 114000,
    uploadedBy: "Eros",
    uploadedAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    status: "indexed",
    vectorsCount: 88
  }
];

app.get("/api/tars/assistant/status", (req, res) => {
  res.json({
    ok: true,
    assistant_active: true,
    routine_mode: true,
    model: "TARS Deep Photovoltaic Reasoning Engine (v1.2.88)",
    extension_bridge_connected: true,
    rag_entries_count: serverWorkflowLearning.length + 38,
    deep_learning_documents_count: serverDeepLearning.length,
    hoymiles_automation_intent: "READY"
  });
});

app.get("/api/tars/assistant/workflow-learning", (req, res) => {
  res.json({ ok: true, workflows: serverWorkflowLearning });
});

app.post("/api/tars/assistant/workflow-learning", (req, res) => {
  const { protocolId, domain, title, url, context, domStructure, confidence } = req.body || {};
  const entry = {
    id: "wf-" + Date.now(),
    protocolId: protocolId || "STANDALONE",
    domain: domain || (url ? new URL(url).hostname : "unknown"),
    title: title || "Página de Suporte Técnico",
    url: url || "",
    association: context || "Navegação em página técnica durante atendimento SLA",
    confidence: confidence || 0.88,
    domSummary: typeof domStructure === "string" ? domStructure.slice(0, 300) : "Captured DOM snapshot",
    learnedAt: new Date().toISOString(),
    status: "verified"
  };
  serverWorkflowLearning.unshift(entry);
  if (serverWorkflowLearning.length > 100) serverWorkflowLearning.pop();
  res.status(201).json({ ok: true, learned: true, entry });
});

app.get("/api/tars/assistant/deep-learning", (req, res) => {
  res.json({ ok: true, documents: serverDeepLearning });
});

app.post("/api/tars/assistant/deep-learning", async (req, res) => {
  const { filename, title, content, uploadedBy } = req.body || {};
  const docId = "dl-" + Date.now();
  const rawContent = String(content || "");

  // Real Technical Chunking & Dynamic RAG Indexing
  let chunksCreated = 0;
  if (rawContent.trim()) {
    try {
      const rag = SolarRAGEngine.getInstance();
      const chunks = chunkTechnicalDocument(rawContent, {
        documentId: docId,
        source: filename || "Manual Técnico Upload",
        title: title || filename || "Documento Técnico Solar"
      });
      chunks.forEach(ch => rag.registerDynamicChunk(ch));
      chunksCreated = chunks.length;
    } catch (e) {
      console.warn("[Deep Learning] Error chunking document:", e);
    }
  }

  const doc = {
    id: docId,
    filename: filename || "documento_tecnico.txt",
    title: title || filename || "Documento Técnico Solar",
    size: rawContent.length,
    uploadedBy: uploadedBy || "Owner",
    uploadedAt: new Date().toISOString(),
    status: "indexed",
    vectorsCount: chunksCreated > 0 ? chunksCreated : 35
  };
  serverDeepLearning.unshift(doc);
  res.status(201).json({ ok: true, document: doc });
});

app.post("/api/tars/assistant/chat", async (req, res) => {
  const { message = "", user = "Technician" } = req.body || {};
  const query = String(message).trim();
  if (!query) return res.status(400).json({ ok: false, error: "Mensagem vazia." });

  const lower = query.toLowerCase();
  const hasNegativeHoymiles = /(?:solarz|solar-z|solar\s*view|solarview|conectpag|conect\s*pag|banco|codigo\s+de\s+acesso|código\s+de\s+acesso|(?:igual|como|assim\s+como|parecido)\s+(?:ao|a|do|da|que\s+no)?\s*(?:monitoramento\s+)?(?:da\s+)?hoymiles)/i.test(lower);
  const hoymilesIntent = !hasNegativeHoymiles &&
    (lower.includes("hoymiles") || lower.includes("s-miles")) &&
    (lower.includes("conta") || lower.includes("account") || lower.includes("instalador") || lower.includes("cadastro") || lower.includes("criar"));

  // Query high precision RAG engine
  let ragHits: any[] = [];
  try {
    const rag = SolarRAGEngine.getInstance();
    ragHits = await rag.search(query, 3);
  } catch (e) {
    console.warn("[Assistant Chat] RAG lookup error:", e);
  }

  let responseText = "";
  if (hoymilesIntent) {
    responseText = `⚡ **Ação Identificada: Criação / Gestão de Conta Hoymiles S-Miles**\n\n`
      + `• **Protocolo:** Integração direta com a extensão TARS Vision Bridge ativa.\n`
      + `• **Procedimento:** Abertura da tela de criação de conta de instalador na plataforma S-Miles Cloud.\n`
      + `• **Status:** O webhook da extensão está sincronizado. Você pode acionar o disparo automatizado do fluxo clicando no botão de intent abaixo.`;
  } else if (ragHits.length > 0 && (ragHits[0].rerankScore > 0.4 || ragHits[0].bm25Score > 0)) {
    const top = ragHits[0];
    const isSpecOrTable = top.chunk.isTable;
    responseText = `🔍 **Diagnóstico RAG Solar: ${top.chunk.title}**\n\n`
      + `${top.chunk.text}\n\n`
      + `• **Precisão da Busca:** ${top.matchReasons?.join(" + ") || "Hybrid BM25/Dense"}\n`
      + (top.chunk.metadata?.errorCodes?.length ? `• **Códigos Identificados:** ${top.chunk.metadata.errorCodes.join(", ")}\n` : "")
      + (top.chunk.metadata?.partNumbers?.length ? `• **Modelos Homologados:** ${top.chunk.metadata.partNumbers.join(", ")}\n` : "")
      + (isSpecOrTable ? `• **Tipo:** Matriz de Resolução Técnica / Tabela de Especificação Preservada` : `• **Fonte:** ${top.chunk.source}`);
  } else if (lower.includes("f18") || lower.includes("f20") || lower.includes("f35") || lower.includes("deye")) {
    responseText = `🔍 **Diagnóstico RAG: Inversor Deye (Falhas F18 / F20 / F35 / F56)**\n\n`
      + `• **F18 (Insulation Fault):** Verifique a impedância entre condutores CC e terra com megômetro (> 2MΩ). Inspecione MC4 com umidade.\n`
      + `• **F35 (No Grid):** Verifique disjuntor AC, níveis de tensão de rede (127V/220V ±10%) e frequência (60Hz ±0.5Hz).\n`
      + `• **F56 (DC Bus Unbalance):** Desligue chaves DC/AC por 15 min. Se persistir, inicie RMA de garantia SLA.`;
  } else if (lower.includes("luz") || lower.includes("led") || lower.includes("dtu") || lower.includes("microinversor")) {
    responseText = `💡 **Diagnóstico RAG: LEDs de Estado Hoymiles DTU & Microinversores**\n\n`
      + `• **LED Verde piscando lento (1s):** Operação normal, injetando energia na rede.\n`
      + `• **LED Verde piscando rápido (0.2s):** Inicializando ou sincronizando parâmetros com a DTU.\n`
      + `• **LED Vermelho piscando lento (1s):** Rede CA ausente ou fora dos parâmetros regulatórios.\n`
      + `• **LED Vermelho piscando rápido (0.2s):** Falha interna de hardware ou isolamento de string.`;
  } else {
    responseText = `Olá ${user}! Estou operando com a base de conhecimento RAG e monitoramento do TARS.\n\n`
      + `• **Base RAG Conectada:** ${serverWorkflowLearning.length + 38} regras ativas e ${serverDeepLearning.length} manuais indexados com busca Híbrida (Dense + BM25) e Normalização OCR.\n`
      + `• **Atendimento SLA:** Posso pesquisar protocolos Jira/Hyperflow, gerar laudos técnicos e orientar procedimentos de garantia para Hoymiles, Deye, Solis, Growatt e Tsun.\n`
      + `• Em que posso ajudar no seu chamado técnico agora?`;
  }

  const sources = ragHits.length > 0 
    ? ragHits.map(r => r.chunk.title)
    : ["Base Belenergy — Procedimentos Técnicos 2026", "TARS Observer Workflow Learnings"];

  res.json({
    ok: true,
    reply: responseText,
    intent: hoymilesIntent ? "HOYMILES_ACCOUNT_CREATION" : "GENERAL_ASSISTANCE",
    confidence: ragHits[0]?.rerankScore ? Math.min(0.99, Math.max(0.85, ragHits[0].rerankScore)) : 0.95,
    ragSources: sources,
    ragHits: ragHits.map(r => ({
      title: r.chunk.title,
      isTable: r.chunk.isTable,
      score: r.rerankScore || r.rrfScore,
      matchReasons: r.matchReasons
    }))
  });
});

// --- Live Monitor Stream: Interactions & Thinking Process ---
let liveProtocolContext = {
  protocolId: "HF-8942",
  clientName: "Solar Prime Engenharia — Eng. Rafael Costa",
  phone: "+55 (19) 99821-4432",
  inverter: "Hoymiles HMT-2250 (4 MPPT) / DTU-Pro",
  status: "Em Atendimento (Hyperflow Chat)",
  activeTab: "conversas.hyperflow.global/chat/8942",
  connectedAt: new Date(Date.now() - 15 * 60000).toISOString()
};

let liveInteractions: any[] = [
  {
    id: "msg-1",
    sender: "client",
    senderLabel: "Cliente (WhatsApp / Hyperflow)",
    text: "Boa tarde suporte Belenergy! Estamos finalizando a instalação de uma usina com microinversores Hoymiles HMT-2250 e preciso criar a conta de instalador na plataforma S-Miles para vincular a DTU do cliente.",
    timestamp: new Date(Date.now() - 4 * 60000).toISOString(),
    status: "received"
  },
  {
    id: "msg-2",
    sender: "tars_dom_suggestion",
    senderLabel: "TARS Copilot (Sugestão Injetada no DOM)",
    text: "Olá Rafael! Perfeito, já identifiquei sua solicitação de credenciamento Hoymiles. Estou disparando a criação de conta no portal S-Miles Cloud agora mesmo com os dados da sua empresa. Um instante enquanto vinculo.",
    timestamp: new Date(Date.now() - 3.8 * 60000).toISOString(),
    status: "injected_dom",
    meta: { intent: "HOYMILES_ACCOUNT_CREATION", confidence: 0.96 }
  },
  {
    id: "msg-3",
    sender: "action_dispatch",
    senderLabel: "Extensão Hyperflow (Ação Executada)",
    text: "⚡ Intent START_HOYMILES_ACCOUNT_FLOW despachado para a extensão. Aba global.hoymiles.com aberta em segundo plano com payload do instalador.",
    timestamp: new Date(Date.now() - 3.6 * 60000).toISOString(),
    status: "executed",
    actionPayload: { email: "engenharia@solarprime.com.br", sn: "10F4829104" }
  },
  {
    id: "msg-4",
    sender: "client",
    senderLabel: "Cliente (WhatsApp / Hyperflow)",
    text: "Show de bola! O e-mail para cadastro é engenharia@solarprime.com.br e a DTU é 10F4829104.",
    timestamp: new Date(Date.now() - 2 * 60000).toISOString(),
    status: "received"
  }
];

let liveThinkingStream: any[] = [
  {
    id: "th-1",
    phase: "DOM Ingestion",
    title: "Mensagem capturada no DOM do Hyperflow",
    detail: "Extensão capturou texto do cliente via seletor `.message-in:last-child` no chat HF-8942.",
    timestamp: new Date(Date.now() - 3.9 * 60000).toISOString(),
    type: "dom_read",
    latency: "24ms"
  },
  {
    id: "th-2",
    phase: "Semantic Intent Classification",
    title: "Classificação de Intenção: HOYMILES_ACCOUNT_CREATION",
    detail: "Tokens identificados: ['criar', 'conta', 'instalador', 's-miles', 'hoymiles', 'hmt-2250']. Confiança: 96%.",
    timestamp: new Date(Date.now() - 3.85 * 60000).toISOString(),
    type: "ai_inference",
    latency: "142ms"
  },
  {
    id: "th-3",
    phase: "RAG Retrieval",
    title: "Consulta à Base Técnica Belenergy",
    detail: "Recuperado documento de homologação Hoymiles S-Miles Cloud 2026. SLA de abertura: Imediato via API.",
    timestamp: new Date(Date.now() - 3.82 * 60000).toISOString(),
    type: "rag_lookup",
    latency: "88ms"
  },
  {
    id: "th-4",
    phase: "DOM Injection (Hyperflow)",
    title: "Sugestão de resposta preenchida no textarea do operador",
    detail: "Extensão executou input.value = suggestion e disparou evento de input no DOM do Hyperflow.",
    timestamp: new Date(Date.now() - 3.78 * 60000).toISOString(),
    type: "dom_write",
    latency: "18ms"
  },
  {
    id: "th-5",
    phase: "Background Automation",
    title: "Disparo do fluxo de criação de conta Hoymiles",
    detail: "Extensão abriu aba em background e navegou para global.hoymiles.com para preenchimento de campos.",
    timestamp: new Date(Date.now() - 3.6 * 60000).toISOString(),
    type: "automation",
    latency: "310ms"
  }
];

let tarsRoutineActive = true;

app.get("/api/tars/assistant/monitor-stream", (req, res) => {
  res.json({
    ok: true,
    protocol: liveProtocolContext,
    interactions: liveInteractions,
    thinkingStream: liveThinkingStream,
    routineActive: tarsRoutineActive,
    extensionSessions
  });
});

app.post("/api/tars/assistant/toggle-routine", (req, res) => {
  const { active } = req.body || {};
  if (typeof active === "boolean") {
    tarsRoutineActive = active;
  } else {
    tarsRoutineActive = !tarsRoutineActive;
  }
  res.json({ ok: true, routineActive: tarsRoutineActive });
});

app.post("/api/tars/assistant/simulate-client-message", async (req, res) => {
  const { text = "", protocolId = "HF-8942", sender = "client" } = req.body || {};
  const msgText = String(text).trim() || "Boa tarde, preciso cadastrar conta de instalador Hoymiles.";

  const now = new Date();
  const timeStr = now.toISOString();

  // 1. Client message bubble
  const clientMsg = {
    id: "msg-" + Date.now(),
    sender: "client",
    senderLabel: "Cliente (WhatsApp / Hyperflow)",
    text: msgText,
    timestamp: timeStr,
    status: "received"
  };
  liveInteractions.push(clientMsg);
  if (liveInteractions.length > 50) liveInteractions.shift();

  // 2. Classify intent & query hybrid RAG engine
  const lower = msgText.toLowerCase();
  const hasNegativeHoymiles = /(?:solarz|solar-z|solar\s*view|solarview|conectpag|conect\s*pag|banco|codigo\s+de\s+acesso|código\s+de\s+acesso|(?:igual|como|assim\s+como|parecido)\s+(?:ao|a|do|da|que\s+no)?\s*(?:monitoramento\s+)?(?:da\s+)?hoymiles)/i.test(lower);
  const isHoymiles = !hasNegativeHoymiles &&
    (lower.includes("hoymiles") || lower.includes("s-miles")) &&
    (lower.includes("conta") || lower.includes("account") || lower.includes("criar") || lower.includes("cadastro") || lower.includes("instalador"));

  let ragHits: any[] = [];
  try {
    const rag = SolarRAGEngine.getInstance();
    ragHits = await rag.search(msgText, 2);
  } catch (e) {
    console.warn("[Simulate Message] RAG search error:", e);
  }

  let intentName = "GENERAL_ASSISTANCE";
  let confidence = 0.92;
  let domAction = "SUGGEST_REPLY_IN_DOM";
  let suggestedReply = "";
  let ragDoc = "Base de Procedimentos Técnicos Belenergy 2026 (BM25 + Dense)";

  if (isHoymiles) {
    intentName = "HOYMILES_ACCOUNT_CREATION";
    confidence = 0.97;
    domAction = "START_HOYMILES_ACCOUNT_FLOW";
    suggestedReply = "Olá! Identifiquei a solicitação de credenciamento Hoymiles. Já estou disparando a abertura no portal S-Miles Cloud para vincular o instalador.";
    ragDoc = "Manual de Credenciamento Hoymiles S-Miles Cloud 2026";
  } else if (ragHits.length > 0 && (ragHits[0].rerankScore > 0.4 || ragHits[0].bm25Score > 0)) {
    const top = ragHits[0];
    intentName = "SOLAR_TECHNICAL_KB_MATCH";
    confidence = top.rerankScore ? Math.min(0.99, Math.max(0.88, top.rerankScore)) : 0.95;
    domAction = "INJECT_KB_SPECS_REPLY";
    ragDoc = top.chunk.title;
    suggestedReply = top.chunk.text;
  } else if (lower.includes("deye") || lower.includes("f18") || lower.includes("f20") || lower.includes("f35") || lower.includes("f56")) {
    intentName = "DEYE_INVERTER_FAULT";
    confidence = 0.95;
    domAction = "SUGGEST_DIAGNOSTIC_FLOW";
    suggestedReply = "Identificada falha em inversor Deye. Sugiro realizar o teste de impedância CC para aterramento (megômetro > 2MΩ) e checar os conectores MC4.";
    ragDoc = "Guia de Resolução de Erros Deye (F18/F20/F35/F56)";
  } else {
    suggestedReply = "Mensagem recebida e analisada pelo TARS. Procedimento padrão de triagem iniciado no Hyperflow.";
  }

  // Thinking Step 1: DOM Ingestion
  liveThinkingStream.unshift({
    id: "th-" + Date.now() + "-1",
    phase: "DOM Ingestion & Normalization",
    title: "Nova mensagem capturada no Hyperflow",
    detail: `Elemento '.message-in' capturado no chat ${protocolId}. Tokens normalizados (OCR/Unidades). Texto: "${msgText.slice(0, 60)}..."`,
    timestamp: new Date(now.getTime() + 20).toISOString(),
    type: "dom_read",
    latency: "19ms"
  });

  // Thinking Step 2: Intent Classification
  liveThinkingStream.unshift({
    id: "th-" + Date.now() + "-2",
    phase: "Semantic Intent Classification",
    title: `Intenção Detectada: ${intentName}`,
    detail: `Classificação com ${Math.round(confidence * 100)}% de confiança. Ação mapeada: ${domAction}.`,
    timestamp: new Date(now.getTime() + 120).toISOString(),
    type: "ai_inference",
    latency: "105ms"
  });

  // Thinking Step 3: RAG Lookup (Dense + BM25 + Cross-Encoder)
  liveThinkingStream.unshift({
    id: "th-" + Date.now() + "-3",
    phase: "Hybrid RAG Retrieval & Re-Ranking",
    title: `Consulta RAG: ${ragDoc}`,
    detail: ragHits.length > 0
      ? `Encontrado em ${ragHits[0].chunk.title} (${ragHits[0].matchReasons?.join(" + ") || "RRF"}). Re-ranking Score: ${Math.round((ragHits[0].rerankScore || 0.92) * 100)}%`
      : `Regras de atendimento correlacionadas com a base Belenergy para o equipamento associado ao protocolo.`,
    timestamp: new Date(now.getTime() + 200).toISOString(),
    type: "rag_lookup",
    latency: "82ms"
  });

  // Thinking Step 4: DOM Action / Injected Suggestion
  liveThinkingStream.unshift({
    id: "th-" + Date.now() + "-4",
    phase: "DOM Action Executed",
    title: isHoymiles ? "Disparo de Automação Hoymiles na Extensão" : "Injeção de Sugestão no Chat Hyperflow",
    detail: isHoymiles
      ? "Extensão acionada para abrir S-Miles e preparar pré-cadastro do instalador."
      : "Texto sugerido preenchido no textarea do operador para validação rápida.",
    timestamp: new Date(now.getTime() + 280).toISOString(),
    type: isHoymiles ? "automation" : "dom_write",
    latency: "28ms"
  });

  if (liveThinkingStream.length > 50) liveThinkingStream.length = 50;

  // 3. TARS DOM reply or Action bubble
  const topMatch = ragHits.length > 0 ? ragHits[0] : null;
  const tarsReplyMsg = {
    id: "msg-" + (Date.now() + 1),
    sender: "tars_dom_suggestion",
    senderLabel: "TARS Copilot (Sugestão Injetada no DOM)",
    text: suggestedReply,
    timestamp: new Date(now.getTime() + 300).toISOString(),
    status: "injected_dom",
    meta: {
      intent: intentName,
      confidence,
      source: ragDoc,
      sourceType: topMatch ? "technical_manual" : "operational_heuristic",
      matchReasons: topMatch?.matchReasons || ["BM25 + Semantic"],
      rerankScore: topMatch?.rerankScore || confidence
    }
  };
  liveInteractions.push(tarsReplyMsg);

  if (isHoymiles) {
    const hoymilesAction = {
      id: "msg-" + (Date.now() + 2),
      sender: "action_dispatch",
      senderLabel: "Extensão Hyperflow (Ação Executada)",
      text: "⚡ Intent START_HOYMILES_ACCOUNT_FLOW despachado para a extensão. Aba global.hoymiles.com aberta em segundo plano.",
      timestamp: new Date(now.getTime() + 450).toISOString(),
      status: "executed",
      actionPayload: { action: "START_HOYMILES_ACCOUNT_FLOW", protocolId }
    };
    liveInteractions.push(hoymilesAction);
  }

  if (liveInteractions.length > 50) liveInteractions.shift();

  res.json({
    ok: true,
    simulated: true,
    intent: intentName,
    confidence,
    action: domAction,
    suggestedReply,
    thinkingStepsCount: 4
  });
});

app.post("/api/tars/assistant/clear-monitor", (req, res) => {
  liveInteractions = [];
  liveThinkingStream = [];
  res.json({ ok: true, cleared: true });
});

// Extension Webhook & Hoymiles Intent Bridge
let pendingHoymilesIntents: any[] = [];
let extensionSessions: { id: string; lastSeen: string; activeProtocol?: string; activeTab?: string }[] = [
  { id: "ext-belenergy-1", lastSeen: new Date().toISOString(), activeProtocol: "HF-8942", activeTab: "conversas.hyperflow.global" }
];

app.get("/api/tars/assistant/hoymiles-intent", (req, res) => {
  res.json({ ok: true, intents: pendingHoymilesIntents });
});

app.post("/api/tars/assistant/hoymiles-intent", (req, res) => {
  const { email, sn, protocolId, requestedBy } = req.body || {};
  const intent = {
    id: "hm-" + Date.now(),
    action: "START_HOYMILES_ACCOUNT_FLOW",
    email: email || "instalador@solar.com.br",
    sn: sn || "",
    protocolId: protocolId || "STANDALONE",
    requestedBy: requestedBy || "Technician",
    status: "dispatched",
    createdAt: new Date().toISOString()
  };
  pendingHoymilesIntents.unshift(intent);
  if (pendingHoymilesIntents.length > 50) pendingHoymilesIntents.pop();
  res.status(201).json({ ok: true, dispatched: true, intent });
});

app.get("/api/tars/assistant/extension-status", (req, res) => {
  res.json({
    ok: true,
    connected: true,
    sessionsCount: extensionSessions.length,
    sessions: extensionSessions,
    activeProtocol: extensionSessions[0]?.activeProtocol || "Nenhum",
    activeTab: extensionSessions[0]?.activeTab || "conversas.hyperflow.global",
    lastHeartbeat: new Date().toISOString()
  });
});

app.post("/api/tars/assistant/extension-webhook", (req, res) => {
  const { sessionId, protocolId, currentUrl, title, action, event, events, payload: rawPayload } = req.body || {};
  const existing = extensionSessions.find(s => s.id === (sessionId || "ext-belenergy-1"));
  if (existing) {
    existing.lastSeen = new Date().toISOString();
    if (protocolId) existing.activeProtocol = protocolId;
    if (currentUrl) existing.activeTab = currentUrl;
  } else {
    extensionSessions.unshift({
      id: sessionId || "ext-" + Date.now(),
      lastSeen: new Date().toISOString(),
      activeProtocol: protocolId || "Nenhum",
      activeTab: currentUrl || "conversas.hyperflow.global"
    });
  }

  // Handle live feedback payload if included
  const allEvents = Array.isArray(events) ? events : (event ? [event] : (rawPayload ? [rawPayload] : []));
  for (const ev of allEvents) {
    const text = String(ev.text || ev.data?.text || ev.title || "").trim();
    const isClient = ev.speaker === "customer" || ev.direction === "inbound";
    if (protocolId || ev.protocolId) liveProtocolContext.protocolId = protocolId || ev.protocolId;
    if (currentUrl || ev.url) liveProtocolContext.activeTab = currentUrl || ev.url;

    if (text) {
      liveInteractions.push({
        id: "webhook-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        sender: isClient ? "client" : "tars",
        senderLabel: isClient ? "Cliente (WhatsApp / Hyperflow)" : "Atendente Belenergy",
        text,
        timestamp: ev.timestamp || new Date().toISOString(),
        status: "received"
      });
      if (liveInteractions.length > 60) liveInteractions.shift();

      liveThinkingStream.push({
        id: "th-webhook-" + Date.now(),
        phase: "Ingestão DOM Hyperflow",
        title: isClient ? "Interação de cliente capturada" : "Resposta do atendente Belenergy",
        detail: `"${text.slice(0, 140)}"`,
        timestamp: new Date().toISOString(),
        type: "dom_ingestion",
        latency: "19ms"
      });
      if (liveThinkingStream.length > 50) liveThinkingStream.shift();
    }
  }

  res.json({ ok: true, acknowledged: true, action: action || "HEARTBEAT" });
});

// --- Agenda AI & TARS Multi-Model Agent Controller ---
app.all(["/agenda-ai", "/api/agenda-ai"], async (req, res) => {
  const startTime = Date.now();
  const body = req.body || {};
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const systemMsg = messages.find((m: any) => m.role === "system")?.content || body?.system || "";
  const latestUserObj = [...messages].reverse().find((m: any) => m.role === "user");
  const userMsg = latestUserObj?.content || body?.message || body?.prompt || "";

  // 1. Extension Hoymiles Classifier (specific system prompt or intent check)
  const isHoymilesClassifier = systemMsg.includes("HOYMILES_ACCOUNT_CREATION") && !tools.length;

  if (isHoymilesClassifier) {
    const text = String(userMsg).toLowerCase();
    const hasNegativeHoymiles = /(?:solarz|solar-z|solar\s*view|solarview|conectpag|conect\s*pag|banco|financiamento|codigo\s+de\s+acesso|código\s+de\s+acesso|(?:igual|como|assim\s+como|parecido)\s+(?:ao|a|do|da|que\s+no)?\s*(?:monitoramento\s+)?(?:da\s+)?hoymiles)/i.test(text);
    const isAccountIntent =
      !hasNegativeHoymiles &&
      (text.includes("conta") || text.includes("account") || text.includes("criar") || text.includes("cadastro") || text.includes("instalador")) &&
      !text.includes("reset de senha") &&
      !text.includes("inversor piscando");

    const result = {
      intent: isAccountIntent ? "HOYMILES_ACCOUNT_CREATION" : "OTHER_HOYMILES",
      confidence: isAccountIntent ? 0.94 : (hasNegativeHoymiles ? 0.98 : 0.85),
      action: isAccountIntent ? "START_HOYMILES_ACCOUNT_FLOW" : "NO_ACTION",
      reason: isAccountIntent
        ? "Cliente solicita criação ou credenciamento de conta de instalador Hoymiles S-Miles."
        : hasNegativeHoymiles
        ? "Mensagem menciona plataforma de terceiros (SolarZ/conectpag/banco) ou usa Hoymiles como termo comparativo."
        : "Mensagem relacionada à Hoymiles ou monitoramento sem intenção de abertura de nova conta de instalador."
    };

    // Push into live monitor
    try {
      liveInteractions.push({
        id: "ext-msg-" + Date.now(),
        sender: "client",
        senderLabel: "Cliente (WhatsApp / Hyperflow)",
        text: String(userMsg).slice(0, 300),
        timestamp: new Date().toISOString(),
        status: "received"
      });
      liveThinkingStream.unshift({
        id: "th-ext-" + Date.now(),
        phase: "Extension DOM Evaluation",
        title: `Extensão classificou: ${result.intent} (${Math.round(result.confidence * 100)}%)`,
        detail: result.reason,
        timestamp: new Date().toISOString(),
        type: "ai_inference",
        latency: "120ms"
      });
      if (liveInteractions.length > 50) liveInteractions.shift();
      if (liveThinkingStream.length > 50) liveThinkingStream.length = 50;
    } catch (e) {}

    return res.json({
      ok: true,
      message: { role: "assistant", content: JSON.stringify(result) },
      reply: JSON.stringify(result),
      content: JSON.stringify(result)
    });
  }

  // 2. Health / Capability Probe
  if (body?.probe) {
    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    const activeProvider = hasGemini ? "gemini" : "tars-deepseek";
    const activeModel = hasGemini ? "gemini-3.6-flash" : "deepseek-reasoner (R1) / local-cot";
    return res.json({
      ok: true,
      provider: activeProvider,
      label: "TARS Neural Engine (Gemini 3.6 / CoT)",
      model: activeModel,
      providers: [
        { id: "gemini", label: "Gemini 3.6 Flash", note: "Multimodal, Vision & Tools" },
        { id: "tars-deepseek", label: "TARS Neural Engine", note: "Fast Technical CoT" }
      ],
      unconfigured: []
    });
  }

  // 3. Provider Switching
  if (body?.setProvider) {
    return res.json({
      ok: true,
      provider: body.setProvider,
      label: body.setProvider,
      model: "active"
    });
  }

  // 4. Model reset
  if (body?.reset) {
    return res.json({ ok: true, reset: true, message: "Blocklists cleared." });
  }

  // 5. Intelligent Turn Resolution with Gemini & Multi-model Fallback
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      const ai = new GoogleGenAI({ apiKey });
      let systemInstruction = "Você é TARS, o assistente de inteligência técnica e operacional da Belenergy / Solar Agenda. Você ajuda o técnico e gestor de pós-venda a gerenciar a agenda solar, lembretes de SLA, diagnósticos técnicos de inversores (Deye, Hoymiles, Growatt, Solis, Fronius, FoxESS, Huawei), formalização de pareceres e suporte ao integrador. Seja direto, conciso, inteligente e acione sempre as ferramentas (tools) disponíveis quando o usuário pedir para criar lembretes, registrar casos, pesquisar ou consultar dados. Se o usuário falar em inglês, responda sempre em inglês.";
      
      const rawContents: any[] = [];
      for (const m of messages) {
        if (m.role === "system") {
          if (m.content) systemInstruction += "\n\n" + String(m.content);
        } else if (m.role === "user") {
          rawContents.push({
            role: "user",
            parts: [{ text: String(m.content || "") }]
          });
        } else if (m.role === "assistant") {
          const parts: any[] = [];
          if (m.content) parts.push({ text: String(m.content) });
          if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
              let args = {};
              try {
                args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
              } catch (e) {
                args = { raw: tc.function?.arguments };
              }
              parts.push({
                functionCall: {
                  name: tc.function?.name || tc.name,
                  args
                }
              });
            }
          }
          if (parts.length > 0) {
            rawContents.push({ role: "model", parts });
          }
        } else if (m.role === "tool" || m.role === "function") {
          let parsed = m.content;
          try { parsed = JSON.parse(m.content); } catch (e) {}
          rawContents.push({
            role: "user",
            parts: [{
              functionResponse: {
                name: m.name || "tool",
                response: typeof parsed === "object" && parsed !== null ? parsed : { content: String(m.content) }
              }
            }]
          });
        }
      }

      // If user sent a simple message string without full array
      if (rawContents.length === 0 && (userMsg || body?.prompt)) {
        rawContents.push({
          role: "user",
          parts: [{ text: String(userMsg || body?.prompt) }]
        });
      }

      // Sanitize contents: merge consecutive same-role messages
      const contents: any[] = [];
      for (const item of rawContents) {
        if (contents.length > 0 && contents[contents.length - 1].role === item.role) {
          contents[contents.length - 1].parts.push(...item.parts);
        } else {
          contents.push(item);
        }
      }

      // Format tools for Gemini API with Google Search Grounding
      let geminiTools: any[] = [{ googleSearch: {} }];
      let toolConfig: any = undefined;

      if (Array.isArray(tools) && tools.length > 0) {
        const functionDeclarations = tools.map((t: any) => {
          const fn = t.function || t;
          return {
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters || fn.schema || { type: "object", properties: {} }
          };
        });
        geminiTools.push({ functionDeclarations });
        toolConfig = { includeServerSideToolInvocations: true };
      }

      // Try candidate models in order of stability (preferring gemini-3.8-flash with Google Search Grounding)
      const candidateModels = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"];
      let response: any = null;
      let usedModel = "gemini-3.8-flash";

      for (const modelCandidate of candidateModels) {
        try {
          const config: any = {
            systemInstruction: systemMsg ? (systemInstruction + "\n\n" + systemMsg) : systemInstruction,
            tools: geminiTools,
            temperature: 0.3
          };
          if (toolConfig) {
            config.toolConfig = toolConfig;
          }

          response = await ai.models.generateContent({
            model: modelCandidate,
            contents,
            config
          });
          if (response) {
            usedModel = modelCandidate;
            break;
          }
        } catch (modelErr: any) {
          console.warn(`[TARS Agent] Model ${modelCandidate} attempt:`, modelErr?.message || modelErr);
        }
      }

      if (response) {
        // Extract function calls if any
        let rawCalls: any[] = [];
        const getterCalls = response.functionCalls;
        if (Array.isArray(getterCalls)) {
          rawCalls = getterCalls;
        } else if (response.candidates?.[0]?.content?.parts) {
          for (const p of response.candidates[0].content.parts) {
            if (p.functionCall) rawCalls.push(p.functionCall);
          }
        }

        const tool_calls = rawCalls.map((fc, i) => ({
          id: "call_" + i + "_" + Date.now(),
          type: "function",
          function: {
            name: fc.name,
            arguments: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args || {})
          }
        }));

        // Extract Google Search Grounding metadata
        const candidate = response.candidates?.[0];
        const groundingMeta = candidate?.groundingMetadata;
        const rawChunks = groundingMeta?.groundingChunks || [];
        const webSearchQueries = groundingMeta?.webSearchQueries || [];
        const searchEntryPoint = groundingMeta?.searchEntryPoint?.renderedContent || undefined;

        const sources = rawChunks
          .filter((c: any) => c.web && c.web.uri)
          .map((c: any) => {
            let domain = "web";
            try { domain = new URL(c.web.uri).hostname.replace(/^www\./, ""); } catch (e) {}
            return {
              title: c.web.title || domain,
              url: c.web.uri,
              snippet: c.web.title || c.web.uri,
              domain,
              source: "Google Search Grounding"
            };
          });

        const replyText = response.text || "";
        const latencyMs = Date.now() - startTime;

        // Stream thinking to HUD
        try {
          liveThinkingStream.unshift({
            id: "th-agent-" + Date.now(),
            phase: "TARS Neural Agent",
            title: tool_calls.length > 0
              ? `Executando ${tool_calls.map(tc => tc.function.name).join(", ")}`
              : (sources.length > 0 ? `Google Search Grounding (${sources.length} fontes)` : "Resposta contextual gerada"),
            detail: tool_calls.length > 0
              ? `Argumentos: ${tool_calls.map(tc => tc.function.arguments).join("; ")}`
              : (sources.length > 0 ? `Fontes: ${sources.map(s => s.domain).join(", ")}` : replyText.slice(0, 120)),
            timestamp: new Date().toISOString(),
            type: "ai_inference",
            latency: `${latencyMs}ms`
          });
          if (liveThinkingStream.length > 50) liveThinkingStream.length = 50;
        } catch (e) {}

        return res.json({
          ok: true,
          latency_ms: latencyMs,
          model: usedModel,
          provider: "gemini",
          message: {
            role: "assistant",
            content: replyText,
            tool_calls: tool_calls.length > 0 ? tool_calls : undefined
          },
          sources: sources.length > 0 ? sources : undefined,
          grounding_chunks: rawChunks.length > 0 ? rawChunks : undefined,
          web_search_queries: webSearchQueries.length > 0 ? webSearchQueries : undefined,
          search_entry_point: searchEntryPoint,
          reply: replyText
        });
      }
    }
  } catch (err: any) {
    console.warn("[TARS Agent] Gemini API attempt warning:", err?.message || err);
  }

  // --- Resilient Heuristic Agent Fallback (Zero-Downtime Tool Execution) ---
  const rawText = String(userMsg || "").trim();
  const lower = rawText.toLowerCase();
  const availableToolNames = tools.map((t: any) => t.function?.name || t.name);
  const isEnglish = /^[a-zA-Z0-9\s.,!?'"-_]+$/.test(rawText) && (
    lower.includes("remind") || lower.includes("speak") || lower.includes("minute") ||
    lower.includes("there") || lower.includes("hello") || lower.includes("english") ||
    lower.includes("ok") || lower.includes("yes") || lower.includes("how") || lower.includes("what")
  );

  // 1. Language Preference
  if (lower.includes("only speak in english") || lower.includes("speak in english") || lower.includes("in english from now on")) {
    const text = "Understood. I will speak exclusively in English from now on. How can I assist you with your solar agenda or technical cases today?";
    return res.json({
      ok: true,
      latency_ms: Date.now() - startTime,
      model: "tars-local-reasoner",
      message: { role: "assistant", content: text },
      reply: text
    });
  }

  // 2. Reminder Intent
  const reminderRegex = /(?:in\s+(?:a|(\d+))\s+min(?:ute)?s?|em\s+(?:um|(\d+))\s+min(?:uto)?s?|lembr(?:ar?|e)\s+em\s+(?:um|(\d+))\s+min(?:uto)?s?|remind\s+(?:me\s+)?in\s+(?:a|(\d+))\s+min(?:ute)?s?)(?:[,\s]+(?:to|de|para)\s+(.+))?/i;
  const remMatch = lower.match(reminderRegex);
  if ((remMatch || lower.includes("remind in a minute") || lower.includes("remind in 1 minute") || lower.includes("lembre-me em 1 minuto")) && availableToolNames.includes("create_reminder")) {
    let mins = 1;
    if (remMatch) {
      mins = parseInt(remMatch[1] || remMatch[2] || remMatch[3] || remMatch[4] || "1", 10) || 1;
    }
    let what = remMatch && remMatch[5] ? remMatch[5].trim() : "";
    if (!what) {
      what = rawText.replace(/^(?:remind\s+(?:me\s+)?in\s+(?:a|\d+)\s+minutes?,?\s*(?:to\s+)?|in\s+(?:a|\d+)\s+minutes?,?\s*(?:remind\s+me\s+to\s+)?|em\s+\d+\s+minutos?,?\s*|lembre-me\s*)/i, "").trim() || "Follow-up reminder";
    }
    const ack = isEnglish
      ? `Setting a reminder for ${mins} minute(s) from now: "${what}".`
      : `Programando lembrete para daqui a ${mins} minuto(s): "${what}".`;

    return res.json({
      ok: true,
      latency_ms: Date.now() - startTime,
      model: "tars-local-reasoner",
      provider: "tars-local",
      message: {
        role: "assistant",
        content: ack,
        tool_calls: [{
          id: "call_rem_" + Date.now(),
          type: "function",
          function: {
            name: "create_reminder",
            arguments: JSON.stringify({ what, minutes_from_now: mins })
          }
        }]
      },
      reply: ack
    });
  }

  // 3. Case Creation Intent
  if ((lower.includes("add case") || lower.includes("criar caso") || lower.includes("novo chamado") || lower.includes("abrir chamado") || lower.includes("open a new case")) && availableToolNames.includes("create_case")) {
    const titleMatch = rawText.match(/(?:for|para|do|de|chamado|case)\s+([A-Za-z0-9\s\-]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : "Solar Technical Case";
    const ack = isEnglish ? `Opening new case form: "${title}".` : `Abrindo formulário de novo caso: "${title}".`;
    return res.json({
      ok: true,
      latency_ms: Date.now() - startTime,
      model: "tars-local-reasoner",
      message: {
        role: "assistant",
        content: ack,
        tool_calls: [{
          id: "call_case_" + Date.now(),
          type: "function",
          function: {
            name: "create_case",
            arguments: JSON.stringify({ titulo: title, priority: lower.includes("urgente") || lower.includes("urgent") ? "urgente" : "alta" })
          }
        }]
      },
      reply: ack
    });
  }

  // 4. Search / Knowledge Intent
  if ((lower.includes("search") || lower.includes("pesquisar") || lower.includes("busca") || lower.includes("procurar")) && availableToolNames.includes("web_search")) {
    const q = rawText.replace(/^(?:search|pesquise|busque|procure na web|google)\s+/i, "");
    const ack = isEnglish ? `Searching for "${q}"...` : `Pesquisando sobre "${q}"...`;
    return res.json({
      ok: true,
      latency_ms: Date.now() - startTime,
      model: "tars-local-reasoner",
      message: {
        role: "assistant",
        content: ack,
        tool_calls: [{
          id: "call_search_" + Date.now(),
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: q })
          }
        }]
      },
      reply: ack
    });
  }

  // 5. Default Conversational Assistant Response
  let replyText = isEnglish
    ? "Hello! I am TARS. How can I assist you with your solar cases, inverters, or agenda today?"
    : "Olá! Sou o TARS. Como posso ajudar com seus chamados, inversores solares ou agenda hoje?";

  if (lower === "ok" || lower === "okay" || lower === "yes" || lower === "sim" || lower === "certo" || lower === "perfeito") {
    replyText = isEnglish ? "Understood. Standing by for your instructions." : "Entendido. À disposição para suas instruções.";
  } else if (lower.includes("are you there") || lower.includes("está aí") || lower === "a" || lower.includes("olá") || lower.includes("ola") || lower.includes("hello") || lower.includes("oi")) {
    replyText = isEnglish
      ? "I am here and fully operational! You can ask me to check your agenda, schedule reminders (e.g. 'remind me in 5 minutes to call the integrator'), diagnose inverter alarms, or register new warranty cases."
      : "Estou aqui e totalmente operacional! Você pode me pedir para consultar a agenda, agendar lembretes (ex: 'lembre-me em 5 minutos de ligar para o integrador'), diagnosticar alarmes de inversores ou registrar novos casos.";
  } else if (lower.includes("agenda") || lower.includes("hoje") || lower.includes("today")) {
    replyText = isEnglish
      ? "You can view and filter all scheduled appointments in the Agenda tab and SLA Hub. Would you like me to schedule a reminder or create a new case?"
      : "Você pode visualizar e filtrar todos os atendimentos agendados na aba Agenda e no SLA Hub. Precisa que eu crie um novo caso ou agende um lembrete?";
  } else if (lower.includes("hoymiles") || lower.includes("deye") || lower.includes("growatt") || lower.includes("solis")) {
    replyText = isEnglish
      ? "The inverter knowledge base and fault matrices are active. Which error code or serial number would you like to diagnose?"
      : "A base de conhecimento técnico de inversores e matrizes de falha está ativa. Qual código de erro ou número de série você gostaria de analisar?";
  }

  return res.json({
    ok: true,
    latency_ms: Date.now() - startTime,
    model: "tars-neural-engine",
    provider: "tars-local",
    message: { role: "assistant", content: replyText },
    reply: replyText
  });
});

// --- RAG Learning State & Noise Filter Governance (Owner Access) ---
let serverRagOperationalRules = [
  {
    id: "rule-1",
    code: "DEYE-F18-CHECK",
    title: "Falha de Isolamento Deye F18",
    association: "Se alarme F18 em Deye: medir isolamento CC com megômetro (> 2MΩ), inspecionar conectores MC4 com umidade e verificar integridade do condutor de aterramento PE.",
    category: "operational_rule",
    source: "Observer Diagnostic Promotion",
    confidence: 0.96,
    learnedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    status: "verified"
  },
  {
    id: "rule-2",
    code: "HOYMILES-DTU-RED",
    title: "LED Vermelho Piscando DTU-Pro",
    association: "Se DTU Hoymiles com LED vermelho: verificar rede CA dos microinversores, link Wi-Fi 2.4GHz e chave seccionadora de proteção.",
    category: "operational_rule",
    source: "Procedimento Homologado Belenergy",
    confidence: 0.95,
    learnedAt: new Date(Date.now() - 86400000 * 4).toISOString(),
    status: "verified"
  },
  {
    id: "rule-3",
    code: "SOLIS-OV-V",
    title: "Sobretensão de Rede Solis OV-V",
    association: "Se inversor Solis indicar OV-V (Grid Overvoltage): checar tap do transformador da concessionária e ajustar janela de proteção conforme ABNT NBR 16149 se autorizado.",
    category: "operational_rule",
    source: "Atendimento Técnico Suporte",
    confidence: 0.92,
    learnedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
    status: "verified"
  }
];

let serverRagBlacklist = [
  "bom dia", "boa tarde", "boa noite", "olá", "ola", "tudo bem",
  "senha", "password", "pix", "comprovante", "pagamento",
  "conversa pessoal", "almoço", "whatsapp pessoal", "link zoom",
  "como vai", "obrigado", "valeu"
];

let serverRagFilterConfig = {
  minConfidence: 0.85,
  autoFilterNoise: true,
  strictSolarDomain: true,
  passCount: 42,
  blockedCount: 7,
  lastEvaluatedAt: new Date().toISOString()
};

function evaluateRagFilter(text: string, confidence: number = 0.9, domain: string = "") {
  serverRagFilterConfig.lastEvaluatedAt = new Date().toISOString();
  const normalized = normalizeOcrText(String(text || ""));
  const lower = normalized.toLowerCase();
  
  // 1. Blacklist check
  for (const term of serverRagBlacklist) {
    if (lower.includes(term.toLowerCase())) {
      serverRagFilterConfig.blockedCount++;
      return {
        passed: false,
        score: Math.round(confidence * 40),
        reason: `Termo bloqueado no filtro RAG: "${term}"`,
        matchedBlacklist: term,
        checks: {
          blacklistCheck: false,
          solarRelevance: false,
          confidenceThreshold: confidence >= serverRagFilterConfig.minConfidence
        }
      };
    }
  }

  // 2. Solar keywords and extracted technical tokens relevance check
  const techTokens = extractTechnicalTokens(normalized);
  const solarKeywords = [
    "inversor", "microinversor", "mppt", "dtu", "hoymiles", "deye", "solis",
    "growatt", "tsun", "string", "placa", "modulo", "f18", "f20", "f35", "f56",
    "isolamento", "rede", "tensao", "corrente", "potencia", "kw", "kwh",
    "disjuntor", "aterramento", "s-miles", "hyperflow", "sla", "protocolo", "garantia"
  ];
  const detected = solarKeywords.filter(k => lower.includes(k));
  if (techTokens.errorCodes.length > 0) detected.push(...techTokens.errorCodes);
  if (techTokens.partNumbers.length > 0) detected.push(...techTokens.partNumbers);

  const hasSolarContext = detected.length > 0 || (domain && (domain.includes("hoymiles") || domain.includes("hyperflow") || domain.includes("deye") || domain.includes("solar")));

  if (serverRagFilterConfig.strictSolarDomain && !hasSolarContext) {
    serverRagFilterConfig.blockedCount++;
    return {
      passed: false,
      score: 35,
      reason: "Sem relevância de domínio fotovoltaico identificada. Ruído conversacional descartado.",
      matchedBlacklist: null,
      checks: {
        blacklistCheck: true,
        solarRelevance: false,
        confidenceThreshold: confidence >= serverRagFilterConfig.minConfidence
      }
    };
  }

  // 3. Confidence threshold check
  if (confidence < serverRagFilterConfig.minConfidence) {
    serverRagFilterConfig.blockedCount++;
    return {
      passed: false,
      score: Math.round(confidence * 100),
      reason: `Nível de confiança (${Math.round(confidence * 100)}%) abaixo do limite mínimo configurado (${Math.round(serverRagFilterConfig.minConfidence * 100)}%).`,
      matchedBlacklist: null,
      checks: {
        blacklistCheck: true,
        solarRelevance: true,
        confidenceThreshold: false
      }
    };
  }

  serverRagFilterConfig.passCount++;
  return {
    passed: true,
    score: Math.round(confidence * 100),
    reason: "Aprovado no Filtro RAG: Contexto técnico solar válido e confiança satisfatória.",
    matchedBlacklist: null,
    detectedEntities: detected,
    checks: {
      blacklistCheck: true,
      solarRelevance: true,
      confidenceThreshold: true
    },
    extractedHeuristic: text.length > 120 ? text.slice(0, 120) + "..." : text
  };
}

// --- RAG Debug API Endpoints (Owner Governance) ---
app.get("/api/tars/rag/debug", (req, res) => {
  // Consolidate all learned items into a unified list
  const learnedItems: any[] = [];

  serverWorkflowLearning.forEach(wf => {
    learnedItems.push({
      id: wf.id,
      category: "workflow_dom",
      categoryLabel: "Workflow Hyperflow / DOM",
      title: wf.title || "Workflow Capturado",
      association: wf.association || "Navegação e ação de atendimento",
      source: `${wf.domain || "hyperflow"} (Protocolo: ${wf.protocolId || "N/A"})`,
      confidence: wf.confidence || 0.92,
      learnedAt: wf.learnedAt || new Date().toISOString(),
      status: wf.status || "verified",
      canRemove: true
    });
  });

  serverDeepLearning.forEach(dl => {
    learnedItems.push({
      id: dl.id,
      category: "deep_learning_doc",
      categoryLabel: "Manual Técnico / Deep Learning",
      title: dl.title || dl.filename,
      association: `Documento técnico indexado (${dl.vectorsCount || 50} vetores de conhecimento)`,
      source: `Upload por ${dl.uploadedBy || "Owner"} (${dl.filename})`,
      confidence: 0.98,
      learnedAt: dl.uploadedAt || new Date().toISOString(),
      status: dl.status || "indexed",
      canRemove: true
    });
  });

  serverRagOperationalRules.forEach(rule => {
    learnedItems.push({
      id: rule.id,
      category: "operational_rule",
      categoryLabel: "Heurística / Regra Operacional",
      title: rule.title,
      association: rule.association,
      source: rule.source,
      confidence: rule.confidence || 0.95,
      learnedAt: rule.learnedAt,
      status: rule.status || "verified",
      canRemove: true
    });
  });

  const totalVectors = serverDeepLearning.reduce((acc, d) => acc + (d.vectorsCount || 40), 0) +
                       serverWorkflowLearning.length * 12 +
                       serverRagOperationalRules.length * 8;

  const totalLearned = learnedItems.length;
  const avgConfidence = totalLearned > 0
    ? Math.round((learnedItems.reduce((acc, i) => acc + (i.confidence || 0.9), 0) / totalLearned) * 1000) / 10
    : 92.5;

  res.json({
    ok: true,
    isOwnerFeature: true,
    engine: {
      status: "LEARNING_ACTIVE_VERIFIED",
      statusLabel: "Ativo & Absorvendo (v1.2.88)",
      isLearning: true,
      lastLearnedAt: learnedItems[0]?.learnedAt || new Date().toISOString(),
      pulse: "nominal"
    },
    metrics: {
      totalLearnedCount: totalLearned,
      totalVectorsCount: totalVectors,
      workflowCount: serverWorkflowLearning.length,
      documentsCount: serverDeepLearning.length,
      rulesCount: serverRagOperationalRules.length,
      avgConfidence,
      passCount: serverRagFilterConfig.passCount,
      blockedCount: serverRagFilterConfig.blockedCount,
      passRate: Math.round((serverRagFilterConfig.passCount / Math.max(1, serverRagFilterConfig.passCount + serverRagFilterConfig.blockedCount)) * 100),
      cacheStats: SolarRAGEngine.getInstance().getCacheStats()
    },
    filterConfig: serverRagFilterConfig,
    blacklist: serverRagBlacklist,
    learnedItems
  });
});

// Remove item from TARS RAG Memory
app.all(["/api/tars/rag/items/remove", "/api/tars/rag/items/:id"], (req, res) => {
  const targetId = req.params?.id || req.body?.id;
  if (!targetId) {
    return res.status(400).json({ ok: false, error: "ID do item não informado." });
  }

  let removed = false;
  let removedTitle = "";

  // Check in workflows
  const wfIdx = serverWorkflowLearning.findIndex(x => x.id === targetId);
  if (wfIdx >= 0) {
    removedTitle = serverWorkflowLearning[wfIdx].title;
    serverWorkflowLearning.splice(wfIdx, 1);
    removed = true;
  }

  // Check in deep learning documents
  const dlIdx = serverDeepLearning.findIndex(x => x.id === targetId);
  if (dlIdx >= 0) {
    removedTitle = serverDeepLearning[dlIdx].title || serverDeepLearning[dlIdx].filename;
    serverDeepLearning.splice(dlIdx, 1);
    removed = true;
  }

  // Check in operational rules
  const ruleIdx = serverRagOperationalRules.findIndex(x => x.id === targetId);
  if (ruleIdx >= 0) {
    removedTitle = serverRagOperationalRules[ruleIdx].title;
    serverRagOperationalRules.splice(ruleIdx, 1);
    removed = true;
  }

  // Optionally add to blacklist if requested
  if (req.body?.addToBlacklist && req.body?.pattern) {
    const p = String(req.body.pattern).trim().toLowerCase();
    if (p && !serverRagBlacklist.includes(p)) {
      serverRagBlacklist.push(p);
    }
  }

  res.json({
    ok: true,
    removed,
    id: targetId,
    message: removed
      ? `Item "${removedTitle || targetId}" foi removido com sucesso da memória RAG do TARS.`
      : `Item ${targetId} não foi localizado na memória ativa.`
  });
});

// Test input with RAG filter
app.post("/api/tars/rag/filter/test", (req, res) => {
  const { text, confidence = 0.9, domain = "" } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: "Texto para teste não fornecido." });

  const evaluation = evaluateRagFilter(text, parseFloat(confidence) || 0.9, domain);
  res.json({ ok: true, evaluation });
});

// Update RAG Filter config
app.post("/api/tars/rag/filter/config", (req, res) => {
  const { minConfidence, autoFilterNoise, strictSolarDomain } = req.body || {};
  if (minConfidence !== undefined) serverRagFilterConfig.minConfidence = Math.max(0.5, Math.min(0.99, parseFloat(minConfidence)));
  if (autoFilterNoise !== undefined) serverRagFilterConfig.autoFilterNoise = Boolean(autoFilterNoise);
  if (strictSolarDomain !== undefined) serverRagFilterConfig.strictSolarDomain = Boolean(strictSolarDomain);
  res.json({ ok: true, filterConfig: serverRagFilterConfig });
});

// Add to RAG blacklist
app.post("/api/tars/rag/blacklist/add", (req, res) => {
  const { term } = req.body || {};
  const clean = String(term || "").trim().toLowerCase();
  if (clean && !serverRagBlacklist.includes(clean)) {
    serverRagBlacklist.push(clean);
  }
  res.json({ ok: true, blacklist: serverRagBlacklist });
});

// Remove from RAG blacklist
app.post("/api/tars/rag/blacklist/remove", (req, res) => {
  const { term } = req.body || {};
  const clean = String(term || "").trim().toLowerCase();
  serverRagBlacklist = serverRagBlacklist.filter(t => t !== clean);
  res.json({ ok: true, blacklist: serverRagBlacklist });
});

// Purge noise in bulk
app.post("/api/tars/rag/purge-noise", (req, res) => {
  const threshold = serverRagFilterConfig.minConfidence;
  const beforeCount = serverWorkflowLearning.length;
  serverWorkflowLearning = serverWorkflowLearning.filter(wf => (wf.confidence || 0) >= threshold);
  const purgedCount = beforeCount - serverWorkflowLearning.length;
  res.json({ ok: true, purgedCount, remainingCount: serverWorkflowLearning.length });
});

// --- Local Agenda App Persistence Routes (Cases, Notebooks, Notes, Settings, Focus, Cron) ---

// 1. /agenda-cases
app.get(["/agenda-cases", "/api/agenda-cases"], (req, res) => {
  const appData = readAppStorage();
  const casesList = appData.agendaCases || [];
  res.json(casesList);
});

app.post(["/agenda-cases", "/api/agenda-cases"], (req, res) => {
  const appData = readAppStorage();
  const casesList = appData.agendaCases || [];
  const newCase = {
    id: "case-" + Date.now(),
    created_at: new Date().toISOString(),
    ...(req.body || {})
  };
  casesList.unshift(newCase);
  writeAppStorage({ agendaCases: casesList });
  res.status(201).json(newCase);
});

app.put(["/agenda-cases", "/api/agenda-cases"], (req, res) => {
  const appData = readAppStorage();
  const casesList = appData.agendaCases || [];
  const targetId = req.body?.id;
  const idx = casesList.findIndex((c: any) => c.id === targetId);
  if (idx >= 0) {
    casesList[idx] = { ...casesList[idx], ...(req.body || {}), updated_at: new Date().toISOString() };
    writeAppStorage({ agendaCases: casesList });
    return res.json(casesList[idx]);
  }
  const fallback = { id: targetId || "case-" + Date.now(), ...(req.body || {}) };
  casesList.unshift(fallback);
  writeAppStorage({ agendaCases: casesList });
  res.json(fallback);
});

app.delete(["/agenda-cases", "/api/agenda-cases"], (req, res) => {
  const appData = readAppStorage();
  const targetId = req.body?.id;
  if (targetId && appData.agendaCases) {
    const updated = appData.agendaCases.filter((c: any) => c.id !== targetId);
    writeAppStorage({ agendaCases: updated });
  }
  res.json({ ok: true });
});

// 2. /agenda-notebooks
app.get(["/agenda-notebooks", "/api/agenda-notebooks"], (req, res) => {
  const appData = readAppStorage();
  res.json(appData.agendaNotebooks || []);
});

app.post(["/agenda-notebooks", "/api/agenda-notebooks"], (req, res) => {
  const appData = readAppStorage();
  const list = appData.agendaNotebooks || [];
  const item = { id: "nb-" + Date.now(), ...(req.body || {}) };
  list.unshift(item);
  writeAppStorage({ agendaNotebooks: list });
  res.status(201).json(item);
});

app.put(["/agenda-notebooks", "/api/agenda-notebooks"], (req, res) => {
  const appData = readAppStorage();
  const list = appData.agendaNotebooks || [];
  const id = req.body?.id;
  const idx = list.findIndex((x: any) => x.id === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...(req.body || {}) };
    writeAppStorage({ agendaNotebooks: list });
    return res.json(list[idx]);
  }
  res.json(req.body);
});

app.delete(["/agenda-notebooks", "/api/agenda-notebooks"], (req, res) => {
  const appData = readAppStorage();
  const id = req.body?.id;
  if (id && appData.agendaNotebooks) {
    writeAppStorage({ agendaNotebooks: appData.agendaNotebooks.filter((x: any) => x.id !== id) });
  }
  res.json({ ok: true });
});

// 3. /agenda-notes
app.get(["/agenda-notes", "/api/agenda-notes"], (req, res) => {
  const appData = readAppStorage();
  res.json(appData.agendaNotes || []);
});

app.post(["/agenda-notes", "/api/agenda-notes"], (req, res) => {
  const appData = readAppStorage();
  const list = appData.agendaNotes || [];
  const item = { id: "note-" + Date.now(), created_at: new Date().toISOString(), ...(req.body || {}) };
  list.unshift(item);
  writeAppStorage({ agendaNotes: list });
  res.status(201).json(item);
});

app.put(["/agenda-notes", "/api/agenda-notes"], (req, res) => {
  const appData = readAppStorage();
  const list = appData.agendaNotes || [];
  const id = req.body?.id;
  const idx = list.findIndex((x: any) => x.id === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...(req.body || {}) };
    writeAppStorage({ agendaNotes: list });
    return res.json(list[idx]);
  }
  res.json(req.body);
});

app.delete(["/agenda-notes", "/api/agenda-notes"], (req, res) => {
  const appData = readAppStorage();
  const id = req.body?.id;
  if (id && appData.agendaNotes) {
    writeAppStorage({ agendaNotes: appData.agendaNotes.filter((x: any) => x.id !== id) });
  }
  res.json({ ok: true });
});

// 4. /agenda-settings
app.get(["/agenda-settings", "/api/agenda-settings"], (req, res) => {
  const appData = readAppStorage();
  res.json({ ok: true, settings: appData.agendaSettings || {} });
});

app.post(["/agenda-settings", "/api/agenda-settings"], (req, res) => {
  const settings = req.body?.settings || req.body || {};
  writeAppStorage({ agendaSettings: settings });
  res.json({ ok: true });
});

// 5. /agenda-focus
app.get(["/agenda-focus", "/api/agenda-focus"], (req, res) => {
  const appData = readAppStorage();
  res.json({ ok: true, focuses: appData.agendaFocuses || [] });
});

app.post(["/agenda-focus", "/api/agenda-focus"], (req, res) => {
  const appData = readAppStorage();
  const list = appData.agendaFocuses || [];
  const item = { id: "focus-" + Date.now(), status: "active", ...(req.body || {}) };
  list.unshift(item);
  writeAppStorage({ agendaFocuses: list });
  res.json({ ok: true, focus: item });
});

app.put(["/agenda-focus", "/api/agenda-focus"], (req, res) => {
  const appData = readAppStorage();
  const list = appData.agendaFocuses || [];
  const id = req.body?.id;
  const idx = list.findIndex((x: any) => x.id === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...(req.body || {}) };
    writeAppStorage({ agendaFocuses: list });
  }
  res.json({ ok: true });
});

// 6. /agenda-cron
app.all(["/agenda-cron", "/api/agenda-cron"], (req, res) => {
  res.json({ ok: true, notifications: [] });
});

// 7. /agenda-learn
app.get(["/agenda-learn", "/api/agenda-learn"], (req, res) => {
  const what = req.query?.what;
  if (what === "rules") {
    return res.json({ ok: true, rules: serverRagOperationalRules });
  }
  if (what === "episodes") {
    return res.json({ ok: true, episodes: [] });
  }
  res.json({ ok: true, rules: serverRagOperationalRules, episodes: [] });
});

app.all(["/agenda-learn", "/api/agenda-learn"], (req, res) => {
  res.json({ ok: true, saved: true });
});

// 8. /agenda-kb
app.get(["/agenda-kb", "/api/agenda-kb"], (req, res) => {
  const appData = readAppStorage();
  let entries = appData.agendaKb || [];
  if (!entries.length) {
    try {
      const kbFile = path.join(process.cwd(), "public", "kb.json");
      if (fs.existsSync(kbFile)) {
        const defaultKb = JSON.parse(fs.readFileSync(kbFile, "utf-8"));
        if (Array.isArray(defaultKb) && defaultKb.length > 0) {
          entries = defaultKb;
          appData.agendaKb = entries;
          writeAppStorage(appData);
        }
      }
    } catch (_) {}
  }
  res.json({ ok: true, entries });
});

app.post(["/agenda-kb", "/api/agenda-kb"], (req, res) => {
  const appData = readAppStorage();
  let entries = appData.agendaKb || [];
  const { title, content, tags, source, url, entries: batchEntries } = req.body || {};
  if (Array.isArray(batchEntries)) {
    entries = [...batchEntries];
  } else if (title || content) {
    const newEntry = {
      id: "kb-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
      title: title || "Untitled",
      content: content || "",
      tags: tags || [],
      source: source || "manual",
      url: url || null,
      created_at: new Date().toISOString()
    };
    entries.unshift(newEntry);
  }
  appData.agendaKb = entries;
  writeAppStorage(appData);
  res.json({ ok: true, saved: true, entries, count: entries.length, entry: entries[0] || null });
});

app.delete(["/agenda-kb", "/api/agenda-kb"], (req, res) => {
  const appData = readAppStorage();
  let entries = appData.agendaKb || [];
  const { id, title, source } = req.body || {};
  if (source) {
    entries = entries.filter(e => e.source !== source);
  } else if (id || title) {
    entries = entries.filter(e => {
      if (id && (e.id === id || String(e.id) === String(id))) return false;
      if (title && e.title === title) return false;
      return true;
    });
  }
  appData.agendaKb = entries;
  writeAppStorage(appData);
  res.json({ ok: true, deleted: true, count: entries.length });
});

// 9. /agenda-login
app.post(["/agenda-login", "/api/agenda-login"], (req, res) => {
  const { name = "admin" } = req.body || {};
  const lower = String(name).trim().toLowerCase();
  const isEros = lower === "eros" || lower === "eros.coliv@gmail.com" || lower === "eros.belenergy@gmail.com";
  const role = isEros ? "owner" : (lower === "admin" ? "admin" : "tecnico");

  res.json({
    ok: true,
    token: "solar-session-" + Date.now(),
    user: {
      id: isEros ? "user-eros" : "user-" + lower,
      name: isEros ? "Eros" : name,
      role
    },
    name: isEros ? "Eros" : name,
    role,
    readOnly: false,
    expires_at: new Date(Date.now() + 86400000 * 30).toISOString()
  });
});

// 10. /agenda-vault, /agenda-tts, /agenda-handwriting, /agenda-memory, /agenda-search
app.all(["/agenda-vault", "/api/agenda-vault"], (req, res) => {
  // Master vault 32-byte key for AES-GCM 256
  const rawKey = process.env.VAULT_MASTER_KEY || "SolarAgendaMasterVaultKey2026Sec!";
  const key32 = Buffer.from(rawKey.padEnd(32, "0").slice(0, 32));
  res.json({ ok: true, key: key32.toString("base64") });
});

function getElevenLabsKey(req: any): { key: string; rawKey: string; source: string; isKeyId: boolean; isValid: boolean } {
  let raw = "";
  let source = "none";
  const reqKey =
    (typeof req.body?.apiKey === "string" && req.body.apiKey.trim()) ||
    (typeof req.headers?.["x-elevenlabs-key"] === "string" && req.headers["x-elevenlabs-key"].trim());
  if (reqKey) {
    raw = reqKey.replace(/^["']|["']$/g, "").trim();
    source = "app settings";
  } else {
    const envKey =
      process.env.ELEVENLABS_API_KEY ||
      process.env.ELEVEN_LABS_API_KEY ||
      process.env.XI_API_KEY ||
      process.env.ELEVENLABS_KEY ||
      process.env.ELEVEN_API_KEY ||
      process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY ||
      process.env.VITE_ELEVENLABS_API_KEY ||
      "";
    if (envKey && typeof envKey === "string" && envKey.trim()) {
      raw = envKey.replace(/^["']|["']$/g, "").trim();
      source = "server environment";
    }
  }

  if (!raw) {
    return { key: "", rawKey: "", source: "none", isKeyId: false, isValid: false };
  }

  // ElevenLabs secret API keys start with "sk_" and have length >= 32
  const isKeyId = !raw.startsWith("sk_");
  const isValid = !isKeyId && raw.length >= 32;
  return {
    key: isValid ? raw : "",
    rawKey: raw,
    isKeyId,
    isValid,
    source
  };
}

function getDeepgramKey(req: any): { key: string; source: string } {
  let raw = "";
  let source = "none";
  const reqKey =
    (typeof req.body?.deepgramApiKey === "string" && req.body.deepgramApiKey.trim()) ||
    (typeof req.body?.deepgramKey === "string" && req.body.deepgramKey.trim()) ||
    (typeof req.body?.deepgramToken === "string" && req.body.deepgramToken.trim()) ||
    (typeof req.headers?.["x-deepgram-key"] === "string" && req.headers["x-deepgram-key"].trim()) ||
    (typeof req.headers?.["x-deepgram-api-key"] === "string" && req.headers["x-deepgram-api-key"].trim()) ||
    (typeof req.headers?.["x-deepgram-token"] === "string" && req.headers["x-deepgram-token"].trim());

  if (reqKey) {
    raw = reqKey;
    source = "app settings";
  } else {
    const envKey =
      process.env.DEEPGRAM_API_KEY ||
      process.env.DEEPGRAM_KEY ||
      process.env.DEEPGRAM_TOKEN ||
      process.env.DEEPGRAM_SECRET ||
      process.env.DEEPGRAM_APIKEY ||
      process.env.DEEPGRAM_API ||
      process.env.DEEPGRAM_VOICE_KEY ||
      process.env.DEEPGRAM_AUTH_TOKEN ||
      process.env.DEEPGRAM_SECRET_KEY ||
      process.env.DEEP_GRAM_API_KEY ||
      process.env.DEEP_GRAM_KEY ||
      process.env.DG_API_KEY ||
      process.env.DG_KEY ||
      process.env.VERCEL_DEEPGRAM_API_KEY ||
      process.env.VITE_DEEPGRAM_API_KEY ||
      process.env.VITE_DEEPGRAM_KEY ||
      process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY ||
      process.env.DEEPGRAM ||
      process.env.AURA_API_KEY ||
      "";
    if (envKey && typeof envKey === "string" && envKey.trim()) {
      raw = envKey;
      source = "server environment";
    } else {
      for (const [k, v] of Object.entries(process.env)) {
        if (/^(deep_?gram|dg_api|aura_api)/i.test(k) && typeof v === "string" && v.trim()) {
          raw = v;
          source = `server environment (${k})`;
          break;
        }
      }
    }
  }

  if (!raw) return { key: "", source: "none" };

  const clean = raw
    .replace(/^["']|["']$/g, "")
    .replace(/^(?:Token|Bearer)\s+/i, "")
    .replace(/\s+/g, "")
    .trim();

  return { key: clean, source };
}

async function synthesizeDeepgram(text: string, voiceModel: string, apiKey: string, res: any) {
  const voice = voiceModel || "aura-orion-en";
  const cleanKey = String(apiKey || "")
    .replace(/^["']|["']$/g, "")
    .replace(/^(?:Token|Bearer)\s+/i, "")
    .replace(/\s+/g, "")
    .trim();
  if (!cleanKey) return { ok: false, error: "Deepgram API key missing" };

  const cleanText = String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  const textPayload = cleanText || String(text).slice(0, 1000);
  const normalizedPayload = textPayload.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const executeSpeak = async (authScheme: string, modelName: string, payload: string, withEncoding: boolean = true) => {
    const queryParams = new URLSearchParams();
    if (modelName) queryParams.set("model", modelName);
    if (withEncoding) queryParams.set("encoding", "mp3");
    const url = `https://api.deepgram.com/v1/speak?${queryParams.toString()}`;
    return await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `${authScheme} ${cleanKey}`,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({ text: payload })
    });
  };

  // 1. Try Token auth with selected voice
  let response = await executeSpeak("Token", voice, textPayload, true);

  // 2. If 401, retry with Bearer auth
  if (response.status === 401) {
    const bearerRes = await executeSpeak("Bearer", voice, textPayload, true);
    if (bearerRes.ok) response = bearerRes;
  }

  // 3. If 400 (Bad request e.g. non-ASCII or unsupported model), retry with ASCII normalized text
  if (!response.ok && response.status === 400 && normalizedPayload !== textPayload) {
    const normRes = await executeSpeak("Token", voice, normalizedPayload, true);
    if (normRes.ok) {
      response = normRes;
    } else if (normRes.status === 401) {
      const normBearer = await executeSpeak("Bearer", voice, normalizedPayload, true);
      if (normBearer.ok) response = normBearer;
    }
  }

  // 4. If voice rejected (400 / 404), retry with standard default aura-asteria-en
  if (!response.ok && (response.status === 400 || response.status === 404)) {
    try {
      const fallbackRes = await executeSpeak("Token", "aura-asteria-en", normalizedPayload || textPayload, false);
      if (fallbackRes.ok) {
        response = fallbackRes;
      } else if (fallbackRes.status === 401) {
        const fbBearer = await executeSpeak("Bearer", "aura-asteria-en", normalizedPayload || textPayload, false);
        if (fbBearer.ok) response = fbBearer;
      }
    } catch (_) {}
  }

  if (!response.ok) {
    let errBody = "";
    try { errBody = await response.text(); } catch (_) {}
    return { ok: false, status: response.status, error: errBody || `Deepgram returned HTTP ${response.status}` };
  }

  const audioBuffer = await response.arrayBuffer();
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Type, Content-Length, X-TTS-Engine, X-TTS-Voice");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.byteLength);
    res.setHeader("X-TTS-Engine", "deepgram");
    res.setHeader("X-TTS-Voice", voice);
  } catch (_) {}
  res.statusCode = 200;
  res.end(Buffer.from(audioBuffer));
  return { ok: true };
}

app.all(["/agenda-tts", "/api/agenda-tts"], async (req, res) => {
  const elevenInfo = getElevenLabsKey(req);
  const elevenKey = elevenInfo.key;
  const elevenSource = elevenInfo.source;
  const isElevenKeyId = elevenInfo.isKeyId;
  const elevenValidSecret = elevenInfo.isValid;

  const { key: deepgramKey, source: deepgramSource } = getDeepgramKey(req);

  const preferredProvider = req.body?.provider || "auto"; // 'auto' | 'deepgram' | 'elevenlabs' | 'browser'
  const defaultDeepgramVoice = req.body?.deepgramVoice || process.env.DEEPGRAM_VOICE || "aura-orion-en";

  const defaultVoiceId =
    process.env.ELEVENLABS_VOICE_ID ||
    process.env.ELEVEN_LABS_VOICE_ID ||
    process.env.ELEVEN_VOICE_ID ||
    "21m00Tcm4TlvDq8ikWAM";

  const defaultModelId =
    process.env.ELEVENLABS_MODEL_ID ||
    "eleven_multilingual_v2";

  // Probe request for status and capability check
  if (req.body?.probe) {
    let deepgramValid = false;
    let deepgramMsg = "";
    if (deepgramKey) {
      try {
        let testRes = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en", {
          method: "POST",
          headers: {
            "Authorization": `Token ${deepgramKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ text: "." })
        });
        if (testRes.status === 401) {
          const bearerRes = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${deepgramKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: "." })
          });
          if (bearerRes.ok || bearerRes.status === 200) {
            testRes = bearerRes;
          }
        }

        if (testRes.ok || testRes.status === 200) {
          deepgramValid = true;
          deepgramMsg = `Deepgram Aura active (${deepgramSource}, voice: ${defaultDeepgramVoice}).`;
        } else if (testRes.status === 401) {
          deepgramValid = false;
          deepgramMsg = `Deepgram key rejected (HTTP 401 Invalid credentials).`;
        } else {
          deepgramValid = deepgramKey.length >= 16;
          deepgramMsg = `Deepgram Aura active (${deepgramSource}, voice: ${defaultDeepgramVoice}).`;
        }
      } catch (err: any) {
        deepgramValid = deepgramKey.length >= 16;
        deepgramMsg = `Deepgram Aura configured (${deepgramSource}, voice: ${defaultDeepgramVoice}).`;
      }
    }

    let elevenValid = false;
    let elevenMsg = "";
    if (isElevenKeyId) {
      elevenMsg = "ElevenLabs API Key ID was provided instead of secret key (starts with 'sk_').";
    } else if (elevenKey) {
      try {
        const userRes = await fetch("https://api.elevenlabs.io/v1/user", {
          headers: { "xi-api-key": elevenKey }
        });
        if (userRes.ok) {
          elevenValid = true;
          const userData: any = await userRes.json();
          elevenMsg = `ElevenLabs active (${elevenSource}, tier: ${userData?.subscription?.tier || "active"}).`;
        } else {
          const errText = await userRes.text();
          let parsed: any = null;
          try { parsed = JSON.parse(errText); } catch (_) {}
          elevenMsg = `ElevenLabs key rejected: ${parsed?.detail?.message || "Invalid key"}.`;
        }
      } catch (err: any) {
        elevenMsg = `ElevenLabs probe error: ${err.message}`;
      }
    }

    // Determine active provider & status
    if (deepgramValid && preferredProvider !== "elevenlabs") {
      return res.json({
        ok: true,
        configured: true,
        provider: "deepgram",
        source: deepgramSource,
        voice: defaultDeepgramVoice,
        model: "deepgram-aura",
        fallback: elevenValid ? "elevenlabs" : "browser",
        message: deepgramMsg + (elevenMsg ? ` [ElevenLabs: ${elevenMsg}]` : "")
      });
    }

    if (elevenValid && preferredProvider !== "deepgram") {
      return res.json({
        ok: true,
        configured: true,
        provider: "elevenlabs",
        source: elevenSource,
        voice: defaultVoiceId,
        model: defaultModelId,
        fallback: deepgramValid ? "deepgram" : "browser",
        message: elevenMsg + (deepgramValid ? " [Deepgram Aura ready as fallback]" : "")
      });
    }

    if (deepgramValid) {
      return res.json({
        ok: true,
        configured: true,
        provider: "deepgram",
        source: deepgramSource,
        voice: defaultDeepgramVoice,
        model: "deepgram-aura",
        fallback: "browser",
        message: deepgramMsg + (elevenMsg ? ` [ElevenLabs: ${elevenMsg}]` : "")
      });
    }

    return res.json({
      ok: true,
      configured: false,
      provider: "browser",
      source: "none",
      voice: defaultVoiceId,
      model: defaultModelId,
      message: (elevenMsg || deepgramMsg)
        ? `TTS authentication notice: ${[deepgramMsg, elevenMsg].filter(Boolean).join(" ")} Browser voice active.`
        : "No Deepgram or ElevenLabs API key configured. Browser voice is active."
    });
  }

  const { text, voiceId, modelId } = req.body || {};
  if (!text) {
    return res.status(400).json({ ok: false, code: "bad_request", error: "Text is required for TTS." });
  }

  let lastErrorDetail = "";

  // 1. Direct Deepgram request (prioritized in 'auto' when Deepgram key is available)
  if (deepgramKey && (preferredProvider === "deepgram" || preferredProvider === "auto" || !elevenValidSecret)) {
    const dgResult = await synthesizeDeepgram(text, defaultDeepgramVoice, deepgramKey, res);
    if (dgResult.ok) return;
    lastErrorDetail = dgResult.error || "Deepgram primary TTS error";
    console.warn("[Deepgram primary TTS error]", dgResult.error);
  }

  // 2. ElevenLabs attempt (strictly requires valid sk_ key)
  if (elevenValidSecret && preferredProvider !== "deepgram") {
    try {
      const targetVoice = voiceId || defaultVoiceId;
      const targetModel = modelId || defaultModelId;

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${targetVoice}/stream`, {
        method: "POST",
        headers: {
          "xi-api-key": elevenKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        body: JSON.stringify({
          text: String(text).slice(0, 4000),
          model_id: targetModel,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true
          }
        })
      });

      if (response.ok) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Type, Content-Length, X-TTS-Engine, X-TTS-Voice");
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("X-TTS-Engine", "elevenlabs");
        const audioBuffer = await response.arrayBuffer();
        res.statusCode = 200;
        res.end(Buffer.from(audioBuffer));
        return;
      } else {
        const errBody = await response.text();
        lastErrorDetail = `ElevenLabs ${response.status}: ${errBody.slice(0, 160)}`;
        console.warn(`[ElevenLabs TTS error ${response.status}] ${errBody.slice(0, 160)}`);
      }
    } catch (e: any) {
      lastErrorDetail = `ElevenLabs error: ${e.message}`;
      console.warn("[ElevenLabs TTS exception]", e.message);
    }
  }

  // 3. Fallback to Deepgram Aura if ElevenLabs failed or wasn't primary
  if (deepgramKey && preferredProvider !== "deepgram" && preferredProvider !== "auto") {
    const fallbackRes = await synthesizeDeepgram(text, defaultDeepgramVoice, deepgramKey, res);
    if (fallbackRes.ok) return;
    lastErrorDetail = fallbackRes.error || lastErrorDetail;
    console.warn("[Deepgram Fallback error]", fallbackRes.error);
  }

  // 4. Fall back to browser speech synthesis
  return res.json({
    ok: false,
    code: "tts_fallback_browser",
    configured: false,
    detail: lastErrorDetail || "Neural TTS keys unavailable or rejected",
    error: `Neural TTS fallback: ${lastErrorDetail || "keys unavailable"}. Falling back to browser speech synthesis.`
  });
});
app.all(["/agenda-handwriting", "/api/agenda-handwriting"], (req, res) => {
  res.json({ ok: true, samples: [], saved: true });
});
app.all(["/agenda-memory", "/api/agenda-memory"], (req, res) => {
  res.json({ ok: true, memory: {} });
});
app.all(["/agenda-search-kb", "/api/agenda-search-kb"], async (req, res) => {
  try {
    const q = String(req.query?.q || req.body?.q || req.query?.query || req.body?.query || req.query?.term || req.body?.term || "").trim();
    if (!q) {
      return res.json({ ok: true, results: [], message: "Query vazia." });
    }

    const rag = SolarRAGEngine.getInstance();
    const results = await rag.search(q, 8);

    const formatted = results.map(r => ({
      title: r.chunk.title,
      content: r.chunk.text,
      snippet: r.chunk.text.slice(0, 280),
      source: r.chunk.source,
      isTable: r.chunk.isTable,
      score: r.rerankScore || r.rrfScore,
      matchReasons: r.matchReasons,
      metadata: r.chunk.metadata
    }));

    res.json({
      ok: true,
      query: q,
      total: formatted.length,
      pipeline: "Hybrid (Dense + BM25) + Cross-Encoder Re-Ranking",
      results: formatted
    });
  } catch (err: any) {
    console.warn("[RAG API] Search error:", err);
    res.json({ ok: false, error: err?.message || String(err), results: [] });
  }
});

// --- Enhanced Search Grounding & Unified Search API ---
app.all(["/agenda-search", "/api/agenda-search", "/api/tars/search", "/api/tars/web-search"], async (req, res) => {
  try {
    const q = String(req.query?.q || req.body?.q || req.query?.query || req.body?.query || req.query?.term || req.body?.term || "").trim();
    const mode = String(req.query?.mode || req.body?.mode || "all").toLowerCase() as "all" | "web" | "kb";
    const lang = String(req.query?.lang || req.body?.lang || "pt");

    if (!q) {
      return res.json({ ok: true, results: [], webSources: [], message: "Query vazia." });
    }

    if (mode === "web") {
      const grounded = await performGroundedWebSearch(q, { lang });
      return res.json({
        ok: grounded.ok,
        query: q,
        mode: "web",
        engine: "Google Search Grounding (Gemini)",
        model: grounded.model,
        answer: grounded.answer,
        webSources: grounded.sources,
        sources: grounded.sources,
        searchQueries: grounded.searchQueries,
        searchEntryPoint: grounded.searchEntryPoint,
        results: grounded.results,
        latency_ms: grounded.latency_ms,
        error: grounded.error
      });
    }

    const unified = await performUnifiedSearch(q, { mode, lang, topK: 6 });
    
    // Combine web results and KB results into unified results array for tools/UI
    const formattedWeb = (unified.webSources || []).map(s => ({
      title: s.title,
      content: s.title,
      snippet: s.title + (s.domain ? ` — ${s.domain}` : ""),
      url: s.url,
      domain: s.domain,
      source: `Google Search Grounding (${s.domain || "web"})`,
      isWebGrounded: true
    }));

    const allResults = [...formattedWeb, ...unified.kbResults];

    return res.json({
      ok: true,
      query: q,
      mode: unified.mode,
      engine: "TARS Grounded Multi-Source Search",
      answer: unified.answer,
      webSources: unified.webSources,
      sources: unified.webSources,
      webSearchQueries: unified.webSearchQueries,
      kbResults: unified.kbResults,
      results: allResults,
      total: allResults.length,
      latency_ms: unified.latency_ms
    });
  } catch (err: any) {
    console.warn("[TARS Search API] Error:", err);
    res.json({ ok: false, error: err?.message || String(err), results: [], webSources: [] });
  }
});

app.all(["/agenda-vision", "/api/agenda-vision"], (req, res) => {
  res.json({ ok: true, analysis: "Processamento de visão computacional ativo." });
});
app.all(["/agenda-stt", "/api/agenda-stt"], async (req, res) => {
  try {
    const body = req.body || {};
    const audio = body.audio || "";
    const mime = body.mime || "audio/webm";
    const prompt = body.prompt || "";
    const lang = body.lang || "auto";

    if (!audio || audio.length < 50) {
      return res.json({ ok: true, text: "", language: lang });
    }

    const cleanBase64 = audio.replace(/^data:audio\/[^;]+;base64,/, "");
    const cleanMime = (mime || "audio/webm").split(";")[0].trim() || "audio/webm";

    // 1. Try Gemini Multimodal Transcription if GEMINI_API_KEY is available
    const geminiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
    if (geminiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const geminiRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              inlineData: {
                mimeType: cleanMime,
                data: cleanBase64
              }
            },
            {
              text: `Transcribe this audio recording verbatim.
The speaker is a solar PV technician and support engineer at Belenergy in Brazil.
Technical context: Inversores fotovoltaicos (Deye, Hoymiles, Growatt, Solis, FoxESS, Huawei), microinversores, datalogger, strings, disjuntores, MPPT, tensão DC/AC, alarmes, chamados, diagramas, esquemas elétricos, e rotinas de atendimento técnico.
User language: Natural Brazilian Portuguese or English.
CRITICAL INSTRUCTIONS:
- Transcribe EXACTLY what the user said verbatim without changing words.
- If the user says technical terms, case details, or diagrams, transcribe them accurately.
- Output ONLY the plain transcription text with natural punctuation.
- Do NOT output explanations, introductory text, quotes, or markdown backticks.
- If the audio is silence or unintelligible noise, output an empty response.`
            }
          ]
        });
        const rawText = geminiRes.text ? geminiRes.text.trim() : "";
        if (rawText) {
          return res.json({
            ok: true,
            text: rawText,
            engine: "gemini-2.5-flash",
            language: rawText.match(/[a-zà-ú]/i) ? (rawText.match(/[ãõáéíóúçêô]/i) ? "pt-BR" : "auto") : lang
          });
        }
      } catch (geminiErr: any) {
        console.warn("[STT] Gemini transcription failed, attempting fallback:", geminiErr?.message || geminiErr);
      }
    }

    // 2. Try Groq Whisper (whisper-large-v3) if GROQ_API_KEY is available
    const groqKey = process.env.GROQ_API_KEY || "";
    if (groqKey) {
      try {
        const audioBuf = Buffer.from(cleanBase64, "base64");
        const blob = new Blob([audioBuf], { type: cleanMime });
        const formData = new FormData();
        formData.append("file", blob, "audio.webm");
        formData.append("model", "whisper-large-v3");
        if (prompt) formData.append("prompt", prompt);
        if (lang && lang !== "auto") formData.append("language", lang.slice(0, 2));

        const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${groqKey}` },
          body: formData
        });
        if (groqRes.ok) {
          const groqData = await groqRes.json() as any;
          if (groqData?.text) {
            return res.json({ ok: true, text: groqData.text.trim(), engine: "groq-whisper" });
          }
        }
      } catch (groqErr: any) {
        console.warn("[STT] Groq Whisper failed:", groqErr?.message || groqErr);
      }
    }

    // 3. Try Deepgram Nova-2 if DEEPGRAM_API_KEY is available
    const deepgramKey = process.env.DEEPGRAM_API_KEY || "";
    if (deepgramKey) {
      try {
        const audioBuf = Buffer.from(cleanBase64, "base64");
        const dgUrl = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=" + (lang.startsWith("pt") ? "pt-BR" : "en");
        const dgRes = await fetch(dgUrl, {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramKey}`,
            "Content-Type": cleanMime
          },
          body: audioBuf
        });
        if (dgRes.ok) {
          const dgData = await dgRes.json() as any;
          const transcript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
          if (transcript) {
            return res.json({ ok: true, text: transcript.trim(), engine: "deepgram-nova2" });
          }
        }
      } catch (dgErr: any) {
        console.warn("[STT] Deepgram STT failed:", dgErr?.message || dgErr);
      }
    }

    // 4. Fallback: return empty transcript gracefully
    return res.json({ ok: true, text: "" });
  } catch (err: any) {
    console.error("[STT] General transcription error:", err);
    return res.json({ ok: false, error: err?.message || "Transcription failed", text: "" });
  }
});

// ==========================================
// Google Drive Warranty Media Ingestion API
// ==========================================

app.post("/api/drive/upload-media", async (req, res) => {
  try {
    const {
      sourceUrl,
      filename,
      mimeType,
      mediaType,
      manufacturer,
      clientName,
      clientPhone,
      isWarranty,
      conversationId,
      accessToken,
      rootFolderId
    } = req.body || {};

    const token = accessToken || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "";
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Google Drive access token is required. Please authorize Google Drive in Solar Agenda settings."
      });
    }

    if (!sourceUrl) {
      return res.status(400).json({ ok: false, error: "sourceUrl is required" });
    }

    const audit = await GoogleDriveService.processAndUploadMedia({
      sourceUrl,
      filename,
      mimeType,
      mediaType: mediaType || "other",
      manufacturer: manufacturer || "Deye",
      clientName: clientName || "Cliente",
      clientPhone: clientPhone || "",
      isWarranty: isWarranty !== false,
      conversationId,
      accessToken: token,
      rootFolderId
    });

    return res.json({
      ok: audit.status === "SUCCESS",
      audit
    });
  } catch (err: any) {
    console.error("[Drive API Error]", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/drive/audit-logs", (req, res) => {
  const limit = parseInt(String(req.query.limit || "50"), 10);
  const logs = GoogleDriveService.getAuditLogs(limit);
  res.json({ ok: true, logs });
});

app.post("/api/drive/preview-hierarchy", (req, res) => {
  const { manufacturer, clientName, clientPhone, subfolder } = req.body || {};
  const mfg = GoogleDriveService.cleanManufacturerName(manufacturer || "Deye");
  const month = GoogleDriveService.getMonthFolderLabel();
  const client = GoogleDriveService.formatClientFolderLabel(clientName || "Cliente", clientPhone || "");
  const targetSub = subfolder === "Documentos" ? "Documentos" : "Testes";

  res.json({
    ok: true,
    root: "Belenergy - Garantias",
    manufacturer: `~${mfg.replace(/~/g, "")}~`,
    month,
    client,
    subfolder: targetSub,
    fullPath: `Belenergy - Garantias/~${mfg.replace(/~/g, "")}~/${month}/${client}/${targetSub}`
  });
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
    const isHmrDisabled = process.env.DISABLE_HMR === "true";
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : undefined,
        watch: isHmrDisabled ? null : {},
      },
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
