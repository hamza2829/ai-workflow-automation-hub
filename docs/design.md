# Design and trust boundaries

The workflow automates handoffs between engineering, sales and finance. All orders and the seeded customer are synthetic. A classifier assigns ownership and produces a summary, but the API controls whether effects are allowed.

## State transitions

```text
received -> ready ----------------------------> completed
         -> pending -> human approved -> ready -> completed
                    -> human rejected --------> rejected
```

An order with confidence below 0.8 requires approval. Model errors, invalid JSON and HTTP failures produce confidence zero. Approval creation and the pending transition are one PostgreSQL statement. The workflow registers its execution resume URL and pauses at a real n8n Wait node. A decision is persisted before the API calls that URL. The resumed workflow reads the persisted order state before attempting effects. Posting directly to a resume URL cannot authorize an order.

The approval UI uses DOM textContent for untrusted summaries. It does not store the API key in browser storage. API calls require an API key compared with timingSafeEqual. Resume URL registration accepts only the configured n8n origin and the webhook-waiting path, reducing SSRF exposure.

## Idempotency and retries

An order requires an Idempotency-Key header of 8 to 128 letters, numbers, underscores or hyphens. A unique PostgreSQL constraint resolves concurrent inserts. Reusing a key with a different validated payload returns 409. A replay returns the original ID.

Fulfillment locks the order row. Each mock remote API uses an independent stable key derived from the order ID and action. If a later step fails, a retry reuses those keys. The API transaction rolls back invoice state until all three effects succeed. External effects cannot roll back, so remote idempotency is essential. The mock server keeps its keys in memory; restarting it loses that protection. A production adapter needs provider-backed idempotency or a durable delivery ledger.

The n8n fulfillment node makes at most three attempts with a one second delay. A failed execution invokes the error workflow, which retries ready deliveries at most three times, then alerts the mock Slack endpoint. The error event is stored in PostgreSQL. If alert delivery also fails, n8n retains the failed execution; there is no independent paging system. Recovery currently scans all ready orders, which is suitable only for this small demonstration.

Approvals are immutable. Reposting the same decision can retry a failed resume notification. There is a crash window between n8n accepting a callback and PostgreSQL recording resumed_at. A production version should use a transactional outbox, authenticated callback tokens, and reconciliation of n8n execution state. Repeated order webhooks while an approval is waiting can create extra waiting executions, although fulfillment remains guarded and idempotent.

## Monitoring semantics

- workflows_triggered_total counts accepted backend intake attempts, including replays.
- workflow_failures_total counts API errors and error-workflow recovery attempts. It is not a count of unique failed n8n executions.
- llm_latency_seconds records the Python classification duration reported to n8n, excluding network transit.
- approvals_total counts acknowledged resume notifications by decision. These application metrics reset on backend restart.
- n8n exposes its own metrics alongside the backend metrics.

The daily report reads PostgreSQL through the authenticated backend API. Its default schedule is 09:00 Europe/Berlin. CI sets REPORT_CRON to every minute to test the actual timer without waiting a day. A separate manual webhook tests the same report graph. Slack report keys include date and trigger mode, so repeated manual calls on the same day reuse the delivery.

## Deployment limits

This is a local demonstration, not a production deployment. Published ports bind to 127.0.0.1. The Compose network is trusted, without TLS or separate service identities. The API key is shared by the operator and n8n. n8n webhook acknowledgments are asynchronous and do not prove order success; query the order state or check the execution. Its editor requires initial owner setup for interactive use. The CLI bootstrap imports and activates workflows without manual editor setup. Bootstrap reimports repository definitions on restart, so export UI edits before restarting.

n8n uses its own persistent SQLite volume; business data uses PostgreSQL. The n8n version is pinned and bootstrap uses its publish CLI. Upgrades require rerunning the full suite. No production security certification or image vulnerability audit is claimed.

Mock Slack, task and invoice APIs are distinct HTTP endpoints in one test server. None contacts a real business account. MailHog is included as a local email sandbox; the workflows use Slack summaries, so no SMTP delivery is claimed. OpenAI mode implements the compatible chat completions protocol but requires a user-provided key and endpoint. Mock accuracy measures a keyword test double, not model intelligence. The small labeled set is transparent and includes paraphrases outside the mock vocabulary; it is not an independent benchmark.
