import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dataStoreMock = vi.hoisted(() => {
  const threadSessions = new Map<string, { threadId: string; sessionId: string; projectPath: string; port: number; createdAt: number; lastUsedAt: number }>();
  const queues = new Map<string, unknown[]>();

  return {
    reset: () => { threadSessions.clear(); queues.clear(); },
    getThreadSession: vi.fn((threadId: string) => threadSessions.get(threadId)),
    setThreadSession: vi.fn((session: any) => { threadSessions.set(session.threadId, session); }),
    updateThreadSessionLastUsed: vi.fn(),
    clearThreadSession: vi.fn((threadId: string) => { threadSessions.delete(threadId); }),
    getAllThreadSessions: vi.fn(() => Array.from(threadSessions.values())),
    clearQueue: vi.fn((threadId: string) => { queues.delete(threadId); }),
  };
});

vi.mock('../services/dataStore.js', () => ({
  getThreadSession: dataStoreMock.getThreadSession,
  setThreadSession: dataStoreMock.setThreadSession,
  updateThreadSessionLastUsed: dataStoreMock.updateThreadSessionLastUsed,
  clearThreadSession: dataStoreMock.clearThreadSession,
  getAllThreadSessions: dataStoreMock.getAllThreadSessions,
  clearQueue: dataStoreMock.clearQueue,
}));

import {
  forceKillThread,
  setSseClient,
  setRunCleanup,
  setSessionForThread,
} from '../services/sessionManager.js';

function makeFakeSseClient() {
  return { disconnect: vi.fn() } as any;
}

describe('forceKillThread', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    dataStoreMock.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns hadSession:false and is idempotent when thread has no session', async () => {
    const result = await forceKillThread('thread-empty');

    expect(result.hadSession).toBe(false);
    expect(result.httpAborted).toBe(false);
    expect(result.sseDisconnected).toBe(false);
    expect(result.sessionCleared).toBe(false);
  });

  it('aborts session, disconnects SSE, clears session+queue', async () => {
    setSessionForThread('thread-1', 'sess-1', '/proj', 14097);
    const sse = makeFakeSseClient();
    setSseClient('thread-1', sse);
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await forceKillThread('thread-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:14097/session/sess-1/abort',
      expect.objectContaining({ method: 'POST' })
    );
    expect(sse.disconnect).toHaveBeenCalledOnce();
    expect(dataStoreMock.clearThreadSession).toHaveBeenCalledWith('thread-1');
    expect(dataStoreMock.clearQueue).toHaveBeenCalledWith('thread-1');
    expect(result).toMatchObject({
      hadSession: true,
      httpAborted: true,
      sseDisconnected: true,
      sessionCleared: true,
    });
  });

  it('reports httpAborted:false when abort fetch fails (timeout/error)', async () => {
    setSessionForThread('thread-2', 'sess-2', '/proj', 14098);
    mockFetch.mockRejectedValueOnce(new Error('boom'));

    const result = await forceKillThread('thread-2');

    expect(result.hadSession).toBe(true);
    expect(result.httpAborted).toBe(false);
    expect(result.sessionCleared).toBe(true);
  });

  it('invokes the registered run cleanup', async () => {
    setSessionForThread('thread-3', 'sess-3', '/proj', 14099);
    const cleanup = vi.fn();
    setRunCleanup('thread-3', cleanup);
    mockFetch.mockResolvedValueOnce({ ok: true });

    await forceKillThread('thread-3');

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('only invokes run cleanup once across consecutive kills', async () => {
    setSessionForThread('thread-4', 'sess-4', '/proj', 14100);
    const cleanup = vi.fn();
    setRunCleanup('thread-4', cleanup);
    mockFetch.mockResolvedValue({ ok: true });

    await forceKillThread('thread-4');
    await forceKillThread('thread-4');

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
