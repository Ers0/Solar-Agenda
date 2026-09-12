import { sendResponse, handleCors } from "./_smtp.js";

export default function handler(req, res) {
  if (handleCors(req, res)) return;

  return sendResponse(res, 200, {
    status: "ok",
    service: "Solar Agenda API (Vercel Serverless Ready)",
  });
}
