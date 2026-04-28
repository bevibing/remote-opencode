import type { SSEClient } from "./sseClient.js";
import * as dataStore from "./dataStore.js";
import { sanitizeModel } from "../utils/stringUtils.js";
import { getAuthHeaders, assertNotAuthError } from "./serverAuth.js";

const threadSseClients = new Map<string, SSEClient>();
const threadRunCleanups = new Map<string, () => void>();

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...getAuthHeaders() };
}

export async function createSession(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/session`;
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

  if (!data.id) {
    throw new Error("Invalid session response: missing id");
  }

  return data.id;
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
): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`;
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

  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });

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
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}`;
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
  }
  return response.ok;
}

export async function getSessionInfo(
  port: number,
  sessionId: string,
): Promise<SessionInfo | null> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}`;
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
    return null;
  }
  const data = await response.json();
  return { id: data.id, title: data.title ?? "" };
}

export interface SessionInfo {
  id: string;
  title: string;
}

export async function listSessions(port: number): Promise<SessionInfo[]> {
  const url = `http://127.0.0.1:${port}/session`;
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
    return [];
  }

  const data = await response.json();
  if (Array.isArray(data)) {
    return data.map((s: { id: string; title?: string }) => ({
      id: s.id,
      title: s.title ?? "",
    }));
  }
  return [];
}

export async function abortSession(
  port: number,
  sessionId: string,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/abort`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to abort session");
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
): Promise<string> {
  const existingSession = getSessionForThread(threadId);

  if (existingSession && existingSession.projectPath === projectPath) {
    const isValid = await validateSession(port, existingSession.sessionId);
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

  const sessionId = await createSession(port);
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

export function setRunCleanup(threadId: string, cleanup: () => void): void {
  threadRunCleanups.set(threadId, cleanup);
}

export function clearRunCleanup(threadId: string): void {
  threadRunCleanups.delete(threadId);
}

function runCleanup(threadId: string): boolean {
  const fn = threadRunCleanups.get(threadId);
  if (!fn) return false;
  threadRunCleanups.delete(threadId);
  try { fn(); } catch { /* ignore */ }
  return true;
}

export interface ForceKillResult {
  hadSession: boolean;
  httpAborted: boolean;
  sseDisconnected: boolean;
  sessionCleared: boolean;
}

export async function forceKillThread(threadId: string): Promise<ForceKillResult> {
  const result: ForceKillResult = {
    hadSession: false,
    httpAborted: false,
    sseDisconnected: false,
    sessionCleared: false,
  };

  const session = getSessionForThread(threadId);
  result.hadSession = !!session;

  if (session) {
    result.httpAborted = await abortSession(session.port, session.sessionId);
  }

  const sseClient = getSseClient(threadId);
  if (sseClient) {
    try { sseClient.disconnect(); } catch { /* ignore */ }
    clearSseClient(threadId);
    result.sseDisconnected = true;
  }

  // Stops the runPrompt update interval that would otherwise edit the
  // stream message every second forever (the SSE idle/error events that
  // normally clear it never fire after disconnect).
  runCleanup(threadId);

  if (session) {
    clearSessionForThread(threadId);
    result.sessionCleared = true;
  }

  dataStore.clearQueue(threadId);

  return result;
}
