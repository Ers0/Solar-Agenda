import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface AppUser {
  id: string;
  name: string;
  role: "owner" | "member";
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  source?: "supabase" | "local" | "hybrid";
}

const SUPABASE_URL = "https://iqclmfebspladyuzwwpy.supabase.co";
const FN_URL = `${SUPABASE_URL}/functions/v1/agenda-login`;
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxY2xtZmVic3BsYWR5dXp3d3B5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMTYzNDcsImV4cCI6MjEwMTY5MjM0N30.Rz3nb7Zo_IFOeWa1cbQgOHjuRZ4FliDeZhC6NfBpvZM";

const STORAGE_FILE = path.join(process.cwd(), ".app_storage.json");

// Helper to hash passwords using SHA-256 with salt
function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(`solar_agenda_${password}_salt`).digest("hex");
}

function verifyPassword(user: AppUser, passwordAttempt: string): boolean {
  if (!passwordAttempt) return false;
  // Check SHA-256 hashed password
  const attemptHash = hashPassword(passwordAttempt);
  if (user.passwordHash === attemptHash) return true;
  // Also check plain equality in case of legacy/initial seed
  if (user.passwordHash === passwordAttempt) return true;
  return false;
}

// In-memory token cache for Supabase cloud session
let cachedSupabaseSession: { token: string; expires_at: string } | null = null;

export async function getSupabaseCloudToken(): Promise<{ token: string; expires_at: string }> {
  // If we have a cached token that is not expiring soon (more than 1 hour left), reuse it
  if (cachedSupabaseSession) {
    const expires = new Date(cachedSupabaseSession.expires_at).getTime();
    if (expires - Date.now() > 3600000) {
      return cachedSupabaseSession;
    }
  }

  try {
    const res = await fetch(FN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ name: "admin", password: "admin" })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.token) {
        cachedSupabaseSession = {
          token: data.token,
          expires_at: data.expires_at || new Date(Date.now() + 86400000 * 30).toISOString()
        };
        return cachedSupabaseSession;
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to obtain Supabase cloud token from admin login:", err);
  }

  // Fallback UUID token if offline
  const fallback = {
    token: crypto.randomUUID(),
    expires_at: new Date(Date.now() + 86400000 * 30).toISOString()
  };
  cachedSupabaseSession = fallback;
  return fallback;
}

// Read and write user registry from .app_storage.json
function readStorageRaw(): any {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[Auth Storage] Read error:", e);
  }
  return {};
}

function writeStorageRaw(data: any) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.warn("[Auth Storage] Write error:", e);
  }
}

// Initialize and ensure Eros and admin exist
export function initUserRegistry(): AppUser[] {
  const storage = readStorageRaw();
  let users: AppUser[] = Array.isArray(storage.userRegistry) ? storage.userRegistry : [];

  let changed = false;

  // 1. Ensure Eros user exists and is configured as owner
  let erosUser = users.find(u => u.name.toLowerCase() === "eros");
  if (!erosUser) {
    erosUser = {
      id: "user-eros",
      name: "Eros",
      role: "owner",
      passwordHash: hashPassword("SolarEros@2026"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: "System Owner & Solar Operations Lead (Supabase Owner)",
      source: "hybrid"
    };
    users.push(erosUser);
    changed = true;
  } else if (erosUser.role !== "owner") {
    erosUser.role = "owner";
    erosUser.updatedAt = new Date().toISOString();
    changed = true;
  }

  // 2. Ensure admin exists as owner
  let adminUser = users.find(u => u.name.toLowerCase() === "admin");
  if (!adminUser) {
    adminUser = {
      id: "user-admin",
      name: "admin",
      role: "owner",
      passwordHash: hashPassword("admin"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: "Default Supabase System Administrator",
      source: "supabase"
    };
    users.push(adminUser);
    changed = true;
  }

  if (changed) {
    storage.userRegistry = users;
    storage.updatedAt = new Date().toISOString();
    writeStorageRaw(storage);
  }

  return users;
}

export function getAllUsers(): AppUser[] {
  return initUserRegistry();
}

export function getUserByName(name: string): AppUser | null {
  const users = getAllUsers();
  const lower = String(name || "").trim().toLowerCase();
  return users.find(u => u.name.toLowerCase() === lower) || null;
}

export async function authenticateUser(
  name: string,
  passwordAttempt: string
): Promise<{ ok: boolean; user?: AppUser; token?: string; expires_at?: string; error?: string }> {
  const trimmedName = String(name || "").trim();
  if (!trimmedName || !passwordAttempt) {
    return { ok: false, error: "Username and password are required." };
  }

  const localUser = getUserByName(trimmedName);

  // If matched in local user registry
  if (localUser) {
    const valid = verifyPassword(localUser, passwordAttempt);
    if (!valid) {
      return { ok: false, error: "Incorrect password for user " + localUser.name };
    }

    // Obtain active Supabase cloud token so client has full access to Supabase edge functions
    const cloudSession = await getSupabaseCloudToken();

    return {
      ok: true,
      user: localUser,
      token: cloudSession.token,
      expires_at: cloudSession.expires_at
    };
  }

  // If not in local registry, query Supabase agenda-login directly
  try {
    const res = await fetch(FN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ name: trimmedName, password: passwordAttempt })
    });

    const data = await res.json();
    if (res.ok && data.token) {
      // Determine role: if name is eros or data.role is owner
      const isOwner = trimmedName.toLowerCase() === "eros" || trimmedName.toLowerCase() === "admin" || data.role === "owner";
      const role: "owner" | "member" = isOwner ? "owner" : (data.role || "member");

      const externalUser: AppUser = {
        id: "user-" + trimmedName.toLowerCase(),
        name: data.name || trimmedName,
        role,
        passwordHash: hashPassword(passwordAttempt),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "supabase"
      };

      // Add to local registry so subsequent management works
      const storage = readStorageRaw();
      const list: AppUser[] = Array.isArray(storage.userRegistry) ? storage.userRegistry : [];
      if (!list.some(u => u.name.toLowerCase() === trimmedName.toLowerCase())) {
        list.push(externalUser);
        storage.userRegistry = list;
        writeStorageRaw(storage);
      }

      return {
        ok: true,
        user: externalUser,
        token: data.token,
        expires_at: data.expires_at || new Date(Date.now() + 86400000 * 30).toISOString()
      };
    }

    return { ok: false, error: data.error || "Name or password is incorrect." };
  } catch (err: any) {
    return { ok: false, error: "Unable to verify credentials: " + (err.message || String(err)) };
  }
}

