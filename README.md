# RunMCP

RunMCP is a multi-user, agent-first running calendar service. A connected agent reads the runner's context, reasons about training, then submits a complete calendar or a versioned patch. RunMCP authenticates the user, stores canonical facts and calendars, validates shape/conflicts, and records every revision. It is not medical advice and does not prescribe training.

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The stdio adapter persists state in `.runmcp-local.json`; it never uses a module-level in-memory database.

```json
{
  "mcpServers": {
    "RunMCP": {
      "command": "npm",
      "args": ["run", "mcp", "--workspace=@runmcp/mcp"],
      "cwd": "/Users/jwives/Code/RunMCP"
    }
  }
}
```

The local adapter uses one configured local subject (`RUNMCP_LOCAL_SUBJECT`), which is useful for development only. Production uses verified Clerk bearer tokens and Supabase.

## Public landing page

`apps/landing` is the active read-only RunMCP landing/onboarding surface. It explains the agent-first workflow and shows an accurate local MCP configuration without inventing a hosted sign-up flow. Run `npm run web` to serve it locally at `http://127.0.0.1:4173`, or deploy the generated `apps/landing/dist` directory as static files after `npm run build`.

The former rich frontend stays preserved and ignored at `archive/legacy-web`; it is not an active product workspace.

## Agent workflow

1. Read `get_planning_context`, `get_schedule_summary`, and factual runs/activities/interruptions.
2. The agent evaluates context, calendar constraints, and any external research itself.
3. Submit `preview_schedule_proposal` with a complete replacement calendar or a patch, a `baseVersion`, reason, and rationale.
4. Resolve reported shape or recorded-constraint conflicts; then call `apply_schedule_proposal` at the same version.

When a runner logs a run without naming the workout, the agent calls
`find_run_match_candidates` first. A single unmatched same-day workout may be
linked when logging the run; an unmatched prior-day workout is only a
confirmation candidate. Planned workouts may include structured `sections` and
`steps`, which `get_planned_workout` returns in full.

Logging a run, illness, missed day, or outside activity only stores a fact. It never silently changes the calendar. `apply_schedule_proposal` is the only calendar mutation, and it uses optimistic version control plus an audit record. RunMCP does not send notifications; agents can read `get_next_workout` for their own user-authorized automation.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Supabase, Clerk, remote MCP, PKCE, and security setup.

## Cloudflare option

`apps/api` is a Hono-on-Cloudflare-Workers API foundation with a D1 schema and OIDC token boundary. It is a strong deployment fit when the custom domain, API, and database should live on Cloudflare. See [CLOUDFLARE.md](CLOUDFLARE.md) for the short architecture and configuration path. No Cloudflare account or deployment is required to work locally.

The Worker API now has the finalized versioned-plan, nested-workout, actual-run, availability, activity, interruption, connection, and audit route surface. See [API.md](API.md) for its route map.
