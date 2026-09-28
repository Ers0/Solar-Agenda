import { sendResponse, handleCors } from "../_smtp.js";
import { readAppStorage, getStoragePath } from "../_storage.js";
import fs from "fs";

export default function handler(req, res) {
  if (handleCors(req, res)) return;

  const url = req.url || "";
  const isDiagnostics = req.query?.diagnostics === "true" || url.includes("/diagnostics");

  if (!isDiagnostics) {
    return sendResponse(res, 200, {
      status: "ok",
      service: "Solar Agenda API (Vercel Serverless Ready)",
      timestamp: new Date().toISOString()
    });
  }

  // Detailed diagnostics probe
  const storagePath = getStoragePath();
  const storage = readAppStorage();
  let storageWritable = false;
  let fileSizeBytes = 0;

  try {
    if (fs.existsSync(storagePath)) {
      const stats = fs.statSync(storagePath);
      fileSizeBytes = stats.size;
      fs.accessSync(storagePath, fs.constants.R_OK | fs.constants.W_OK);
      storageWritable = true;
    } else {
      storageWritable = true;
    }
  } catch (_) {
    storageWritable = false;
  }

  const mem = process.memoryUsage ? process.memoryUsage() : { rss: 0, heapTotal: 0, heapUsed: 0 };
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasDeepgram = Boolean(process.env.DEEPGRAM_API_KEY);
  const hasSmtp = Boolean(process.env.SMTP_USER && (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD));
  const hasJira = Boolean(process.env.JIRA_API_TOKEN || storage?.jiraConfig?.token);
  const hasDrive = Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN);

  return sendResponse(res, 200, {
    status: storageWritable ? "ok" : "degraded",
    service: "Solar Agenda API (Vercel Serverless Ready)",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime ? process.uptime() : 0),
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      memoryMb: {
        rss: Math.round(mem.rss / (1024 * 1024)),
        heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
        heapUsed: Math.round(mem.heapUsed / (1024 * 1024))
      }
    },
    storage: {
      activePath: storagePath,
      isWritable: storageWritable,
      fileSizeBytes,
      records: {
        contacts: Array.isArray(storage?.contacts) ? storage.contacts.length : 0,
        slaCases: Array.isArray(storage?.slaCases) ? storage.slaCases.length : 0,
        tarsObserverCases: Array.isArray(storage?.tarsObserverCases) ? storage.tarsObserverCases.length : 0,
        jiraWebhookLogs: Array.isArray(storage?.jiraWebhookLogs) ? storage.jiraWebhookLogs.length : 0
      }
    },
    integrations: {
      gemini: { configured: hasGemini, defaultModel: "gemini-2.5-flash" },
      deepgram: { configured: hasDeepgram, ttsEngine: "aura-asteria-en / aura-2", sttEngine: "nova-2" },
      smtp: { configured: hasSmtp, host: process.env.SMTP_HOST || (process.env.SMTP_USER?.toLowerCase().endsWith("@gmail.com") ? "smtp.gmail.com" : null) },
      jira: { configured: hasJira, host: process.env.JIRA_HOST || storage?.jiraConfig?.host || null },
      googleDrive: { configured: hasDrive }
    }
  });
}
