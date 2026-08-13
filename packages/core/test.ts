import assert from "node:assert/strict";
import { createRaceGoal, freshUserState, recordCompletedRunFact, recordInterruptionFact } from "./training.js";

const fresh = freshUserState();
const withFacts = recordInterruptionFact(recordCompletedRunFact(fresh, {
  date: "2026-08-04", distance: 3, unit: "mi", duration: "00:30:00",
}), { startDate: "2026-08-05", days: 2, reason: "Sick" });
assert.equal(withFacts.plan.version, 0);
assert.deepEqual(withFacts.plan.workouts, [], "facts cannot generate or rewrite a calendar");
assert.equal(createRaceGoal(fresh, { name: "10K", distance: "10K", unit: "mi", targetDate: "2026-10-01" }).plans.length, 1);
console.log("Core stores facts without prescribing or modifying a calendar.");
