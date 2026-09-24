import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

const DEFAULT_USERS = [
  {
    id: "user-eros",
    name: "Eros",
    role: "owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    notes: "System Owner & Solar Operations Lead (Full Permissions)",
    source: "system"
  },
  {
    id: "user-admin",
    name: "admin",
    role: "member",
    readOnly: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    notes: "Demo Guest Viewer — Read-only access, no owner power",
    source: "system"
  }
];

function readUsers() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
      if (Array.isArray(data.userRegistry) && data.userRegistry.length > 0) {
        return data.userRegistry;
      }
    }
  } catch (e) {}
  return [...DEFAULT_USERS];
}

function writeUsers(users) {
  try {
    let current = {};
    if (fs.existsSync(STORAGE_FILE)) {
      current = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
    current.userRegistry = users;
    current.updatedAt = new Date().toISOString();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {}
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const url = new URL(req.url, "http://localhost");
  const subAction = url.pathname.replace(/^\/api\/auth\/users\/?/, "").replace(/^\/+/, "");

  if (req.method === "GET") {
    const users = readUsers();
    return sendResponse(res, 200, {
      ok: true,
      users
    });
  }

  if (req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const action = subAction || body?.action || "";
      const users = readUsers();

      if (action === "delete") {
        const idOrName = String(body?.id || body?.name || "").trim().toLowerCase();
        if (idOrName === "user-eros" || idOrName === "eros") {
          return sendResponse(res, 403, { ok: false, error: "Cannot delete the primary system owner." });
        }
        const filtered = users.filter(u => u.id.toLowerCase() !== idOrName && u.name.toLowerCase() !== idOrName);
        writeUsers(filtered);
        return sendResponse(res, 200, { ok: true, message: "User deleted successfully", users: filtered });
      }

      if (action === "reset-password") {
        const idOrName = String(body?.id || body?.name || "").trim().toLowerCase();
        const user = users.find(u => u.id.toLowerCase() === idOrName || u.name.toLowerCase() === idOrName);
        if (!user) return sendResponse(res, 404, { ok: false, error: "User not found" });
        user.updatedAt = new Date().toISOString();
        writeUsers(users);
        return sendResponse(res, 200, { ok: true, message: `Password for ${user.name} reset successfully.` });
      }

      if (action === "set-role") {
        const idOrName = String(body?.id || body?.name || "").trim().toLowerCase();
        const newRole = body?.role === "owner" ? "owner" : "member";
        if (idOrName === "admin" && newRole === "owner") {
          return sendResponse(res, 403, { ok: false, error: "Admin viewer cannot be elevated to owner." });
        }
        const user = users.find(u => u.id.toLowerCase() === idOrName || u.name.toLowerCase() === idOrName);
        if (!user) return sendResponse(res, 404, { ok: false, error: "User not found" });
        user.role = newRole;
        user.updatedAt = new Date().toISOString();
        writeUsers(users);
        return sendResponse(res, 200, { ok: true, message: `Role for ${user.name} updated to ${newRole}.` });
      }

      // Default create new user
      const name = String(body?.name || "").trim();
      const role = body?.role === "owner" ? "owner" : "member";
      if (!name) {
        return sendResponse(res, 400, { ok: false, error: "Username is required" });
      }

      const existing = users.find(u => u.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.role = role;
        existing.notes = String(body?.notes || existing.notes || "");
        existing.updatedAt = new Date().toISOString();
        writeUsers(users);
        return sendResponse(res, 200, { ok: true, user: existing, message: `User ${name} updated.` });
      }

      const newUser = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        role,
        notes: String(body?.notes || ""),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "local"
      };

      users.push(newUser);
      writeUsers(users);

      return sendResponse(res, 201, {
        ok: true,
        user: newUser,
        message: `Login for ${name} created successfully.`
      });
    } catch (e) {
      return sendResponse(res, 500, { ok: false, error: "Failed to process user operation" });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
