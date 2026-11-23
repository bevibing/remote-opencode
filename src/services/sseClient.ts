import { EventSource } from "eventsource";
import type { TextPart, SSEEvent, SessionErrorInfo } from "../types/index.js";
import { getAuthHeaders } from "./serverAuth.js";
import type { ApiFamily } from "./serveManager.js";

type PartUpdatedCallback = (part: TextPart) => void;
type SessionIdleCallback = (sessionId: string) => void;
type SessionErrorCallback = (
  sessionId: string,
  error: SessionErrorInfo,
) => void;
type ErrorCallback = (error: Error) => void;

export class SSEClient {
  private eventSource: EventSource | null = null;
  private partUpdatedCallbacks: PartUpdatedCallback[] = [];
  private sessionIdleCallbacks: SessionIdleCallback[] = [];
  private sessionErrorCallbacks: SessionErrorCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private textByMessage = new Map<string, string>();

  connect(baseUrl: string, apiFamily: ApiFamily = "legacy"): void {
    const url = `${baseUrl}${apiFamily === "api" ? "/api/event" : "/event"}`;
    // When OPENCODE_SERVER_PASSWORD is set, forward the same Basic auth
    // header we use for regular HTTP requests. The `eventsource` package
    // allows overriding the underlying fetch so we can inject headers —
    // EventSource itself does not accept headers directly.
    const authHeaders = getAuthHeaders();
    const init: ConstructorParameters<typeof EventSource>[1] =
      Object.keys(authHeaders).length > 0
        ? {
            fetch: (input, fetchInit) =>
              fetch(input, {
                ...fetchInit,
                headers: { ...fetchInit?.headers, ...authHeaders },
              }),
          }
        : undefined;
    this.eventSource = new EventSource(url, init);

    const handleEvent = (event: MessageEvent, eventType?: string): void => {
      try {
        const data = JSON.parse(event.data) as Partial<SSEEvent>;
        this.handleMessage({
          ...data,
          type: data.type ?? eventType ?? "",
        } as SSEEvent);
      } catch (error) {
        this.handleError(new Error(`Failed to parse SSE event: ${error}`));
      }
    };

    this.eventSource.addEventListener("message", handleEvent);
    if (apiFamily === "api") {
      for (const eventType of [
        "session.text.delta",
        "session.idle",
        "session.execution.succeeded",
        "session.error",
      ]) {
        this.eventSource.addEventListener(eventType, (event: MessageEvent) =>
          handleEvent(event, eventType),
        );
      }
    }

    this.eventSource.addEventListener("error", (error: Event) => {
      this.handleError(
        error instanceof Error ? error : new Error("SSE connection error"),
      );
    });
  }

  onPartUpdated(callback: PartUpdatedCallback): void {
    this.partUpdatedCallbacks.push(callback);
  }

  onSessionIdle(callback: SessionIdleCallback): void {
    this.sessionIdleCallbacks.push(callback);
  }

  onSessionError(callback: SessionErrorCallback): void {
    this.sessionErrorCallbacks.push(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  isConnected(): boolean {
    return (
      this.eventSource !== null &&
      this.eventSource.readyState === EventSource.OPEN
    );
  }

  private handleMessage(event: SSEEvent): void {
    const properties = event.properties ?? event.data ?? {};
    if (event.type === "message.part.updated") {
      const part = (properties as any).part;
      if (part && part.type === "text") {
        const textPart: TextPart = {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          text: part.text,
        };
        this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
      }
    } else if (
      event.type === "session.idle" ||
      event.type === "session.execution.succeeded"
    ) {
      const sessionID = (properties as any).sessionID;
      if (sessionID) {
        this.sessionIdleCallbacks.forEach((cb) => cb(sessionID));
      }
    } else if (event.type === "session.text.delta") {
      const sessionID = (properties as any).sessionID;
      const messageID = (properties as any).assistantMessageID;
      const delta = (properties as any).delta;
      if (
        typeof sessionID === "string" &&
        typeof messageID === "string" &&
        typeof delta === "string"
      ) {
        const key = `${sessionID}:${messageID}`;
        const text = (this.textByMessage.get(key) ?? "") + delta;
        this.textByMessage.set(key, text);
        const textPart: TextPart = {
          id: messageID,
          sessionID,
          messageID,
          text,
        };
        this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
      }
    } else if (event.type === "session.error") {
      const sessionID = (properties as any).sessionID;
      const error = (properties as any).error as
        | SessionErrorInfo
        | undefined;
      if (sessionID && error) {
        this.sessionErrorCallbacks.forEach((cb) => cb(sessionID, error));
      }
    }
  }

  private handleError(error: Error): void {
    this.errorCallbacks.forEach((cb) => cb(error));
  }
}
