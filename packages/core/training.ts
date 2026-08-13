/**
 * Shared data contracts and pure fact helpers. This package deliberately does
 * not contain a coach, a plan generator, or rules that rewrite a calendar.
 * Planning is performed by a connected agent, which submits a versioned
 * calendar through the service layer.
 */
export type Distance = "5K" | "10K" | "Half marathon" | "Marathon" | "Custom";
export type Unit = "mi" | "km";
export type TrainingIntensity = "conservative" | "balanced" | "ambitious";
export type WorkoutKind = "easy" | "long" | "quality" | "rest" | "recovery" | "race";
export type ActivityType = "strength" | "cycling" | "yoga" | "other";
export type ActivityIntensity = "low" | "moderate" | "high";
export type ActivityPreference = "no_run" | "easy_only" | "normal";

export interface Profile { name: string; trainingIntensity: TrainingIntensity; }
export interface WorkoutStep {
  action: string;
  targetDistance?: number;
  targetDistanceUnit?: Unit;
  targetDurationSeconds?: number;
  targetPace?: string;
  maxPace?: string;
  targetEffort?: number;
  instruction?: string;
}
export interface WorkoutSection {
  sectionType: string;
  repeatCount?: number;
  note?: string;
  steps: WorkoutStep[];
}
export interface Workout {
  id: string; date: string; kind: WorkoutKind; title: string; miles: number;
  detail: string; sections?: WorkoutSection[]; planIds?: string[]; completed?: boolean;
}
export interface Interruption { id: string; startDate: string; days: number; reason: string; note?: string; }
export interface Plan {
  id: string; generatedAt: string; workouts: Workout[]; interruptions: Interruption[];
  version?: number; revisionReason?: string; revisionRationale?: string;
}
export interface RacePlan {
  id: string; name: string; distance: Distance; customDistance?: number; unit: Unit;
  targetDate: string; targetPace?: string; active: boolean; createdAt: string;
}
export type RunMatchStatus = "matched" | "unmatched";
export interface CompletedRun {
  id: string; date: string; distance: number; unit: Unit; duration: string; notes?: string;
  plannedWorkoutId?: string; matchStatus: RunMatchStatus; matchRationale?: string;
}
export interface PlanningActivity {
  id: string; name: string; type: ActivityType; intensity: ActivityIntensity;
  preference: ActivityPreference; date?: string; weekday?: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
}
export interface State { profile: Profile; plan: Plan; plans: RacePlan[]; runs: CompletedRun[]; activities: PlanningActivity[]; }

let sequence = 0;
const entityId = (prefix: string) => {
  sequence += 1;
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${sequence}`}`;
};
export const today = () => new Date().toISOString().slice(0, 10);
export const freshUserState = (): State => ({
  profile: { name: "Runner", trainingIntensity: "balanced" },
  plan: { id: "current", generatedAt: new Date().toISOString(), version: 0, workouts: [], interruptions: [] },
  plans: [], runs: [], activities: [],
});
export function createRaceGoal(state: State, input: Omit<RacePlan, "id" | "active" | "createdAt">): State {
  return { ...state, plans: [...state.plans, { ...input, id: entityId("goal"), active: true, createdAt: new Date().toISOString() }] };
}
export function toggleRaceGoalFact(state: State, id: string, active: boolean): State {
  return { ...state, plans: state.plans.map((goal) => goal.id === id ? { ...goal, active } : goal) };
}
export function recordCompletedRunFact(state: State, input: Omit<CompletedRun, "id" | "matchStatus"> & { matchStatus?: RunMatchStatus }): State {
  return { ...state, runs: [...state.runs, { ...input, matchStatus: input.matchStatus || "unmatched", id: entityId("run") }] };
}
export function recordInterruptionFact(state: State, input: Omit<Interruption, "id">): State {
  return { ...state, plan: { ...state.plan, interruptions: [...state.plan.interruptions, { ...input, id: entityId("interruption") }] } };
}
const defaultPreference = (intensity: ActivityIntensity): ActivityPreference => intensity === "high" ? "no_run" : intensity === "moderate" ? "easy_only" : "normal";
export function recordPlanningActivity(state: State, input: Omit<PlanningActivity, "id" | "preference"> & { preference?: ActivityPreference }): State {
  return { ...state, activities: [...state.activities, { ...input, id: entityId("activity"), preference: input.preference || defaultPreference(input.intensity) }] };
}
export function updatePlanningActivityFact(state: State, id: string, changes: Partial<Omit<PlanningActivity, "id">>): State {
  return { ...state, activities: state.activities.map((activity) => activity.id === id ? { ...activity, ...changes } : activity) };
}
export function removePlanningActivityFact(state: State, id: string): State {
  return { ...state, activities: state.activities.filter((activity) => activity.id !== id) };
}
