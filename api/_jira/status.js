import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function readJiraConfig() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
      if (data.jiraConfig) return data.jiraConfig;
    }
  } catch (e) {}
  return {
    host: process.env.JIRA_HOST || "",
    email: process.env.JIRA_EMAIL || "",
    projectKey: process.env.JIRA_PROJECT_KEY || "SOLAR",
    issueType: process.env.JIRA_ISSUE_TYPE || "Task",
    enabled: Boolean(process.env.JIRA_HOST && process.env.JIRA_EMAIL)
  };
}

function writeJiraConfig(config) {
  try {
    let current = {};
    if (fs.existsSync(STORAGE_FILE)) {
      current = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
    current.jiraConfig = config;
    current.updatedAt = new Date().toISOString();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {}
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const url = new URL(req.url, "http://localhost");
  const sub = url.pathname.replace(/^\/api\/jira\/?/, "").replace(/^\/+/, "");

  if (sub === "config") {
    if (req.method === "GET") {
      const config = readJiraConfig();
      return sendResponse(res, 200, { ok: true, config });
    }
    if (req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        const config = readJiraConfig();
        const updated = {
          ...config,
          host: body.host !== undefined ? body.host : config.host,
          email: body.email !== undefined ? body.email : config.email,
          projectKey: body.projectKey !== undefined ? body.projectKey : config.projectKey,
          issueType: body.issueType !== undefined ? body.issueType : config.issueType,
          enabled: body.enabled !== undefined ? body.enabled : config.enabled
        };
        writeJiraConfig(updated);
        return sendResponse(res, 200, { ok: true, config: updated, message: "Jira settings saved." });
      } catch (e) {
        return sendResponse(res, 500, { ok: false, error: "Failed to save Jira configuration" });
      }
    }
  }

  if (sub === "projects") {
    return sendResponse(res, 200, {
      ok: true,
      projects: [
        { key: "SOLAR", name: "Solar Operations & Maintenance" },
        { key: "SLA", name: "Solar SLA Customer Support" }
      ]
    });
  }

  // Default: status
  const cfg = readJiraConfig();
  const configured = Boolean(cfg.host && cfg.email);

  return sendResponse(res, 200, {
    ok: true,
    configured,
    host: cfg.host ? `https://${cfg.host.replace(/^https?:\/\//, "")}` : "",
    email: cfg.email,
    status: configured ? "connected" : "standby",
    message: configured ? "Jira integration connected" : "Jira integration standby"
  });
}
