import { sendResponse, handleCors, parseJsonBody } from "./_smtp.js";
import fs from "fs";
import path from "path";

// Writable path in serverless container environment
const STORAGE_FILE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function readStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
  } catch (e) {}
  return { contacts: null, smtpConfig: null };
}

function writeStorage(data) {
  try {
    const current = readStorage();
    const merged = {
      contacts: data.contacts !== undefined ? data.contacts : current.contacts,
      smtpConfig: data.smtpConfig !== undefined ? data.smtpConfig : current.smtpConfig,
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
    return sendResponse(res, 200, { ok: true, contacts: data.contacts, smtpConfig: data.smtpConfig });
  }

  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    const { contacts, smtpConfig } = body || {};
    const saved = writeStorage({ contacts, smtpConfig });
    return sendResponse(res, 200, { ok: true, data: saved });
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
