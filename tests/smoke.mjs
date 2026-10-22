import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split("=")),
);
const key = env.API_KEY;
const base = "http://localhost:3000";
const run = Date.now().toString();
const checks = [];
const timings = [];
async function call(url, body, headers = {}) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json() };
}
async function until(fn, label, timeout = 90000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Timed out: " + label + " " + JSON.stringify(last));
}
const mark = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
await until(
  async () => {
    const r = await fetch("http://localhost:5678/healthz");
    return r.ok;
  },
  "n8n healthy",
  180000,
);
assert.equal(
  (await call(base + "/approvals", null, { "x-api-key": "wrong" })).status,
  401,
);
mark("API authentication");
const customerId = "11111111-1111-4111-8111-111111111111";
assert.equal(
  (
    await call(
      base + "/orders",
      { customerId, description: "bad", amount: -1, currency: "EUR" },
      { "Idempotency-Key": "invalid-" + run },
    )
  ).status,
  400,
);
mark("payload contract validation");
async function intake(description, suffix) {
  const payload = { customerId, description, amount: 120, currency: "EUR" };
  const idem = "smoke-" + run + "-" + suffix;
  const started = Date.now();
  // The HTTP health endpoint can be ready before published triggers register.
  await until(async () => {
    const response = await call(
      "http://localhost:5678/webhook/orders",
      payload,
      {
        "Idempotency-Key": idem,
      },
    );
    if (response.status === 404) return false;
    assert.equal(response.status, 200);
    return true;
  }, "published webhook registration");
  const row = await until(async () => {
    const a = await call(base + "/approvals");
    const found = a.data.find((x) => x.payload.description === description);
    if (found) return found;
    const r = await call(base + "/orders", payload, {
      "Idempotency-Key": idem,
    });
    return ["completed", "ready", "pending"].includes(r.data.status)
      ? r.data
      : false;
  }, "intake " + suffix);
  return { id: row.id, idem, payload, started };
}
async function status(id, expected) {
  return until(async () => {
    const r = await call(base + "/orders/" + id);
    return r.data.status === expected ? r.data : false;
  }, expected);
}
const high = await intake("New license seats " + run, "high");
await status(high.id, "completed");
timings.push({ case: "automatic", milliseconds: Date.now() - high.started });
mark("webhook through LLM task invoice and Slack");
const repeats = await Promise.all(
  Array.from({ length: 5 }, () =>
    call(base + "/orders", high.payload, { "Idempotency-Key": high.idem }),
  ),
);
assert(repeats.every((r) => r.data.id === high.id));
assert.equal(
  (
    await call(
      base + "/orders",
      { ...high.payload, amount: 999 },
      { "Idempotency-Key": high.idem },
    )
  ).status,
  409,
);
mark("concurrent idempotency and conflict detection");
await call("http://localhost:5678/webhook/orders", high.payload, {
  "Idempotency-Key": high.idem,
});
await new Promise((r) => setTimeout(r, 2000));
const records = () => call("http://localhost:8090/records");
let delivered = (await records()).data.filter(
  (x) => x.body.orderId === high.id,
);
assert.equal(delivered.length, 3);
mark("retried webhook has no duplicate external effects");
for (const decision of ["approved", "rejected"]) {
  const low = await intake(
    "Please help with request " + run + " " + decision,
    decision,
  );
  await until(async () => {
    const r = await call(base + "/approvals");
    return r.data.find((a) => a.id === low.id && a.resumable);
  }, "callback registration");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await call(base + "/orders/" + low.id)).data.status, "pending");
  assert.equal(
    (await records()).data.filter((x) => x.body.orderId === low.id).length,
    0,
  );
  await until(async () => {
    const r = await call(base + "/approvals/" + low.id + "/decision", {
      decision,
    });
    return r.status === 200;
  }, "resume wait");
  await status(low.id, decision === "approved" ? "completed" : "rejected");
  assert.equal(
    (await call(base + "/approvals/" + low.id + "/decision", { decision }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(base + "/approvals/" + low.id + "/decision", {
        decision: decision === "approved" ? "rejected" : "approved",
      })
    ).status,
    409,
  );
  if (decision === "rejected")
    assert.equal(
      (await records()).data.filter((x) => x.body.orderId === low.id).length,
      0,
    );
  mark("human " + decision + " resumes n8n and gates effects");
}
await call("http://localhost:8090/control", { failNext: 4 });
const recovery = await intake("Fix technical bug " + run, "recovery");
await status(recovery.id, "completed");
await until(
  async () =>
    (await records()).data.some((x) => x.body.alert === "workflow failure"),
  "recovery alert",
);
mark("bounded retries error workflow recovery and alert");
await call("http://localhost:5678/webhook/report", {});
await until(
  async () =>
    (await records()).data.some((x) => x.body.since === "last 24 hours"),
  "daily report",
);
mark("daily report graph reads PostgreSQL and sends summary");
if (process.env.EXPECT_SCHEDULE === "1") {
  await until(
    async () =>
      (await records()).data.some((x) => x.body.trigger === "trigger"),
    "real schedule trigger",
    90000,
  );
  mark("real scheduled report fires on accelerated CI clock");
}
const invoices = (await call(base + "/invoice-drafts")).data;
assert(invoices.some((x) => x.order_id === high.id));
mark("invoice drafts persisted");
const metrics = await (await fetch(base + "/metrics")).text();
for (const metric of [
  "workflows_triggered_total",
  "workflow_failures_total",
  "llm_latency_seconds_count",
  "approvals_total",
])
  assert(metrics.includes(metric));
mark("Prometheus instrumentation");
await until(async () => {
  const r = await fetch("http://localhost:9090/api/v1/targets");
  const data = await r.json();
  return (
    data.data.activeTargets.length === 2 &&
    data.data.activeTargets.every((t) => t.health === "up")
  );
}, "Prometheus scrapes");
mark("Prometheus scrape targets up");
assert((await fetch("http://localhost:3001/api/health")).ok);
const dashboardResponse = await fetch(
  "http://localhost:3001/api/dashboards/uid/automation-hub",
  {
    headers: {
      Authorization:
        "Basic " +
        Buffer.from("admin:" + env.GRAFANA_PASSWORD).toString("base64"),
    },
  },
);
assert(dashboardResponse.ok);
assert.equal((await dashboardResponse.json()).dashboard.panels.length, 4);
assert((await fetch("http://localhost:8025/api/v2/messages")).ok);
mark("Grafana dashboard provisioned and MailHog healthy");
mkdirSync("docs/runs", { recursive: true });
const result = {
  timestamp: new Date().toISOString(),
  mode: "mock",
  passed: checks.length,
  checks,
  timings,
};
writeFileSync("docs/runs/smoke.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
