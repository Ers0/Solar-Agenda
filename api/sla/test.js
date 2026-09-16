import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import webhookHandler from "./webhook.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    const {
      company = "SolarTech Brasil Teste",
      name = "Engenheiro Marcelo Rocha",
      email = "marcelo.solar@teste.com.br",
      phone = "(11) 98765-4321",
      conversationId = "TEST-CONV-" + Date.now().toString().slice(-4),
      event = "hoymiles.account.created"
    } = body || {};

    const syntheticPayload = {
      event,
      version: "1.0",
      source: "tars-vision-bridge",
      bridgeVersion: "1.2.37-test",
      occurredAt: new Date().toISOString(),
      status: "COMPLETED",
      conversationId,
      customer: {
        name,
        email,
        phone,
        state: "SP"
      },
      organization: {
        name: company,
        parentOrganization: "APItest",
        type: "Installer",
        role: "Installer"
      },
      account: {
        loginEmail: email,
        passwordSharedWithCustomer: true
      },
      reporting: {
        ok: true,
        method: "test_ping"
      }
    };

    // Forward to webhook handler
    const fakeReq = {
      method: "POST",
      body: syntheticPayload,
      headers: req.headers || {}
    };

    return webhookHandler(fakeReq, res);
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
