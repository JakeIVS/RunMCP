# Cloudflare foundation

RunMCP can now use Cloudflare as its deployment path without creating an account or deploying from this repository. The Worker lives in `apps/api`; it is a Hono API with a D1 binding, verified OIDC identity boundary, versioned calendar writes, and account-scoped fact routes.

## How it fits

```text
Agent or landing page → Hono Worker API → D1
                          │
                          └→ verified OIDC subject scopes every query
```

- **Hono** is the small HTTP router inside the Cloudflare Worker. It handles `/health`, authenticated connection provisioning, goals, plan versions, nested workout reads, actual runs, availability, activities, interruptions, connections, and audit reads.
- **D1** is Cloudflare’s serverless SQLite database. The Worker reaches it through a private `DB` binding, not a database URL or client-side secret.
- **OIDC/Clerk** verifies the bearer token in the Worker. D1 does not provide RLS, so the verified `sub` is the only account key used in queries.
- **RunMCP service/MCP** remains the plan command model: agents reason, then submit explicit versioned proposals. The Worker is a deployable API foundation, not an automatic planner.

## When ready to configure Cloudflare

1. Create D1 with `wrangler d1 create runmcp`.
2. Copy `apps/api/wrangler.example.toml` to `apps/api/wrangler.toml` and add the generated database ID.
3. Apply `apps/api/migrations/0001_runmcp.sql` with `wrangler d1 migrations apply runmcp --remote`.
4. Configure `CLERK_ISSUER`, `CLERK_AUDIENCE`, and optionally `CLERK_AUTHORIZED_PARTIES` as Worker secrets or environment variables.
5. Deploy from `apps/api` with Wrangler and attach the Worker to the desired Cloudflare domain.

No Cloudflare resources or secrets have been created here. Before production, connect the remote MCP transport to the Worker’s authenticated command layer and test concurrent versioned revisions against D1.

See [API.md](API.md) for the Worker routes. The existing stdio MCP remains useful for local development; remote MCP transport is the next integration step before exposing agent connections in production.
