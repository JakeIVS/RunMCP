import {
  createRaceGoal,
  freshUserState,
  recordCompletedRunFact,
  recordInterruptionFact,
  recordPlanningActivity,
  removePlanningActivityFact,
  today,
  toggleRaceGoalFact,
  updatePlanningActivityFact,
  type ActivityIntensity,
  type ActivityPreference,
  type ActivityType,
  type CompletedRun,
  type Distance,
  type PlanningActivity,
  type RacePlan,
  type State,
  type TrainingIntensity,
  type Unit,
  type Workout,
} from "@runmcp/core/training.js";
import {
  type AppliedRevision,
  type AuthenticatedIdentity,
  type RunnerRepository,
} from "./contracts.js";

export const provisionState = (identity: AuthenticatedIdentity): State => {
  const state = freshUserState();
  return {
    ...state,
    profile: {
      ...state.profile,
      name: identity.displayName?.trim() || "Runner",
      trainingIntensity: "balanced",
    },
    plan: { ...state.plan, id: "current", version: 0 },
  };
};

const mustGoal = (state: State, id: string) => {
  const goal = state.plans.find((item) => item.id === id);
  if (!goal) throw new Error("Goal not found for this authenticated runner.");
  return goal;
};
const mustActivity = (state: State, id: string) => {
  const activity = state.activities.find((item) => item.id === id);
  if (!activity)
    throw new Error("Activity not found for this authenticated runner.");
  return activity;
};
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const dayName = (date: string) =>
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(`${date}T12:00:00`).getDay()
  ]!;

export interface CreateGoalInput {
  name: string;
  distance: Distance;
  customDistance?: number;
  unit: Unit;
  targetDate: string;
  targetPace?: string;
}
export interface RunMatchCandidate {
  workout: Workout;
  daysFromRun: number;
  confidence: "high" | "medium";
  recommendedAction: "auto_link" | "ask_runner";
  prompt?: string;
}
const runMatchCandidates = (state: State, date: string): RunMatchCandidate[] => {
  const matched = new Set(state.runs.flatMap((run) => run.plannedWorkoutId ? [run.plannedWorkoutId] : []));
  return state.plan.workouts
    .filter((workout) => workout.kind !== "rest" && workout.miles > 0 && !matched.has(workout.id))
    .flatMap<RunMatchCandidate>((workout) => {
      const daysFromRun = Math.round((new Date(`${workout.date}T12:00:00`).getTime() - new Date(`${date}T12:00:00`).getTime()) / 86_400_000);
      if (daysFromRun === 0) return [{ workout, daysFromRun, confidence: "high", recommendedAction: "auto_link" }];
      if (daysFromRun === -1) return [{ workout, daysFromRun, confidence: "medium", recommendedAction: "ask_runner", prompt: `I see ${workout.title} was scheduled yesterday and has no recorded run. Was today's run a make-up for that workout?` }];
      return [];
    });
};
export interface ActivityInput {
  name: string;
  type: ActivityType;
  intensity: ActivityIntensity;
  preference?: ActivityPreference;
  date?: string;
  weekday?: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
}
export type ProposedWorkout = Omit<Workout, "completed"> & { completed?: boolean };
export type CalendarPatch =
  | { op: "upsert"; workout: ProposedWorkout }
  | { op: "remove"; workoutId: string };
export interface ScheduleProposal {
  baseVersion: number;
  mode: "replace" | "patch";
  reason: string;
  rationale: string;
  workouts?: ProposedWorkout[];
  patches?: CalendarPatch[];
}
export interface CalendarConflict {
  date: string;
  source: "interruption" | "activity";
  sourceId: string;
  message: string;
}

