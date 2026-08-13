# RunMCP Worker API

All `/api/*` routes require a verified OIDC bearer token. The Worker derives the account from the token subject; routes never accept a user ID. Responses and writes are therefore account-scoped.

| Resource | Routes |
|---|---|
| Connection | `GET /api/connection` |
| Profile | `GET`, `PATCH /api/profile` |
| Goals | `GET`, `POST /api/goals`; `PATCH /api/goals/:id` |
| Current plan | `GET /api/plan`; `GET /api/plan/versions`; `GET /api/plan/versions/:id` |
| Revisions | `POST /api/plan-revisions/preview`; `POST /api/plan-revisions` |
| Workout detail | `GET /api/planned-workouts/:id` |
| Actual runs | `GET`, `POST /api/actual-runs`; `PATCH /api/actual-runs/:id`; `POST /api/actual-runs/:id/match` |
| Availability | `GET`, `POST /api/availability-rules`; `PATCH`, `DELETE /api/availability-rules/:id` |
| Activities | `GET`, `POST /api/activities`; `PATCH`, `DELETE /api/activities/:id` |
| Interruptions | `GET`, `POST /api/interruptions`; `PATCH`, `DELETE /api/interruptions/:id` |
| Agent connections | `GET /api/connections`; `DELETE /api/connections/:id` |
| Audit | `GET /api/audit-events` |
| Operations | `GET /health` |

Plan revisions accept a full `workouts` snapshot, with nested `sections` and `steps`. Applying one checks `expectedVersion`, makes the new version current, snapshots active goals, retains older versions, and writes an audit event. It does not generate a plan or infer a revision.

Search is intentionally deferred. Date/status filters on the list routes cover the initial product; add an account-scoped FTS endpoint when note search proves necessary.
