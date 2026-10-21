import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const samples = JSON.parse(readFileSync("tests/labeled-orders.json", "utf8"));
const results = [];
for (const sample of samples) {
  const started = performance.now();
  const response = await fetch("http://localhost:8000/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: sample.description }),
  });
  if (!response.ok) throw Error("LLM HTTP " + response.status);
  const data = await response.json();
  results.push({
    ...sample,
    ...data,
    request_ms: performance.now() - started,
    correct: data.classification.category === sample.label,
  });
}
const health = await (await fetch("http://localhost:8000/health")).json();
const times = results.map((r) => r.request_ms).sort((a, b) => a - b);
const output = {
  timestamp: new Date().toISOString(),
  mode: health.mode,
  samples: results.length,
  correct: results.filter((r) => r.correct).length,
  accuracy: results.filter((r) => r.correct).length / results.length,
  mean_request_ms: times.reduce((a, b) => a + b, 0) / times.length,
  p95_request_ms: times[Math.ceil(times.length * 0.95) - 1],
  results,
};
mkdirSync("docs/runs", { recursive: true });
writeFileSync(
  "docs/runs/evaluation-" + health.mode + ".json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(JSON.stringify({ ...output, results: undefined }, null, 2));
