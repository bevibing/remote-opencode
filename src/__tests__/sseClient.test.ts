import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockEventSourceInstance = {
  addEventListener: vi.fn(),
  close: vi.fn(),
  readyState: 1,
};

vi.mock("eventsource", () => {
  const EventSourceMock: any = vi.fn().mockImplementation(function () {
    return mockEventSourceInstance;
  });
  EventSourceMock.OPEN = 1;
  EventSourceMock.CLOSED = 2;
  EventSourceMock.CONNECTING = 0;

  return {
    EventSource: EventSourceMock,
  };
});

import { SSEClient } from "../services/sseClient.js";
import { EventSource } from "eventsource";

const MockEventSource = EventSource as unknown as ReturnType<typeof vi.fn>;

describe("SSEClient", () => {
  let client: SSEClient;
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const originalUsername = process.env.OPENCODE_SERVER_USERNAME;

  beforeEach(() => {
    mockEventSourceInstance.addEventListener = vi.fn();
    mockEventSourceInstance.close = vi.fn();
    mockEventSourceInstance.readyState = 1;
    MockEventSource.mockClear();
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    client = new SSEClient();
  });

  afterEach(() => {
    client.disconnect();
    if (originalPassword === undefined)
      delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
    if (originalUsername === undefined)
      delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = originalUsername;
  });

  describe("connect", () => {
    it("should connect to SSE endpoint", () => {
      client.connect("http://127.0.0.1:3000");

      expect(MockEventSource).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/event",
        undefined,
      );
    });

    it("should set up message event listener", () => {
      client.connect("http://127.0.0.1:3000");

      expect(mockEventSourceInstance.addEventListener).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    });

    it("should set up error event listener", () => {
      client.connect("http://127.0.0.1:3000");

      expect(mockEventSourceInstance.addEventListener).toHaveBeenCalledWith(
        "error",
        expect.any(Function),
      );
    });
  });

  describe("onPartUpdated", () => {
    it("should trigger callback for text part updates", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onPartUpdated(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              id: "part-1",
              sessionID: "session-1",
              messageID: "msg-1",
              text: "Hello, world!",
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        text: "Hello, world!",
      });
    });

    it("should not trigger callback for non-text parts", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onPartUpdated(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              id: "part-1",
              sessionID: "session-1",
              messageID: "msg-1",
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it("should not trigger callback for non-part-updated events", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onPartUpdated(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "other.event",
          properties: {},
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("onSessionIdle", () => {
    it("should trigger callback for session.idle events", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onSessionIdle(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith("session-1");
    });

    it("should not trigger callback for non-idle events", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onSessionIdle(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "other.event",
          properties: {},
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("onSessionError", () => {
    it("should trigger callback for session.error events with ProviderAuthError", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onSessionError(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "session.error",
          properties: {
            sessionID: "session-1",
            error: {
              name: "ProviderAuthError",
              data: {
                message: "Invalid model ID",
                providerID: "ollama",
              },
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith("session-1", {
        name: "ProviderAuthError",
        data: {
          message: "Invalid model ID",
          providerID: "ollama",
        },
      });
    });

    it("should trigger callback for session.error events with UnknownError", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onSessionError(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "session.error",
          properties: {
            sessionID: "session-2",
            error: {
              name: "UnknownError",
              data: {
                message: "Rate limit exceeded",
              },
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith("session-2", {
        name: "UnknownError",
        data: {
          message: "Rate limit exceeded",
        },
      });
    });

    it("should not trigger callback when error property is missing", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onSessionError(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "session.error",
          properties: {
            sessionID: "session-1",
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it("should not trigger callback for non-error events", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onSessionError(callback);

      const messageHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "message",
        )?.[1];

      const event = {
        data: JSON.stringify({
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("onError", () => {
    it("should trigger callback on error", () => {
      const callback = vi.fn();
      client.connect("http://127.0.0.1:3000");
      client.onError(callback);

      const errorHandler =
        mockEventSourceInstance.addEventListener.mock.calls.find(
          (call: any) => call[0] === "error",
        )?.[1];

      const error = new Error("Connection failed");
      errorHandler(error);

      expect(callback).toHaveBeenCalledWith(error);
    });
  });

  describe("disconnect", () => {
    it("should close the connection", () => {
      client.connect("http://127.0.0.1:3000");
      client.disconnect();

      expect(mockEventSourceInstance.close).toHaveBeenCalled();
    });

    it("should handle disconnect when not connected", () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe("isConnected", () => {
    it("should return true when connected", () => {
      client.connect("http://127.0.0.1:3000");
      mockEventSourceInstance.readyState = 1;

      expect(client.isConnected()).toBe(true);
    });

    it("should return false when disconnected", () => {
      client.connect("http://127.0.0.1:3000");
      mockEventSourceInstance.readyState = 2;

      expect(client.isConnected()).toBe(false);
    });

    it("should return false when not initialized", () => {
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("OPENCODE_SERVER_PASSWORD auth", () => {
    it("does not pass a custom fetch when password is unset (current behavior)", () => {
      client.connect("http://127.0.0.1:3000");

      expect(MockEventSource).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/event",
        undefined,
      );
    });

    it("injects a Basic Authorization header via custom fetch when password is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "s3cret";

      client.connect("http://127.0.0.1:3000");

      expect(MockEventSource).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/event",
        expect.objectContaining({ fetch: expect.any(Function) }),
      );

      // Verify the injected fetch actually forwards the Authorization header.
      const [, init] = MockEventSource.mock.calls[0] as [
        string,
        { fetch: typeof fetch },
      ];
      const underlyingFetch = vi
        .fn()
        .mockResolvedValue({ ok: true } as Response);
      vi.stubGlobal("fetch", underlyingFetch);
      await init.fetch("http://127.0.0.1:3000/event", { method: "GET" });
      vi.unstubAllGlobals();

      const expected = `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`;
      const call = underlyingFetch.mock.calls[0] as [string, RequestInit];
      expect((call[1].headers as Record<string, string>).Authorization).toBe(
        expected,
      );
    });

    it("uses OPENCODE_SERVER_USERNAME in the Basic token when provided", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "s3cret";
      process.env.OPENCODE_SERVER_USERNAME = "alice";

      client.connect("http://127.0.0.1:3000");

      const [, init] = MockEventSource.mock.calls[0] as [
        string,
        { fetch: typeof fetch },
      ];
      const underlyingFetch = vi
        .fn()
        .mockResolvedValue({ ok: true } as Response);
      vi.stubGlobal("fetch", underlyingFetch);
      await init.fetch("http://127.0.0.1:3000/event", {});
      vi.unstubAllGlobals();

      const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
      const call = underlyingFetch.mock.calls[0] as [string, RequestInit];
      expect((call[1].headers as Record<string, string>).Authorization).toBe(
        expected,
      );
    });
  });
});
