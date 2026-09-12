import { parseJsonBody, sendResponse, handleCors } from "./_smtp.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    return sendResponse(res, 405, { ok: false, error: "Method not allowed. Use POST." });
  }

  try {
    const body = await parseJsonBody(req);
    const { cases = [], notes = [], rules = [] } = body || {};

    const dataset = [];
    const systemPrompt =
      "You are TARS, an expert technical solar inverter support agent specializing in on-grid, microinverter, and hybrid systems (Deye, Foxess, Growatt). You analyze alarm codes, guide PAC diagnostics, and provide actionable technical runbooks.";

    cases.forEach((c) => {
      if (!c.titulo) return;
      const alarmCode = (c.tags || []).join(", ");
      const userQuery = `Inverter issue reported: ${c.titulo}. Tags: ${alarmCode}. What is the diagnosis and recommended procedure?`;

      let resolution = "";
      if (Array.isArray(c.notes_log) && c.notes_log.length > 0) {
        resolution = c.notes_log.map((n) => n.text).join("\n");
      } else if (c.actual_end) {
        resolution = `Resolved case within priority ${c.prioridade}. Followed standard manufacturer isolation and verification checklist.`;
      }

      if (resolution) {
        dataset.push({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userQuery },
            { role: "assistant", content: `Diagnostic assessment: ${c.titulo}.\n\nField Procedures:\n${resolution}` },
          ],
        });
      }
    });

    rules.forEach((r) => {
      if (!r.pattern || !r.action) return;
      dataset.push({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `How should I handle this scenario: ${r.pattern}?` },
          { role: "assistant", content: `Technical rule: ${r.action}` },
        ],
      });
    });

    notes.forEach((n) => {
      if (!n.title || !n.content) return;
      const cleanContent = n.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      dataset.push({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Explain runbook guidelines for: ${n.title}` },
          { role: "assistant", content: cleanContent },
        ],
      });
    });

    return sendResponse(res, 200, {
      ok: true,
      count: dataset.length,
      dataset,
      jsonl: dataset.map((item) => JSON.stringify(item)).join("\n"),
    });
  } catch (err) {
    return sendResponse(res, 500, { ok: false, error: err.message });
  }
}
