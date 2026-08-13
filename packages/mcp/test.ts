import assert from "node:assert/strict";
import { CoachService, InMemoryRunnerRepository, type AuthenticatedIdentity } from "@runmcp/service";

const identity: AuthenticatedIdentity = {
  subject: "verified-clerk-subject",
  provider: "development",
  displayName: "MCP runner",
};
const service = new CoachService(new InMemoryRunnerRepository());
await service.connect(identity);
const before = await service.getCurrentCalendar(identity);
await service.logCompletedRun(identity, {
  date: "2026-08-04",
  distance: 3,
  unit: "mi",
  duration: "00:30:00",
});
assert.equal(
  (await service.getCurrentCalendar(identity)).version,
  before.version,
  "MCP factual events do not own or rebalance calendar state",
);
console.log("MCP uses the shared command/repository layer without an in-memory server state.");
