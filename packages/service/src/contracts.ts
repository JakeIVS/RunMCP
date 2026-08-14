import type { Plan, State } from "@runmcp/core/training.js";

export type AuthProvider = "clerk" | "development";

/** Only a verified token verifier can create this object. */
export interface AuthenticatedIdentity {
  subject: string;
  provider: AuthProvider;
  accessToken?: string;
  displayName?: string;
  email?: string;
  clientId?: string;
}

export interface AuditEvent {
  id: string;
  userId: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface PlanVersion {
  id: string;
  userId: string;
  version: number;
  reason: string;
  rationale: string;
  mode: "replace" | "patch";
  workouts: Plan["workouts"];
  createdAt: string;
}

export interface AgentConnection {
  userId: string;
  clientId: string;
  provider: AuthProvider;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AppliedRevision {
  expectedVersion: number;
  reason: string;
  rationale: string;
  mode: "replace" | "patch";
}

export class PlanVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Calendar changed before this revision could be applied (current version ${currentVersion}).`);
    this.name = "PlanVersionConflictError";
  }
}

/**
 * The persistence port used by coaching commands. The local MCP uses a file
 * adapter; the deployed API persists data in Cloudflare D1.
 */
export interface RunnerRepository {
  ensure(identity: AuthenticatedIdentity): Promise<State>;
  load(userId: string): Promise<State | null>;
  /** Saves profile, goals, factual events, and constraints without changing the calendar. */
  saveFacts(identity: AuthenticatedIdentity, state: State): Promise<void>;
  /** Applies a validated calendar revision atomically against its expected version. */
  applyRevision(
    identity: AuthenticatedIdentity,
    plan: Plan,
    revision: AppliedRevision,
  ): Promise<Plan>;
  recordConnection(identity: AuthenticatedIdentity): Promise<void>;
  appendAudit(
    identity: AuthenticatedIdentity,
    event: Omit<AuditEvent, "id" | "createdAt" | "userId">,
  ): Promise<AuditEvent>;
  listAudit(identity: AuthenticatedIdentity, limit: number): Promise<AuditEvent[]>;
  listPlanVersions(identity: AuthenticatedIdentity, limit: number): Promise<PlanVersion[]>;
}
