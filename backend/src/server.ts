import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import pg from "pg";
import pino from "pino";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import { z } from "zod";
import {
  orderSchema,
  classificationSchema,
  decisionSchema,
  keySchema,
} from "./schema.js";

const log = pino({
  redact: ["req.headers.authorization", "req.headers.x-api-key", "resume_url"],
});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const triggered = new Counter({
  name: "workflows_triggered_total",
  help: "Accepted intake attempts",
  registers: [registry],
});
const failures = new Counter({
  name: "workflow_failures_total",
  help: "Workflow and service failures",
  registers: [registry],
});
const approvals = new Counter({
  name: "approvals_total",
  help: "Human decisions",
  labelNames: ["decision"],
  registers: [registry],
});
const latency = new Histogram({
  name: "llm_latency_seconds",
  help: "Observed LLM request duration",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [registry],
});
export const app = express();
app.use(express.json({ limit: "32kb" }));
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
const query = (sql: string, args: unknown[] = []) => pool.query(sql, args);
async function remote(url: string, body: unknown, key: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Integration HTTP ${response.status}`);
  return response.json() as Promise<{ id: string }>;
}
app.get(
  "/health",
  wrap(async (_req, res) => {
    await query("SELECT 1");
    res.json({ status: "ok" });
  }),
);
app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
app.get("/openapi.json", (_req, res) =>
  res.json(JSON.parse(readFileSync("openapi.json", "utf8"))),
);
app.use("/ui", express.static("../approvals-ui"));
app.use((req, res, next) => {
  const expected = Buffer.from(process.env.API_KEY || "");
  const actual = Buffer.from(req.header("x-api-key") || "");
  if (
    !expected.length ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});
app.get(
  "/customers/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const r = await query("SELECT * FROM customers WHERE id=$1", [id]);
    res
      .status(r.rowCount ? 200 : 404)
      .json(r.rows[0] || { error: "Unknown customer" });
  }),
);
app.post(
  "/orders",
  wrap(async (req, res) => {
    const body = orderSchema.parse(req.body);
    const key = keySchema.parse(req.header("Idempotency-Key"));
    const c = await query("SELECT * FROM customers WHERE id=$1", [
      body.customerId,
    ]);
    if (!c.rowCount) {
      res.status(404).json({ error: "Unknown customer" });
      return;
    }
    await query(
      "INSERT INTO orders(id,idempotency_key,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [randomUUID(), key, body],
    );
    const r = await query("SELECT * FROM orders WHERE idempotency_key=$1", [
      key,
    ]);
    const order = r.rows[0];
    if (
      JSON.stringify(orderSchema.parse(order.payload)) !== JSON.stringify(body)
    ) {
      res.status(409).json({ error: "Idempotency key payload mismatch" });
      return;
    }
    triggered.inc();
    res.json({ ...order, customer: c.rows[0] });
  }),
);
app.get(
  "/orders/:id",
  wrap(async (req, res) => {
    const r = await query("SELECT * FROM orders WHERE id=$1", [
      z.string().uuid().parse(req.params.id),
    ]);
    res
      .status(r.rowCount ? 200 : 404)
      .json(r.rows[0] || { error: "Not found" });
  }),
);
app.post(
  "/orders/:id/classification",
  wrap(async (req, res) => {
    const classification = classificationSchema.parse(req.body);
    const id = z.string().uuid().parse(req.params.id);
    const status = classification.confidence < 0.8 ? "pending" : "ready";
    await query(
      `WITH changed AS (
         UPDATE orders SET classification=$2,status=$3
         WHERE id=$1 AND status='received' RETURNING id,status
       ) INSERT INTO approvals(order_id)
         SELECT id FROM changed WHERE status='pending' ON CONFLICT DO NOTHING`,
      [id, classification, status],
    );
    const current = await query("SELECT * FROM orders WHERE id=$1", [id]);
    res
      .status(current.rowCount ? 200 : 404)
      .json(current.rows[0] || { error: "Not found" });
  }),
);
app.post(
  "/telemetry/llm",
  wrap(async (req, res) => {
    latency.observe(z.number().nonnegative().parse(req.body.seconds));
    res.json({ ok: true });
  }),
);
app.get(
  "/approvals",
  wrap(async (_req, res) => {
    const r = await query(
      "SELECT o.id,o.payload,o.classification,a.decision,a.resume_url IS NOT NULL AS resumable FROM approvals a JOIN orders o ON o.id=a.order_id WHERE a.resumed_at IS NULL ORDER BY o.created_at",
    );
    res.json(r.rows);
  }),
);
app.post(
  "/approvals/:id/register",
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const url = z.string().url().parse(req.body.resumeUrl);
    const target = new URL(url);
    if (
      target.origin !== new URL(process.env.N8N_URL!).origin ||
      !target.pathname.startsWith("/webhook-waiting/")
    ) {
      res.status(400).json({ error: "Invalid resume target" });
      return;
    }
    const r = await query(
      "UPDATE approvals SET resume_url=$2 WHERE order_id=$1 RETURNING order_id",
      [id, url],
    );
    res.status(r.rowCount ? 200 : 404).json({ id });
  }),
);
app.post(
  "/approvals/:id/decision",
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { decision } = decisionSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        "SELECT * FROM approvals WHERE order_id=$1 FOR UPDATE",
        [id],
      );
      if (!r.rowCount) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" });
        return;
      }
      const a = r.rows[0];
      if (a.decision && a.decision !== decision) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Decision is immutable" });
        return;
      }
      if (a.resumed_at) {
        await client.query("COMMIT");
        res.json({ decision, replayed: true });
        return;
      }
      if (!a.resume_url) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Workflow not waiting yet" });
        return;
      }
      await client.query("UPDATE approvals SET decision=$2 WHERE order_id=$1", [
        id,
        decision,
      ]);
      await client.query("UPDATE orders SET status=$2 WHERE id=$1", [
        id,
        decision === "approved" ? "ready" : "rejected",
      ]);
      // Commit the decision before notifying n8n, which reads it through another connection.
      await client.query("COMMIT");
      const response = await fetch(a.resume_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: id, decision }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(
          `Resume HTTP ${response.status}; retry the same decision`,
        );
      await query("UPDATE approvals SET resumed_at=now() WHERE order_id=$1", [
        id,
      ]);
      approvals.inc({ decision });
      res.json({ decision });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);
async function fulfill(id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT * FROM orders WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!r.rowCount) throw new Error("Order not found");
    const order = r.rows[0];
    if (["completed", "rejected"].includes(order.status)) {
      await client.query("COMMIT");
      return order;
    }
    if (order.status !== "ready")
      throw new Error("Order requires classification or approval");
    const base = process.env.INTEGRATIONS_URL!;
    await remote(
      `${base}/tasks`,
      {
        orderId: id,
        summary: order.classification.summary,
        team: order.classification.category,
      },
      `${id}-task`,
    );
    const invoice = await remote(
      `${base}/invoices`,
      {
        orderId: id,
        amount: order.payload.amount,
        currency: order.payload.currency,
      },
      `${id}-invoice`,
    );
    await client.query(
      "INSERT INTO invoice_drafts VALUES($1,$2) ON CONFLICT DO NOTHING",
      [id, invoice.id],
    );
    await remote(
      `${base}/slack`,
      { text: order.classification.summary, orderId: id },
      `${id}-slack`,
    );
    await client.query("UPDATE orders SET status='completed' WHERE id=$1", [
      id,
    ]);
    await client.query("COMMIT");
    return { ...order, status: "completed" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
app.post(
  "/orders/:id/fulfill",
  wrap(async (req, res) =>
    res.json(await fulfill(z.string().uuid().parse(req.params.id))),
  ),
);
app.get(
  "/invoice-drafts",
  wrap(async (_req, res) =>
    res.json((await query("SELECT * FROM invoice_drafts")).rows),
  ),
);
app.get(
  "/reports/daily",
  wrap(async (_req, res) =>
    res.json({
      since: "last 24 hours",
      orders: (
        await query(
          "SELECT status,count(*)::int AS count FROM orders WHERE created_at>now()-interval '24 hours' GROUP BY status",
        )
      ).rows,
    }),
  ),
);
app.post(
  "/reports/send",
  wrap(async (req, res) =>
    res.json(
      await remote(
        `${process.env.INTEGRATIONS_URL}/slack`,
        req.body,
        `report-${new Date().toISOString().slice(0, 10)}-${req.header("Idempotency-Key") || "scheduled"}`,
      ),
    ),
  ),
);
app.post(
  "/recovery",
  wrap(async (req, res) => {
    failures.inc();
    await query(
      "INSERT INTO events(kind,payload) VALUES('workflow_error',$1)",
      [req.body],
    );
    const pending = await query("SELECT id FROM orders WHERE status='ready'");
    let recovered = 0;
    for (const order of pending.rows) {
      await fulfill(order.id);
      recovered++;
    }
    res.json({ recovered });
  }),
);
app.post(
  "/alerts",
  wrap(async (req, res) =>
    res.json(
      await remote(
        `${process.env.INTEGRATIONS_URL}/slack`,
        { alert: "workflow failure", ...req.body },
        `alert-${randomUUID()}`,
      ),
    ),
  ),
);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  failures.inc();
  const validation = error instanceof z.ZodError;
  log.error(
    { error: validation ? "validation failed" : String(error) },
    "request failed",
  );
  res
    .status(validation ? 400 : 500)
    .json({ error: validation ? "Invalid input" : "Request failed" });
});
await query(readFileSync("migrations/001.sql", "utf8"));
app.listen(3000, () => log.info({ port: 3000 }, "backend started"));
