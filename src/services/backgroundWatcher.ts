import { TextBasedChannel } from 'discord.js';
import { SSEClient } from './sseClient.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as qaPrompts from './qaPrompts.js';
import * as sessionSync from './sessionSync.js';
import { getClient } from './clientRef.js';

interface Watcher {
  client: SSEClient;
  reconnectTimer?: NodeJS.Timeout;
}

const watchers = new Map<number, Watcher>();

const RECONNECT_DELAY_MS = 5000;

function channelForSession(sessionId: string): string | undefined {
  const found = dataStore.getAllThreadSessions().find((s) => s.sessionId === sessionId);
  return found?.threadId;
}

function fetchChannel(channelId: string): TextBasedChannel | undefined {
  const client = getClient();
  if (!client) return undefined;
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return undefined;
  if (typeof (channel as { name?: string }).name === 'string' && (channel as { name: string }).name.startsWith('🔒')) {
    return undefined;
  }
  return channel as TextBasedChannel;
}

export function ensureWatcher(port: number): void {
  if (watchers.has(port)) return;

  const client = new SSEClient();
  const watcher: Watcher = { client };
  watchers.set(port, watcher);

  client.onQuestionAsked((request) => {
    const channelId = channelForSession(request.sessionID);
    if (!channelId) return;
    const channel = fetchChannel(channelId);
    if (channel) {
      void qaPrompts.postQuestion(channel, port, request);
    }
  });

  client.onPermissionAsked((request) => {
    const channelId = channelForSession(request.sessionID);
    if (!channelId) return;
    const channel = fetchChannel(channelId);
    if (channel) {
      void qaPrompts.postPermission(channel, port, request);
    }
  });

  client.onSessionIdle((sessionId) => {
    const channelId = channelForSession(sessionId);
    if (!channelId) return;
    // Skip if a run is currently active in that channel — the run client already
    // renders the completion, so this avoids double notifications.
    if (sessionManager.getSseClient(channelId)?.isConnected()) return;
    const channel = fetchChannel(channelId);
    if (channel) {
      void sessionSync.syncSessionToChannel(channel, channelId).catch(() => {});
    }
  });

  client.onError(() => {
    if (watcher.reconnectTimer) return;
    watcher.reconnectTimer = setTimeout(() => {
      watcher.reconnectTimer = undefined;
      watchers.delete(port);
      try {
        client.disconnect();
      } catch {
        // ignore
      }
      ensureWatcher(port);
    }, RECONNECT_DELAY_MS);
  });

  client.connect(`http://127.0.0.1:${port}`);

  // Catch-up: surface questions/permissions that may have been missed
  void (async () => {
    try {
      const questions = await sessionManager.listQuestions(port);
      for (const q of questions) {
        const channelId = channelForSession(q.sessionID);
        if (!channelId) continue;
        const channel = fetchChannel(channelId);
        if (channel) {
          await qaPrompts.postQuestion(channel, port, q);
        }
      }
      const permissions = await sessionManager.listPermissions(port);
      for (const p of permissions) {
        const channelId = channelForSession(p.sessionID);
        if (!channelId) continue;
        const channel = fetchChannel(channelId);
        if (channel) {
          await qaPrompts.postPermission(channel, port, p);
        }
      }
    } catch {
      // ignore catch-up errors
    }
  })();
}

export function stopWatcher(port: number): void {
  const watcher = watchers.get(port);
  if (!watcher) return;
  if (watcher.reconnectTimer) {
    clearTimeout(watcher.reconnectTimer);
  }
  try {
    watcher.client.disconnect();
  } catch {
    // ignore
  }
  watchers.delete(port);
}

export function stopAllWatchers(): void {
  for (const port of [...watchers.keys()]) {
    stopWatcher(port);
  }
}
