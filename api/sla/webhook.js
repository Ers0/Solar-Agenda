import { sendResponse, handleCors, parseJsonBody } from "../_smtp.js";
import { readAppStorage, writeAppStorage, getObserverCases } from "../tars/_observer-engine.js";

function readStorage() {
  return readAppStorage();
}

function writeStorage(data) {
  return writeAppStorage(data);
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method === "GET") {
    const data = readStorage();
    return sendResponse(res, 200, { ok: true, logs: data.slaWebhookLogs || [] });
  }

  if (req.method === "POST") {
    try {
      const payload = await parseJsonBody(req);
      const url = new URL(req.url, "http://localhost");
      const action = url.searchParams.get("action") || payload?.action;

      if (action === "test") {
        const testCaseNum = Math.floor(1000 + Math.random() * 9000);
        const testCaseId = `SLA-HOY-${testCaseNum}`;
        const testPayload = {
          event: "hoymiles.account.created (TEST)",
          occurredAt: new Date().toISOString(),
          status: "COMPLETED",
          conversationId: payload.conversationId || "hyperflow-test-conv-99",
          customer: {
            name: payload.name || payload.customer?.name || "Engenheiro Marcelo Rocha",
            email: payload.email || payload.customer?.email || "marcelo.solar@teste.com.br",
            phone: payload.phone || payload.customer?.phone || "11988776655",
            state: payload.state || payload.customer?.state || "São Paulo"
          },
          organization: {
            name: payload.company || payload.organization?.name || "SolarTech Brasil Teste",
            parentOrganization: "APItest",
            role: "Installer"
          },
          account: {
            loginEmail: payload.email || payload.account?.loginEmail || "marcelo.solar@teste.com.br",
            passwordSharedWithCustomer: true
          }
        };

        const storage = readStorage();
        const list = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
        const newCase = {
          id: testCaseId,
          title: `Criação de Conta Hoymiles — ${testPayload.organization.name}`,
          priority: "media",
          status: "concluido",
          created_at: testPayload.occurredAt,
          resolved_at: testPayload.occurredAt,
          sla_limit_hours: 24,
          responsible_tech: "TARS Vision Bridge",
          customer: testPayload.customer,
          equipment: {
            manufacturer: "Hoymiles",
            model: "S-Miles Cloud (Portal do Instalador)",
            serial_numbers: ["N/A - Conta Web/App"]
          },
          problem_summary: `[TESTE SIMULADO] Criação de conta Hoymiles para ${testPayload.customer.name} (${testPayload.organization.name}). Login: ${testPayload.account.loginEmail}. Senha entregue via Hyperflow.`,
          protocols: {
            hoymiles: [{
              account_email: testPayload.account.loginEmail,
              org_name: testPayload.organization.name,
              parent_org: "APItest",
              role: "Installer",
              created_at: testPayload.occurredAt,
              conversation_id: testPayload.conversationId,
              status: "COMPLETED"
            }],
            hyperflow: [testPayload.conversationId]
          },
          timeline: [{
            id: `tl-sim-${Date.now()}`,
            type: "hoymiles_account_created",
            title: "Teste de Webhook SLA Executado",
            detail: `Simulação de criação de conta Hoymiles via painel Solar Agenda. Conta vinculada a APItest (${testPayload.organization.name}).`,
            author: "TARS Webhook Simulator",
            timestamp: testPayload.occurredAt
          }],
          notes: "Caso de teste gerado pelo simulador de webhook SLA."
        };
        list.unshift(newCase);

        const logs = Array.isArray(storage.slaWebhookLogs) ? [...storage.slaWebhookLogs] : [];
        const testLog = {
          id: `sla-wh-test-${Date.now()}`,
          receivedAt: new Date().toISOString(),
          event: "hoymiles.account.created (TEST)",
          source: "tars-vision-bridge-test",
          bridgeVersion: "1.2.37",
          status: "COMPLETED",
          customer: testPayload.customer.name,
          email: testPayload.account.loginEmail,
          company: testPayload.organization.name,
          conversationId: testPayload.conversationId,
          matchedCaseId: testCaseId,
          isNewCase: true
        };
        logs.unshift(testLog);

        writeStorage({
          slaCases: list,
          slaWebhookLogs: logs.slice(0, 50)
        });

        return sendResponse(res, 200, {
          ok: true,
          tested: true,
          caseId: testCaseId,
          customer: testPayload.customer.name,
          email: testPayload.account.loginEmail,
          company: testPayload.organization.name,
          log: testLog
        });
      }

      const eventType = payload.event || "sla.generic.event";
      const occurredAt = payload.occurredAt || new Date().toISOString();
      const conversationId = (payload.conversationId || "").trim();
      const source = payload.source || "tars-vision-bridge";
      const bridgeVersion = payload.bridgeVersion || "1.2.37";
      const eventStatus = payload.status || "COMPLETED";

      const customerObj = payload.customer || {};
      const orgObj = payload.organization || {};
      const accountObj = payload.account || {};

      const customerName = (customerObj.name || orgObj.name || payload.customerName || "Cliente Solar").trim();
      const customerEmail = (customerObj.email || accountObj.loginEmail || payload.email || "").trim();
      const customerPhone = (customerObj.phone || payload.phone || "").trim();
      const customerState = (customerObj.state || payload.state || "").trim();

      // Hyperflow specific fields
      const conversationUrl = (payload.conversationUrl || payload.conversationLink || payload.url || "").trim();
      const hyperflowProtocol = (payload.protocol || payload.hyperflowProtocol || (conversationId ? `HF-${conversationId.replace(/^hyperflow:/, '').slice(0, 8)}` : "")).trim();
      const isHyperflowEvent = eventType.startsWith("hyperflow") || !!conversationUrl || !!payload.protocol || !!payload.messages;

      const orgName = (orgObj.name || payload.company || "").trim();
      const parentOrg = (orgObj.parentOrganization || "APItest").trim();
      const orgRole = (orgObj.role || "Installer").trim();
      const loginEmail = (accountObj.loginEmail || customerEmail).trim().toLowerCase();

      const storage = readStorage();
      const list = Array.isArray(storage.slaCases) ? [...storage.slaCases] : [];
      let matchedCaseId = null;
      let isNewCase = false;

      // 1. Look for matching case
      const targetCaseId = (payload.caseId || payload.slaCaseId || "").trim();
      for (let i = 0; i < list.length; i++) {
        const c = { ...list[i] };
        const cEmail = (c.customer?.email || "").toLowerCase();
        const cPhone = (c.customer?.phone || "").replace(/\D/g, "");
        const searchPhone = customerPhone.replace(/\D/g, "");

        const matchesDirectId = Boolean(targetCaseId && c.id.toLowerCase() === targetCaseId.toLowerCase());
        const matchesProtocol = Boolean(
          hyperflowProtocol && (
            (c.protocols?.hyperflow_id && String(c.protocols.hyperflow_id).toLowerCase() === hyperflowProtocol.toLowerCase()) ||
            (c.protocols?.hyperflow?.protocol && String(c.protocols.hyperflow.protocol).toLowerCase() === hyperflowProtocol.toLowerCase()) ||
            (c.conversation?.protocol && String(c.conversation.protocol).toLowerCase() === hyperflowProtocol.toLowerCase())
          )
        );
        const matchesConv = Boolean(conversationId && (
          (c.protocols?.hyperflow_id && String(c.protocols.hyperflow_id).includes(conversationId)) ||
          (c.protocols?.hyperflow?.conversation_id === conversationId) ||
          (Array.isArray(c.protocols?.hyperflow) && c.protocols.hyperflow.includes(conversationId))
        ));
        const matchesConvUrl = Boolean(conversationUrl && (
          (c.protocols?.hyperflow_url && c.protocols.hyperflow_url === conversationUrl) ||
          (c.protocols?.hyperflow?.conversation_url === conversationUrl) ||
          (c.conversation?.conversation_url === conversationUrl)
        ));
        const matchesEmail = Boolean(loginEmail && cEmail && (cEmail === loginEmail));
        const matchesPhone = Boolean(searchPhone.length >= 8 && cPhone && (cPhone === searchPhone || cPhone.endsWith(searchPhone) || searchPhone.endsWith(cPhone)));
        const matchesHoymilesProto = Boolean(loginEmail && Array.isArray(c.protocols?.hoymiles) && c.protocols.hoymiles.some(h => (h.account_email || "").toLowerCase() === loginEmail));

        if (matchesDirectId || matchesProtocol || matchesConv || matchesConvUrl || matchesEmail || matchesPhone || matchesHoymilesProto) {
          matchedCaseId = c.id;
          c.protocols = c.protocols || {};

          if (isHyperflowEvent) {
            const protoCode = hyperflowProtocol || c.protocols.hyperflow_id || (conversationId ? `HF-${conversationId}` : "HF-AUTO");
            c.protocols.hyperflow = {
              protocol: protoCode,
              conversation_url: conversationUrl || c.protocols.hyperflow_url || (conversationId ? `https://conversas.hyperflow.global/chat/${conversationId}` : ""),
              conversation_id: conversationId || c.protocols.hyperflow?.conversation_id || "",
              status: "LINKED",
              synced_at: occurredAt,
              customer_name: customerName,
              customer_phone: customerPhone
            };
            c.protocols.hyperflow_id = protoCode;
            c.protocols.hyperflow_url = c.protocols.hyperflow.conversation_url;

            c.conversation = c.conversation || {};
            c.conversation.source = "Hyperflow";
            c.conversation.channel = "WhatsApp";
            c.conversation.conversation_url = c.protocols.hyperflow.conversation_url;
            c.conversation.protocol = protoCode;

            if (Array.isArray(payload.messages) && payload.messages.length > 0) {
              c.conversation.messages = payload.messages;
            }

            if (!Array.isArray(c.timeline)) c.timeline = [];
            c.timeline.push({
              id: `tl-hf-${Date.now()}`,
              type: "hyperflow_protocol_linked",
              title: `Protocolo Hyperflow Vinculado: ${protoCode}`,
              detail: `Conversa sincronizada via TARS Bridge. Link: ${c.protocols.hyperflow.conversation_url || 'N/A'}. Total de mensagens: ${c.conversation.messages?.length || 0}.`,
              author: `TARS Vision Bridge v${bridgeVersion}`,
              timestamp: occurredAt
            });
          } else {
            c.protocols.hoymiles = Array.isArray(c.protocols.hoymiles) ? [...c.protocols.hoymiles] : [];
            if (!c.protocols.hoymiles.some(h => (h.account_email || "").toLowerCase() === loginEmail)) {
              c.protocols.hoymiles.push({
                account_email: loginEmail,
                org_name: orgName,
                parent_org: parentOrg,
                role: orgRole,
                created_at: occurredAt,
                conversation_id: conversationId,
                status: eventStatus
              });
            }

            if (conversationId && Array.isArray(c.protocols.hyperflow) && !c.protocols.hyperflow.includes(conversationId)) {
              c.protocols.hyperflow.push(conversationId);
            }

            if (!Array.isArray(c.timeline)) c.timeline = [];
            c.timeline.push({
              id: `tl-wh-${Date.now()}`,
              type: "hoymiles_account_created",
              title: `Conta Hoymiles Criada: ${loginEmail}`,
              detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Credenciais entregues via Hyperflow.`,
              author: `TARS Vision Bridge v${bridgeVersion}`,
              timestamp: occurredAt
            });

            if (["aberto", "em_analise", "aguardando_terceiros"].includes(c.status)) {
              c.status = "concluido";
              c.resolved_at = occurredAt;
            }
          }

          c.updated_at = new Date().toISOString();
          list[i] = c;
          break;
        }
      }

      // 2. If no case exists, auto-create documented SLA case
      if (!matchedCaseId) {
        isNewCase = true;
        const caseNum = Math.floor(1000 + Math.random() * 9000);

        if (isHyperflowEvent) {
          matchedCaseId = `SLA-HF-${caseNum}`;
          const protoCode = hyperflowProtocol || `HF-${caseNum}`;
          const hfUrl = conversationUrl || (conversationId ? `https://conversas.hyperflow.global/chat/${conversationId}` : "");

          const newCase = {
            id: matchedCaseId,
            title: `Atendimento Hyperflow — ${customerName}`,
            priority: payload.priority || "alta",
            status: payload.status || "aberto",
            created_at: occurredAt,
            updated_at: occurredAt,
            sla_deadline: new Date(Date.now() + 24 * 3600000).toISOString(),
            sla_limit_hours: 24,
            responsible_tech: "Suporte Solar (TARS Bridge)",
            customer: {
              name: customerName,
              email: customerEmail,
              phone: customerPhone,
              state: customerState,
              site_location: payload.site_location || ""
            },
            equipment: payload.equipment || {
              manufacturer: payload.manufacturer || "Inversor Solar",
              model: payload.model || "Equipamento em Diagnóstico",
              serial_numbers: payload.serial_number ? [payload.serial_number] : (payload.serial_numbers || [])
            },
            problem_summary: payload.problem_summary || (payload.messages?.[0]?.text ? `Conversa Hyperflow: ${payload.messages[0].text.slice(0, 180)}` : "Atendimento importado via TARS Bridge."),
            next_action: "Avaliar protocolo e histórico do cliente via conversa Hyperflow vinculada.",
            protocols: {
              hyperflow: {
                protocol: protoCode,
                conversation_url: hfUrl,
                conversation_id: conversationId,
                status: "LINKED",
                synced_at: occurredAt,
                customer_name: customerName,
                customer_phone: customerPhone
              },
              hyperflow_id: protoCode,
              hyperflow_url: hfUrl,
              jira: [],
              hoymiles: []
            },
            conversation: {
              source: "Hyperflow",
              channel: "WhatsApp",
              conversation_url: hfUrl,
              protocol: protoCode,
              messages: Array.isArray(payload.messages) ? payload.messages : []
            },
            timeline: [
              {
                id: `tl-hf-init-${Date.now()}`,
                type: "hyperflow_protocol_linked",
                title: `Caso Aberto via Hyperflow Protocol: ${protoCode}`,
                detail: `Atendimento recebido via TARS Bridge Webhook com link direto da conversa: ${hfUrl || 'N/A'}.`,
                author: `TARS Vision Bridge v${bridgeVersion}`,
                timestamp: occurredAt
              }
            ]
          };
          list.unshift(newCase);
        } else {
          matchedCaseId = `SLA-HOY-${caseNum}`;
          const newCase = {
            id: matchedCaseId,
            title: `Criação de Conta Hoymiles — ${orgName || customerName}`,
            priority: "media",
            status: "concluido",
            created_at: occurredAt,
            resolved_at: occurredAt,
            sla_limit_hours: 24,
            responsible_tech: "TARS Vision Bridge",
            customer: {
              name: customerName,
              email: customerEmail || loginEmail,
              phone: customerPhone,
              state: customerState,
              company: orgName
            },
            equipment: {
              manufacturer: "Hoymiles",
              model: "S-Miles Cloud (Portal do Instalador)",
              serial_numbers: ["N/A - Conta Web/App"]
            },
            problem_summary: `Criação automatizada de conta de Instalador Hoymiles para ${customerName} (${orgName}). Login: ${loginEmail}. Senha padrão configurada e entregue via Hyperflow.`,
            protocols: {
              hoymiles: [{
                account_email: loginEmail,
                org_name: orgName,
                parent_org: parentOrg,
                role: orgRole,
                created_at: occurredAt,
                conversation_id: conversationId,
                status: eventStatus
              }],
              hyperflow: conversationId ? [conversationId] : []
            },
            timeline: [
              {
                id: `tl-sla-init-${Date.now()}`,
                type: "hoymiles_account_created",
                title: "Conta Hoymiles Criada & Entregue",
                detail: `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${parentOrg} (${orgName}). Status: ${eventStatus}. Credenciais e links de treinamento repassados ao cliente via chat Hyperflow.`,
                author: `TARS Vision Bridge v${bridgeVersion}`,
                timestamp: occurredAt
              }
            ],
            notes: `Evento recebido via Webhook SLA (${eventType}) da extensão TARS Vision Bridge v${bridgeVersion}. Senhas não são armazenadas no Solar Agenda por segurança.`
          };
          list.unshift(newCase);
        }
      }

      // 3. Log event
      const logs = Array.isArray(storage.slaWebhookLogs) ? [...storage.slaWebhookLogs] : [];
      const logEntry = {
        id: `sla-wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        receivedAt: new Date().toISOString(),
        event: eventType,
        source,
        bridgeVersion,
        status: eventStatus,
        customer: customerName,
        email: loginEmail,
        company: orgName,
        conversationId: conversationId || null,
        matchedCaseId,
        isNewCase
      };
      logs.unshift(logEntry);

      let updatedObserverCases = null;
      if (isHyperflowEvent) {
        try {
          const protoCode = hyperflowProtocol || (matchedCaseId ? matchedCaseId.replace('SLA-', 'TARS-OBS-') : `HF-${Date.now()}`);
          const obsCases = getObserverCases();
          const obsIdx = obsCases.findIndex(oc =>
            (protoCode && oc.protocol === protoCode) ||
            (conversationId && oc.conversationId === conversationId) ||
            (matchedCaseId && oc.id === `TARS-OBS-${protoCode}`)
          );

          const obsTimeline = (payload.timeline && Array.isArray(payload.timeline) && payload.timeline.length > 0)
            ? payload.timeline.map(t => ({
                id: t.id || `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                eventType: "HYPERFLOW_SYNC",
                timestamp: t.timestamp || occurredAt,
                title: t.title || "Sincronização Hyperflow",
                detail: t.detail || "Conversa sincronizada via TARS Bridge",
                author: t.author || `TARS Vision Bridge v${bridgeVersion}`
              }))
            : [{
                id: `tl-${Date.now()}`,
                eventType: "HYPERFLOW_SYNC",
                timestamp: occurredAt,
                title: `Conversa Hyperflow Sincronizada (${protoCode})`,
                detail: `${(payload.messages?.length || payload.messageCount || 0)} mensagens sincronizadas do WhatsApp Hyperflow`,
                author: `TARS Vision Bridge v${bridgeVersion}`
              }];

          const obsMessages = (Array.isArray(payload.messages) ? payload.messages : []).map(m => ({
            messageId: m.id || m.messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            direction: m.direction || (m.speaker === "technician" ? "outbound" : "incoming"),
            speaker: (m.speaker === "technician" || m.speaker === "agent") ? "technician" : "customer",
            timestamp: m.timestamp || occurredAt,
            capturedAt: m.capturedAt || occurredAt,
            text: String(m.text || "").slice(0, 12000),
            attachmentCount: Number(m.attachmentCount || 0)
          }));

          if (obsIdx >= 0) {
            const oc = { ...obsCases[obsIdx] };
            oc.updatedAt = occurredAt;
            if (obsMessages.length > 0) oc.messages = obsMessages;
            if (customerName && customerName !== "Cliente Solar") oc.customer.name = customerName;
            if (customerPhone) oc.customer.phone = customerPhone;
            if (customerEmail) oc.customer.email = customerEmail;
            if (!Array.isArray(oc.timeline)) oc.timeline = [];
            oc.timeline.push(...obsTimeline);
            obsCases[obsIdx] = oc;
          } else {
            obsCases.unshift({
              id: `TARS-OBS-${protoCode}`,
              protocol: protoCode,
              conversationId: conversationId || `conv_hf_${protoCode}`,
              status: "ACTIVE",
              customer: {
                name: customerName,
                phone: customerPhone,
                email: customerEmail,
                protocol: protoCode
              },
              equipment: {
                manufacturer: payload.equipment?.manufacturer || payload.manufacturer || "Inversor Solar",
                model: payload.equipment?.model || payload.model || "Equipamento em Diagnóstico",
                serialNumbers: payload.equipment?.serial_numbers || (payload.serial_number ? [payload.serial_number] : []),
                sn: payload.serial_number || (payload.equipment?.serial_numbers?.[0] || "")
              },
              timeline: obsTimeline,
              messages: obsMessages,
              technicianActions: [],
              technicalEvidence: [],
              aiObservations: [
                {
                  id: `obs-hf-${Date.now()}`,
                  timestamp: occurredAt,
                  category: "hyperflow_conversation",
                  title: `Atendimento WhatsApp Integrado (${protoCode})`,
                  detail: `Conversa sincronizada via TARS Vision Bridge com ${obsMessages.length || payload.messageCount || 0} mensagens registradas.`,
                  confidence: 0.95,
                  confidenceLevel: "HIGH",
                  needsHumanReview: false,
                  uncertainties: []
                }
              ],
              confidence: 0.95,
              confidenceLevel: "HIGH",
              needsHumanReview: false,
              uncertainties: [],
              humanCorrections: [],
              humanAnalysis: {},
              attachments: [],
              learningMetadata: {
                isValidated: false,
                validatedAt: null,
                validatedBy: null,
                isTrainingCandidate: false,
                tags: ["hyperflow", "whatsapp", "bridge-sync"]
              },
              createdAt: occurredAt,
              updatedAt: occurredAt
            });
          }
          updatedObserverCases = obsCases;
        } catch (e) {
          console.warn("[SLA Webhook] Could not mirror Hyperflow event to Observer Cases:", e);
        }
      }

      writeStorage({
        slaCases: list,
        slaWebhookLogs: logs.slice(0, 50),
        ...(updatedObserverCases ? { tarsObserverCases: updatedObserverCases } : {})
      });

      return sendResponse(res, 200, {
        ok: true,
        message: "SLA webhook event successfully processed and persisted.",
        caseId: matchedCaseId,
        isNewCase,
        event: eventType,
        logId: logEntry.id
      });
    } catch (err) {
      return sendResponse(res, 500, { ok: false, error: err.message });
    }
  }

  return sendResponse(res, 405, { ok: false, error: "Method not allowed" });
}
