import { readFileSync, writeFileSync } from "node:fs";
// Preserve executable definitions exported by n8n, without instance ownership or timer cache.
const path = "docs/runs/workflows-export.json";
const exports = JSON.parse(readFileSync(path, "utf8"));
const portable = exports.map((workflow) => ({
  id: workflow.id,
  name: workflow.name,
  active: false,
  nodes: workflow.nodes,
  connections: workflow.connections,
  settings: workflow.settings,
  staticData: null,
  versionId: workflow.versionId,
  activeVersionId: null,
  tags: [],
}));
for (const workflow of portable)
  writeFileSync(
    "workflows/" + workflow.id + ".json",
    JSON.stringify(workflow, null, 2) + "\n",
  );
writeFileSync(path, JSON.stringify(portable, null, 2) + "\n");
