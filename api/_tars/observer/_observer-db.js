import { readAppStorage, writeAppStorage } from "../_observer-engine.js";

const TABLE = "tars_observer_state";
const ROW_ID = "observer";
const TIMEOUT_MS = 10000;

function hasSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();
  return Boolean(url && key);
}

function config() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  ).trim();

  if (!url || !key) {
    return null;
  }

  return { url, key };
}

async function request(path, options = {}) {
  const cfg = config();
  if (!cfg) {
    throw new Error("TARS Observer storage is not configured with Supabase.");
  }
  const { url, key } = cfg;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new Error(
        `Supabase ${response.status}: ${
          typeof body === "string" ? body : JSON.stringify(body)
        }`
      );
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function readObserverState() {
  if (hasSupabaseConfig()) {
    try {
      const rows = await request(
        `${TABLE}?id=eq.${encodeURIComponent(
          ROW_ID
        )}&select=id,cases,processed_event_ids,version,updated_at`
      );

      if (Array.isArray(rows) && rows.length) {
        return rows[0];
      }

      const created = await request(TABLE, {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          id: ROW_ID,
          cases: [],
          processed_event_ids: [],
          version: 1
        })
      });

      return Array.isArray(created) ? created[0] : created;
    } catch (err) {
      console.warn("[TARS Observer DB] Supabase read fallback to local storage:", err?.message || err);
    }
  }

  // Fallback to local storage
  const local = readAppStorage();
  return {
    id: ROW_ID,
    cases: Array.isArray(local.tarsObserverCases) ? local.tarsObserverCases : [],
    processed_event_ids: Array.isArray(local.tarsProcessedEvents) ? local.tarsProcessedEvents : [],
    version: Number(local.tarsStorageVersion || 1),
    updated_at: local.updatedAt || new Date().toISOString()
  };
}

export async function initializeObserverState(defaultCases) {
  const state = await readObserverState();

  if (Array.isArray(state.cases) && state.cases.length) {
    return state;
  }

  const initialCases = Array.isArray(defaultCases) ? defaultCases : [];

  if (hasSupabaseConfig()) {
    try {
      const rows = await request(
        `${TABLE}?id=eq.${encodeURIComponent(ROW_ID)}`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            cases: initialCases,
            updated_at: new Date().toISOString()
          })
        }
      );

      return rows?.[0] || readObserverState();
    } catch (err) {
      console.warn("[TARS Observer DB] Supabase init fallback to local storage:", err?.message || err);
    }
  }

  // Local fallback
  writeAppStorage({
    tarsObserverCases: initialCases,
    tarsStorageVersion: (state.version || 1) + 1
  });

  return {
    id: ROW_ID,
    cases: initialCases,
    processed_event_ids: state.processed_event_ids || [],
    version: (state.version || 1) + 1,
    updated_at: new Date().toISOString()
  };
}

export async function writeObserverState({
  cases,
  processedEventIds,
  expectedVersion
}) {
  const version = Number(expectedVersion || 1);
  const nextCases = Array.isArray(cases) ? cases : [];
  const nextEventIds = Array.isArray(processedEventIds)
    ? processedEventIds.slice(-2000)
    : [];

  if (hasSupabaseConfig()) {
    try {
      const rows = await request(
        `${TABLE}?id=eq.${encodeURIComponent(
          ROW_ID
        )}&version=eq.${encodeURIComponent(version)}`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            cases: nextCases,
            processed_event_ids: nextEventIds,
            version: version + 1,
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!Array.isArray(rows) || rows.length !== 1) {
        const error = new Error(
          "Observer storage changed concurrently; retry required."
        );
        error.code = "OBSERVER_STORAGE_CONFLICT";
        throw error;
      }

      // Also mirror to local storage as secondary cache
      try {
        writeAppStorage({
          tarsObserverCases: nextCases,
          tarsProcessedEvents: nextEventIds,
          tarsStorageVersion: version + 1
        });
      } catch (_) {}

      return rows[0];
    } catch (err) {
      if (err?.code === "OBSERVER_STORAGE_CONFLICT") {
        throw err;
      }
      console.warn("[TARS Observer DB] Supabase write fallback to local storage:", err?.message || err);
    }
  }

  // Fallback to local storage
  writeAppStorage({
    tarsObserverCases: nextCases,
    tarsProcessedEvents: nextEventIds,
    tarsStorageVersion: version + 1
  });

  return {
    id: ROW_ID,
    cases: nextCases,
    processed_event_ids: nextEventIds,
    version: version + 1,
    updated_at: new Date().toISOString()
  };
}
