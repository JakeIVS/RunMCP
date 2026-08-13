import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CoachService, FileRunnerRepository, SupabaseRunnerRepository, type AuthenticatedIdentity } from "@runmcp/service";
import { configuredVerifier } from "./auth.js";
import { createRunMcpServer } from "./server.js";

const port = Number(process.env.PORT || 3001);
const publicUrl = new URL(process.env.RUNMCP_PUBLIC_URL || `http://127.0.0.1:${port}`);
const mcpUrl = new URL("/mcp", publicUrl);
const allowedOrigins = (process.env.RUNMCP_ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000").split(",").map((item) => item.trim());
const authMode = process.env.RUNMCP_AUTH_MODE || "clerk";
const repository = authMode === "development"
  ? new FileRunnerRepository(process.env.RUNMCP_REMOTE_DEV_STATE_PATH || ".runmcp-remote-dev.json")
  : new SupabaseRunnerRepository(
      required("RUNMCP_SUPABASE_URL"),
      required("RUNMCP_SUPABASE_ANON_KEY"),
    );
const coach = new CoachService(repository);
const verifier = configuredVerifier();

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required outside development auth mode.`);
  return value;
}
function originGuard(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("origin");
  if (origin && !allowedOrigins.includes(origin)) {
    res.status(403).json({ error: "origin_not_allowed" });
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
}

const app = express();
app.disable("x-powered-by");
app.use(originGuard);
app.options("/mcp", (_req, res) => res.status(204).end());
app.get("/health", (_req, res) => res.json({ service: "RunMCP", transport: "streamable-http", authMode }));
app.use(mcpAuthMetadataRouter({
  oauthMetadata: {
    issuer: process.env.RUNMCP_OAUTH_ISSUER || publicUrl.href,
    authorization_endpoint: process.env.RUNMCP_OAUTH_AUTHORIZATION_ENDPOINT || new URL("/dev-authorize", publicUrl).href,
    token_endpoint: process.env.RUNMCP_OAUTH_TOKEN_ENDPOINT || new URL("/dev-token", publicUrl).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  },
  resourceServerUrl: mcpUrl,
  scopesSupported: ["runmcp:tools"],
  resourceName: "RunMCP",
}));

const bearer = requireBearerAuth({
  verifier: {
    verifyAccessToken: async (token) => {
      const identity = await verifier.verify(token);
      return {
        token,
        clientId: identity.clientId || "authenticated-agent",
        scopes: ["runmcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        extra: { identity },
      } satisfies AuthInfo;
    },
  },
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});
app.use("/mcp", express.json({ type: ["application/json", "application/*+json"] }), bearer);
app.all("/mcp", async (req, res, next) => {
  try {
    const identity = (req.auth?.extra?.identity as AuthenticatedIdentity | undefined);
    if (!identity) throw new Error("Verified identity was not attached to the request.");
    await coach.connect(identity);
    const server = createRunMcpServer(coach, identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    next(error);
  }
});
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "internal_error" });
});
app.listen(port, () => console.error(`RunMCP remote MCP listening at ${mcpUrl.href}`));