function validateWorkout(workout: ProposedWorkout) {
  if (!workout.id || !/^[a-zA-Z0-9_-]{3,120}$/.test(workout.id))
    throw new Error("Each calendar workout needs a stable id of 3–120 letters, digits, underscores, or hyphens.");
  if (!isoDate.test(workout.date)) throw new Error("Calendar dates must use YYYY-MM-DD.");
  if (!workout.title.trim() || !workout.detail.trim())
    throw new Error("Each calendar workout needs a title and a detail.");
  if (!Number.isFinite(workout.miles) || workout.miles < 0)
    throw new Error("Workout distance must be a non-negative number.");
}
function validateCalendar(workouts: ProposedWorkout[]) {
  const ids = new Set<string>();
  const dates = new Set<string>();
  for (const workout of workouts) {
    validateWorkout(workout);
    if (ids.has(workout.id)) throw new Error(`Duplicate calendar workout id: ${workout.id}.`);
    if (dates.has(workout.date))
      throw new Error(`Calendar has more than one workout for ${workout.date}. Submit one canonical day entry.`);
    ids.add(workout.id);
    dates.add(workout.date);
  }
}
function buildProposalCalendar(state: State, proposal: ScheduleProposal) {
  if (proposal.mode === "replace") {
    if (!proposal.workouts?.length)
      throw new Error("A complete calendar proposal must include at least one day entry.");
    return [...proposal.workouts].sort((a, b) => a.date.localeCompare(b.date));
  }
  if (!proposal.patches?.length)
    throw new Error("A patch proposal must include at least one operation.");
  const calendar = new Map(state.plan.workouts.map((workout) => [workout.id, workout]));
  for (const patch of proposal.patches) {
    if (patch.op === "upsert") calendar.set(patch.workout.id, patch.workout);
    else if (!calendar.delete(patch.workoutId))
      throw new Error(`Cannot remove unknown calendar workout ${patch.workoutId}.`);
  }
  return [...calendar.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function findConflicts(state: State, workouts: ProposedWorkout[]): CalendarConflict[] {
  return workouts.flatMap<CalendarConflict>((workout) => {
    if (workout.kind === "rest" || workout.miles === 0) return [];
    const interruption = state.plan.interruptions.find((item) => {
      const start = new Date(`${item.startDate}T12:00:00`).getTime();
      const end = start + item.days * 86400000;
      const date = new Date(`${workout.date}T12:00:00`).getTime();
      return date >= start && date < end;
    });
    if (interruption)
      return [{ date: workout.date, source: "interruption" as const, sourceId: interruption.id, message: `Scheduled run overlaps recorded ${interruption.reason}.` }];
    const blocked = state.activities.find(
      (activity) =>
        activity.preference === "no_run" &&
        (activity.date === workout.date || activity.weekday === dayName(workout.date)),
    );
    return blocked
      ? [{ date: workout.date, source: "activity" as const, sourceId: blocked.id, message: `Scheduled run conflicts with ${blocked.name}, marked no-run.` }]
      : [];
  });
}
function calendarDiff(previous: Workout[], next: ProposedWorkout[]) {
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(next.map((item) => [item.id, item]));
  return {
    added: next.filter((item) => !before.has(item.id)).map((item) => item.id),
    removed: previous.filter((item) => !after.has(item.id)).map((item) => item.id),
    changed: next
      .filter((item) => {
        const old = before.get(item.id);
        return old && JSON.stringify(old) !== JSON.stringify(item);
      })
      .map((item) => item.id),
  };
}

/**
 * Canonical storage and validation service. It does not prescribe workouts,
 * infer recovery, or change a schedule from factual events. Only an agent's
 * explicit versioned proposal changes the current calendar.
 */
export class CoachService {
  constructor(private readonly repository: RunnerRepository) {}

  async connect(identity: AuthenticatedIdentity) {
    const state = await this.repository.ensure(identity);
    await this.repository.recordConnection(identity);
    return { provider: identity.provider, profile: state.profile, calendarVersion: state.plan.version ?? 0 };
  }
  async getProfile(identity: AuthenticatedIdentity) {
    return (await this.repository.ensure(identity)).profile;
  }
  async updateProfile(identity: AuthenticatedIdentity, input: { name?: string }) {
    if (input.name !== undefined && !input.name.trim()) throw new Error("Profile name cannot be blank.");
    return this.mutateFacts(identity, "profile.updated", input, (state) => ({
      ...state,
      profile: { ...state.profile, ...(input.name === undefined ? {} : { name: input.name.trim() }) },
    }));
  }
  async getTrainingIntensity(identity: AuthenticatedIdentity) {
    const state = await this.repository.ensure(identity);
    return { trainingIntensity: state.profile.trainingIntensity, message: "A runner preference for the connected agent to consider; it does not alter the calendar by itself." };
  }
  async updateTrainingIntensity(identity: AuthenticatedIdentity, trainingIntensity: TrainingIntensity) {
    return this.mutateFacts(identity, "training_intensity.updated", { trainingIntensity }, (state) => ({
      ...state,
      profile: { ...state.profile, trainingIntensity },
    }));
  }
  async getToday(identity: AuthenticatedIdentity, date = today()) {
    const state = await this.repository.ensure(identity);
    return { date, calendarVersion: state.plan.version ?? 0, workouts: state.plan.workouts.filter((workout) => workout.date === date) };
  }
  async getUpcoming(identity: AuthenticatedIdentity, from = today(), count = 7) {
    const state = await this.repository.ensure(identity);
    return { calendarVersion: state.plan.version ?? 0, workouts: state.plan.workouts.filter((workout) => workout.date >= from).slice(0, count) };
  }
  async getNextWorkout(identity: AuthenticatedIdentity) {
    const state = await this.repository.ensure(identity);
    return {
      calendarVersion: state.plan.version ?? 0,
      next: state.plan.workouts.find((workout) => workout.date >= today() && workout.kind !== "rest") ?? null,
      automationNote: "RunMCP never sends notifications. A connected agent may use this factual schedule in its own user-authorized automation.",
    };
  }
  async getCurrentCalendar(identity: AuthenticatedIdentity) {
    const state = await this.repository.ensure(identity);
    return state.plan;
  }
  async getPlannedWorkout(identity: AuthenticatedIdentity, workoutId: string) {
    const state = await this.repository.ensure(identity);
    const workout = state.plan.workouts.find((item) => item.id === workoutId);
    if (!workout) throw new Error("Planned workout not found for this authenticated runner.");
    return { calendarVersion: state.plan.version ?? 0, workout };
  }
  async getScheduleSummary(identity: AuthenticatedIdentity) {
    const state = await this.repository.ensure(identity);
    const weeklyMiles = state.plan.workouts.reduce<Record<string, number>>((totals, workout) => {
      const week = workout.date.slice(0, 7);
      totals[week] = +(totals[week] || 0) + workout.miles;
      return totals;
    }, {});
    return { calendarVersion: state.plan.version ?? 0, weeklyMiles, workoutCount: state.plan.workouts.length };
  }
  async listGoals(identity: AuthenticatedIdentity) { return (await this.repository.ensure(identity)).plans; }
  async createGoal(identity: AuthenticatedIdentity, input: CreateGoalInput) { return this.mutateFacts(identity, "goal.created", input, (state) => createRaceGoal(state, input)); }
  async updateGoal(identity: AuthenticatedIdentity, id: string, changes: Partial<CreateGoalInput> & { active?: boolean }) {
    return this.mutateFacts(identity, "goal.updated", { id, ...changes }, (state) => {
      mustGoal(state, id);
      return { ...state, plans: state.plans.map((goal) => goal.id === id ? { ...goal, ...changes } : goal) };
    });
  }
  async toggleGoal(identity: AuthenticatedIdentity, id: string, active: boolean) { return this.mutateFacts(identity, "goal.toggled", { id, active }, (state) => { mustGoal(state, id); return toggleRaceGoalFact(state, id, active); }); }
  async rescheduleGoal(identity: AuthenticatedIdentity, id: string, targetDate: string) { return this.mutateFacts(identity, "goal.rescheduled", { id, targetDate }, (state) => { mustGoal(state, id); return { ...state, plans: state.plans.map((goal) => goal.id === id ? { ...goal, targetDate } : goal) }; }); }
  async listCompletedRuns(identity: AuthenticatedIdentity) { return (await this.repository.ensure(identity)).runs; }
  async getRunMatchCandidates(identity: AuthenticatedIdentity, date: string) {
    if (!isoDate.test(date)) throw new Error("Run date must use YYYY-MM-DD.");
    const state = await this.repository.ensure(identity);
    return {
      date,
      calendarVersion: state.plan.version ?? 0,
      candidates: runMatchCandidates(state, date),
      guidance: "Auto-link only a single high-confidence same-day candidate. Ask the runner before linking any adjacent-day candidate.",
    };
  }
  async logCompletedRun(identity: AuthenticatedIdentity, input: Omit<CompletedRun, "id" | "matchStatus"> & { idempotencyKey?: string; autoMatch?: boolean }) {
    const { idempotencyKey, autoMatch = true, ...fact } = input;
    if (idempotencyKey && await this.wasApplied(identity, "run.logged", idempotencyKey))
      return this.repository.ensure(identity);
    return this.mutateFacts(identity, "run.logged", { ...fact, autoMatch, idempotencyKey }, (state) => {
      const automatic = !fact.plannedWorkoutId && autoMatch
        ? runMatchCandidates(state, fact.date).filter((candidate) => candidate.recommendedAction === "auto_link")
        : [];
      const plannedWorkoutId = fact.plannedWorkoutId || (automatic.length === 1 ? automatic[0]!.workout.id : undefined);
      const matchedFact = {
        ...fact,
        plannedWorkoutId,
        matchStatus: plannedWorkoutId ? "matched" as const : "unmatched" as const,
        matchRationale: fact.matchRationale || (plannedWorkoutId && automatic.length === 1 ? "Automatically linked to the single unmatched planned run on the same date." : undefined),
      };
      this.validateRunMatch(state, plannedWorkoutId);
      return recordCompletedRunFact(state, matchedFact);
    });
  }
  async matchCompletedRun(identity: AuthenticatedIdentity, runId: string, plannedWorkoutId: string, matchRationale?: string) {
    return this.mutateFacts(identity, "run.matched", { runId, plannedWorkoutId, matchRationale }, (state) => {
      if (!state.runs.some((run) => run.id === runId)) throw new Error("Completed run not found for this authenticated runner.");
      this.validateRunMatch(state, plannedWorkoutId, runId);
      return { ...state, runs: state.runs.map((run) => run.id === runId ? {
        ...run, plannedWorkoutId, matchStatus: "matched" as const, matchRationale,
      } : run) };
    });
  }
  async listInterruptions(identity: AuthenticatedIdentity) { return (await this.repository.ensure(identity)).plan.interruptions; }
  async recordInterruption(identity: AuthenticatedIdentity, input: { startDate: string; days: number; reason: string; note?: string }) { return this.mutateFacts(identity, "interruption.recorded", input, (state) => recordInterruptionFact(state, input)); }
  async listActivities(identity: AuthenticatedIdentity) { return (await this.repository.ensure(identity)).activities; }
  async addActivity(identity: AuthenticatedIdentity, input: ActivityInput) { return this.mutateFacts(identity, "activity.added", input, (state) => recordPlanningActivity(state, input)); }
  async updateActivity(identity: AuthenticatedIdentity, id: string, changes: Partial<Omit<PlanningActivity, "id">>) { return this.mutateFacts(identity, "activity.updated", { id, ...changes }, (state) => { mustActivity(state, id); return updatePlanningActivityFact(state, id, changes); }); }
  async removeActivity(identity: AuthenticatedIdentity, id: string) { return this.mutateFacts(identity, "activity.removed", { id }, (state) => { mustActivity(state, id); return removePlanningActivityFact(state, id); }); }
  async getPlanningContext(identity: AuthenticatedIdentity) {
    const state = await this.repository.ensure(identity);
    return { profile: state.profile, goals: state.plans, calendar: state.plan, completedRuns: state.runs, activities: state.activities, interruptions: state.plan.interruptions, boundary: "Facts and canonical calendar only. The connected agent owns planning decisions and must submit a revision explicitly." };
  }
  async previewScheduleProposal(identity: AuthenticatedIdentity, proposal: ScheduleProposal) {
    const state = await this.repository.ensure(identity);
    const next = buildProposalCalendar(state, proposal);
    validateCalendar(next);
    const conflicts = findConflicts(state, next);
    return { baseVersion: proposal.baseVersion, currentVersion: state.plan.version ?? 0, canApply: proposal.baseVersion === (state.plan.version ?? 0) && conflicts.length === 0, conflicts, diff: calendarDiff(state.plan.workouts, next), proposedWorkouts: next, message: "Preview only. No calendar was changed." };
  }
  async applyScheduleProposal(identity: AuthenticatedIdentity, proposal: ScheduleProposal) {
    const state = await this.repository.ensure(identity);
    const preview = await this.previewScheduleProposal(identity, proposal);
    if (proposal.baseVersion !== (state.plan.version ?? 0)) throw new Error(`Calendar version conflict. Refresh context and revise from version ${state.plan.version ?? 0}.`);
    if (preview.conflicts.length) throw new Error(`Calendar conflicts must be resolved before apply: ${preview.conflicts.map((item) => item.message).join(" ")}`);
    const applied = await this.repository.applyRevision(identity, { ...state.plan, workouts: preview.proposedWorkouts }, { expectedVersion: proposal.baseVersion, reason: proposal.reason, rationale: proposal.rationale, mode: proposal.mode } satisfies AppliedRevision);
    await this.repository.appendAudit(identity, { action: "calendar.revision_applied", metadata: { baseVersion: proposal.baseVersion, version: applied.version, reason: proposal.reason, rationale: proposal.rationale, mode: proposal.mode, diff: preview.diff } });
    return { plan: applied, diff: preview.diff, message: "Agent-authored calendar revision applied atomically." };
  }
  async connectionStatus(identity: AuthenticatedIdentity) { return this.connect(identity); }
  async listPlanVersions(identity: AuthenticatedIdentity, limit = 20) { await this.repository.ensure(identity); return this.repository.listPlanVersions(identity, Math.min(Math.max(limit, 1), 100)); }
  async listAudit(identity: AuthenticatedIdentity, limit = 20) { await this.repository.ensure(identity); return this.repository.listAudit(identity, Math.min(Math.max(limit, 1), 100)); }
  private async mutateFacts(identity: AuthenticatedIdentity, action: string, metadata: object, transform: (state: State) => State) {
    const before = await this.repository.ensure(identity);
    const after = transform(before);
    await this.repository.saveFacts(identity, after);
    await this.repository.appendAudit(identity, { action, metadata: metadata as Record<string, unknown> });
    return after;
  }
  /** Retry-safe fact writes use a caller-provided opaque key; no key is stored as runner data. */
  private async wasApplied(identity: AuthenticatedIdentity, action: string, idempotencyKey: string) {
    const recent = await this.repository.listAudit(identity, 1_000);
    return recent.some((event) => event.action === action && event.metadata.idempotencyKey === idempotencyKey);
  }
  private validateRunMatch(state: State, plannedWorkoutId: string | undefined, exceptRunId?: string) {
    if (!plannedWorkoutId) return;
    const workout = state.plan.workouts.find((item) => item.id === plannedWorkoutId);
    if (!workout) throw new Error("Planned workout not found for this authenticated runner.");
    if (workout.kind === "rest" || workout.miles === 0) throw new Error("A completed run cannot be linked to a rest workout.");
    if (state.runs.some((run) => run.id !== exceptRunId && run.plannedWorkoutId === plannedWorkoutId))
      throw new Error("That planned workout is already linked to another completed run.");
  }
}
