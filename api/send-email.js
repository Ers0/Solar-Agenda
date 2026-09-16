import { getTransporter, formatSmtpError, parseJsonBody, sendResponse, handleCors } from "./_smtp.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  // GET: SMTP status check (consolidated from /api/smtp-status)
  if (req.method === "GET") {
    const host = process.env.SMTP_HOST || "mail.mailcorp.com.br";
    const port = process.env.SMTP_PORT || "587";
    const user = process.env.SMTP_USER || "";
    const from = process.env.SMTP_FROM || user || "";
    const configured = !!(user && process.env.SMTP_PASS);

    return sendResponse(res, 200, {
      configured,
      host,
      port,
      from,
      hasServerCredentials: configured,
    });
  }

  if (req.method !== "POST") {
    return sendResponse(res, 405, { ok: false, error: "Method not allowed. Use POST or GET." });
  }

  let userEmail = "";
  try {
    const body = await parseJsonBody(req);
    const url = new URL(req.url, "http://localhost");
    const action = url.searchParams.get("action") || body?.action;

    // Action: verify connection test (consolidated from /api/test-smtp)
    if (action === "test" || body?.testConnection) {
      const smtpConfig = body?.smtpConfig || {};
      userEmail = smtpConfig?.user || "";
      const transporter = getTransporter(smtpConfig);

      const verifyPromise = transporter.verify();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out after 6 seconds. Please check host and port.")), 6000)
      );

      await Promise.race([verifyPromise, timeoutPromise]);

      return sendResponse(res, 200, {
        ok: true,
        message: `Connection to email server (${smtpConfig.host || 'Gmail'}) verified successfully! Ready to dispatch.`,
      });
    }

    const { to, cc, subject, text, html, smtpConfig } = body || {};
    userEmail = smtpConfig?.user || "";

    if (!to) {
      return sendResponse(res, 400, { ok: false, error: "Recipient ('to') email address is required." });
    }
    if (!subject) {
      return sendResponse(res, 400, { ok: false, error: "Email subject is required." });
    }

    const transporter = getTransporter(smtpConfig);
    const fromAddr = smtpConfig?.from || smtpConfig?.user || process.env.SMTP_FROM || process.env.SMTP_USER;

    const mailOptions = {
      from: fromAddr ? `Solar Agenda <${fromAddr}>` : undefined,
      to,
      cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc) : undefined,
      subject,
      text: text || undefined,
      html: html || (text ? `<div style="font-family: sans-serif; line-height: 1.6; color: #1f2937;">${String(text).replace(/\n/g, "<br/>")}</div>` : undefined),
    };

    const sendPromise = transporter.sendMail(mailOptions);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Email dispatch timed out after 8 seconds. Please check server settings.")), 8000)
    );

    const info = await Promise.race([sendPromise, timeoutPromise]);

    console.log("[SMTP] Email sent:", info.messageId, "to:", to, "cc:", cc || "none");
    return sendResponse(res, 200, { ok: true, messageId: info.messageId, accepted: info.accepted });
  } catch (err) {
    console.error("[SMTP Send Error]", err);
    return sendResponse(res, 500, {
      ok: false,
      error: formatSmtpError(err, userEmail),
    });
  }
}
