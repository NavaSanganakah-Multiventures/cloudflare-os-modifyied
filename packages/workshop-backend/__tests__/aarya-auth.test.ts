import { describe, expect, it } from "vitest";
import {
  authorizedMemberIds,
  isAuthorizedMember,
  mintAaryaToken,
  verifyAaryaToken,
} from "../src/aarya/aarya-auth";
import type { AaryaAuthEnv } from "../src/aarya/aarya-auth";

const env: AaryaAuthEnv = {
  AARYA_SIGNING_SECRET: "test-secret-that-is-long-enough",
  AARYA_AUTHORIZED_MEMBERS: "alice,bob",
};

describe("aarya-auth", () => {
  it("mints and verifies a token, carrying the subject, name and call", async () => {
    const token = await mintAaryaToken({ sub: "alice", name: "Alice", call: "room-1" }, env);
    const claims = await verifyAaryaToken(token, env);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("alice");
    expect(claims?.name).toBe("Alice");
    expect(claims?.call).toBe("room-1");
  });

  it("rejects tampered tokens, unknown secrets and missing secrets", async () => {
    const token = await mintAaryaToken({ sub: "alice", name: "Alice", call: "room-1" }, env);
    expect(await verifyAaryaToken(token + "x", env)).toBeNull();
    expect(
      await verifyAaryaToken(token, { AARYA_SIGNING_SECRET: "some-other-secret" }),
    ).toBeNull();
    expect(await verifyAaryaToken(null, env)).toBeNull();
    expect(await verifyAaryaToken(token, { AARYA_SIGNING_SECRET: undefined })).toBeNull();
  });

  it("enforces the authorized-member allowlist", () => {
    expect(authorizedMemberIds(env)).toEqual(new Set(["alice", "bob"]));
    expect(isAuthorizedMember("alice", env)).toBe(true);
    expect(isAuthorizedMember("eve", env)).toBe(false);
    expect(isAuthorizedMember(undefined, env)).toBe(false);
    // With no allowlist configured, any signed token's subject is accepted.
    expect(isAuthorizedMember("eve", {})).toBe(true);
  });
});
