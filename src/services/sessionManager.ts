import type { SSEClient } from "./sseClient.js";
import * as dataStore from "./dataStore.js";
import { sanitizeModel } from "../utils/stringUtils.js";
import { getAuthHeaders, assertNotAuthError } from "./serverAuth.js";
import type { ApiFamily } from "./serveManager.js";

const threadSseClients = new Map<string, SSEClient>();

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...getAuthHeaders() };
}

function assertNotServerError(status: number, context: string): void {
  if (status < 500) return;
  throw new Error(`${context}: OpenCode server returned HTTP ${status}`);
}

export async function createSession(
  port: number,
  apiFamily: ApiFamily = "legacy",
): Promise<string> {
  const url = `http://127.0.0.1:${port}${apiFamily === "api" ? "/api/session" : "/session"}`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: "{}",
  });

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to create session");
    throw new Error(
      `Failed to create session: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();

  const sessionId = apiFamily === "api" ? data.data?.id : data.id;
  if (!sessionId) {
    throw new Error("Invalid session response: missing id");
  }

  return sessionId;
}

function parseModelString(
  model: string,
): { providerID: string; modelID: string } | null {
  const clean = sanitizeModel(model);
  const slashIndex = clean.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return {
    providerID: clean.slice(0, slashIndex),
    modelID: clean.slice(slashIndex + 1),
  };
}

export async function sendPrompt(
  port: number,
  sessionId: string,
  text: string,
  model?: string,
  apiFamily: ApiFamily = "legacy",
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const body: {
    parts: { type: string; text: string }[];
    model?: { providerID: string; modelID: string };
  } = {
    parts: [{ type: "text", text }],
  };

  if (model) {
    const cleanModel = sanitizeModel(model);
    const parsedModel = parseModelString(cleanModel);
    if (parsedModel) {
      body.model = parsedModel;
    }
  }

  if (apiFamily === "api") {
    if (body.model) {
      const modelResponse = await fetch(
        `${baseUrl}/api/session/${sessionId}/model`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            model: {
              providerID: body.model.providerID,
              id: body.model.modelID,
            },
          }),
        },
      );
      if (!modelResponse.ok) {
        const responseBody = await modelResponse.text();
        assertNotAuthError(modelResponse.status, "Failed to set session model");
        throw new Error(
          `Failed to set session model: ${modelResponse.status} ${modelResponse.statusText} — ${responseBody}`,
        );
      }
    }

    const response = await fetch(`${baseUrl}/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      assertNotAuthError(response.status, "Failed to send prompt");
      throw new Error(
        `Failed to send prompt: ${response.status} ${response.statusText} — ${responseBody}`,
      );
    }
    return;
  }

  const response = await fetch(
    `${baseUrl}/session/${sessionId}/prompt_async`,
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const responseBody = await response.text();
    assertNotAuthError(response.status, "Failed to send prompt");
    throw new Error(
      `Failed to send prompt: ${response.status} ${response.statusText} — ${responseBody}`,
    );
  }
}

export async function validateSession(
  port: number,
  sessionId: string,
  apiFamily: ApiFamily = "legacy",
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}${apiFamily === "api" ? `/api/session/${sessionId}` : `/session/${sessionId}`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: jsonHeaders(),
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to validate session");
    assertNotServerError(response.status, "Failed to validate session");
  }
  return response.ok;
}

export async function getSessionInfo(
  port: number,
  sessionId: string,
  apiFamily: ApiFamily = "legacy",
): Promise<SessionInfo | null> {
  const url = `http://127.0.0.1:${port}${apiFamily === "api" ? `/api/session/${sessionId}` : `/session/${sessionId}`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: jsonHeaders(),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to get session info");
    assertNotServerError(response.status, "Failed to get session info");
    return null;
  }
  const data = await response.json();
  const session = apiFamily === "api" ? data.data : data;
  return { id: session.id, title: session.title ?? "" };
}

export interface SessionInfo {
  id: string;
  title: string;
}

export async function listSessions(
  port: number,
  apiFamily: ApiFamily = "legacy",
): Promise<SessionInfo[]> {
  const url = `http://127.0.0.1:${port}${apiFamily === "api" ? "/api/session" : "/session"}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: jsonHeaders(),
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to list sessions");
    assertNotServerError(response.status, "Failed to list sessions");
    return [];
  }

  const data = await response.json();
  const sessions = apiFamily === "api" ? data.data : data;
  if (Array.isArray(sessions)) {
    return sessions.map((s: { id: string; title?: string }) => ({
      id: s.id,
      title: s.title ?? "",
    }));
  }
  return [];
}

export async function abortSession(
  port: number,
  sessionId: string,
  apiFamily: ApiFamily = "legacy",
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}${apiFamily === "api" ? `/api/session/${sessionId}/interrupt` : `/session/${sessionId}/abort`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to abort session");
    assertNotServerError(response.status, "Failed to abort session");
  }
  if (apiFamily === "api" && response.ok) {
    const data = await response.json();
    return data.interrupted === true;
  }
  return response.ok;
}

export function getSessionForThread(
  threadId: string,
): { sessionId: string; projectPath: string; port: number } | undefined {
  const session = dataStore.getThreadSession(threadId);
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    port: session.port,
  };
}

export function setSessionForThread(
  threadId: string,
  sessionId: string,
  projectPath: string,
  port: number,
): void {
  const existing = dataStore.getThreadSession(threadId);
  const now = Date.now();
  dataStore.setThreadSession({
    threadId,
    sessionId,
    projectPath,
    port,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  });
}

export async function ensureSessionForThread(
  threadId: string,
  projectPath: string,
  port: number,
  apiFamily: ApiFamily = "legacy",
): Promise<string> {
  const existingSession = getSessionForThread(threadId);

  if (existingSession && existingSession.projectPath === projectPath) {
    const isValid = await validateSession(
      port,
      existingSession.sessionId,
      apiFamily,
    );
    if (isValid) {
      setSessionForThread(
        threadId,
        existingSession.sessionId,
        projectPath,
        port,
      );
      return existingSession.sessionId;
    }
  }

  const sessionId = await createSession(port, apiFamily);
  setSessionForThread(threadId, sessionId, projectPath, port);
  return sessionId;
}

export function updateSessionLastUsed(threadId: string): void {
  dataStore.updateThreadSessionLastUsed(threadId);
}

export function clearSessionForThread(threadId: string): void {
  dataStore.clearThreadSession(threadId);
}

export function setSseClient(threadId: string, client: SSEClient): void {
  threadSseClients.set(threadId, client);
}

export function getSseClient(threadId: string): SSEClient | undefined {
  return threadSseClients.get(threadId);
}

export function clearSseClient(threadId: string): void {
  threadSseClients.delete(threadId);
}
