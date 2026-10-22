import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("=")),
);
const description = "Review this synthetic request " + Date.now();
const response = await fetch("http://localhost:5678/webhook/orders", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": env.API_KEY,
    "Idempotency-Key": "browser-" + Date.now(),
  },
  body: JSON.stringify({
    customerId: "11111111-1111-4111-8111-111111111111",
    description,
    amount: 50,
    currency: "EUR",
  }),
});
assert(response.ok);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 850 },
  });
  await page.goto("http://localhost:3000/ui/");
  await page.getByLabel("API key").fill(env.API_KEY);
  let card;
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.getByRole("button", { name: "Load approvals" }).click();
    card = page.locator("article").filter({ hasText: description });
    if (
      (await card.count()) &&
      (await card
        .getByRole("button", { name: "approved", exact: true })
        .isEnabled())
    )
      break;
    await page.waitForTimeout(500);
  }
  assert.equal(await card.count(), 1);
  await page.screenshot({
    path: "docs/runs/approval-queue.png",
    fullPage: true,
  });
  const id = JSON.parse(await card.locator("pre").textContent()).id;
  await card.getByRole("button", { name: "approved", exact: true }).click();
  await card.waitFor({ state: "detached", timeout: 15000 });
  let status;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await (
      await fetch("http://localhost:3000/orders/" + id, {
        headers: { "x-api-key": env.API_KEY },
      })
    ).json();
    status = result.status;
    if (status === "completed") break;
    await page.waitForTimeout(500);
  }
  assert.equal(status, "completed");
  const result = {
    timestamp: new Date().toISOString(),
    passed: 1,
    check:
      "Browser loads pending order and approves it through n8n to completion",
  };
  writeFileSync(
    "docs/runs/browser.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
