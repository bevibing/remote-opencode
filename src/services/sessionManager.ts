import type { SSEClient } from "./sseClient.js";
import * as dataStore from "./dataStore.js";
import { sanitizeModel } from "../utils/stringUtils.js";
import { getAuthHeaders, assertNotAuthError } from "./serverAuth.js";
import type { QuestionRequest, PermissionRequest } from "../types/index.js";

const threadSseClients = new Map<string, SSEClient>();

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...getAuthHeaders() };
}

// OpenCode returns session `time` as `{ created, updated }` (epoch ms), not a
// string. Normalize to a comparable string so consumers can sort/format it.
function normalizeTime(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const t = value as { updated?: unknown; created?: unknown };
    const pick = t.updated ?? t.created;
    if (typeof pick === "number") return String(pick);
    if (typeof pick === "string") return pick;
  }
  return "";
}

export async function createSession(port: number, title?: string): Promise<string> {
  const url = `http://127.0.0.1:${port}/session`;
  const body = title ? { title } : {};
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
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
  agent?: string,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`;
  const body: {
    parts: { type: string; text: string }[];
    model?: { providerID: string; modelID: string };
    agent?: string;
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

  if (agent) {
    body.agent = agent;
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

export async function renameSession(
  port: number,
  sessionId: string,
  title: string,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to rename session");
    return false;
  }
  return true;
}

export async function revertLastMessage(
  port: number,
  sessionId: string,
): Promise<{ ok: boolean; message?: string }> {
  const listUrl = `http://127.0.0.1:${port}/session/${sessionId}/message?limit=30`;
  const listResponse = await fetch(listUrl, { headers: jsonHeaders() });
  if (!listResponse.ok) {
    assertNotAuthError(listResponse.status, "Failed to list messages");
    return { ok: false, message: `list failed: ${listResponse.status}` };
  }
  const messages = await listResponse.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, message: "no messages" };
  }
  const lastUser = [...messages].reverse().find((m) => m.info?.role === "user");
  if (!lastUser?.info?.id) {
    return { ok: false, message: "no user message found" };
  }
  const revertUrl = `http://127.0.0.1:${port}/session/${sessionId}/revert`;
  const revertResponse = await fetch(revertUrl, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ messageID: lastUser.info.id }),
  });
  if (!revertResponse.ok) {
    assertNotAuthError(revertResponse.status, "Failed to revert message");
    return { ok: false, message: `revert failed: ${revertResponse.status}` };
  }
  return { ok: true };
}

function parseModelPair(model?: string): { providerID: string; modelID: string } | null {
  if (!model) return null;
  return parseModelString(model);
}

export async function summarizeSession(
  port: number,
  sessionId: string,
  model?: string,
): Promise<boolean> {
  const pair = parseModelPair(model);
  const body: Record<string, string> = {};
  if (pair) {
    body.providerID = pair.providerID;
    body.modelID = pair.modelID;
  }
  const url = `http://127.0.0.1:${port}/session/${sessionId}/summarize`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to summarize session");
    return false;
  }
  return true;
}

export async function initSession(
  port: number,
  sessionId: string,
  model?: string,
): Promise<boolean> {
  const pair = parseModelPair(model);
  const body: Record<string, string> = {};
  if (pair) {
    body.providerID = pair.providerID;
    body.modelID = pair.modelID;
  }
  const url = `http://127.0.0.1:${port}/session/${sessionId}/init`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to init session");
    return false;
  }
  return true;
}

export async function replyToQuestion(
  port: number,
  sessionId: string,
  requestId: string,
  answers: string[][],
): Promise<boolean> {
  void sessionId;
  const url = `http://127.0.0.1:${port}/question/${requestId}/reply`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ answers }),
  });
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to reply to question");
    return false;
  }
  return true;
}

export async function rejectQuestion(
  port: number,
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  void sessionId;
  const url = `http://127.0.0.1:${port}/question/${requestId}/reject`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
  });
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to reject question");
    return false;
  }
  return true;
}

export async function replyToPermission(
  port: number,
  sessionId: string,
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<boolean> {
  void sessionId;
  const url = `http://127.0.0.1:${port}/permission/${requestId}/reply`;
  const body: { reply: string; message?: string } = { reply };
  if (message) {
    body.message = message;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to reply to permission");
    return false;
  }
  return true;
}

export async function listQuestions(port: number): Promise<QuestionRequest[]> {
  const url = `http://127.0.0.1:${port}/question`;
  try {
    const response = await fetch(url, { headers: jsonHeaders() });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? (data as QuestionRequest[]) : [];
  } catch {
    return [];
  }
}

export async function listPermissions(port: number): Promise<PermissionRequest[]> {
  const url = `http://127.0.0.1:${port}/permission`;
  try {
    const response = await fetch(url, { headers: jsonHeaders() });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? (data as PermissionRequest[]) : [];
  } catch {
    return [];
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
  return {
    id: data.id,
    title: data.title ?? "",
    time: normalizeTime(data.time) || normalizeTime(data.timeUpdated),
    timeUpdated: normalizeTime(data.timeUpdated) || normalizeTime(data.time),
    directory: typeof data.directory === "string" ? data.directory : undefined,
    agent: typeof data.agent === "string" ? data.agent : undefined,
    model: formatModelRef(data.model),
    cost: typeof data.cost === "number" ? data.cost : undefined,
    tokens: data.tokens
      ? {
          input: data.tokens.input,
          output: data.tokens.output,
          reasoning: data.tokens.reasoning,
        }
      : undefined,
  };
}

export interface SessionInfo {
  id: string;
  title: string;
  time?: string;
  timeUpdated?: string;
  directory?: string;
  agent?: string;
  model?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

function formatModelRef(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { id?: unknown; providerID?: unknown };
  if (typeof m.providerID === "string" && typeof m.id === "string") {
    return `${m.providerID}/${m.id}`;
  }
  if (typeof m.id === "string") return m.id;
  return undefined;
}

function toSessionInfo(s: {
  id: string;
  title?: string;
  time?: unknown;
  timeUpdated?: unknown;
  directory?: unknown;
  agent?: unknown;
  model?: unknown;
}): SessionInfo {
  return {
    id: s.id,
    title: s.title ?? "",
    time: normalizeTime(s.time) || normalizeTime(s.timeUpdated),
    timeUpdated: normalizeTime(s.timeUpdated) || normalizeTime(s.time),
    directory: typeof s.directory === "string" ? s.directory : undefined,
    agent: typeof s.agent === "string" ? s.agent : undefined,
    model: formatModelRef(s.model),
  };
}

export async function listMessages(
  port: number,
  sessionId: string,
): Promise<SessionMessage[]> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/message`;
  let response: Response;
  try {
    response = await fetch(url, { headers: jsonHeaders() });
  } catch {
    return [];
  }
  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to list messages");
    return [];
  }
  const data = await response.json();
  if (!Array.isArray(data)) return [];
  return data
    .map((m: { info?: { id?: string; role?: string }; parts?: Array<{ type?: string; text?: string }> }) => {
      const text = (m.parts ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      return {
        id: m.info?.id ?? "",
        role: m.info?.role === "user" ? ("user" as const) : ("assistant" as const),
        text,
      };
    })
    .filter((m) => m.id);
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
    return data.map(toSessionInfo);
  }
  const wrapped = (data as { data?: unknown })?.data;
  if (Array.isArray(wrapped)) {
    return wrapped.map(toSessionInfo);
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
  title?: string,
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

  const sessionId = await createSession(port, title);
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
