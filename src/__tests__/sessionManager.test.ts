import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const dataStoreMock = vi.hoisted(() => {
  const threadSessions = new Map<
    string,
    {
      threadId: string;
      sessionId: string;
      projectPath: string;
      port: number;
      createdAt: number;
      lastUsedAt: number;
    }
  >();

  return {
    reset: () => threadSessions.clear(),
    getThreadSession: vi.fn((threadId: string) => threadSessions.get(threadId)),
    setThreadSession: vi.fn(
      (session: {
        threadId: string;
        sessionId: string;
        projectPath: string;
        port: number;
        createdAt: number;
        lastUsedAt: number;
      }) => {
        threadSessions.set(session.threadId, session);
      },
    ),
    updateThreadSessionLastUsed: vi.fn((threadId: string) => {
      const session = threadSessions.get(threadId);
      if (session) {
        session.lastUsedAt = Date.now();
      }
    }),
    clearThreadSession: vi.fn((threadId: string) => {
      threadSessions.delete(threadId);
    }),
  };
});

vi.mock("../services/dataStore.js", () => ({
  getThreadSession: dataStoreMock.getThreadSession,
  setThreadSession: dataStoreMock.setThreadSession,
  updateThreadSessionLastUsed: dataStoreMock.updateThreadSessionLastUsed,
  clearThreadSession: dataStoreMock.clearThreadSession,
}));

import {
  createSession,
  sendPrompt,
  ensureSessionForThread,
  getSessionForThread,
  setSessionForThread,
  clearSessionForThread,
  setSseClient,
  getSseClient,
  clearSseClient,
} from "../services/sessionManager.js";
import { SSEClient } from "../services/sseClient.js";

