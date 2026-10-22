# AI Workflow Automation Hub

[![CI](https://github.com/hamza2829/ai-workflow-automation-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/hamza2829/ai-workflow-automation-hub/actions/workflows/ci.yml)

A small internal order automation project connecting engineering, sales and finance with n8n, REST APIs, structured LLM output, human approval and monitoring. Only synthetic customer data is used.

An incoming customer order is validated, enriched with customer information and classified by team. High confidence orders create a project task, invoice draft and Slack summary. Low confidence orders pause for a human decision. The backend enforces the approval state before allowing effects.

```text
Synthetic client
    | POST webhook + API key + Idempotency-Key
    v
n8n order workflow -----> TypeScript / Node.js API -----> PostgreSQL
    |                       ^              |
    v                       |              +----> Mock task API
Python FastAPI classifier   |              +----> Mock invoice API
    |                       |              +----> Mock Slack webhook
    +--> Mock / Ollama /     |
         compatible API     |
    |                       |
    +--> confidence < 0.8 -> Wait node
                            ^
Approval HTML page -> decision API -> n8n resume webhook

n8n daily schedule -> API -> PostgreSQL report -> Mock Slack
n8n error trigger -> bounded delivery retries -> Mock Slack alert

API metrics + n8n metrics -> Prometheus -> Grafana
MailHog: local email sandbox, available but no email workflow
```

## Run

Requires Docker Compose v2 with a running Linux container engine and Node.js 22 or newer. No paid API keys are needed for mock mode.

```sh
git clone https://github.com/hamza2829/ai-workflow-automation-hub.git
cd ai-workflow-automation-hub
node tests/setup.mjs
docker compose up -d --build --wait --wait-timeout 240
sh tests/smoke.sh
node tests/evaluate.mjs
```

On Windows, use `node tests/smoke.mjs` if a POSIX shell is unavailable. Setup generates random local secrets in ignored `.env`; it does not print them. The smoke test loads its own key from that file.

| Service                  | Local address                                                       |
| ------------------------ | ------------------------------------------------------------------- |
| Approval page            | http://localhost:3000/ui/                                           |
| API health and OpenAPI   | http://localhost:3000/health and http://localhost:3000/openapi.json |
| n8n editor               | http://localhost:5678                                               |
| Python API docs          | http://localhost:8000/docs                                          |
| Mock integration records | http://localhost:8090/records                                       |
| Prometheus               | http://localhost:9090                                               |
| Grafana                  | http://localhost:3001                                               |
| MailHog                  | http://localhost:8025                                               |

For the approval page, paste API_KEY from your local `.env` and click Load approvals. Grafana uses username `admin` and GRAFANA_PASSWORD from `.env`. The dashboard is provisioned automatically. Interactive n8n editor use needs initial owner setup. Workflows are imported and published by the container bootstrap without requiring editor interaction.

Example request, after exporting API_KEY into your shell:

```sh
curl -X POST http://localhost:5678/webhook/orders \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: synthetic-order-001" \
  -d '{"customerId":"11111111-1111-4111-8111-111111111111","description":"Add license seats","amount":120,"currency":"EUR"}'
```

Use `Please help with this request` as the description to exercise human review in mock mode. A webhook 200 acknowledges receipt; downstream success is asynchronous. Check n8n executions, the approval queue, order state and mock records.

## Workflows

The JSON files in [workflows/](workflows/) contain complete node definitions and connections, with credentials referenced through environment expressions.

| Export                                            | Behavior                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Order intake](workflows/orderIntake001.json)     | Webhook, Zod validation, PostgreSQL customer enrichment, Python classification, latency recording, confidence routing, Wait node and idempotent fulfillment |
| [Daily report](workflows/dailyReport001.json)     | 09:00 Europe/Berlin timer, PostgreSQL aggregation through the API, mock Slack summary, plus a manual test webhook                                           |
| [Error recovery](workflows/errorRecovery001.json) | Error Trigger, bounded delivery retries and mock Slack alert                                                                                                |
| [Failure probe](workflows/failureProbe001.json)   | Synthetic deliberate failure for manual investigation                                                                                                       |

Repository definitions are inactive for clean import. Bootstrap publishes each workflow before starting n8n. Restarting n8n reimports these definitions, so export editor changes first. CI also exports the definitions from its running instance as an execution artifact.

## LLM modes and evaluation

Mock mode is a deterministic keyword test double. It validates the automation paths without making an inference request. A real local model runs through Ollama's OpenAI compatible API:

```sh
docker compose --profile ollama up -d ollama
docker compose exec -T ollama ollama pull qwen2.5:0.5b
LLM_MODE=ollama docker compose up -d --no-deps --wait llm
node tests/evaluate.mjs
node tests/ollama-smoke.mjs
```

For PowerShell, set `$env:LLM_MODE='ollama'` before recreating `llm`. To restore the default, remove that variable or set it to `mock` and recreate `llm`.

For a hosted compatible endpoint, set LLM_MODE=openai, LLM_BASE_URL including `/v1`, LLM_MODEL and LLM_API_KEY in `.env`, then recreate `llm`. The service requests JSON schema output and validates category, summary and confidence with Pydantic. Invalid output or API failure returns confidence zero for human review.

[tests/labeled-orders.json](tests/labeled-orders.json) contains 20 transparent labeled examples, including two paraphrases outside the mock vocabulary. The evaluation calls the running HTTP service and records each prediction, fallback flag and request duration. Mock and model results have separate filenames. This tiny synthetic set does not establish general business accuracy.

## Verification and results

Local verification completed: **20 Vitest tests** for backend validation and the webhook payload contract, and **9 pytest tests** for classification, confidence routing, invalid input, compatible API requests and invalid model output. TypeScript checking and Ruff passed. Runtime Compose results will be recorded here only after the CI execution completes.

The CI pipeline installs dependencies, checks formatting and types, runs both test suites, builds Docker images, starts Compose, executes the curl and Node smoke checks, evaluates mock mode, starts a real Ollama model, evaluates it and submits one model-classified order through n8n. CI accelerates the report schedule to every minute and verifies a real timer execution. Artifacts retain measured results and runtime workflow exports.

The local Windows Docker Desktop engine failed before containers could start with an inference-manager socket error. Full-stack verification is performed on the GitHub Actions Linux runner. No local Compose success is claimed.

## Structure

```text
workflows/       n8n JSON definitions
backend/         TypeScript Express API, Zod schemas, SQL migration, OpenAPI
llm-service/     FastAPI classifier and pytest suite
approvals-ui/    HTML review queue with approve and reject controls
monitoring/      Prometheus config and Grafana dashboard/provisioning
tests/           mock APIs, labeled orders, evaluation and smoke scripts
docs/            design notes and execution evidence
```

## Security and limitations

Secrets are generated in `.env`, passed through environment variables and excluded from Git and Docker build context. Do not commit `.env` or real customer data. All published ports bind to localhost. The API requires an API key. Business data persists in PostgreSQL; n8n uses a separate SQLite volume. Unique intake keys, row locks and stable remote action keys protect retries. Low confidence output cannot create effects until an approval is persisted.

Task management, invoicing and Slack are **mock HTTP integrations** hosted by one test server. MailHog is a real local email sandbox, but SMTP delivery is not implemented. No live SaaS account, paid model request or production deployment is claimed. The mock server's delivery keys are memory-only. There is no transactional outbox, per-user login, TLS, independent paging or load-test evidence. The workflow is deterministic orchestration with an LLM classification step, not an autonomous planning agent. See [design notes](docs/design.md) for failure windows, metric semantics and deployment boundaries.

To stop the stack, run `docker compose --profile ollama down`. Add `-v` only to intentionally remove the project's local database and model volumes.
