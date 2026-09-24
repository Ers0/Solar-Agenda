import nodemailer from "nodemailer";

export function getTransporter(customConfig) {
  const user = customConfig?.user || process.env.SMTP_USER || "";
  const pass = customConfig?.pass || process.env.SMTP_PASS || "";
  const host = customConfig?.host || process.env.SMTP_HOST || (user.toLowerCase().endsWith("@gmail.com") ? "smtp.gmail.com" : "mail.mailcorp.com.br");
  const port = parseInt(String(customConfig?.port || process.env.SMTP_PORT || (host.includes("gmail") ? "465" : "587")), 10);
  const secure = customConfig?.secure !== undefined
    ? (customConfig.secure === true || customConfig.secure === "true")
    : (process.env.SMTP_SECURE === "true" || port === 465 || host.includes("gmail"));

  if (!user || !pass) {
    throw new Error("Credentials missing: Email and Password (or 16-char App Password) are required.");
  }

  // Gmail special transport
  if (host.includes("gmail") || user.toLowerCase().endsWith("@gmail.com")) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user,
        pass,
      },
      connectionTimeout: 6000,
      greetingTimeout: 6000,
      socketTimeout: 7000,
    });
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 6000,
    greetingTimeout: 6000,
    socketTimeout: 7000,
  });
}

export function formatSmtpError(err, user) {
  const msg = err?.message || String(err);
  if (msg.includes("535") || msg.includes("BadCredentials") || msg.includes("Username and Password not accepted") || msg.includes("Invalid login")) {
    if (user?.toLowerCase().endsWith("@gmail.com") || msg.includes("gmail")) {
      return "Gmail rejected the login (Error 535). If 2-Step Verification is ON, generate a 16-character App Password at myaccount.google.com/apppasswords and use it as your password.";
    }
    return "Invalid email username or password. Please verify your credentials in Connections tab.";
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("timeout") || msg.includes("timed out")) {
    return "Connection timed out. Please check if the SMTP host and port are correct and reachable.";
  }
  if (msg.includes("ECONNREFUSED")) {
    return "Connection refused by server. Check the SMTP host and port (e.g. 465 for SSL, 587 for TLS).";
  }
  return msg;
}

export async function parseJsonBody(req) {
  if (req.body) {
    if (typeof req.body === "object") {
      if (Buffer.isBuffer(req.body)) {
        try {
          return JSON.parse(req.body.toString("utf-8"));
        } catch {
          return {};
        }
      }
      return req.body;
    }
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
  }

  // If stream hasn't been read, read with a 400ms timeout
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({});
      }
    }, 400);

    if (!req.on || typeof req.on !== "function") {
      clearTimeout(timer);
      resolved = true;
      resolve({});
      return;
    }

    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        try {
          resolve(JSON.parse(data || "{}"));
        } catch {
          resolve({});
        }
      }
    });
    req.on("error", () => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        resolve({});
      }
    });
  });
}

export function sendResponse(res, statusCode, data) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Type", "application/json");
  } catch (e) {
    // ignore header errors if already sent
  }

  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(statusCode).json(data);
  }
  res.statusCode = statusCode;
  res.end(JSON.stringify(data));
}

export function handleCors(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  } catch (e) {}
  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return true;
  }
  return false;
}
