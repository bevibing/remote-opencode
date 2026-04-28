import { EventSource } from "eventsource";
import type { TextPart, SSEEvent, SessionErrorInfo } from "../types/index.js";
import { getAuthHeaders } from "./serverAuth.js";

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

  connect(baseUrl: string): void {
    const url = `${baseUrl}/event`;
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

    this.eventSource.addEventListener("message", (event: MessageEvent) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        this.handleError(new Error(`Failed to parse SSE event: ${error}`));
      }
    });

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
    if (event.type === "message.part.updated") {
      const part = (event.properties as any).part;
      if (part && part.type === "text") {
        const textPart: TextPart = {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          text: part.text,
        };
        this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
      }
    } else if (event.type === "session.idle") {
      const sessionID = (event.properties as any).sessionID;
      if (sessionID) {
        this.sessionIdleCallbacks.forEach((cb) => cb(sessionID));
      }
    } else if (event.type === "session.error") {
      const sessionID = (event.properties as any).sessionID;
      const error = (event.properties as any).error as
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
