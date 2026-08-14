import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const [page, client] = await Promise.all([readFile("src/index.html", "utf8"), readFile("src/main.js", "utf8")]);
for (const required of ["connect your agent", "versioned", "Hosted connection is coming soon", "Create your RunMCP account", "not public", "@runmcp/mcp", "Sign in", "Get started", "clerk-js"]) assert.match(`${page}\n${client}`, new RegExp(required, "i"));
console.log("Landing page copy verifies the agent-first, non-dashboard workflow.");
