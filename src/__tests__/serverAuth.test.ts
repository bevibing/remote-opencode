import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("serverAuth", () => {
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const originalUsername = process.env.OPENCODE_SERVER_USERNAME;

  beforeEach(() => {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalPassword === undefined)
      delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
    if (originalUsername === undefined)
      delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = originalUsername;
  });

  describe("when OPENCODE_SERVER_PASSWORD is not set (current behavior)", () => {
    it("reports auth disabled", async () => {
      const mod = await import("../services/serverAuth.js");
      expect(mod.isAuthEnabled()).toBe(false);
      expect(mod.getAuthToken()).toBeUndefined();
      expect(mod.getAuthHeaders()).toEqual({});
    });

    it("assertNotAuthError is a no-op for non-auth statuses", async () => {
      const mod = await import("../services/serverAuth.js");
      expect(() => mod.assertNotAuthError(200, "ctx")).not.toThrow();
      expect(() => mod.assertNotAuthError(404, "ctx")).not.toThrow();
      expect(() => mod.assertNotAuthError(500, "ctx")).not.toThrow();
    });

    it("assertNotAuthError throws a helpful error when server demands auth but env is not set", async () => {
      const mod = await import("../services/serverAuth.js");
      expect(() =>
        mod.assertNotAuthError(401, "Failed to create session"),
      ).toThrow(/OPENCODE_SERVER_PASSWORD is not set/i);
    });

    it("treats an empty OPENCODE_SERVER_PASSWORD as disabled", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "";
      const mod = await import("../services/serverAuth.js");
      expect(mod.isAuthEnabled()).toBe(false);
    });
  });

  describe("when OPENCODE_SERVER_PASSWORD is set", () => {
    beforeEach(() => {
      process.env.OPENCODE_SERVER_PASSWORD = "s3cret";
    });

    it("reports auth enabled and builds a Basic token with the default username", async () => {
      const mod = await import("../services/serverAuth.js");
      expect(mod.isAuthEnabled()).toBe(true);

      const expected = Buffer.from("opencode:s3cret").toString("base64");
      expect(mod.getAuthToken()).toBe(expected);
      expect(mod.getAuthHeaders()).toEqual({
        Authorization: `Basic ${expected}`,
      });
    });

    it("uses OPENCODE_SERVER_USERNAME when provided", async () => {
      process.env.OPENCODE_SERVER_USERNAME = "alice";
      const mod = await import("../services/serverAuth.js");

      const expected = Buffer.from("alice:s3cret").toString("base64");
      expect(mod.getAuthToken()).toBe(expected);
      expect(mod.getAuthHeaders()).toEqual({
        Authorization: `Basic ${expected}`,
      });
    });

    it("falls back to the default username when OPENCODE_SERVER_USERNAME is empty", async () => {
      process.env.OPENCODE_SERVER_USERNAME = "";
      const mod = await import("../services/serverAuth.js");

      const expected = Buffer.from("opencode:s3cret").toString("base64");
      expect(mod.getAuthToken()).toBe(expected);
    });

    it("assertNotAuthError surfaces a credential-mismatch error on 401", async () => {
      const mod = await import("../services/serverAuth.js");
      expect(() =>
        mod.assertNotAuthError(401, "Failed to create session"),
      ).toThrow(/rejected credentials/i);
    });

    it("assertNotAuthError also surfaces 403 as a credential error", async () => {
      const mod = await import("../services/serverAuth.js");
      expect(() =>
        mod.assertNotAuthError(403, "Failed to send prompt"),
      ).toThrow(/rejected credentials/i);
    });
  });
});
