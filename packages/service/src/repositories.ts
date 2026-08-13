import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  freshUserState,
  type CompletedRun,
  type Interruption,
  type Plan,
  type PlanningActivity,
  type Profile,
  type RacePlan,
  type State,
  type Workout,
} from "@runmcp/core/training.js";
import {
  type AgentConnection,
  type AppliedRevision,
  type AuditEvent,
  type AuthenticatedIdentity,
  PlanVersionConflictError,
  type PlanVersion,
  type RunnerRepository,
} from "./contracts.js";

const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const newState = (identity: AuthenticatedIdentity): State => {
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

type LocalData = {
  users: Record<string, State>;
  audits: AuditEvent[];
  planVersions: PlanVersion[];
  connections: AgentConnection[];
};
const blankLocalData = (): LocalData => ({ users: {}, audits: [], planVersions: [], connections: [] });

/** Deterministic adapter for unit tests only. Never used by an MCP process. */
export class InMemoryRunnerRepository implements RunnerRepository {
  protected data: LocalData = blankLocalData();

  async ensure(identity: AuthenticatedIdentity) {
    const existing = this.data.users[identity.subject];
    if (existing) return clone(existing);
    const created = newState(identity);
    this.data.users[identity.subject] = clone(created);
    return clone(created);
  }
  async load(userId: string): Promise<State | null> {
    const state = this.data.users[userId];
    return state ? clone(state) : null;
  }
  async saveFacts(identity: AuthenticatedIdentity, state: State) {
    const current = this.data.users[identity.subject];
    this.data.users[identity.subject] = clone({
      ...state,
      plan: current
        ? { ...current.plan, interruptions: state.plan.interruptions }
        : state.plan,
    });
  }
  async applyRevision(identity: AuthenticatedIdentity, plan: Plan, revision: AppliedRevision) {
    const current = this.data.users[identity.subject];
    if (!current) throw new Error("Authenticated runner profile was not provisioned.");
    const currentVersion = current.plan.version ?? 0;
    if (currentVersion !== revision.expectedVersion)
      throw new PlanVersionConflictError(currentVersion);
    const applied: Plan = {
      ...clone(plan),
      version: currentVersion + 1,
      generatedAt: now(),
      revisionReason: revision.reason,
      revisionRationale: revision.rationale,
      interruptions: clone(current.plan.interruptions),
    };
    this.data.users[identity.subject] = { ...current, plan: applied };
    this.data.planVersions.push({
      id: randomUUID(), userId: identity.subject, version: applied.version!,
      reason: revision.reason, rationale: revision.rationale, mode: revision.mode,
      workouts: clone(applied.workouts), createdAt: applied.generatedAt,
    });
    return clone(applied);
  }
  async recordConnection(identity: AuthenticatedIdentity) {
    const clientId = identity.clientId || "unknown-agent";
    const existing = this.data.connections.find(
      (item) => item.userId === identity.subject && item.clientId === clientId,
    );
    if (existing) existing.lastSeenAt = now();
    else
      this.data.connections.push({
        userId: identity.subject,
        clientId,
        provider: identity.provider,
        firstSeenAt: now(),
        lastSeenAt: now(),
      });
  }
  async appendAudit(
    identity: AuthenticatedIdentity,
    event: Omit<AuditEvent, "id" | "createdAt" | "userId">,
  ) {
    const recorded: AuditEvent = {
      ...clone(event),
      id: randomUUID(),
      userId: identity.subject,
      createdAt: now(),
    };
    this.data.audits.push(recorded);
    return clone(recorded);
  }
  async listAudit(identity: AuthenticatedIdentity, limit: number) {
    return clone(
      this.data.audits
        .filter((item) => item.userId === identity.subject)
        .slice(-limit)
        .reverse(),
    );
  }
  async listPlanVersions(identity: AuthenticatedIdentity, limit: number) {
    return clone(this.data.planVersions.filter((item) => item.userId === identity.subject).slice(-limit).reverse());
  }
}

/**
 * Persistent local adapter for the stdio server. It is intentionally a file,
 * not a module-level in-memory database, and is never used in remote mode.
 */
export class FileRunnerRepository extends InMemoryRunnerRepository {
  private hydrated = false;
  constructor(private readonly filePath: string) {
    super();
  }
  private async hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      this.data = { ...blankLocalData(), ...JSON.parse(await readFile(this.filePath, "utf8")) as LocalData };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
  override async ensure(identity: AuthenticatedIdentity) {
    await this.hydrate();
    const state = await super.ensure(identity);
    await this.persist();
    return state;
  }
  override async load(userId: string) {
    await this.hydrate();
    return super.load(userId);
  }
  override async saveFacts(identity: AuthenticatedIdentity, state: State) {
    await this.hydrate();
    await super.saveFacts(identity, state);
    await this.persist();
  }
  override async applyRevision(identity: AuthenticatedIdentity, plan: Plan, revision: AppliedRevision) {
    await this.hydrate();
    const applied = await super.applyRevision(identity, plan, revision);
    await this.persist();
    return applied;
  }
  override async recordConnection(identity: AuthenticatedIdentity) {
    await this.hydrate();
    await super.recordConnection(identity);
    await this.persist();
  }
  override async appendAudit(identity: AuthenticatedIdentity, event: Omit<AuditEvent, "id" | "createdAt" | "userId">) {
    await this.hydrate();
    const recorded = await super.appendAudit(identity, event);
    await this.persist();
    return recorded;
  }
  override async listAudit(identity: AuthenticatedIdentity, limit: number) {
    await this.hydrate();
    return super.listAudit(identity, limit);
  }
  override async listPlanVersions(identity: AuthenticatedIdentity, limit: number) {
    await this.hydrate();
    return super.listPlanVersions(identity, limit);
  }
}

type DbProfile = {
  user_id: string;
  display_name: string | null;
  training_intensity: Profile["trainingIntensity"];
};
type DbPlan = {
  id: string;
  generated_at: string;
  version: number;
  revision_reason: string | null;
  revision_rationale: string | null;
};

/**
 * Production implementation. It creates a Supabase client with the verified
 * user's bearer token and the public anon key only. RLS is therefore part of
 * the authorization boundary; no service-role credential is accepted here.
 */
export class SupabaseRunnerRepository implements RunnerRepository {
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
  ) {}

  private client(identity: AuthenticatedIdentity) {
    if (!identity.accessToken)
      throw new Error("A verified bearer token is required for the Supabase repository.");
    return createClient(this.url, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${identity.accessToken}` } },
    });
  }
  private async expect<T>(request: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>) {
    const { data, error } = await request;
    if (error) throw new Error(error.message);
    return data;
  }
  async ensure(identity: AuthenticatedIdentity) {
    const existing = await this.loadWithIdentity(identity);
    if (existing) return existing;
    const state = newState(identity);
    const client = this.client(identity);
    await this.expect(
      client.from("profiles").insert({
        user_id: identity.subject,
        display_name: state.profile.name,
        training_intensity: state.profile.trainingIntensity,
      }),
    );
    await this.expect(
      client.from("training_plans").insert({
        user_id: identity.subject,
        id: state.plan.id,
        generated_at: state.plan.generatedAt,
        version: 0,
        revision_reason: "initial",
        revision_rationale: "Empty canonical calendar provisioned on first authenticated connection.",
      }),
    );
    return state;
  }
  async load(userId: string): Promise<State | null> {
    throw new Error(
      `Supabase loading requires a verified token-bound identity; user id ${userId} alone is not authorized.`,
    );
  }
  private async loadWithIdentity(identity: AuthenticatedIdentity): Promise<State | null> {
    const client = this.client(identity);
    const userId = identity.subject;
    const [profile, goals, runs, activities, interruptions, plan, workouts] = await Promise.all([
      this.expect(client.from("profiles").select("*").eq("user_id", userId).maybeSingle()),
      this.expect(client.from("goals").select("*").eq("user_id", userId).order("created_at")),
      this.expect(client.from("completed_runs").select("*").eq("user_id", userId).order("date")),
      this.expect(client.from("activities").select("*").eq("user_id", userId).order("created_at")),
      this.expect(client.from("interruptions").select("*").eq("user_id", userId).order("start_date")),
      this.expect(client.from("training_plans").select("*").eq("user_id", userId).maybeSingle()),
      this.expect(client.from("workouts").select("*").eq("user_id", userId).order("date")),
    ]);
    if (!profile) return null;
    const profileRow = profile as DbProfile;
    const goalRows = (goals ?? []) as Array<Record<string, unknown>>;
    const runRows = (runs ?? []) as Array<Record<string, unknown>>;
    const activityRows = (activities ?? []) as Array<Record<string, unknown>>;
    const interruptionRows = (interruptions ?? []) as Array<Record<string, unknown>>;
    const planRow = plan as DbPlan | null;
    const fallback = newState(identity);
    const mappedGoals: RacePlan[] = goalRows.map((row) => ({
      id: String(row.id), name: String(row.name), distance: row.distance as RacePlan["distance"],
      customDistance: row.custom_distance as number | undefined, unit: row.unit as RacePlan["unit"],
      targetDate: String(row.target_date), targetPace: row.target_pace as string | undefined,
      active: Boolean(row.active), createdAt: String(row.created_at),
    }));
    const mappedRuns: CompletedRun[] = runRows.map((row) => ({
      id: String(row.id), date: String(row.date), distance: Number(row.distance),
      unit: row.unit as CompletedRun["unit"], duration: String(row.duration), notes: row.notes as string | undefined,
      plannedWorkoutId: row.planned_workout_id as string | undefined,
      matchStatus: (row.match_status as CompletedRun["matchStatus"] | undefined) || "unmatched",
      matchRationale: row.match_rationale as string | undefined,
    }));
    const mappedActivities: PlanningActivity[] = activityRows.map((row) => ({
      id: String(row.id), name: String(row.name), type: row.type as PlanningActivity["type"],
      intensity: row.intensity as PlanningActivity["intensity"], preference: row.preference as PlanningActivity["preference"],
      date: row.date as string | undefined, weekday: row.weekday as PlanningActivity["weekday"],
    }));
    const mappedInterruptions: Interruption[] = interruptionRows.map((row) => ({
      id: String(row.id), startDate: String(row.start_date), days: Number(row.days),
      reason: String(row.reason), note: row.note as string | undefined,
    }));
    const mappedWorkouts: Workout[] = ((workouts ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), date: String(row.date), kind: row.kind as Workout["kind"],
      title: String(row.title), miles: Number(row.miles), detail: String(row.detail),
      sections: row.sections as Workout["sections"],
      planIds: row.plan_ids as string[] | undefined, completed: Boolean(row.completed),
    }));
    return {
      profile: {
        ...fallback.profile,
        name: profileRow.display_name || "Runner",
        trainingIntensity: profileRow.training_intensity,
      },
      plans: mappedGoals,
      runs: mappedRuns,
      activities: mappedActivities,
      plan: {
        id: planRow?.id || "current", generatedAt: planRow?.generated_at || now(),
        version: planRow?.version || 0, revisionReason: planRow?.revision_reason || undefined,
        revisionRationale: planRow?.revision_rationale || undefined,
        workouts: mappedWorkouts, interruptions: mappedInterruptions,
      },
    };
  }
  async saveFacts(identity: AuthenticatedIdentity, state: State) {
    const client = this.client(identity);
    const userId = identity.subject;
    await this.expect(client.from("profiles").upsert({ user_id: userId, display_name: state.profile.name, training_intensity: state.profile.trainingIntensity }));
    for (const table of ["goals", "completed_runs", "activities", "interruptions"])
      await this.expect(client.from(table).delete().eq("user_id", userId));
    if (state.plans.length) await this.expect(client.from("goals").insert(state.plans.map((goal) => ({ user_id: userId, id: goal.id, name: goal.name, distance: goal.distance, custom_distance: goal.customDistance ?? null, unit: goal.unit, target_date: goal.targetDate, target_pace: goal.targetPace ?? null, active: goal.active, created_at: goal.createdAt }))));
    if (state.runs.length) await this.expect(client.from("completed_runs").insert(state.runs.map((run) => ({ user_id: userId, id: run.id, date: run.date, distance: run.distance, unit: run.unit, duration: run.duration, notes: run.notes ?? null, planned_workout_id: run.plannedWorkoutId ?? null, match_status: run.matchStatus, match_rationale: run.matchRationale ?? null }))));
    if (state.activities.length) await this.expect(client.from("activities").insert(state.activities.map((activity) => ({ user_id: userId, id: activity.id, name: activity.name, type: activity.type, intensity: activity.intensity, preference: activity.preference, date: activity.date ?? null, weekday: activity.weekday ?? null }))));
    if (state.plan.interruptions.length) await this.expect(client.from("interruptions").insert(state.plan.interruptions.map((item) => ({ user_id: userId, id: item.id, start_date: item.startDate, days: item.days, reason: item.reason, note: item.note ?? null }))));
  }
  async applyRevision(identity: AuthenticatedIdentity, plan: Plan, revision: AppliedRevision) {
    const client = this.client(identity);
    const { data, error } = await client.rpc("apply_plan_revision", {
      p_expected_version: revision.expectedVersion,
      p_plan_id: plan.id,
      p_workouts: plan.workouts,
      p_reason: revision.reason,
      p_rationale: revision.rationale,
      p_mode: revision.mode,
    });
    if (error) {
      if (error.code === "P0001" && /version/i.test(error.message)) {
        const current = await this.loadWithIdentity(identity);
        throw new PlanVersionConflictError(current?.plan.version ?? 0);
      }
      throw new Error(error.message);
    }
    const result = data as { version?: number; generated_at?: string } | null;
    return {
      ...plan,
      version: result?.version ?? revision.expectedVersion + 1,
      generatedAt: result?.generated_at ?? now(),
      revisionReason: revision.reason,
      revisionRationale: revision.rationale,
    };
  }
  async recordConnection(identity: AuthenticatedIdentity) {
    const client = this.client(identity);
    await this.expect(client.from("agent_connections").upsert({ user_id: identity.subject, client_id: identity.clientId || "unknown-agent", provider: identity.provider, last_seen_at: now() }, { onConflict: "user_id,client_id" }));
  }
  async appendAudit(identity: AuthenticatedIdentity, event: Omit<AuditEvent, "id" | "createdAt" | "userId">) {
    const client = this.client(identity);
    const row = await this.expect(client.from("audit_events").insert({ user_id: identity.subject, action: event.action, metadata: event.metadata }).select("*").single());
    return { id: String((row as Record<string, unknown>).id), userId: identity.subject, action: event.action, metadata: event.metadata, createdAt: String((row as Record<string, unknown>).created_at) };
  }
  async listAudit(identity: AuthenticatedIdentity, limit: number) {
    const client = this.client(identity);
    const rows = await this.expect(client.from("audit_events").select("*").eq("user_id", identity.subject).order("created_at", { ascending: false }).limit(limit));
    return (rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), userId: String(row.user_id), action: String(row.action), metadata: (row.metadata || {}) as Record<string, unknown>, createdAt: String(row.created_at) }));
  }
  async listPlanVersions(identity: AuthenticatedIdentity, limit: number) {
    const client = this.client(identity);
    const rows = await this.expect(client.from("plan_versions").select("*").eq("user_id", identity.subject).order("version", { ascending: false }).limit(limit));
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), userId: String(row.user_id), version: Number(row.version),
      reason: String(row.reason), rationale: String(row.rationale), mode: row.mode as PlanVersion["mode"],
      workouts: row.workouts as Plan["workouts"], createdAt: String(row.created_at),
    }));
  }
}
