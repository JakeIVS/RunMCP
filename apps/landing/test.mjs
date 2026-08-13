import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const page = await readFile("src/index.html", "utf8");
for (const required of ["connect your agent", "versioned", "Hosted connection is coming soon", "not public", "@runmcp/mcp"]) assert.match(page, new RegExp(required, "i"));
assert.doesNotMatch(page, /sign up|dashboard/i);
console.log("Landing page copy verifies the agent-first, non-dashboard workflow.");
