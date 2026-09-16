import { handleCors } from "../../_smtp.js";
import { getObserverCases, exportLearningCandidatesJSONL } from "../_observer-engine.js";

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  try {
    const cases = getObserverCases();
    const jsonlContent = exportLearningCandidatesJSONL(cases);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Disposition", 'attachment; filename="tars-validated-cases.jsonl"');
    res.setHeader("Content-Type", "application/x-jsonlines; charset=utf-8");
    res.statusCode = 200;
    return res.end(jsonlContent);
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: err.message || "Internal error" }));
  }
}
