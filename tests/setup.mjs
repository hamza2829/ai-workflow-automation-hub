import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(".env"))
  writeFileSync(
    ".env",
    ["API_KEY", "POSTGRES_PASSWORD", "N8N_ENCRYPTION_KEY", "GRAFANA_PASSWORD"]
      .map((k) => k + "=" + randomBytes(24).toString("hex"))
      .join("\n") + "\n",
  );
console.log("Local .env ready. Values are never printed or committed.");
