import { getTransporter, formatSmtpError, parseJsonBody, sendResponse, handleCors } from "./_smtp.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    return sendResponse(res, 405, { ok: false, error: "Method not allowed. Use POST." });
  }

  let userEmail = "";
  try {
    const body = await parseJsonBody(req);
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
