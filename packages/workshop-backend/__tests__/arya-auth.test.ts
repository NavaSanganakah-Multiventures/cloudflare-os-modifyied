import { describe, expect, it } from "vitest";
import {
  authorizedMemberIds,
  isAuthorizedMember,
  mintAryaToken,
  verifyAryaToken,
} from "../src/arya/arya-auth";
import type { AryaAuthEnv } from "../src/arya/arya-auth";

const env: AryaAuthEnv = {
  ARYA_SIGNING_SECRET: "test-secret-that-is-long-enough",
  ARYA_AUTHORIZED_MEMBERS: "alice,bob",
};

describe("arya-auth", () => {
  it("mints and verifies a token, carrying the subject, name and call", async () => {
    const token = await mintAryaToken({ sub: "alice", name: "Alice", call: "room-1" }, env);
    const claims = await verifyAryaToken(token, env);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("alice");
    expect(claims?.name).toBe("Alice");
    expect(claims?.call).toBe("room-1");
  });

  it("rejects tampered tokens, unknown secrets and missing secrets", async () => {
    const token = await mintAryaToken({ sub: "alice", name: "Alice", call: "room-1" }, env);
    expect(await verifyAryaToken(token + "x", env)).toBeNull();
    expect(
      await verifyAryaToken(token, { ARYA_SIGNING_SECRET: "some-other-secret" }),
    ).toBeNull();
    expect(await verifyAryaToken(null, env)).toBeNull();
    expect(await verifyAryaToken(token, { ARYA_SIGNING_SECRET: undefined })).toBeNull();
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
