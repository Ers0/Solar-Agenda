import { handleCors, parseJsonBody } from "../_smtp.js";
import { readAppStorage, writeAppStorage } from "../_observer-engine.js";

const MAX_LOGS = 100;
const MAX_PROCESSED_EVENTS = 1000;

function send(res, status, body) {
  return res.status(status).json(body);
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function normalizePhone(value) {
  return clean(value).replace(/\D/g, "");
}

function lower(value) {
  return clean(value).toLowerCase();
}

function firstNonEmpty(...values) {
  return values.find(v => clean(v)) || "";
}

function makeEventId(payload, index = 0) {
  return clean(
    payload.eventId ||
    payload.id ||
    payload.data?.eventId ||
    `${payload.event || payload.eventType || "sla.generic.event"}:${payload.conversationId || payload.case?.conversationId || "no-conversation"}:${payload.occurredAt || payload.observedAt || Date.now()}:${index}`
  );
}

function normalizeIncoming(raw) {
  // The current Bridge sends a flat event. The Observer Engine uses events[].
  // Accept both so the webhook is not coupled to one producer format.
  if (Array.isArray(raw?.events)) {
    return raw.events.map((ev, index) => normalizeObserverEvent(ev, index));
  }

  return [normalizeFlatEvent(raw, 0)];
}

function normalizeObserverEvent(ev, index) {
  const data = ev?.data || {};
  const event = clean(
    ev?.eventType ||
    ev?.event ||
    data.event ||
    "sla.generic.event"
  );

  const caseData = ev?.case || {};

  return {
    ...ev,

    event,

    eventId: makeEventId(ev, index),

    occurredAt: firstNonEmpty(
      ev?.observedAt,
      ev?.occurredAt,
      data?.occurredAt,
      new Date().toISOString()
    ),

    conversationId: firstNonEmpty(
      caseData.conversationId,
      ev?.conversationId,
      data?.conversationId
    ),

    protocol: firstNonEmpty(
      caseData.protocol,
      ev?.protocol,
      data?.protocol
    ),

    source: firstNonEmpty(
      ev?.source,
      data?.source,
      "tars-vision-bridge"
    ),

    bridgeVersion: firstNonEmpty(
      ev?.bridgeVersion,
      data?.bridgeVersion,
      "1.2.80"
    ),

    status: firstNonEmpty(
      ev?.status,
      data?.status,
      "COMPLETED"
    ),

    customer: {
      ...(caseData.customer || {}),
      ...(data.customer || {}),

      name: firstNonEmpty(
        caseData.customer?.name,
        caseData.customerName,
        data.customer?.name,
        ev?.customer?.name
      ),

      phone: firstNonEmpty(
        caseData.customer?.phone,
        caseData.customerPhone,
        data.customer?.phone,
        ev?.customer?.phone
      ),

      email: firstNonEmpty(
        caseData.customer?.email,
        data.customer?.email,
        ev?.customer?.email
      )
    },

    organization:
      data.organization ||
      ev?.organization ||
      {},

    account:
      data.account ||
      ev?.account ||
      {},

    messages:
      Array.isArray(data.messages)
        ? data.messages
        : Array.isArray(ev?.messages)
          ? ev.messages
          : [],

    conversationUrl: firstNonEmpty(
      data.conversationUrl,
      ev?.conversationUrl,
      ev?.conversationLink,
      ev?.url
    ),

    caseId: firstNonEmpty(
      caseData.caseId,
      ev?.caseId,
      ev?.slaCaseId,
      data.caseId
    )
  };
}

function normalizeFlatEvent(payload) {
  return {
    ...payload,

    event: clean(
      payload?.event ||
      payload?.eventType ||
      "sla.generic.event"
    ),

    eventId: makeEventId(payload),

    occurredAt: firstNonEmpty(
      payload?.occurredAt,
      payload?.observedAt,
      new Date().toISOString()
    ),

    conversationId: firstNonEmpty(
      payload?.conversationId,
      payload?.case?.conversationId
    ),

    protocol: firstNonEmpty(
      payload?.protocol,
      payload?.hyperflowProtocol,
      payload?.case?.protocol
    ),

    source: firstNonEmpty(
      payload?.source,
      "tars-vision-bridge"
    ),

    bridgeVersion: firstNonEmpty(
      payload?.bridgeVersion,
      payload?.version,
      "1.2.80"
    ),

    status: firstNonEmpty(
      payload?.status,
      "COMPLETED"
    ),

    customer:
      payload?.customer ||
      {},

    organization:
      payload?.organization ||
      {},

    account:
      payload?.account ||
      {},

    messages:
      Array.isArray(payload?.messages)
        ? payload.messages
        : [],

    conversationUrl: firstNonEmpty(
      payload?.conversationUrl,
      payload?.conversationLink,
      payload?.url
    ),

    caseId: firstNonEmpty(
      payload?.caseId,
      payload?.slaCaseId
    )
  };
}

function getProtocolIds(protocols) {
  const out = [];

  if (!protocols || typeof protocols !== "object") {
    return out;
  }

  if (clean(protocols.hyperflow_id)) {
    out.push(clean(protocols.hyperflow_id));
  }

  if (clean(protocols.hyperflow_url)) {
    out.push(clean(protocols.hyperflow_url));
  }

  const hf = protocols.hyperflow;

  if (Array.isArray(hf)) {
    for (const item of hf) {
      if (typeof item === "string") {
        out.push(item);
      } else if (item && typeof item === "object") {
        out.push(
          clean(item.protocol),
          clean(item.conversation_id),
          clean(item.conversation_url)
        );
      }
    }
  } else if (hf && typeof hf === "object") {
    out.push(
      clean(hf.protocol),
      clean(hf.conversation_id),
      clean(hf.conversation_url)
    );
  }

  return out.filter(Boolean);
}

function caseMatches(c, ev, identity) {
  const protocols = c?.protocols || {};

  const values = getProtocolIds(protocols)
    .map(lower);

  const conversationId =
    lower(identity.conversationId);

  const protocol =
    lower(identity.protocol);

  const conversationUrl =
    lower(identity.conversationUrl);

  const email =
    lower(
      identity.loginEmail ||
      identity.customerEmail
    );

  const phone =
    normalizePhone(identity.customerPhone);

  const caseId =
    lower(identity.caseId);

  if (
    caseId &&
    lower(c?.id) === caseId
  ) {
    return true;
  }

  if (
    protocol &&
    values.includes(protocol)
  ) {
    return true;
  }

  if (
    conversationId &&
    values.includes(conversationId)
  ) {
    return true;
  }

  if (
    conversationUrl &&
    values.includes(conversationUrl)
  ) {
    return true;
  }

  const cEmail =
    lower(c?.customer?.email);

  const cPhone =
    normalizePhone(c?.customer?.phone);

  if (
    email &&
    cEmail &&
    email === cEmail
  ) {
    return true;
  }

  if (
    phone.length >= 8 &&
    cPhone &&
    (
      cPhone === phone ||
      cPhone.endsWith(phone) ||
      phone.endsWith(cPhone)
    )
  ) {
    return true;
  }

  if (
    email &&
    Array.isArray(protocols.hoymiles) &&
    protocols.hoymiles.some(
      h =>
        lower(h?.account_email) === email
    )
  ) {
    return true;
  }

  return false;
}

function isHyperflowEvent(ev) {
  const event = lower(ev.event);

  return (
    event.startsWith("hyperflow") ||
    Boolean(ev.conversationUrl) ||
    Boolean(ev.protocol) ||
    ev.messages.length > 0
  );
}

function appendTimeline(c, item) {
  if (!Array.isArray(c.timeline)) {
    c.timeline = [];
  }

  c.timeline.push(item);

  if (c.timeline.length > 200) {
    c.timeline =
      c.timeline.slice(-200);
  }
}

function buildIdentity(ev) {
  const customer =
    ev.customer || {};

  const organization =
    ev.organization || {};

  const account =
    ev.account || {};

  const customerName =
    firstNonEmpty(
      customer.name,
      organization.name,
      ev.customerName,
      "Cliente Solar"
    );

  const customerEmail =
    firstNonEmpty(
      customer.email,
      account.loginEmail,
      ev.email
    );

  const customerPhone =
    firstNonEmpty(
      customer.phone,
      ev.phone
    );

  const customerState =
    firstNonEmpty(
      customer.state,
      ev.state
    );

  const orgName =
    firstNonEmpty(
      organization.name,
      ev.company
    );

  const parentOrg =
    firstNonEmpty(
      organization.parentOrganization,
      "APItest"
    );

  const role =
    firstNonEmpty(
      organization.role,
      "Installer"
    );

  const loginEmail =
    lower(
      firstNonEmpty(
        account.loginEmail,
        customerEmail
      )
    );

  const conversationId =
    clean(ev.conversationId);

  const conversationUrl =
    clean(ev.conversationUrl);

  const protocol =
    firstNonEmpty(
      ev.protocol,
      conversationId
        ? `HF-${conversationId
            .replace(/^hyperflow:/i, "")
            .slice(0, 12)}`
        : ""
    );

  return {
    customerName,
    customerEmail,
    customerPhone,
    customerState,
    orgName,
    parentOrg,
    role,
    loginEmail,
    conversationId,
    conversationUrl,
    protocol,
    caseId: clean(ev.caseId)
  };
}

function updateCase(c, ev, identity) {
  c.protocols =
    c.protocols || {};

  const now =
    new Date().toISOString();

  if (isHyperflowEvent(ev)) {
    const proto =
      identity.protocol ||
      c.protocols.hyperflow_id ||
      `HF-${identity.conversationId || Date.now()}`;

    const url =
      identity.conversationUrl ||
      c.protocols.hyperflow_url ||
      (
        identity.conversationId
          ? `https://conversas.hyperflow.global/chat/${identity.conversationId}`
          : ""
      );

    c.protocols.hyperflow = {
      protocol: proto,

      conversation_url: url,

      conversation_id:
        identity.conversationId ||
        c.protocols.hyperflow?.conversation_id ||
        "",

      status: "LINKED",

      synced_at:
        ev.occurredAt,

      customer_name:
        identity.customerName,

      customer_phone:
        identity.customerPhone
    };

    c.protocols.hyperflow_id =
      proto;

    c.protocols.hyperflow_url =
      url;

    c.conversation =
      c.conversation || {};

    c.conversation.source =
      "Hyperflow";

    c.conversation.channel =
      "WhatsApp";

    c.conversation.conversation_url =
      url;

    c.conversation.protocol =
      proto;

    if (ev.messages.length) {
      c.conversation.messages =
        ev.messages;
    }

    appendTimeline(c, {
      id:
        `tl-hf-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,

      eventId:
        ev.eventId,

      type:
        "hyperflow_protocol_linked",

      eventType:
        "hyperflow_protocol_linked",

      title:
        `Protocolo Hyperflow Vinculado: ${proto}`,

      detail:
        `Conversa sincronizada via TARS Bridge. Total de mensagens: ${c.conversation.messages?.length || 0}.`,

      author:
        `TARS Vision Bridge v${ev.bridgeVersion}`,

      timestamp:
        ev.occurredAt
    });
  } else {
    c.protocols.hoymiles =
      Array.isArray(c.protocols.hoymiles)
        ? c.protocols.hoymiles
        : [];

    if (
      !c.protocols.hoymiles.some(
        h =>
          lower(h?.account_email) ===
          identity.loginEmail
      )
    ) {
      c.protocols.hoymiles.push({
        account_email:
          identity.loginEmail,

        org_name:
          identity.orgName,

        parent_org:
          identity.parentOrg,

        role:
          identity.role,

        created_at:
          ev.occurredAt,

        conversation_id:
          identity.conversationId,

        status:
          ev.status
      });
    }

    const hf =
      c.protocols.hyperflow;

    if (identity.conversationId) {
      if (Array.isArray(hf)) {
        if (
          !hf.includes(
            identity.conversationId
          )
        ) {
          hf.push(
            identity.conversationId
          );
        }
      } else if (
        hf &&
        typeof hf === "object"
      ) {
        hf.conversation_id =
          identity.conversationId;
      } else {
        c.protocols.hyperflow = [
          identity.conversationId
        ];
      }
    }

    appendTimeline(c, {
      id:
        `tl-hoy-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,

      eventId:
        ev.eventId,

      type:
        "hoymiles_account_created",

      eventType:
        "hoymiles_account_created",

      title:
        `Conta Hoymiles Criada: ${identity.loginEmail || "sem e-mail"}`,

      detail:
        `Conta de Instalador criada no portal Hoymiles vinculada a ${identity.parentOrg} (${identity.orgName || "organização"}). Credenciais entregues via Hyperflow.`,

      author:
        `TARS Vision Bridge v${ev.bridgeVersion}`,

      timestamp:
        ev.occurredAt
    });

    if (
      [
        "aberto",
        "em_analise",
        "aguardando_terceiros"
      ].includes(
        lower(c.status)
      )
    ) {
      c.status =
        "concluido";

      c.resolved_at =
        ev.occurredAt;
    }
  }

  c.updated_at =
    now;

  return c;
}

function createCase(ev, identity) {
  const caseNum =
    `${Date.now()
      .toString(36)
      .slice(-5)}${Math.floor(
      Math.random() * 1000
    )}`.toUpperCase();

  const hf =
    isHyperflowEvent(ev);

  if (hf) {
    const id =
      `SLA-HF-${caseNum}`;

    const proto =
      identity.protocol ||
      `HF-${caseNum}`;

    const url =
      identity.conversationUrl ||
      (
        identity.conversationId
          ? `https://conversas.hyperflow.global/chat/${identity.conversationId}`
          : ""
      );

    return {
      id,

      title:
        `Atendimento Hyperflow — ${identity.customerName}`,

      priority:
        ev.priority || "alta",

      status:
        ev.status || "aberto",

      created_at:
        ev.occurredAt,

      updated_at:
        ev.occurredAt,

      sla_deadline:
        new Date(
          Date.now() +
          24 * 3600000
        ).toISOString(),

      sla_limit_hours:
        24,

      responsible_tech:
        "Suporte Solar (TARS Bridge)",

      customer: {
        name:
          identity.customerName,

        email:
          identity.customerEmail,

        phone:
          identity.customerPhone,

        state:
          identity.customerState,

        site_location:
          ev.site_location || ""
      },

      equipment:
        ev.equipment || {
          manufacturer:
            ev.manufacturer ||
            "Inversor Solar",

          model:
            ev.model ||
            "Equipamento em Diagnóstico",

          serial_numbers:
            ev.serial_number
              ? [ev.serial_number]
              : (
                  ev.serial_numbers ||
                  []
                )
        },

      problem_summary:
        ev.problem_summary ||
        (
          ev.messages?.[0]?.text
            ? `Conversa Hyperflow: ${String(
                ev.messages[0].text
              ).slice(0, 180)}`
            : "Atendimento importado via TARS Bridge."
        ),

      next_action:
        "Avaliar protocolo e histórico do cliente via conversa Hyperflow vinculada.",

      protocols: {
        hyperflow: {
          protocol:
            proto,

          conversation_url:
            url,

          conversation_id:
            identity.conversationId,

          status:
            "LINKED",

          synced_at:
            ev.occurredAt,

          customer_name:
            identity.customerName,

          customer_phone:
            identity.customerPhone
        },

        hyperflow_id:
          proto,

        hyperflow_url:
          url,

        jira:
          [],

        hoymiles:
          []
      },

      conversation: {
        source:
          "Hyperflow",

        channel:
          "WhatsApp",

        conversation_url:
          url,

        protocol:
          proto,

        messages:
          ev.messages
      },

      timeline: [{
        id:
          `tl-hf-init-${Date.now()}`,

        type:
          "hyperflow_protocol_linked",

        eventType:
          "hyperflow_protocol_linked",

        eventId:
          ev.eventId,

        title:
          `Caso Aberto via Hyperflow: ${proto}`,

        detail:
          `Atendimento recebido via TARS Bridge Webhook com link direto da conversa: ${url || "N/A"}.`,

        author:
          `TARS Vision Bridge v${ev.bridgeVersion}`,

        timestamp:
          ev.occurredAt
      }]
    };
  }

  const id =
    `SLA-HOY-${caseNum}`;

  return {
    id,

    title:
      `Criação de Conta Hoymiles — ${identity.orgName || identity.customerName}`,

    priority:
      "media",

    status:
      "concluido",

    created_at:
      ev.occurredAt,

    updated_at:
      ev.occurredAt,

    resolved_at:
      ev.occurredAt,

    sla_limit_hours:
      24,

    responsible_tech:
      "TARS Vision Bridge",

    customer: {
      name:
        identity.customerName,

      email:
        identity.customerEmail ||
        identity.loginEmail,

      phone:
        identity.customerPhone,

      state:
        identity.customerState,

      company:
        identity.orgName
    },

    equipment: {
      manufacturer:
        "Hoymiles",

      model:
        "S-Miles Cloud (Portal do Instalador)",

      serial_numbers:
        ["N/A - Conta Web/App"]
    },

    problem_summary:
      `Criação automatizada de conta de Instalador Hoymiles para ${identity.customerName} (${identity.orgName || "organização"}). Login: ${identity.loginEmail || "N/A"}. Credenciais entregues via Hyperflow.`,

    protocols: {
      hoymiles: [{
        account_email:
          identity.loginEmail,

        org_name:
          identity.orgName,

        parent_org:
          identity.parentOrg,

        role:
          identity.role,

        created_at:
          ev.occurredAt,

        conversation_id:
          identity.conversationId,

        status:
          ev.status
      }],

      hyperflow:
        identity.conversationId
          ? [identity.conversationId]
          : []
    },

    conversation:
      identity.conversationId
        ? {
            source:
              "Hyperflow",

            channel:
              "WhatsApp",

            conversation_url:
              identity.conversationUrl ||
              `https://conversas.hyperflow.global/chat/${identity.conversationId}`,

            protocol:
              identity.protocol,

            messages:
              ev.messages
          }
        : undefined,

    timeline: [{
      id:
        `tl-hoy-init-${Date.now()}`,

      type:
        "hoymiles_account_created",

      eventType:
        "hoymiles_account_created",

      eventId:
        ev.eventId,

      title:
        "Conta Hoymiles Criada & Entregue",

      detail:
        `Conta de Instalador criada no portal global.hoymiles.com vinculada a ${identity.parentOrg} (${identity.orgName || "organização"}). Status: ${ev.status}. Credenciais e links repassados ao cliente via Hyperflow.`,

      author:
        `TARS Vision Bridge v${ev.bridgeVersion}`,

      timestamp:
        ev.occurredAt
    }],

    notes:
      `Evento recebido via Webhook SLA (${ev.event}) da extensão TARS Vision Bridge v${ev.bridgeVersion}. Senhas não são armazenadas no Solar Agenda.`
  };
}

function processEvent(storage, ev) {
  const identity =
    buildIdentity(ev);

  const cases =
    Array.isArray(storage.slaCases)
      ? [...storage.slaCases]
      : [];

  const processed =
    Array.isArray(
      storage.tarsProcessedSlaWebhookEvents
    )
      ? [
          ...storage.tarsProcessedSlaWebhookEvents
        ]
      : [];

  if (
    processed.includes(
      ev.eventId
    )
  ) {
    return {
      duplicate:
        true,

      caseId:
        null,

      isNewCase:
        false,

      log: {
        id:
          `sla-wh-dup-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,

        receivedAt:
          new Date().toISOString(),

        event:
          ev.event,

        eventId:
          ev.eventId,

        source:
          ev.source,

        bridgeVersion:
          ev.bridgeVersion,

        status:
          "DUPLICATE",

        customer:
          identity.customerName,

        email:
          identity.loginEmail,

        company:
          identity.orgName,

        conversationId:
          identity.conversationId ||
          null,

        matchedCaseId:
          null,

        isNewCase:
          false
      },

      cases,

      processed
    };
  }

  let index =
    cases.findIndex(
      c =>
        caseMatches(
          c,
          ev,
          identity
        )
    );

  let isNewCase =
    false;

  let caseId;

  if (index >= 0) {
    cases[index] =
      updateCase(
        { ...cases[index] },
        ev,
        identity
      );

    caseId =
      cases[index].id;
  } else {
    const newCase =
      createCase(
        ev,
        identity
      );

    cases.unshift(
      newCase
    );

    caseId =
      newCase.id;

    isNewCase =
      true;
  }

  processed.unshift(
    ev.eventId
  );

  const log = {
    id:
      `sla-wh-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,

    receivedAt:
      new Date().toISOString(),

    event:
      ev.event,

    eventId:
      ev.eventId,

    source:
      ev.source,

    bridgeVersion:
      ev.bridgeVersion,

    status:
      ev.status,

    customer:
      identity.customerName,

    email:
      identity.loginEmail,

    company:
      identity.orgName,

    conversationId:
      identity.conversationId ||
      null,

    matchedCaseId:
      caseId,

    isNewCase
  };

  return {
    duplicate:
      false,

    caseId,

    isNewCase,

    log,

    cases,

    processed:
      processed.slice(
        0,
        MAX_PROCESSED_EVENTS
      )
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return;
  }

  if (req.method === "GET") {
    const storage =
      readAppStorage();

    const logs =
      Array.isArray(
        storage.slaWebhookLogs
      )
        ? storage.slaWebhookLogs
        : [];

    const cases =
      Array.isArray(
        storage.slaCases
      )
        ? storage.slaCases
        : [];

    // GET is intentionally a read/sync endpoint.
    // It does not fabricate an event and now exposes
    // the same SLA state that POST updates.
    return send(res, 200, {
      ok:
        true,

      service:
        "solar-agenda-sla-webhook",

      receiver:
        "tars-vision-bridge",

      accepts:
        ["POST"],

      logs:
        logs.slice(
          0,
          MAX_LOGS
        ),

      cases,

      latest:
        logs[0] ||
        null,

      counts: {
        logs:
          logs.length,

        cases:
          cases.length,

        processedEvents:
          Array.isArray(
            storage.tarsProcessedSlaWebhookEvents
          )
            ? storage
                .tarsProcessedSlaWebhookEvents
                .length
            : 0
      },

      now:
        new Date().toISOString()
    });
  }

  if (req.method !== "POST") {
    res.setHeader(
      "Allow",
      "GET, POST, OPTIONS"
    );

    return send(
      res,
      405,
      {
        ok:
          false,

        error:
          "method_not_allowed"
      }
    );
  }

  try {
    const raw =
      await parseJsonBody(req);

    const events =
      normalizeIncoming(
        raw || {}
      );

    if (!events.length) {
      return send(
        res,
        400,
        {
          ok:
            false,

          error:
            "no_events"
        }
      );
    }

    let storage =
      readAppStorage();

    const results =
      [];

    for (const ev of events) {
      const result =
        processEvent(
          storage,
          ev
        );

      storage = {
        ...storage,

        slaCases:
          result.cases,

        slaWebhookLogs: [
          result.log,
          ...(Array.isArray(
            storage.slaWebhookLogs
          )
            ? storage.slaWebhookLogs
            : [])
        ].slice(
          0,
          MAX_LOGS
        ),

        tarsProcessedSlaWebhookEvents:
          result.processed
      };

      const persisted =
        writeAppStorage({
          slaCases:
            storage.slaCases,

          slaWebhookLogs:
            storage.slaWebhookLogs,

          tarsProcessedSlaWebhookEvents:
            storage.tarsProcessedSlaWebhookEvents
        });

      if (!persisted) {
        throw new Error(
          "Solar Agenda storage write failed"
        );
      }

      results.push({
        eventId:
          ev.eventId,

        event:
          ev.event,

        caseId:
          result.caseId,

        isNewCase:
          result.isNewCase,

        duplicate:
          result.duplicate,

        receivedAt:
          result.log.receivedAt
      });
    }

    return send(
      res,
      200,
      {
        ok:
          true,

        received:
          true,

        processed:
          results.length,

        results,

        // Kept for compatibility with
        // the original single-event response.
        caseId:
          results.length === 1
            ? results[0].caseId
            : undefined,

        isNewCase:
          results.length === 1
            ? results[0].isNewCase
            : undefined,

        event:
          results.length === 1
            ? results[0].event
            : "batch",

        logId:
          results.length === 1
            ? storage
                .slaWebhookLogs[0]?.id
            : undefined
      }
    );
  } catch (err) {
    console.error(
      "[TARS SLA WEBHOOK] ERROR",
      err
    );

    return send(
      res,
      400,
      {
        ok:
          false,

        error:
          err?.message ||
          "invalid_webhook_payload"
      }
    );
  }
}
