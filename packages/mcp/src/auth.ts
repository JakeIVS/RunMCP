import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthenticatedIdentity } from "@runmcp/service";

export interface TokenVerifier {
  verify(token: string): Promise<AuthenticatedIdentity>;
}

const list = (value?: string) =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) || [];

export function createDevelopmentVerifier(): TokenVerifier {
  const expected = process.env.RUNMCP_DEV_TOKEN;
  if (!expected) throw new Error("RUNMCP_DEV_TOKEN is required in development auth mode.");
  return {
    async verify(token) {
      if (token !== expected) throw new Error("Invalid development bearer token.");
      return {
        subject: process.env.RUNMCP_DEV_SUBJECT || "dev-runner",
        displayName: process.env.RUNMCP_DEV_NAME || "Development Runner",
        provider: "development",
        accessToken: token,
        clientId: "remote-development-agent",
      };
    },
  };
}

/** Clerk-specific verifier behind the provider-neutral TokenVerifier boundary. */
export function createClerkVerifier(): TokenVerifier {
  const issuer = process.env.RUNMCP_CLERK_ISSUER?.replace(/\/$/, "");
  const audience = process.env.RUNMCP_CLERK_AUDIENCE;
  if (!issuer || !audience)
    throw new Error("RUNMCP_CLERK_ISSUER and RUNMCP_CLERK_AUDIENCE are required for Clerk auth.");
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const allowedParties = list(process.env.RUNMCP_CLERK_AUTHORIZED_PARTIES);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      const subject = typeof payload.sub === "string" ? payload.sub : "";
      if (!subject) throw new Error("Verified Clerk token is missing subject.");
      const party = typeof payload.azp === "string" ? payload.azp : undefined;
      if (allowedParties.length && (!party || !allowedParties.includes(party)))
        throw new Error("Clerk token authorized party is not allowed.");
      return {
        subject,
        provider: "clerk",
        accessToken: token,
        displayName: typeof payload.name === "string" ? payload.name : undefined,
        email: typeof payload.email === "string" ? payload.email : undefined,
        clientId: party || "clerk-agent",
      };
    },
  };
}

export function configuredVerifier(): TokenVerifier {
  return process.env.RUNMCP_AUTH_MODE === "development"
    ? createDevelopmentVerifier()
    : createClerkVerifier();
}
