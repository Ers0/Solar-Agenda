const TABLE = "tars_observer_state";
const ROW_ID = "observer";
const TIMEOUT_MS = 10000;

function config() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();

  if (!url || !key) {
    throw new Error(
      "TARS Observer storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel."
    );
  }

  return { url, key };
}

async function request(path, options = {}) {
  const { url, key } = config();
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
}

export async function initializeObserverState(defaultCases) {
  const state = await readObserverState();

  if (Array.isArray(state.cases) && state.cases.length) {
    return state;
  }

  const rows = await request(
    `${TABLE}?id=eq.${encodeURIComponent(ROW_ID)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        cases: Array.isArray(defaultCases) ? defaultCases : [],
        updated_at: new Date().toISOString()
      })
    }
  );

  return rows?.[0] || readObserverState();
}

export async function writeObserverState({
  cases,
  processedEventIds,
  expectedVersion
}) {
  const version = Number(expectedVersion || 1);

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
        cases: Array.isArray(cases) ? cases : [],
        processed_event_ids: Array.isArray(processedEventIds)
          ? processedEventIds.slice(-2000)
          : [],
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

  return rows[0];
}
