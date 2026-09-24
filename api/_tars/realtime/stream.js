import { handleCors } from "../../_smtp.js";

export default function handler(req, res) {
  if (handleCors(req, res)) return;

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Send initial connection packet
    res.write(`data: ${JSON.stringify({ type: "CONNECTED", message: "TARS Sentinel Real-Time Active" })}\n\n`);

    // In serverless, keep alive briefly and flush
    const timer = setTimeout(() => {
      try {
        res.write(`data: ${JSON.stringify({ type: "PING", timestamp: new Date().toISOString() })}\n\n`);
        res.end();
      } catch (e) {}
    }, 25000);

    req.on("close", () => {
      clearTimeout(timer);
    });
  } catch (err) {
    try {
      res.statusCode = 200;
      res.end();
    } catch (e) {}
  }
}
