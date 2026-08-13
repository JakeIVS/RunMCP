import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import app from "./src/index.js";

const response = await app.request("https://runmcp.test/health");
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { service: "RunMCP", runtime: "cloudflare-worker", database: "D1" });
const protectedResponse = await app.request("https://runmcp.test/api/calendar");
assert.equal(protectedResponse.status, 401, "API paths never trust a tool-supplied user id");
const migration = await readFile("migrations/0001_runmcp.sql", "utf8");
for (const table of ["plan_series", "plan_versions", "plan_version_goals", "planned_workouts", "workout_sections", "workout_steps", "actual_runs", "availability_rules"]) assert.match(migration, new RegExp(`create table ${table}`));
console.log("Hono Worker exposes health, rejects unauthenticated reads, and ships the finalized D1 schema.");
