import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callbacks: {
    partUpdated: undefined as ((part: any) => void) | undefined,
    sessionIdle: undefined as ((sessionId: string) => void) | undefined,
    sessionError: undefined as ((sessionId: string, error: any) => void) | undefined,
    error: undefined as ((error: Error) => void) | undefined,
  },
  dataStore: {
    getChannelProjectPath: vi.fn(() => "/project"),
    getWorktreeMapping: vi.fn(() => undefined),
    getChannelBinding: vi.fn(() => undefined),
    getProjectAutoWorktree: vi.fn(() => false),
    getChannelModel: vi.fn(() => undefined),
    getQueueSettings: vi.fn(() => ({
      freshContext: false,
      continueOnFailure: false,
    })),
    clearQueue: vi.fn(),
  },
  sessionManager: {
    clearSessionForThread: vi.fn(),
    ensureSessionForThread: vi.fn(async () => "ses-test"),
    setSseClient: vi.fn(),
    getSseClient: vi.fn(),
    clearSseClient: vi.fn(),
    sendPrompt: vi.fn(),
  },
  serveManager: {
    spawnServe: vi.fn(async () => 14097),
    waitForReady: vi.fn(async () => "api"),
  },
  worktreeManager: {
    getCurrentBranch: vi.fn(async () => "main"),
  },
  sseClient: {
    connect: vi.fn(),
    onPartUpdated: vi.fn((callback) => {
      mocks.callbacks.partUpdated = callback;
    }),
    onSessionIdle: vi.fn((callback) => {
      mocks.callbacks.sessionIdle = callback;
    }),
    onSessionError: vi.fn((callback) => {
      mocks.callbacks.sessionError = callback;
    }),
    onError: vi.fn((callback) => {
      mocks.callbacks.error = callback;
    }),
    disconnect: vi.fn(),
  },
}));

vi.mock("../services/dataStore.js", () => mocks.dataStore);
vi.mock("../services/sessionManager.js", () => mocks.sessionManager);
vi.mock("../services/serveManager.js", () => mocks.serveManager);
vi.mock("../services/worktreeManager.js", () => mocks.worktreeManager);
vi.mock("../services/queueManager.js", () => ({
  processNextInQueue: vi.fn(),
}));
vi.mock("../services/sseClient.js", () => ({
  SSEClient: vi.fn(function () {
    return mocks.sseClient;
  }),
}));
vi.mock("../utils/messageFormatter.js", () => ({
  formatOutput: vi.fn((text: string) => text),
  formatOutputForMobile: vi.fn((text: string) => ({ chunks: [text] })),
  buildContextHeader: vi.fn(() => "main"),
}));

import { runPrompt } from "../services/executionService.js";

describe("runPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callbacks.partUpdated = undefined;
    mocks.callbacks.sessionIdle = undefined;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(1 as any);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles session idle emitted before prompt request resolves", async () => {
    const streamMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const channel = { send: vi.fn().mockResolvedValue(streamMessage) };
    mocks.sessionManager.sendPrompt.mockImplementation(async () => {
      mocks.callbacks.partUpdated?.({
        id: "part-1",
        sessionID: "ses-test",
        messageID: "msg-1",
        text: "Hi",
      });
      mocks.callbacks.sessionIdle?.("ses-test");
    });

    await runPrompt(channel as any, "thread-1", "hi", "parent-1");

    expect(mocks.sessionManager.sendPrompt).toHaveBeenCalled();
    expect(mocks.callbacks.sessionIdle).toBeTypeOf("function");
    await vi.waitFor(() =>
      expect(channel.send).toHaveBeenCalledWith({ content: "✅ Done" }),
    );
  });
});
