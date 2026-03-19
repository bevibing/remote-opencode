import type { SSEClient } from './sseClient.js';
import * as dataStore from './dataStore.js';
import { sanitizeModel } from '../utils/stringUtils.js';

const threadSseClients = new Map<string, SSEClient>();

export async function createSession(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/session`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error('Invalid session response: missing id');
  }

  return data.id;
}

function parseModelString(model: string): { providerID: string; modelID: string } | null {
  const clean = sanitizeModel(model);
  const slashIndex = clean.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }
  return {
    providerID: clean.slice(0, slashIndex),
    modelID: clean.slice(slashIndex + 1),
  };
}

export async function sendPrompt(port: number, sessionId: string, text: string, model?: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`;
  const body: { parts: { type: string; text: string }[]; model?: { providerID: string; modelID: string } } = {
    parts: [{ type: 'text', text }],
  };

  if (model) {
    const cleanModel = sanitizeModel(model);
    const parsedModel = parseModelString(cleanModel);
    if (parsedModel) {
      body.model = parsedModel;
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Failed to send prompt: ${response.status} ${response.statusText} — ${responseBody}`);
  }
}

export async function validateSession(port: number, sessionId: string): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getSessionInfo(port: number, sessionId: string): Promise<SessionInfo | null> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return { id: data.id, title: data.title ?? '' };
  } catch {
    return null;
  }
}

export interface SessionInfo {
  id: string;
  title: string;
}

export async function listSessions(port: number): Promise<SessionInfo[]> {
  try {
    const url = `http://127.0.0.1:${port}/session`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    if (Array.isArray(data)) {
      return data.map((s: { id: string; title?: string }) => ({
        id: s.id,
        title: s.title ?? '',
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export async function abortSession(port: number, sessionId: string): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}/abort`;
    const response = await fetch(url, {
      method: 'POST',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function getSessionForThread(threadId: string): { sessionId: string; projectPath: string; port: number } | undefined {
  const session = dataStore.getThreadSession(threadId);
  if (!session) return undefined;
  return { sessionId: session.sessionId, projectPath: session.projectPath, port: session.port };
}

export function setSessionForThread(threadId: string, sessionId: string, projectPath: string, port: number): void {
  const now = Date.now();
  dataStore.setThreadSession({
    threadId,
    sessionId,
    projectPath,
    port,
    createdAt: now,
    lastUsedAt: now,
  });
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
