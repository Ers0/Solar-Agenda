import { sendResponse, handleCors } from "../_smtp.js";
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

function readStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
  } catch (e) {}
  return { slaWebhookLogs: [] };
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const data = readStorage();
    return sendResponse(res, 200, { ok: true, logs: data.slaWebhookLogs || [] });
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
