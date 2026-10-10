import { describe, it, expect } from "vitest";
import { selectNewMessages, lastSyncedMessageId } from "../services/sessionSync.js";
import type { SessionMessage } from "../services/sessionManager.js";

function msg(id: string, text = id): SessionMessage {
  return { id, role: "assistant", text };
}

describe("sessionSync.selectNewMessages", () => {
  const messages = [msg("m1"), msg("m2"), msg("m3")];

  it("returns everything when there is no cursor", () => {
    expect(selectNewMessages(messages, undefined)).toEqual(messages);
  });

  it("returns only messages after the cursor", () => {
    expect(selectNewMessages(messages, "m2")).toEqual([msg("m3")]);
  });

  it("returns nothing when the cursor is the last message", () => {
    expect(selectNewMessages(messages, "m3")).toEqual([]);
  });

  it("falls back to everything when the cursor is unknown", () => {
    expect(selectNewMessages(messages, "missing")).toEqual(messages);
  });

  it("handles an empty session", () => {
    expect(selectNewMessages([], "m1")).toEqual([]);
  });
});

describe("sessionSync.lastSyncedMessageId", () => {
  it("returns the last message with text", () => {
    expect(lastSyncedMessageId([msg("m1"), msg("m2")])).toBe("m2");
  });

  it("skips a trailing empty message so it is not lost", () => {
    expect(lastSyncedMessageId([msg("m1"), msg("m2"), msg("m3", "")])).toBe("m2");
  });

  it("returns undefined when every message is empty", () => {
    expect(lastSyncedMessageId([msg("m1", "  ")])).toBeUndefined();
  });

  it("returns undefined for an empty session", () => {
    expect(lastSyncedMessageId([])).toBeUndefined();
  });
});
