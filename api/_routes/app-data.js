import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import { readAppStorage, writeAppStorage } from "../_tars/_observer-engine.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const data = readAppStorage();
    return sendResponse(res, 200, { ok: true, contacts: data.contacts, smtpConfig: data.smtpConfig, slaCases: data.slaCases });
  }

  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    const { contacts, smtpConfig, slaCases } = body || {};
    const saved = writeAppStorage({ contacts, smtpConfig, slaCases });
    return sendResponse(res, 200, { ok: true, data: saved });
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
