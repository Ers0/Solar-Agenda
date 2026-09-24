import { handleCors } from "../../_smtp.js";
import { getObserverCases, exportLearningCandidates } from "../_observer-engine.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  try {
    const cases = getObserverCases();
    const urlObj = new URL(req.url, "http://localhost:3000");
    const format = (urlObj.searchParams.get("format") || "jsonl").toLowerCase();
    const content = exportLearningCandidates(cases, format);

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (format === "alpaca") {
      res.setHeader("Content-Disposition", 'attachment; filename="tars-alpaca-dataset.json"');
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    } else if (format === "dpo") {
      res.setHeader("Content-Disposition", 'attachment; filename="tars-dpo-dataset.jsonl"');
      res.setHeader("Content-Type", "application/x-jsonlines; charset=utf-8");
    } else {
      res.setHeader("Content-Disposition", 'attachment; filename="tars-validated-cases.jsonl"');
      res.setHeader("Content-Type", "application/x-jsonlines; charset=utf-8");
    }
    res.statusCode = 200;
    return res.end(content);
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: err.message || "Internal error" }));
  }
}
