import fs from "fs";
import path from "path";
import os from "os";

export interface DiagnosticsReport {
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSeconds: number;
  uptimeFormatted: string;
  system: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpus: number;
    memoryMb: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
    };
    freeSystemMemoryMb: number;
    totalSystemMemoryMb: number;
  };
  storage: {
    activePath: string;
    isWritable: boolean;
    fileSizeBytes: number;
    stats: {
      contactsCount: number;
      slaCasesCount: number;
      observerCasesCount: number;
      jiraWebhookLogsCount: number;
      slaWebhookLogsCount: number;
      processedEventsCount: number;
    };
  };
  integrations: {
    gemini: { configured: boolean; defaultModel: string };
    deepgram: { configured: boolean; ttsEngine: string; sttEngine: string };
    smtp: { configured: boolean; host: string | null; user: string | null };
    jira: { configured: boolean; host: string | null };
    googleDrive: { configured: boolean };
  };
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function collectDiagnostics(storageData: any, storageFilePath: string): DiagnosticsReport {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor(process.uptime());

  // Test storage writability and file size
  let isWritable = false;
  let fileSizeBytes = 0;
  try {
    if (fs.existsSync(storageFilePath)) {
      const stats = fs.statSync(storageFilePath);
      fileSizeBytes = stats.size;
      fs.accessSync(storageFilePath, fs.constants.R_OK | fs.constants.W_OK);
      isWritable = true;
    } else {
      isWritable = true;
    }
  } catch (_) {
    isWritable = false;
  }

  // Count records
  const stats = {
    contactsCount: Array.isArray(storageData?.contacts) ? storageData.contacts.length : 0,
    slaCasesCount: Array.isArray(storageData?.slaCases) ? storageData.slaCases.length : 0,
    observerCasesCount: Array.isArray(storageData?.tarsObserverCases) ? storageData.tarsObserverCases.length : 0,
    jiraWebhookLogsCount: Array.isArray(storageData?.jiraWebhookLogs) ? storageData.jiraWebhookLogs.length : 0,
    slaWebhookLogsCount: Array.isArray(storageData?.slaWebhookLogs) ? storageData.slaWebhookLogs.length : 0,
    processedEventsCount: Array.isArray(storageData?.tarsProcessedEvents) ? storageData.tarsProcessedEvents.length : 0,
  };

  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasDeepgram = Boolean(process.env.DEEPGRAM_API_KEY);
  const hasSmtp = Boolean(process.env.SMTP_USER && (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD));
  const hasJira = Boolean(process.env.JIRA_API_TOKEN || storageData?.jiraConfig?.token);
  const hasDrive = Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN);

  const status: "ok" | "degraded" = isWritable ? "ok" : "degraded";

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: uptimeSec,
    uptimeFormatted: formatUptime(uptimeSec),
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus()?.length || 1,
      memoryMb: {
        rss: Math.round(mem.rss / (1024 * 1024)),
        heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
        heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
        external: Math.round(mem.external / (1024 * 1024)),
      },
      freeSystemMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
      totalSystemMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    },
    storage: {
      activePath: storageFilePath,
      isWritable,
      fileSizeBytes,
      stats,
    },
    integrations: {
      gemini: {
        configured: hasGemini,
        defaultModel: "gemini-2.5-flash",
      },
      deepgram: {
        configured: hasDeepgram,
        ttsEngine: "aura-asteria-en / aura-2",
        sttEngine: "nova-2",
      },
      smtp: {
        configured: hasSmtp,
        host: process.env.SMTP_HOST || (process.env.SMTP_USER?.toLowerCase().endsWith("@gmail.com") ? "smtp.gmail.com" : null),
        user: process.env.SMTP_USER ? `${process.env.SMTP_USER.slice(0, 3)}...` : null,
      },
      jira: {
        configured: hasJira,
        host: process.env.JIRA_HOST || storageData?.jiraConfig?.host || null,
      },
      googleDrive: {
        configured: hasDrive,
      },
    },
  };
}
