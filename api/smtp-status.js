import { sendResponse, handleCors } from "./_smtp.js";

export default function handler(req, res) {
  if (handleCors(req, res)) return;

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
