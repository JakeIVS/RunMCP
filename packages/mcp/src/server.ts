import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedIdentity } from "@runmcp/service";
import {
  CoachService,
  type ScheduleProposal,
} from "@runmcp/service";
import { z } from "zod";

const out = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const workoutStep = z.object({
  action: z.string().min(1),
  targetDistance: z.number().positive().optional(),
  targetDistanceUnit: z.enum(["mi", "km"]).optional(),
  targetDurationSeconds: z.number().int().positive().optional(),
  targetPace: z.string().min(1).optional(),
  maxPace: z.string().min(1).optional(),
  targetEffort: z.number().int().min(1).max(10).optional(),
  instruction: z.string().min(1).optional(),
});
const workoutSections = z.array(z.object({
  sectionType: z.string().min(1),
  repeatCount: z.number().int().positive().optional(),
  note: z.string().min(1).optional(),
  steps: z.array(workoutStep),
})).optional();
const workout = z.object({
  id: z.string(), date, kind: z.enum(["easy", "long", "quality", "rest", "recovery", "race"]),
  title: z.string(), miles: z.number().nonnegative(), detail: z.string(), sections: workoutSections,
  planIds: z.array(z.string()).optional(), completed: z.boolean().optional(),
});
const activity = z.object({
  name: z.string().min(2),
  type: z.enum(["strength", "cycling", "yoga", "other"]),
  intensity: z.enum(["low", "moderate", "high"]),
  preference: z.enum(["no_run", "easy_only", "normal"]).optional(),
  date: date.optional(),
  weekday: z.enum(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).optional(),
}).refine((value) => value.date || value.weekday, "Provide a date or weekday.");
const goal = z.object({
  name: z.string().min(2),
  distance: z.enum(["5K", "10K", "Half marathon", "Marathon", "Custom"]),
  customDistance: z.number().positive().optional(),
  unit: z.enum(["mi", "km"]),
  targetDate: date,
  targetPace: z.string().optional(),
}).refine((value) => value.distance !== "Custom" || value.customDistance, "Custom goals require customDistance.");
const proposal = z.object({
  baseVersion: z.number().int().nonnegative(),
  mode: z.enum(["replace", "patch"]),
  reason: z.string().min(8),
  rationale: z.string().min(12),
  workouts: z.array(workout).optional(),
  patches: z.array(z.union([
    z.object({ op: z.literal("remove"), workoutId: z.string() }),
    z.object({ op: z.literal("upsert"), workout }),
  ])).optional(),
});

