import http from "node:http";
// Stateful external-style test doubles, keyed independently for each API.
const records = new Map();
let fail = 0;
http
  .createServer(async (req, res) => {
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/health") return send(200, { status: "ok" });
    if (req.url === "/records") return send(200, [...records.values()]);
    let body = "";
    for await (const part of req) body += part;
    if (req.url === "/control") {
      fail = JSON.parse(body).failNext;
      return send(200, { fail });
    }
    if (!["/tasks", "/invoices", "/slack"].includes(req.url))
      return send(404, {});
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return send(400, { error: "Invalid JSON" });
    }
    if (req.url === "/slack" && typeof payload.text !== "string")
      return send(400, { error: "Slack requires text" });
    if (req.url === "/tasks" && (!payload.summary || !payload.team))
      return send(400, { error: "Task requires summary and team" });
    if (
      req.url === "/invoices" &&
      (!(payload.amount > 0) || !["EUR", "USD"].includes(payload.currency))
    )
      return send(400, {
        error: "Invoice requires positive amount and supported currency",
      });
    const key = req.url + ":" + req.headers["idempotency-key"];
    if (!req.headers["idempotency-key"])
      return send(400, { error: "Missing idempotency key" });
    if (records.has(key)) return send(200, records.get(key));
    if (fail > 0) {
      fail--;
      return send(503, { error: "Injected integration outage" });
    }
    const result = {
      id: "mock-" + (records.size + 1),
      path: req.url,
      body: payload,
    };
    records.set(key, result);
    console.log(
      JSON.stringify({ event: "mock_delivery", path: req.url, id: result.id }),
    );
    send(201, result);
  })
  .listen(8090, "0.0.0.0");
