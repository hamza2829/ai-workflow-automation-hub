import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const run = process.argv[2];
if (!/^\d+$/.test(run || ""))
  throw Error("Usage: node tests/document-results.mjs RUN_ID");
const metadata = JSON.parse(
  execFileSync(
    "gh",
    [
      "run",
      "view",
      run,
      "--json",
      "url,headSha,conclusion,createdAt,updatedAt,jobs",
    ],
    { encoding: "utf8" },
  ),
);
assert.equal(
  metadata.conclusion,
  "success",
  "Only publish results from a green run",
);
const logs = execFileSync("gh", ["run", "view", run, "--log"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
const count = logs
  .replace(/\u001b\[[0-9;]*m/g, "")
  .replace(/\^\[\[[0-9;]*m/g, "")
  .match(/Tests\s+(\d+)\s+passed/);
assert(count, "Vitest count must come from the run log");
const backendTests = Number(count[1]);
const pythonTests = Number(
  readFileSync("docs/runs/pytest.xml", "utf8").match(/tests="(\d+)"/)[1],
);
const read = (name) =>
  JSON.parse(readFileSync("docs/runs/" + name + ".json", "utf8"));
const smoke = read("smoke"),
  browser = read("browser"),
  mock = read("evaluation-mock"),
  model = read("evaluation-ollama"),
  order = read("ollama-smoke");
assert.equal(model.mode, "ollama");
assert.equal(order.status, "completed");
const provenance = {
  ...metadata,
  backendTests,
  pythonTests,
  exportNormalization:
    "Removed instance ownership and timer cache; definitions imported inactive and published by bootstrap.",
};
writeFileSync(
  "docs/runs/provenance.json",
  JSON.stringify(provenance, null, 2) + "\n",
);
const text = `Measured on the GitHub Actions Linux runner in [verified run ${run}](${metadata.url}), source commit \`${metadata.headSha.slice(0, 7)}\`. Full Docker Compose flow completed successfully. Raw measurements and per-order predictions are in [docs/runs/](docs/runs/).

| Check | Actual result |
| --- | --- |
| Backend Vitest suite, including webhook contract | ${backendTests} passed |
| Python pytest suite | ${pythonTests} passed |
| Compose smoke assertions | ${smoke.passed} passed |
| Chromium approval page test | ${browser.passed} passed |
| Real Ollama order through n8n | ${order.status}, ${order.external_effects} mock external effects |
| TypeScript, formatting, Ruff, Docker builds | Passed in linked CI run |

| Evaluation, 20 synthetic labeled orders | Correct | Accuracy | Fallbacks | Mean HTTP latency | p95 HTTP latency |
| --- | --- | --- | --- | --- | --- |
| Deterministic mock | ${mock.correct}/${mock.samples} | ${(mock.accuracy * 100).toFixed(1)}% | ${mock.fallbacks} | ${mock.mean_request_ms.toFixed(2)} ms | ${mock.p95_request_ms.toFixed(2)} ms |
| Ollama qwen2.5:0.5b | ${model.correct}/${model.samples} | ${(model.accuracy * 100).toFixed(1)}% | ${model.fallbacks} | ${model.mean_request_ms.toFixed(2)} ms | ${model.p95_request_ms.toFixed(2)} ms |

One automatic mock order took **${smoke.timings[0].milliseconds} ms** from webhook submission to completed state. The warmed Ollama workflow order took **${order.total_ms} ms**. These are individual smoke timings, not a load benchmark. HTTP evaluation latency includes transport and first-request overhead; p95 uses nearest rank across 20 sequential requests. Accuracy is raw category accuracy, including low confidence predictions. Mock accuracy measures a test double, and model confidence is not calibrated.

The model produced **${model.results.filter((r) => !r.correct && r.classification.confidence >= 0.8).length} incorrect high confidence predictions**. The approval threshold alone did not catch these errors. This is a concrete limitation of using the model's own confidence score for routing.

The smoke assertions cover API authentication, malformed payloads, concurrent idempotency, replay conflict, no duplicate external effects, approve and reject callbacks, injected integration failures, retries and alerts, manual and actual timer reports, persisted invoice drafts, Prometheus targets and the provisioned Grafana dashboard. The browser test captures the actual pending queue and clicks its approval control:

![Actual approval queue captured by the CI browser test](docs/runs/approval-queue.png)`;
let readme = readFileSync("README.md", "utf8");
const section = readme.indexOf("## Verification and results");
const start = readme.indexOf("\n\n", section) + 2;
const end = readme.indexOf("\n\nThe CI pipeline", start);
assert(section >= 0 && end > start, "Expected results section");
readme = readme.slice(0, start) + text + readme.slice(end);
writeFileSync("README.md", readme);
console.log(
  JSON.stringify({
    run,
    backendTests,
    pythonTests,
    smoke: smoke.passed,
    browser: browser.passed,
    mock: mock.accuracy,
    ollama: model.accuracy,
  }),
);
