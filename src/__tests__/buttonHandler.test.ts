import { describe, it, expect, vi, beforeEach } from "vitest";

const sessionManagerMock = vi.hoisted(() => ({
  getSessionForThread: vi.fn(),
  listQuestions: vi.fn(),
  replyQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  abortSession: vi.fn(),
  ensureSessionForThread: vi.fn(),
  sendPrompt: vi.fn(),
}));

vi.mock("../services/sessionManager.js", () => sessionManagerMock);
vi.mock("../services/serveManager.js", () => ({
  getPort: vi.fn(),
  spawnServe: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("../services/dataStore.js", () => ({
  getChannelModel: vi.fn(),
  getWorktreeMapping: vi.fn(),
  removeWorktreeMapping: vi.fn(),
}));
vi.mock("../services/worktreeManager.js", () => ({
  worktreeExists: vi.fn(),
  removeWorktree: vi.fn(),
}));

import { handleButton } from "../handlers/buttonHandler.js";

function mockInteraction(customId: string) {
  return {
    customId,
    reply: vi.fn(),
    deferReply: vi.fn(),
    editReply: vi.fn(),
    channel: { id: "channel-1", isThread: () => false },
  } as any;
}

describe("handleButton question responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers OpenCode questions with the selected option", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_dfcfdc0e70013EvGpyc0soVaR7",
        sessionID: "ses_123",
        questions: [
          {
            question: "Approve this plan?",
            options: [{ label: "Approve plan" }, { label: "Revise plan" }],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockInteraction(
      "qanswer:thread123:que_dfcfdc0e70013EvGpyc0soVaR7:0",
    );

    await handleButton(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(
      14098,
      "que_dfcfdc0e70013EvGpyc0soVaR7",
      [["Approve plan"]],
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "✅ Sent response: Approve plan",
    });
  });

  it("rejects OpenCode questions", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.rejectQuestion.mockResolvedValue(true);

    const interaction = mockInteraction(
      "qreject:thread123:que_dfcfdc0e70013EvGpyc0soVaR7",
    );

    await handleButton(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(sessionManagerMock.rejectQuestion).toHaveBeenCalledWith(
      14098,
      "que_dfcfdc0e70013EvGpyc0soVaR7",
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "🚫 Question rejected.",
    });
  });
});
