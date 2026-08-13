import assert from "node:assert/strict";
import { type AuthenticatedIdentity } from "./src/contracts.js";
import { CoachService, type ScheduleProposal } from "./src/commands.js";
import { InMemoryRunnerRepository } from "./src/repositories.js";

const repository = new InMemoryRunnerRepository();
const coach = new CoachService(repository);
const alice: AuthenticatedIdentity = {
  subject: "clerk_alice",
  provider: "development",
  displayName: "Alice",
};
const bob: AuthenticatedIdentity = {
  subject: "clerk_bob",
  provider: "development",
  displayName: "Bob",
};

assert.equal((await coach.connect(alice)).profile.name, "Alice");
assert.equal((await coach.connect(bob)).profile.name, "Bob");
await coach.createGoal(alice, {
  name: "Spring 10K",
  distance: "10K",
  unit: "mi",
  targetDate: "2026-10-10",
});
assert.equal((await coach.listGoals(alice)).length, 1);
assert.equal(
  (await coach.listGoals(bob)).length,
  0,
  "users are isolated by verified subject",
);

const initial = await coach.getCurrentCalendar(alice);
assert.equal(initial.version, 0);
await coach.logCompletedRun(alice, {
  date: "2026-08-04",
  distance: 3,
  unit: "mi",
  duration: "00:31:00",
  idempotencyKey: "completed-run-2026-08-04",
});
await coach.logCompletedRun(alice, {
  date: "2026-08-04", distance: 3, unit: "mi", duration: "00:31:00",
  idempotencyKey: "completed-run-2026-08-04",
});
assert.equal((await coach.listCompletedRuns(alice)).length, 1, "retry key prevents duplicate factual writes");
await coach.recordInterruption(alice, {
  startDate: "2026-08-05",
  days: 3,
  reason: "Sick",
});
const afterFacts = await coach.getCurrentCalendar(alice);
assert.deepEqual(
  afterFacts.workouts,
  initial.workouts,
  "factual events never silently adjust the calendar",
);
assert.equal(afterFacts.version, 0);

const proposal: ScheduleProposal = {
  baseVersion: 0,
  mode: "replace",
  reason: "Agent reviewed completed runs and sickness event",
  rationale: "Restart with a shorter easy run after the documented rest period.",
  workouts: [
    {
      id: "agent-2026-08-08",
      date: "2026-08-08",
      kind: "easy",
      title: "Easy return",
      miles: 2,
      detail: "Agent-authored easy return.",
      sections: [{
        sectionType: "main",
        steps: [{ action: "run", targetDistance: 2, targetDistanceUnit: "mi", targetEffort: 3 }],
      }],
    },
    {
      id: "agent-2026-08-10",
      date: "2026-08-10",
      kind: "easy",
      title: "Easy run",
      miles: 3,
      detail: "Easy aerobic run.",
    },
  ],
};
const preview = await coach.previewScheduleProposal(alice, proposal);
assert.equal(preview.canApply, true);
const applied = await coach.applyScheduleProposal(alice, proposal);
assert.equal(applied.plan.version, 1);
assert.equal((await coach.getCurrentCalendar(alice)).workouts.length, 2);
assert.equal((await coach.getPlannedWorkout(alice, "agent-2026-08-08")).workout.sections?.[0]?.steps[0]?.action, "run");
const sameDayCandidates = await coach.getRunMatchCandidates(alice, "2026-08-08");
assert.equal(sameDayCandidates.candidates.length, 1);
assert.equal(sameDayCandidates.candidates[0]?.recommendedAction, "auto_link");
await coach.logCompletedRun(alice, {
  date: "2026-08-08", distance: 2, unit: "mi", duration: "00:22:00",
});
assert.equal((await coach.listCompletedRuns(alice)).at(-1)?.matchStatus, "matched");
assert.equal((await coach.listCompletedRuns(alice)).at(-1)?.plannedWorkoutId, "agent-2026-08-08");
const previousDayCandidates = await coach.getRunMatchCandidates(alice, "2026-08-11");
assert.equal(previousDayCandidates.candidates[0]?.recommendedAction, "ask_runner");
assert.match(previousDayCandidates.candidates[0]?.prompt || "", /make-up/i);

await assert.rejects(
  () => coach.applyScheduleProposal(alice, proposal),
  /version conflict/i,
  "stale revisions require an explicit re-preview",
);
const blocked = await coach.previewScheduleProposal(alice, {
  ...proposal,
  baseVersion: 1,
  workouts: [
    {
      id: "agent-2026-08-05",
      date: "2026-08-05",
      kind: "easy",
      title: "Conflict",
      miles: 2,
      detail: "Should be rejected.",
    },
  ],
});
assert.equal(
  blocked.conflicts.length,
  1,
  "recorded interruption is a shape conflict, not an automatic plan change",
);
assert.equal((await coach.listCompletedRuns(alice)).length, 2);
assert.equal((await coach.listInterruptions(alice)).length, 1);
assert.equal(
  (await coach.listAudit(alice)).some(
    (event) => event.action === "calendar.revision_applied",
  ),
  true,
);
console.log(
  "Service verifies JIT provisioning, isolation, factual-event storage, and explicit atomic revisions.",
);