describe("SessionManager", () => {
  const mockFetch = vi.fn();
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const originalUsername = process.env.OPENCODE_SERVER_USERNAME;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    dataStoreMock.reset();
    vi.clearAllMocks();
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalPassword === undefined)
      delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
    if (originalUsername === undefined)
      delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = originalUsername;
  });

  describe("createSession", () => {
    it("should create a session via HTTP POST and return sessionId", async () => {
      const mockSessionId = "ses_abc123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: mockSessionId, slug: "test-session" }),
      });

      const sessionId = await createSession(3000);

      expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:3000/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(sessionId).toBe(mockSessionId);
    });

    it("should throw error if HTTP request fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(createSession(3000)).rejects.toThrow(
        "Failed to create session: 500 Internal Server Error",
      );
    });

    it("should throw error if response is missing id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: "test-session" }),
      });

      await expect(createSession(3000)).rejects.toThrow(
        "Invalid session response: missing id",
      );
    });
  });

  describe("sendPrompt", () => {
    it("should send prompt via HTTP POST with correct payload", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await sendPrompt(3000, "ses_abc123", "Hello OpenCode");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/session/ses_abc123/prompt_async",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "Hello OpenCode" }],
          }),
        },
      );
    });

    it("should include model in payload when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await sendPrompt(
        3000,
        "ses_abc123",
        "Hello OpenCode",
        "llm-proxy/ant_gemini-3-flash",
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/session/ses_abc123/prompt_async",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "Hello OpenCode" }],
            model: { providerID: "llm-proxy", modelID: "ant_gemini-3-flash" },
          }),
        },
      );
    });

    it("should throw error if HTTP request fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Not Found",
      });

      await expect(sendPrompt(3000, "ses_invalid", "test")).rejects.toThrow(
        "Failed to send prompt: 404 Not Found — Not Found",
      );
    });
  });

  describe("thread-session mapping", () => {
    it("should store and retrieve session for thread", () => {
      setSessionForThread("thread1", "ses_123", "/path/to/project", 4000);

      const result = getSessionForThread("thread1");

      expect(result).toEqual({
        sessionId: "ses_123",
        projectPath: "/path/to/project",
        port: 4000,
      });
    });

    it("should return undefined for unknown thread", () => {
      const result = getSessionForThread("unknown_thread");

      expect(result).toBeUndefined();
    });

    it("should clear session for thread", () => {
      setSessionForThread("thread2", "ses_456", "/path/to/project2", 4001);

      clearSessionForThread("thread2");

      const result = getSessionForThread("thread2");
      expect(result).toBeUndefined();
    });

    it("should overwrite existing session for thread", () => {
      setSessionForThread("thread3", "ses_old", "/path/to/old", 4002);
      setSessionForThread("thread3", "ses_new", "/path/to/new", 4003);

      const result = getSessionForThread("thread3");

      expect(result).toEqual({
        sessionId: "ses_new",
        projectPath: "/path/to/new",
        port: 4003,
      });
    });

    it("should preserve createdAt when updating an existing thread session", () => {
      setSessionForThread("thread4", "ses_original", "/path/to/project", 4004);
      const original = dataStoreMock.getThreadSession("thread4");

      setSessionForThread("thread4", "ses_original", "/path/to/project", 4005);

      const updated = dataStoreMock.getThreadSession("thread4");
      expect(updated?.createdAt).toBe(original?.createdAt);
      expect(updated?.port).toBe(4005);
    });
  });

  describe("ensureSessionForThread", () => {
    it("should reuse and refresh an existing valid session", async () => {
      setSessionForThread("thread5", "ses_valid", "/path/to/project", 4000);
      const original = dataStoreMock.getThreadSession("thread5");

      mockFetch.mockResolvedValueOnce({ ok: true });

      const sessionId = await ensureSessionForThread(
        "thread5",
        "/path/to/project",
        4010,
      );

      const updated = dataStoreMock.getThreadSession("thread5");
      expect(sessionId).toBe("ses_valid");
      expect(updated?.sessionId).toBe("ses_valid");
      expect(updated?.port).toBe(4010);
      expect(updated?.createdAt).toBe(original?.createdAt);
    });

    it("should create and persist a new session when the stored one is invalid", async () => {
      setSessionForThread("thread6", "ses_stale", "/path/to/project", 4000);
      const original = dataStoreMock.getThreadSession("thread6");

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: "ses_new" }),
        });

      const sessionId = await ensureSessionForThread(
        "thread6",
        "/path/to/project",
        4011,
      );

      const updated = dataStoreMock.getThreadSession("thread6");
      expect(sessionId).toBe("ses_new");
      expect(updated?.sessionId).toBe("ses_new");
      expect(updated?.port).toBe(4011);
      expect(updated?.createdAt).toBe(original?.createdAt);
    });

    it("should create a new session when the stored project path no longer matches", async () => {
      setSessionForThread("thread7", "ses_old", "/path/to/old", 4000);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ses_project_new" }),
      });

      const sessionId = await ensureSessionForThread(
        "thread7",
        "/path/to/new",
        4012,
      );

      const updated = dataStoreMock.getThreadSession("thread7");
      expect(sessionId).toBe("ses_project_new");
      expect(updated?.sessionId).toBe("ses_project_new");
      expect(updated?.projectPath).toBe("/path/to/new");
      expect(updated?.port).toBe(4012);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("SSEClient management", () => {
    it("should store and retrieve SSEClient for thread", () => {
      const mockClient = new SSEClient();

      setSseClient("thread1", mockClient);

      const result = getSseClient("thread1");

      expect(result).toBe(mockClient);
    });

    it("should return undefined for unknown thread", () => {
      const result = getSseClient("unknown_thread");

      expect(result).toBeUndefined();
    });

    it("should clear SSEClient for thread", () => {
      const mockClient = new SSEClient();
      setSseClient("thread2", mockClient);

      clearSseClient("thread2");

      const result = getSseClient("thread2");
      expect(result).toBeUndefined();
    });

    it("should overwrite existing SSEClient for thread", () => {
      const mockClient1 = new SSEClient();
      const mockClient2 = new SSEClient();

      setSseClient("thread3", mockClient1);
      setSseClient("thread3", mockClient2);

      const result = getSseClient("thread3");

      expect(result).toBe(mockClient2);
    });
  });

  describe("integration", () => {
    it("should manage both session and SSEClient independently", () => {
      const mockClient = new SSEClient();

      setSessionForThread("thread1", "ses_123", "/path/to/project", 4000);
      setSseClient("thread1", mockClient);

      expect(getSessionForThread("thread1")).toEqual({
        sessionId: "ses_123",
        projectPath: "/path/to/project",
        port: 4000,
      });
      expect(getSseClient("thread1")).toBe(mockClient);

      clearSessionForThread("thread1");

      expect(getSessionForThread("thread1")).toBeUndefined();
      expect(getSseClient("thread1")).toBe(mockClient); // SSEClient still exists

      clearSseClient("thread1");

      expect(getSseClient("thread1")).toBeUndefined();
    });
  });

  describe("OPENCODE_SERVER_PASSWORD auth", () => {
    it("does not send Authorization header when env is unset (current behavior)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ses_new" }),
      });

      await createSession(3000);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      expect(
        (init.headers as Record<string, string>).Authorization,
      ).toBeUndefined();
    });

    it("sends a Basic Authorization header on createSession when password is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "s3cret";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ses_new" }),
      });

      await createSession(3000);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const expected = `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        expected,
      );
    });

    it("uses OPENCODE_SERVER_USERNAME in the Basic token when provided", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "s3cret";
      process.env.OPENCODE_SERVER_USERNAME = "alice";
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      await sendPrompt(3000, "ses_abc", "hi");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        expected,
      );
    });

    it("throws a clear credential-mismatch error on 401 when password is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "wrong";
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(createSession(3000)).rejects.toThrow(
        /rejected credentials/i,
      );
    });

    it("throws a clear missing-password error on 401 when password is unset", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(createSession(3000)).rejects.toThrow(
        /OPENCODE_SERVER_PASSWORD is not set/i,
      );
    });
  });
});
