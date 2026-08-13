# RunMCP deployment and security

## Architecture

`@runmcp/core` holds data contracts and pure fact helpers; it contains no planner or calendar-rewrite logic. `@runmcp/service` owns user-bound factual storage, calendar validation, previews, compare-and-swap revisions, and audits. `@runmcp/mcp` offers a persistent local stdio adapter and a remote Streamable HTTP resource server. `apps/landing` is a deployable static, read-only landing/onboarding page; it does not implement auth or a dashboard. The ignored `archive/legacy-web` directory is not part of the product.

The remote service uses Supabase as its source of truth. It never accepts a tool-supplied user id: the verified bearer JWT subject is the sole owner key. No browser or MCP client receives a Supabase service-role key.

## Supabase

1. Create a Supabase project and apply `supabase/migrations/202608040001_runmcp_agent_first.sql` through the CLI or SQL editor.
2. Configure Supabase third-party JWT verification for the Clerk issuer/JWKS. Clerk tokens must carry `sub` and an `authenticated` database role claim. The migration's RLS policies compare `auth.jwt() ->> 'sub'` to each row's `user_id`; this supports Clerk's non-UUID subject values.
3. Use only the project URL and anon key in the remote service. The caller's verified bearer token is forwarded to Supabase so RLS enforces ownership.

The migration creates profiles, goals, current plans/workouts, immutable plan versions, completed runs, activities, interruptions, agent connections, and audit events. `apply_plan_revision` locks the current plan row and compares the expected version before atomically replacing workouts and writing history.

## Clerk and remote MCP

Configure a Clerk OAuth/OIDC application with authorization-code + PKCE, allowed redirect URLs for the chosen MCP client, and an audience for this protected resource. The remote server validates issuer, audience, expiry/not-before/signature through the issuer JWKS, requires `sub`, optionally checks `azp` against allowed parties, and validates browser Origins.

Required production environment:

```bash
RUNMCP_AUTH_MODE=clerk
RUNMCP_PUBLIC_URL=https://mcp.example.com
RUNMCP_ALLOWED_ORIGINS=https://your-agent-host.example
RUNMCP_CLERK_ISSUER=https://your-instance.clerk.accounts.dev
RUNMCP_CLERK_AUDIENCE=your-mcp-audience
RUNMCP_CLERK_AUTHORIZED_PARTIES=https://your-agent-host.example
RUNMCP_SUPABASE_URL=https://project-ref.supabase.co
RUNMCP_SUPABASE_ANON_KEY=your-anon-key
RUNMCP_OAUTH_ISSUER=https://your-clerk-oidc-issuer
RUNMCP_OAUTH_AUTHORIZATION_ENDPOINT=https://your-clerk-oidc-issuer/oauth/authorize
RUNMCP_OAUTH_TOKEN_ENDPOINT=https://your-clerk-oidc-issuer/oauth/token
PORT=3001
```

Start with `npm run mcp:remote`. The endpoint is `POST/GET /mcp`. It uses the official Streamable HTTP transport and emits protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`; missing/invalid bearer tokens receive a 401 with `WWW-Authenticate` and the metadata pointer. The metadata advertises PKCE (`S256`) and the configured Clerk authorization server. Final Clerk OAuth-client registration and public HTTPS deployment require real external credentials and are intentionally not performed here.

For a safe credential-free smoke mode only:

```bash
RUNMCP_AUTH_MODE=development RUNMCP_DEV_TOKEN=replace-me \
RUNMCP_PUBLIC_URL=http://127.0.0.1:3001 npm run mcp:remote
```

This uses a local file repository and a fixed server-side development subject; it is not a multi-user or production mode.

## Security notes

- Stateless HTTP sessions allow horizontal scaling; canonical data and revision versions live in Postgres.
- Agents may propose calendars but cannot bypass RLS, select another user, or apply stale revisions.
- A factual interruption or run is deliberately not a planning instruction. The agent must preview and apply a separate revision.
- Do not expose local development tokens, Clerk secrets, or Supabase service-role keys. Service-role keys are neither required nor supported by RunMCP.
