import { createRemoteJWKSet, jwtVerify } from "jose";

export type Identity = { subject: string; name?: string; clientId?: string };
export type AuthEnv = { CLERK_ISSUER?: string; CLERK_AUDIENCE?: string; CLERK_AUTHORIZED_PARTIES?: string };

/** A Worker accepts identity only after signature, issuer, audience, and optional azp validation. */
export async function verifyIdentity(request: Request, env: AuthEnv): Promise<Identity> {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new Response("Bearer token required", { status: 401 });
  if (!env.CLERK_ISSUER || !env.CLERK_AUDIENCE)
    throw new Response("OIDC verification is not configured", { status: 503 });
  const issuer = env.CLERK_ISSUER.replace(/\/$/, "");
  const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), {
    issuer, audience: env.CLERK_AUDIENCE,
  });
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  const clientId = typeof payload.azp === "string" ? payload.azp : undefined;
  const parties = env.CLERK_AUTHORIZED_PARTIES?.split(",").map((item) => item.trim()).filter(Boolean) || [];
  if (!subject || (parties.length && (!clientId || !parties.includes(clientId))))
    throw new Response("Token is not authorized for RunMCP", { status: 403 });
  return { subject, clientId, name: typeof payload.name === "string" ? payload.name : undefined };
}
