import handler from "./index.js";

export default async function catchAll(req, res) {
  return handler(req, res);
}
