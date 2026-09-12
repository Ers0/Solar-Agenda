import { getTransporter, formatSmtpError, parseJsonBody, sendResponse, handleCors } from "./_smtp.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    return sendResponse(res, 405, { ok: false, error: "Method not allowed. Use POST." });
  }

  let userEmail = "";
  try {
    const body = await parseJsonBody(req);
    const smtpConfig = body?.smtpConfig || {};
    userEmail = smtpConfig?.user || "";

    const transporter = getTransporter(smtpConfig);

    // Timeout guard so the lambda doesn't hang
    const verifyPromise = transporter.verify();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Connection timed out after 6 seconds. Please check host and port.")), 6000)
    );

    await Promise.race([verifyPromise, timeoutPromise]);

    return sendResponse(res, 200, {
      ok: true,
      message: `Connection to email server (${smtpConfig.host || 'Gmail'}) verified successfully! Ready to dispatch.`,
    });
  } catch (err) {
    console.error("[SMTP Verify Error]", err);
    return sendResponse(res, 400, {
      ok: false,
      error: formatSmtpError(err, userEmail),
    });
  }
}
