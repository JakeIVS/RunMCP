import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  freshUserState,
  type Plan,
  type State,
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
