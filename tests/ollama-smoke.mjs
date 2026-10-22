import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split("=")),
);
const headers = {
  "x-api-key": env.API_KEY,
  "Content-Type": "application/json",
  "Idempotency-Key": "ollama-" + Date.now(),
};
const payload = {
  customerId: "11111111-1111-4111-8111-111111111111",
  description:
    "Please add ten annual software license seats for the sales team.",
  amount: 240,
  currency: "EUR",
};
async function api(path, body) {
  const r = await fetch("http://localhost:3000" + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Error("API HTTP " + r.status);
  return r.json();
}
const started = Date.now();
const intake = await fetch("http://localhost:5678/webhook/orders", {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});
assert(intake.ok);
let order;
while (Date.now() - started < 120000) {
  order = await api("/orders", payload);
  if (order.status === "pending") {
    const approvals = await api("/approvals");
    if (approvals.some((a) => a.id === order.id && a.resumable)) {
      // The test acts as the human reviewer for this synthetic order.
      const decision = await fetch(
        "http://localhost:3000/approvals/" + order.id + "/decision",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ decision: "approved" }),
        },
      );
      if (!decision.ok && decision.status !== 500)
        throw Error("Approval HTTP " + decision.status);
    }
  }
  if (order.status === "completed") break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.equal(order.status, "completed");
assert(
  order.classification.confidence > 0,
  "Expected a real validated model response",
);
const records = await (await fetch("http://localhost:8090/records")).json();
assert.equal(records.filter((r) => r.body.orderId === order.id).length, 3);
const result = {
  timestamp: new Date().toISOString(),
  mode: "ollama",
  status: order.status,
  classification: order.classification,
  total_ms: Date.now() - started,
  external_effects: 3,
};
writeFileSync(
  "docs/runs/ollama-smoke.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