export function createRunMcpServer(coach: CoachService, identity: AuthenticatedIdentity) {
  const server = new McpServer({ name: "RunMCP", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.registerTool("get_connection_status", { description: "Read the verified connection and provision the runner on first use.", inputSchema: z.object({}) }, async () => out(await coach.connectionStatus(identity)));
  server.registerTool("get_profile", { description: "Read the authenticated runner profile. No user id is accepted.", inputSchema: z.object({}) }, async () => out(await coach.getProfile(identity)));
  server.registerTool("update_profile", { description: "Update the authenticated runner profile without changing the calendar.", inputSchema: z.object({ name: z.string().min(1).max(120).optional() }) }, async (input) => out(await coach.updateProfile(identity, input)));
  server.registerTool("get_training_intensity", { description: "Read the runner's conservative, balanced, or ambitious preference.", inputSchema: z.object({}) }, async () => out(await coach.getTrainingIntensity(identity)));
  server.registerTool("update_training_intensity", { description: "Persist a runner preference only. It does not change the calendar.", inputSchema: z.object({ trainingIntensity: z.enum(["conservative", "balanced", "ambitious"]) }) }, async ({ trainingIntensity }) => out(await coach.updateTrainingIntensity(identity, trainingIntensity)));
  server.registerTool("get_today", { description: "Read factual canonical calendar entries for a day.", inputSchema: z.object({ date: date.optional() }) }, async ({ date }) => out(await coach.getToday(identity, date)));
  server.registerTool("get_upcoming", { description: "Read canonical upcoming calendar entries; no planning advice is generated.", inputSchema: z.object({ from: date.optional(), count: z.number().int().min(1).max(60).optional() }) }, async ({ from, count }) => out(await coach.getUpcoming(identity, from, count)));
  server.registerTool("get_next_workout", { description: "Read the next calendar entry for an agent's own user-authorized automation. RunMCP never notifies users.", inputSchema: z.object({}) }, async () => out(await coach.getNextWorkout(identity)));
  server.registerTool("get_current_calendar", { description: "Read the full canonical agent-authored calendar and optimistic version.", inputSchema: z.object({}) }, async () => out(await coach.getCurrentCalendar(identity)));
  server.registerTool("get_planned_workout", { description: "Read one canonical planned workout, including its structured sections and steps.", inputSchema: z.object({ workoutId: z.string() }) }, async ({ workoutId }) => out(await coach.getPlannedWorkout(identity, workoutId)));
  server.registerTool("get_schedule_summary", { description: "Read non-prescriptive schedule totals and the current version.", inputSchema: z.object({}) }, async () => out(await coach.getScheduleSummary(identity)));
  server.registerTool("get_planning_context", { description: "Read profile, goals, calendar, runs, activities, and interruptions for agent reasoning. Facts are not prescriptions.", inputSchema: z.object({}) }, async () => out(await coach.getPlanningContext(identity)));
  server.registerTool("list_goals", { description: "List authenticated runner goals.", inputSchema: z.object({}) }, async () => out(await coach.listGoals(identity)));
  server.registerTool("create_goal", { description: "Store a goal. It does not generate or change a calendar.", inputSchema: goal }, async (input) => out(await coach.createGoal(identity, input)));
  server.registerTool("update_goal", { description: "Update a stored goal without changing the calendar.", inputSchema: z.object({ id: z.string(), name: z.string().min(2).optional(), distance: z.enum(["5K", "10K", "Half marathon", "Marathon", "Custom"]).optional(), customDistance: z.number().positive().optional(), unit: z.enum(["mi", "km"]).optional(), targetDate: date.optional(), targetPace: z.string().optional(), active: z.boolean().optional() }) }, async ({ id, ...changes }) => out(await coach.updateGoal(identity, id, changes)));
  server.registerTool("toggle_goal", { description: "Set a goal active or inactive without changing the calendar.", inputSchema: z.object({ id: z.string(), active: z.boolean() }) }, async ({ id, active }) => out(await coach.toggleGoal(identity, id, active)));
  server.registerTool("reschedule_goal", { description: "Store a goal date change. Submit a calendar revision separately if the agent wants to alter training.", inputSchema: z.object({ id: z.string(), targetDate: date }) }, async ({ id, targetDate }) => out(await coach.rescheduleGoal(identity, id, targetDate)));
  server.registerTool("list_completed_runs", { description: "Read factual completed-run history.", inputSchema: z.object({}) }, async () => out(await coach.listCompletedRuns(identity)));
  server.registerTool("find_run_match_candidates", { description: "Before logging an unspecified run, find unmatched planned-run candidates. Auto-link only one same-day high-confidence candidate; ask the runner before matching a prior-day candidate.", inputSchema: z.object({ date }) }, async ({ date }) => out(await coach.getRunMatchCandidates(identity, date)));
  server.registerTool("log_completed_run", { description: "Store a factual completed run. With the default autoMatch=true, RunMCP links only a single unmatched same-day planned run; it never guesses an adjacent-day match. Use find_run_match_candidates to ask the runner about an adjacent-day candidate. A supplied plannedWorkoutId creates an explicit link; this never changes the calendar. Supply idempotencyKey when retrying a write.", inputSchema: z.object({ date, distance: z.number().positive(), unit: z.enum(["mi", "km"]), duration: z.string().min(3), notes: z.string().optional(), plannedWorkoutId: z.string().optional(), matchRationale: z.string().min(3).optional(), autoMatch: z.boolean().optional(), idempotencyKey: z.string().min(8).max(200).optional() }) }, async (input) => out(await coach.logCompletedRun(identity, input)));
  server.registerTool("match_completed_run", { description: "Explicitly link a previously logged run to a planned workout after the runner confirms it. It never changes the calendar.", inputSchema: z.object({ runId: z.string(), plannedWorkoutId: z.string(), matchRationale: z.string().min(3).optional() }) }, async ({ runId, plannedWorkoutId, matchRationale }) => out(await coach.matchCompletedRun(identity, runId, plannedWorkoutId, matchRationale)));
  server.registerTool("list_interruptions", { description: "Read factual missed-day, illness, injury, and time-off events.", inputSchema: z.object({}) }, async () => out(await coach.listInterruptions(identity)));
  server.registerTool("record_interruption", { description: "Store a factual interruption only; preview and apply an explicit calendar revision separately.", inputSchema: z.object({ startDate: date, days: z.number().int().min(1).max(90), reason: z.string().min(2), note: z.string().optional() }) }, async (input) => out(await coach.recordInterruption(identity, input)));
  server.registerTool("list_activities", { description: "List factual agent-classified activity constraints.", inputSchema: z.object({}) }, async () => out(await coach.listActivities(identity)));
  server.registerTool("add_activity", { description: "Store an external activity constraint without changing the calendar.", inputSchema: activity }, async (input) => out(await coach.addActivity(identity, input)));
  server.registerTool("update_activity", { description: "Update a stored factual activity constraint.", inputSchema: z.object({ id: z.string(), name: z.string().min(2).optional(), type: z.enum(["strength", "cycling", "yoga", "other"]).optional(), intensity: z.enum(["low", "moderate", "high"]).optional(), preference: z.enum(["no_run", "easy_only", "normal"]).optional(), date: date.optional(), weekday: z.enum(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).optional() }) }, async ({ id, ...changes }) => out(await coach.updateActivity(identity, id, changes)));
  server.registerTool("remove_activity", { description: "Remove an activity constraint.", inputSchema: z.object({ id: z.string() }) }, async ({ id }) => out(await coach.removeActivity(identity, id)));
  server.registerTool("preview_schedule_proposal", { description: "Validate an agent-authored complete calendar or patch against shape, recorded constraints, and optimistic version. Never writes.", inputSchema: proposal }, async (input) => out(await coach.previewScheduleProposal(identity, input as ScheduleProposal)));
  server.registerTool("apply_schedule_proposal", { description: "Atomically apply a previously valid agent-authored calendar proposal at its baseVersion. This is the only tool that changes the canonical calendar.", inputSchema: proposal }, async (input) => out(await coach.applyScheduleProposal(identity, input as ScheduleProposal)));
  server.registerTool("list_plan_versions", { description: "Read prior explicit calendar revisions for the authenticated runner.", inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) }, async ({ limit }) => out(await coach.listPlanVersions(identity, limit)));
  server.registerTool("list_audit_events", { description: "Read the authenticated runner's recent fact and calendar-revision audit events.", inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) }, async ({ limit }) => out(await coach.listAudit(identity, limit)));
  return server;
}
