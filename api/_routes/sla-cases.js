import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
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
  return { contacts: null, smtpConfig: null, slaCases: [] };
}

function writeStorage(data) {
  try {
    const current = readStorage();
    const merged = {
      ...current,
      ...data,
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
    const cases = Array.isArray(data.slaCases) ? data.slaCases : [];
    return sendResponse(res, 200, { ok: true, cases });
  }

  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    const current = readStorage();
    let list = Array.isArray(current.slaCases) ? [...current.slaCases] : [];

    if (Array.isArray(body)) {
      list = body;
    } else if (Array.isArray(body?.cases)) {
      list = body.cases;
    } else if (body?.case && typeof body.case === "object") {
      const item = body.case;
      const idx = list.findIndex(c => String(c.id).toLowerCase() === String(item.id).toLowerCase());
      if (idx >= 0) list[idx] = item;
      else list.unshift(item);
    } else if (body?.id || body?.problem_summary || body?.customer) {
      const item = {
        id: body.id || `SLA-${Date.now().toString().slice(-4)}`,
        created_at: body.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: body.status || 'aberto',
        priority: body.priority || 'alta',
        ...body
      };
      const idx = list.findIndex(c => String(c.id).toLowerCase() === String(item.id).toLowerCase());
      if (idx >= 0) list[idx] = item;
      else list.unshift(item);
    } else {
      return sendResponse(res, 400, { ok: false, error: "Expected 'cases' array or SLA case object in request body." });
    }

    const saved = writeStorage({ slaCases: list });
    return sendResponse(res, 200, { ok: true, count: list.length, cases: saved?.slaCases || list });
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
