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

import { handleButton, handleSelectMenu, handleModalSubmit } from "../handlers/buttonHandler.js";

function mockInteraction(customId: string) {
  return {
    customId,
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    message: { id: "msg_1" },
    channel: { id: "channel-1", isThread: () => false },
  } as any;
}

function mockSelectInteraction(customId: string, values: string[]) {
  return {
    customId,
    values,
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { id: "msg_1" },
    channel: { id: "channel-1", isThread: () => false },
  } as any;
}

function mockModalInteraction(customId: string, answer: string) {
  return {
    customId,
    fields: { getTextInputValue: vi.fn().mockReturnValue(answer) },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { id: "msg_1" },
    channel: { id: "channel-1", isThread: () => false },
  } as any;
}

describe("handleButton question responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers a single-select question with one question (auto-submit)", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_abc",
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

    const interaction = mockInteraction("qanswer:thread123:que_abc:0:0");
    await handleButton(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_abc", [
      ["Approve plan"],
    ]);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "✅ All questions answered.",
      flags: 64,
    });
  });

  it("rejects OpenCode questions", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_abc",
        sessionID: "ses_123",
        questions: [],
      },
    ]);
    sessionManagerMock.rejectQuestion.mockResolvedValue(true);

    const interaction = mockInteraction("qreject:thread123:que_abc");
    await handleButton(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(sessionManagerMock.rejectQuestion).toHaveBeenCalledWith(14098, "que_abc");
  });

  it("handles multi-question single-select: answers progressively, submits when done", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_xyz",
        sessionID: "ses_123",
        questions: [
          {
            question: "Choose framework?",
            options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }],
          },
          {
            header: "Styling",
            question: "Choose styling approach?",
            options: [{ label: "CSS" }, { label: "Tailwind" }],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const q1Interaction = mockInteraction("qanswer:thread123:que_xyz:0:1");
    await handleButton(q1Interaction);
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();
    expect(q1Interaction.deferUpdate).toHaveBeenCalled();
    expect(q1Interaction.followUp).toHaveBeenCalledWith({
      content: "✅ Q1 answered: Vue",
      flags: 64,
    });

    const q2Interaction = mockInteraction("qanswer:thread123:que_xyz:1:0");
    await handleButton(q2Interaction);
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_xyz", [
      ["Vue"],
      ["CSS"],
    ]);
  });

  it("handles multi-select toggle: toggle in, then submit", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_multi",
        sessionID: "ses_123",
        questions: [
          {
            question: "Select toppings?",
            multiple: true,
            options: [
              { label: "Cheese" },
              { label: "Pepperoni" },
              { label: "Mushrooms" },
            ],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const toggle1 = mockInteraction("qtoggle:thread123:que_multi:0:0");
    await handleButton(toggle1);
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();
    expect(toggle1.deferUpdate).toHaveBeenCalled();

    const toggle2 = mockInteraction("qtoggle:thread123:que_multi:0:2");
    await handleButton(toggle2);
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();

    const submit = mockInteraction("qsubmit:thread123:que_multi");
    await handleButton(submit);
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_multi", [
      ["Cheese", "Mushrooms"],
    ]);
  });

  it("handles select menu interaction for single-select", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_select",
        sessionID: "ses_123",
        questions: [
          {
            question: "Pick one?",
            options: [
              { label: "Option A" },
              { label: "Option B" },
              { label: "Option C" },
            ],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockSelectInteraction("qselect:thread123:que_select:0", ["1"]);
    await handleSelectMenu(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_select", [
      ["Option B"],
    ]);
  });

  it("handles select menu interaction for multi-select", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_multi_select",
        sessionID: "ses_123",
        questions: [
          {
            question: "Pick multiple?",
            multiple: true,
            options: [
              { label: "Alpha" },
              { label: "Beta" },
              { label: "Gamma" },
            ],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockSelectInteraction("qselect:thread123:que_multi_select:0", [
      "0",
      "2",
    ]);
    await handleSelectMenu(interaction);

    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(
      14098,
      "que_multi_select",
      [["Alpha", "Gamma"]],
    );
  });

  it("rejects cross-session question access", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_expected",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_wrong_ses",
        sessionID: "ses_other",
        questions: [
          {
            question: "Should not reach?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    ]);

    const interaction = mockInteraction("qanswer:thread123:que_wrong_ses:0:0");
    await handleButton(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("belongs to another session"),
    });
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();
  });

  it("prevents submit when not all questions have answers", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_two",
        sessionID: "ses_123",
        questions: [
          {
            question: "Q1?",
            options: [{ label: "A" }, { label: "B" }],
          },
          {
            question: "Q2?",
            options: [{ label: "C" }, { label: "D" }],
          },
        ],
      },
    ]);

    const submit = mockInteraction("qsubmit:thread123:que_two");
    await handleButton(submit);

    expect(submit.deferUpdate).toHaveBeenCalled();
    expect(submit.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("Not all questions have an answer"),
    });
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();
  });

  it("handles custom answer via modal submit", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_custom",
        sessionID: "ses_123",
        questions: [
          {
            question: "Type your answer?",
            options: [{ label: "Option" }],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockModalInteraction("qcustomModal:thread123:que_custom:0", "My custom answer");
    await handleModalSubmit(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_custom", [
      ["My custom answer"],
    ]);
  });

  it("handles custom answer button by showing a modal", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_custom_btn",
        sessionID: "ses_123",
        questions: [
          {
            question: "Say something?",
            options: [],
          },
        ],
      },
    ]);

    const interaction = mockInteraction("qcustom:thread123:que_custom_btn:0");
    await handleButton(interaction);

    expect(interaction.showModal).toHaveBeenCalled();
  });

  it("returns error for invalid button customId", async () => {
    const interaction = mockInteraction("qanswer:thread123:que_abc:notanumber:0");
    await handleButton(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "❌ Invalid question response.",
      flags: 64,
    });
  });

  it("returns error when session not found", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue(undefined);
    const interaction = mockInteraction("qanswer:thread123:que_abc:0:0");
    await handleButton(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "⚠️ Session not found.",
      flags: 64,
    });
  });
});
