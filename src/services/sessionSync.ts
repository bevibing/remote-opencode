import type { TextBasedChannel, TextChannel } from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import { formatOutputForMobile } from '../utils/messageFormatter.js';

const HISTORY_LIMIT = 20;

export interface SyncResult {
  posted: number;
  total: number;
}

export function selectNewMessages(
  messages: sessionManager.SessionMessage[],
  cursor?: string,
): sessionManager.SessionMessage[] {
  if (messages.length === 0) return [];
  if (!cursor) return messages;
  const idx = messages.findIndex((m) => m.id === cursor);
  if (idx === -1) return messages;
  return messages.slice(idx + 1);
}

// Last message with actual text. Never advance the cursor past a trailing
// message that is still empty (e.g. an assistant turn not yet persisted),
// otherwise it would be skipped forever once it gains text.
export function lastSyncedMessageId(
  messages: sessionManager.SessionMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].text.trim()) return messages[i].id;
  }
  return undefined;
}

export async function syncSessionToChannel(
  channel: TextBasedChannel,
  threadId: string,
  opts?: { history?: boolean; maxMessages?: number },
): Promise<SyncResult> {
  const session = sessionManager.getSessionForThread(threadId);
  if (!session) return { posted: 0, total: 0 };

  const messages = await sessionManager.listMessages(session.port, session.sessionId);
  const cursor = opts?.history ? undefined : dataStore.getSyncCursor(threadId);
  let fresh = selectNewMessages(messages, cursor);
  if (opts?.history) {
    fresh = fresh.slice(-(opts.maxMessages ?? HISTORY_LIMIT));
  }

  let posted = 0;
  for (const m of fresh) {
    if (!m.text.trim()) continue;
    const body = `${m.role === 'user' ? '🧑' : '🤖'} ${m.text}`;
    const { chunks } = formatOutputForMobile(body);
    for (const chunk of chunks) {
      await (channel as TextChannel).send({ content: chunk });
      posted++;
    }
  }

  const last = lastSyncedMessageId(messages);
  if (last) {
    dataStore.setSyncCursor(threadId, last);
  }
  return { posted, total: messages.length };
}

export async function markThreadSynced(
  threadId: string,
  port: number,
  sessionId: string,
): Promise<void> {
  try {
    const messages = await sessionManager.listMessages(port, sessionId);
    const last = lastSyncedMessageId(messages);
    if (last) {
      dataStore.setSyncCursor(threadId, last);
    }
  } catch {
    // ignore
  }
}
