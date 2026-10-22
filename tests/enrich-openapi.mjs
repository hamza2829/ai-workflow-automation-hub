import { readFileSync, writeFileSync } from "node:fs";
const path = "backend/openapi.json";
const spec = JSON.parse(readFileSync(path, "utf8"));
const schemas = {
  "/orders/{id}/classification": {
    type: "object",
    additionalProperties: false,
    required: ["category", "summary", "confidence"],
    properties: {
      category: { type: "string", enum: ["engineering", "sales", "finance"] },
      summary: { type: "string", minLength: 1, maxLength: 1000 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  "/approvals/{id}/register": {
    type: "object",
    required: ["resumeUrl"],
    properties: {
      resumeUrl: {
        type: "string",
        format: "uri",
        description:
          "Must target configured n8n origin and /webhook-waiting/ path",
      },
    },
  },
  "/telemetry/llm": {
    type: "object",
    required: ["seconds"],
    properties: { seconds: { type: "number", minimum: 0 } },
  },
  "/reports/send": {
    type: "object",
    additionalProperties: true,
    description: "Daily aggregation and trigger mode",
  },
  "/recovery": {
    type: "object",
    additionalProperties: true,
    description: "n8n error event, persisted for investigation",
  },
  "/alerts": {
    type: "object",
    additionalProperties: true,
    description: "Recovery result included in operations alert",
  },
};
for (const [route, schema] of Object.entries(schemas))
  spec.paths[route].post.requestBody = {
    required: true,
    content: { "application/json": { schema } },
  };
for (const route of Object.values(spec.paths))
  for (const operation of Object.values(route)) {
    operation.responses["404"] = { description: "Resource not found" };
    operation.responses["500"] = {
      description: "Downstream or server error; safe action keys allow retries",
    };
  }
writeFileSync(path, JSON.stringify(spec, null, 2) + "\n");
