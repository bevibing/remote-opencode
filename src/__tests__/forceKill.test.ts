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

const serveManagerMock = vi.hoisted(() => ({
  killServeByPort: vi.fn(),
}));

vi.mock('../services/dataStore.js', () => ({
  getThreadSession: dataStoreMock.getThreadSession,
  setThreadSession: dataStoreMock.setThreadSession,
  updateThreadSessionLastUsed: dataStoreMock.updateThreadSessionLastUsed,
  clearThreadSession: dataStoreMock.clearThreadSession,
  getAllThreadSessions: dataStoreMock.getAllThreadSessions,
  clearQueue: dataStoreMock.clearQueue,
}));

vi.mock('../services/serveManager.js', () => ({
  killServeByPort: serveManagerMock.killServeByPort,
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
    expect(result.serveKilled).toBe(false);
    expect(serveManagerMock.killServeByPort).not.toHaveBeenCalled();
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
      serveKilled: false,
      affectedThreads: [],
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

  describe('nuclear', () => {
    it('kills serve and resets sibling threads (session + sse + queue + cleanup)', async () => {
      setSessionForThread('thread-A', 'sess-A', '/proj', 14200);
      setSessionForThread('thread-B', 'sess-B', '/proj', 14200);
      setSessionForThread('thread-C', 'sess-C', '/proj', 14200);
      const sseA = makeFakeSseClient();
      const sseB = makeFakeSseClient();
      const sseC = makeFakeSseClient();
      setSseClient('thread-A', sseA);
      setSseClient('thread-B', sseB);
      setSseClient('thread-C', sseC);
      const cleanupB = vi.fn();
      const cleanupC = vi.fn();
      setRunCleanup('thread-B', cleanupB);
      setRunCleanup('thread-C', cleanupC);

      mockFetch.mockResolvedValueOnce({ ok: true });
      serveManagerMock.killServeByPort.mockResolvedValueOnce(true);

      const result = await forceKillThread('thread-A', { nuclear: true });

      expect(serveManagerMock.killServeByPort).toHaveBeenCalledWith(14200);
      expect(result.serveKilled).toBe(true);
      expect(new Set(result.affectedThreads)).toEqual(new Set(['thread-B', 'thread-C']));

      expect(sseB.disconnect).toHaveBeenCalledOnce();
      expect(sseC.disconnect).toHaveBeenCalledOnce();
      expect(dataStoreMock.clearThreadSession).toHaveBeenCalledWith('thread-B');
      expect(dataStoreMock.clearThreadSession).toHaveBeenCalledWith('thread-C');
      expect(dataStoreMock.clearQueue).toHaveBeenCalledWith('thread-B');
      expect(dataStoreMock.clearQueue).toHaveBeenCalledWith('thread-C');
      expect(cleanupB).toHaveBeenCalledOnce();
      expect(cleanupC).toHaveBeenCalledOnce();
    });

    it('does not affect threads on a different port', async () => {
      setSessionForThread('thread-A', 'sess-A', '/proj-a', 14200);
      setSessionForThread('thread-D', 'sess-D', '/proj-d', 14201);

      mockFetch.mockResolvedValueOnce({ ok: true });
      serveManagerMock.killServeByPort.mockResolvedValueOnce(true);

      const result = await forceKillThread('thread-A', { nuclear: true });

      expect(result.affectedThreads).toEqual([]);
      expect(dataStoreMock.clearQueue).not.toHaveBeenCalledWith('thread-D');
    });

    it('reports serveKilled:false when killServeByPort returns false', async () => {
      setSessionForThread('thread-E', 'sess-E', '/proj', 14202);
      mockFetch.mockResolvedValueOnce({ ok: true });
      serveManagerMock.killServeByPort.mockResolvedValueOnce(false);

      const result = await forceKillThread('thread-E', { nuclear: true });

      expect(result.serveKilled).toBe(false);
    });
  });
});
