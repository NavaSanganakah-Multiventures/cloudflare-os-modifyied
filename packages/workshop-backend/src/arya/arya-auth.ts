import { SignJWT, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

// Token minting and verification for Arya voice calls.
//
// The signing secret (ARYA_SIGNING_SECRET) is the capability that authorizes a caller: a room
// accepts only tokens signed with it. In production only the workshop backend mints tokens, for the
// logged-in owner (and, later, authorized members). PR 2 will add that authenticated RPC; PR 1
// ships a dev-only token endpoint for local testing.

const TOKEN_ALG = "HS256";

/** The subset of env config that Arya voice auth reads. */
export interface AryaAuthEnv {
  /** HMAC-SHA256 signing secret for voice-call tokens. Voice calls are disabled when absent. */
  ARYA_SIGNING_SECRET?: string;
  /** Optional allowlist of user ids (see authorizedMemberIds). */
  ARYA_AUTHORIZED_MEMBERS?: string;
}

/** Verified claims of an Arya voice-call token. */
export interface AryaTokenClaims extends JWTPayload {
  /** User id of the caller (JWT sub). */
  sub?: string;
  /** Display name of the caller. */
  name?: string;
  /** The room the token is scoped to. Must match the call query parameter. */
  call?: string;
}

function signingKey(env: AryaAuthEnv): Uint8Array {
  if (!env.ARYA_SIGNING_SECRET) {
    throw new Error("ARYA_SIGNING_SECRET is not configured");
  }
  return new TextEncoder().encode(env.ARYA_SIGNING_SECRET);
}

/** Mints a short-lived token authorizing sub to join call. */
export async function mintAryaToken(
  claims: { sub: string; name: string; call: string },
  env: AryaAuthEnv,
  ttlSeconds = 600,
): Promise<string> {
  return await new SignJWT({ name: claims.name, call: claims.call })
    .setProtectedHeader({ alg: TOKEN_ALG })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(signingKey(env));
}

/** Verifies a token's signature and expiry, returning its claims, or null when invalid. */
export async function verifyAryaToken(
  token: string | null,
  env: AryaAuthEnv,
): Promise<AryaTokenClaims | null> {
  if (!token || !env.ARYA_SIGNING_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(env), { algorithms: [TOKEN_ALG] });
    return payload as AryaTokenClaims;
  } catch {
    return null;
  }
}

/** Parses ARYA_AUTHORIZED_MEMBERS into a set of user ids, or null when no allowlist is set. */
export function authorizedMemberIds(env: AryaAuthEnv): Set<string> | null {
  const raw = env.ARYA_AUTHORIZED_MEMBERS?.trim();
  if (!raw) return null;
  let list: string[];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed.map(String) : raw.split(",");
  } catch {
    list = raw.split(",");
  }
  return new Set(list.map((s) => s.trim()).filter(Boolean));
}

/** Whether userId may join a voice call under the deployment's access-control config. */
export function isAuthorizedMember(userId: string | undefined, env: AryaAuthEnv): boolean {
  if (!userId) return false;
  const allowlist = authorizedMemberIds(env);
  return allowlist === null || allowlist.has(userId);
}