export async function createNewUser(params: {
  name: string;
  password: string;
  role?: "owner" | "member";
  notes?: string;
  creatorToken?: string;
}): Promise<{ ok: boolean; user?: AppUser; error?: string }> {
  const name = String(params.name || "").trim();
  const password = String(params.password || "").trim();
  const role: "owner" | "member" = params.role === "owner" ? "owner" : "member";
  const notes = params.notes ? String(params.notes).trim() : undefined;

  if (!name) {
    return { ok: false, error: "Username is required." };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { ok: false, error: "Username may only contain letters, numbers, dot, dash or underscore." };
  }
  if (password.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters long." };
  }

  const existing = getUserByName(name);
  if (existing) {
    return { ok: false, error: `User "${name}" already exists.` };
  }

  // Attempt to register in Supabase as well
  try {
    const cloudSession = await getSupabaseCloudToken();
    const bearer = params.creatorToken || cloudSession.token;
    await fetch(FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify({
        action: "register",
        name,
        password,
        role
      })
    });
  } catch (e) {
    console.warn("[Auth] Supabase register sync error (non-fatal):", e);
  }

  const newUser: AppUser = {
    id: "user-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
    name,
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes,
    source: "hybrid"
  };

  const storage = readStorageRaw();
  const users: AppUser[] = Array.isArray(storage.userRegistry) ? storage.userRegistry : [];
  users.push(newUser);
  storage.userRegistry = users;
  storage.updatedAt = new Date().toISOString();
  writeStorageRaw(storage);

  return { ok: true, user: newUser };
}

export async function updateUserPassword(
  name: string,
  newPassword: string,
  userToken?: string
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = String(name || "").trim();
  const pwd = String(newPassword || "").trim();

  if (!trimmed || pwd.length < 6) {
    return { ok: false, error: "Valid username and a password of at least 6 characters are required." };
  }

  const storage = readStorageRaw();
  const users: AppUser[] = Array.isArray(storage.userRegistry) ? storage.userRegistry : [];
  const user = users.find(u => u.name.toLowerCase() === trimmed.toLowerCase());

  if (!user) {
    return { ok: false, error: `User "${trimmed}" not found in registry.` };
  }

  user.passwordHash = hashPassword(pwd);
  user.updatedAt = new Date().toISOString();
  storage.userRegistry = users;
  storage.updatedAt = new Date().toISOString();
  writeStorageRaw(storage);

  // If user token or admin token is provided, update password in Supabase via action: "passwd"
  if (userToken) {
    try {
      await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON_KEY,
          Authorization: `Bearer ${userToken}`
        },
        body: JSON.stringify({ action: "passwd", password: pwd })
      });
    } catch (e) {
      console.warn("[Auth] Supabase passwd sync error:", e);
    }
  }

  return { ok: true };
}

export function updateUserRole(
  name: string,
  newRole: "owner" | "member"
): { ok: boolean; error?: string } {
  const trimmed = String(name || "").trim();
  const storage = readStorageRaw();
  const users: AppUser[] = Array.isArray(storage.userRegistry) ? storage.userRegistry : [];
  const user = users.find(u => u.name.toLowerCase() === trimmed.toLowerCase());

  if (!user) {
    return { ok: false, error: `User "${trimmed}" not found in registry.` };
  }

  user.role = newRole;
  user.updatedAt = new Date().toISOString();
  storage.userRegistry = users;
  storage.updatedAt = new Date().toISOString();
  writeStorageRaw(storage);

  return { ok: true };
}

export function deleteUser(name: string): { ok: boolean; error?: string } {
  const trimmed = String(name || "").trim();
  if (trimmed.toLowerCase() === "eros" || trimmed.toLowerCase() === "admin") {
    return { ok: false, error: `Cannot delete core system administrator "${trimmed}".` };
  }

  const storage = readStorageRaw();
  let users: AppUser[] = Array.isArray(storage.userRegistry) ? storage.userRegistry : [];
  const initialLen = users.length;
  users = users.filter(u => u.name.toLowerCase() !== trimmed.toLowerCase());

  if (users.length === initialLen) {
    return { ok: false, error: `User "${trimmed}" not found in registry.` };
  }

  storage.userRegistry = users;
  storage.updatedAt = new Date().toISOString();
  writeStorageRaw(storage);

  return { ok: true };
}
