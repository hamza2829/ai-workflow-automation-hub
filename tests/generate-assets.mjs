import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const write = (path, data) => {
  mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};
const node = (name, type, parameters = {}, version = 1) => ({
  id: randomUUID(),
  name,
  type: "n8n-nodes-base." + type,
  typeVersion: version,
  position: [0, 0],
  parameters,
});
const hook = (name, path) => ({
  ...node(
    name,
    "webhook",
    { httpMethod: "POST", path, responseMode: "onReceived", options: {} },
    2,
  ),
  webhookId: randomUUID(),
});
const http = (name, url, body, method = "POST", extra = {}) =>
  node(
    name,
    "httpRequest",
    {
      method,
      url,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "x-api-key", value: "={{ $env.API_KEY }}" },
          ...(extra.headers || []),
        ],
      },
      ...(body ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
      options: { timeout: 20000 },
    },
    4.2,
  );
const flow = (id, name, nodes, edges, settings = {}) => {
  nodes.forEach((n, i) => (n.position = [i * 240, 200]));
  const connections = {};
  for (const [from, to, output = 0] of edges) {
    connections[from] ??= { main: [] };
    connections[from].main[output] ??= [];
    connections[from].main[output].push({ node: to, type: "main", index: 0 });
  }
  write("workflows/" + id + ".json", {
    id,
    name,
    active: false,
    activeVersionId: null,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "all",
      ...settings,
    },
    versionId: randomUUID(),
    tags: [],
  });
};
const accept = http(
  "Validate and enrich",
  "http://backend:3000/orders",
  "={{ $json.body }}",
);
// Forward the caller key for intake authorization, rather than granting anonymous callers access.
accept.parameters.headerParameters.parameters = [
  { name: "x-api-key", value: '={{ $json.headers["x-api-key"] || "" }}' },
  {
    name: "Idempotency-Key",
    value: '={{ $json.headers["idempotency-key"] || "" }}',
  },
];
const llm = http(
  "Classify and summarize",
  "http://llm:8000/classify",
  "={{ {description: $json.payload.description} }}",
);
const telemetry = http(
  "Record LLM latency",
  "http://backend:3000/telemetry/llm",
  "={{ {seconds: $json.seconds} }}",
);
const route = http(
  "Persist classification",
  '={{ "http://backend:3000/orders/" + $("Validate and enrich").item.json.id + "/classification" }}',
  '={{ $("Classify and summarize").item.json.classification }}',
);
const condition = node(
  "Needs approval",
  "if",
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: "",
        typeValidation: "strict",
        version: 2,
      },
      conditions: [
        {
          id: randomUUID(),
          leftValue: "={{ $json.status }}",
          rightValue: "pending",
          operator: { type: "string", operation: "equals" },
        },
      ],
      combinator: "and",
    },
    options: {},
  },
  2.2,
);
const register = http(
  "Register approval callback",
  '={{ "http://backend:3000/approvals/" + $("Validate and enrich").item.json.id + "/register" }}',
  "={{ {resumeUrl: $execution.resumeUrl} }}",
);
const wait = {
  ...node(
    "Wait for human",
    "wait",
    {
      resume: "webhook",
      httpMethod: "POST",
      responseMode: "onReceived",
      options: {},
    },
    1.1,
  ),
  webhookId: randomUUID(),
};
const fulfill = http(
  "Create task invoice and summary",
  '={{ "http://backend:3000/orders/" + $("Validate and enrich").item.json.id + "/fulfill" }}',
  "={{ {} }}",
);
fulfill.retryOnFail = true;
fulfill.maxTries = 3;
fulfill.waitBetweenTries = 1000;
flow(
  "orderIntake001",
  "Order intake with human review",
  [
    hook("Order webhook", "orders"),
    accept,
    llm,
    telemetry,
    route,
    condition,
    register,
    wait,
    fulfill,
  ],
  [
    ["Order webhook", "Validate and enrich"],
    ["Validate and enrich", "Classify and summarize"],
    ["Classify and summarize", "Record LLM latency"],
    ["Record LLM latency", "Persist classification"],
    ["Persist classification", "Needs approval"],
    ["Needs approval", "Register approval callback", 0],
    ["Register approval callback", "Wait for human"],
    ["Wait for human", "Create task invoice and summary"],
    ["Needs approval", "Create task invoice and summary", 1],
  ],
  { errorWorkflow: "errorRecovery001" },
);
const report = http(
  "Read PostgreSQL report",
  "http://backend:3000/reports/daily",
  null,
  "GET",
);
flow(
  "dailyReport001",
  "Daily operational report",
  [
    node(
      "Daily at 09",
      "scheduleTrigger",
      {
        rule: {
          interval: [{ field: "cronExpression", expression: "0 9 * * *" }],
        },
      },
      1.2,
    ),
    hook("Manual report test", "report"),
    report,
    http("Send summary", "http://backend:3000/reports/send", "={{ $json }}"),
  ],
  [
    ["Daily at 09", "Read PostgreSQL report"],
    ["Manual report test", "Read PostgreSQL report"],
    ["Read PostgreSQL report", "Send summary"],
  ],
  { errorWorkflow: "errorRecovery001" },
);
const retry = http(
  "Retry ready deliveries",
  "http://backend:3000/recovery",
  "={{ $json }}",
);
retry.retryOnFail = true;
retry.maxTries = 3;
retry.waitBetweenTries = 1000;
retry.onError = "continueRegularOutput";
flow(
  "errorRecovery001",
  "Error recovery and alert",
  [
    node("Execution error", "errorTrigger"),
    retry,
    http(
      "Alert operations",
      "http://backend:3000/alerts",
      "={{ {recovery: $json} }}",
    ),
  ],
  [
    ["Execution error", "Retry ready deliveries"],
    ["Retry ready deliveries", "Alert operations"],
  ],
);
flow(
  "failureProbe001",
  "Synthetic failure probe",
  [
    hook("Failure probe", "failure-probe"),
    http(
      "Deliberate failure",
      "http://backend:3000/not-a-real-route",
      "={{ {} }}",
    ),
  ],
  [["Failure probe", "Deliberate failure"]],
  { errorWorkflow: "errorRecovery001" },
);
const panels = [
  ["Intake attempts", "workflows_triggered_total", "stat"],
  ["Workflow failures", "workflow_failures_total", "stat"],
  ["Human approvals", "sum(approvals_total)", "stat"],
  [
    "Mean LLM latency",
    "rate(llm_latency_seconds_sum[5m]) / rate(llm_latency_seconds_count[5m])",
    "timeseries",
  ],
].map(([title, expr, type], i) => ({
  id: i + 1,
  title,
  type,
  datasource: { type: "prometheus", uid: "prometheus" },
  gridPos: { x: (i % 2) * 12, y: Math.floor(i / 2) * 8, w: 12, h: 8 },
  targets: [{ expr, refId: "A" }],
  options: {},
}));
write("monitoring/dashboard.json", {
  uid: "automation-hub",
  title: "AI Workflow Automation Hub",
  schemaVersion: 40,
  version: 1,
  refresh: "5s",
  time: { from: "now-30m", to: "now" },
  panels,
});
const paths = {};
for (const [path, methods] of Object.entries({
  "/health": ["get"],
  "/metrics": ["get"],
  "/orders": ["post"],
  "/orders/{id}": ["get"],
  "/orders/{id}/classification": ["post"],
  "/orders/{id}/fulfill": ["post"],
  "/customers/{id}": ["get"],
  "/invoice-drafts": ["get"],
  "/approvals": ["get"],
  "/approvals/{id}/register": ["post"],
  "/approvals/{id}/decision": ["post"],
  "/reports/daily": ["get"],
  "/reports/send": ["post"],
  "/recovery": ["post"],
  "/alerts": ["post"],
  "/telemetry/llm": ["post"],
})) {
  paths[path] = {};
  for (const method of methods) {
    const op = {
      summary: method.toUpperCase() + " " + path,
      security: ["/health", "/metrics"].includes(path) ? [] : [{ ApiKey: [] }],
      responses: {
        200: { description: "Success" },
        400: { description: "Invalid input" },
        401: { description: "Missing or invalid API key" },
        409: { description: "Conflicting state" },
      },
    };
    if (path.includes("{id}"))
      op.parameters = [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ];
    if (path === "/orders") {
      op.parameters = [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 8, maxLength: 128 },
        },
      ];
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Order" },
          },
        },
      };
    }
    if (path.endsWith("/decision"))
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["decision"],
              properties: {
                decision: { type: "string", enum: ["approved", "rejected"] },
              },
            },
          },
        },
      };
    paths[path][method] = op;
  }
}
write("backend/openapi.json", {
  openapi: "3.0.3",
  info: { title: "Automation Hub", version: "1.0.0" },
  paths,
  components: {
    securitySchemes: {
      ApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
    },
    schemas: {
      Order: {
        type: "object",
        additionalProperties: false,
        required: ["customerId", "description", "amount", "currency"],
        properties: {
          customerId: { type: "string", format: "uuid" },
          description: { type: "string", minLength: 3, maxLength: 2000 },
          amount: {
            type: "number",
            exclusiveMinimum: true,
            minimum: 0,
            maximum: 1000000,
          },
          currency: { type: "string", enum: ["EUR", "USD"] },
        },
      },
    },
  },
});
const samples = [
  ["engineering", "Build a technical integration"],
  ["engineering", "Fix the API bug"],
  ["engineering", "Review deployment plan"],
  ["engineering", "Debug API latency"],
  ["engineering", "Add integration mapping"],
  ["engineering", "Technical migration request"],
  ["sales", "Add license seats"],
  ["sales", "Renew subscription"],
  ["sales", "Schedule a demo"],
  ["sales", "Request plan upgrade"],
  ["sales", "Purchase ten seats"],
  ["sales", "New annual license"],
  ["finance", "Correct invoice address"],
  ["finance", "Issue a refund"],
  ["finance", "Resolve payment mismatch"],
  ["finance", "Update billing contact"],
  ["finance", "Review tax amount"],
  ["finance", "Send invoice copy"],
  ["engineering", "Connect our systems"],
  ["finance", "Return duplicate charge"],
].map(([label, description], i) => ({ id: i + 1, label, description }));
write("tests/labeled-orders.json", samples);
