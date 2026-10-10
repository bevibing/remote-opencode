import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const callbacks: Record<string, any[]> = {};
  const instances: any[] = [];
  class MockSSEClient {
    connect = () => {};
    disconnect = () => {};
    onQuestionAsked(cb: any) {
      (callbacks.question ??= []).push(cb);
    }
    onPermissionAsked(cb: any) {
      (callbacks.permission ??= []).push(cb);
    }
    onSessionIdle(cb: any) {
      (callbacks.idle ??= []).push(cb);
    }
    onError(cb: any) {
      (callbacks.error ??= []).push(cb);
    }
    constructor() {
      instances.push(this);
    }
  }
  return { callbacks, instances, MockSSEClient };
});

vi.mock('../services/sseClient.js', () => ({ SSEClient: h.MockSSEClient }));
vi.mock('../services/dataStore.js', () => ({
  getAllThreadSessions: vi.fn(() => []),
}));
vi.mock('../services/sessionManager.js', () => ({
  getSseClient: vi.fn(() => undefined),
  listQuestions: vi.fn(async () => []),
  listPermissions: vi.fn(async () => []),
}));
vi.mock('../services/qaPrompts.js', () => ({
  postQuestion: vi.fn(async () => {}),
  postPermission: vi.fn(async () => {}),
}));
vi.mock('../services/sessionSync.js', () => ({
  syncSessionToChannel: vi.fn(async () => ({ posted: 0, total: 0 })),
}));
vi.mock('../services/clientRef.js', () => ({ getClient: vi.fn(() => null) }));

const { ensureWatcher, stopAllWatchers } = await import('../services/backgroundWatcher.js');
const dataStore = await import('../services/dataStore.js');
const qaPrompts = await import('../services/qaPrompts.js');
const sessionSync = await import('../services/sessionSync.js');
const clientRef = await import('../services/clientRef.js');
const sessionManager = await import('../services/sessionManager.js');

function mockChannel(overrides: Partial<{ name: string; send: any }> = {}) {
  const send = vi.fn(async () => {});
  const channel: any = {
    isTextBased: () => true,
    isDMBased: () => false,
    name: overrides.name ?? '🤖 test',
    send: overrides.send ?? send,
  };
  return channel;
}

describe('backgroundWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.callbacks.question = [];
    h.callbacks.permission = [];
    h.callbacks.idle = [];
    h.callbacks.error = [];
    h.instances.length = 0;
    stopAllWatchers();
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([]);
    vi.mocked(clientRef.getClient).mockReturnValue(null);
  });

  it('should connect a single watcher per port', () => {
    ensureWatcher(14097);
    ensureWatcher(14097);
    expect(h.instances.length).toBe(1);
    ensureWatcher(14098);
    expect(h.instances.length).toBe(2);
  });

  it('should route question.asked to the mapped channel', () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([
      { threadId: 'chan_1', sessionId: 'ses_1', projectPath: '/p', port: 14097, createdAt: 0, lastUsedAt: 0 },
    ]);
    const channel = mockChannel();
    const cache = { get: vi.fn(() => channel) };
    vi.mocked(clientRef.getClient).mockReturnValue({ channels: { cache } } as any);

    ensureWatcher(14097);

    const request = { id: 'que_1', sessionID: 'ses_1', questions: [{ header: 'H', question: 'Q', options: [] }] };
    h.callbacks.question[0](request);

    expect(qaPrompts.postQuestion).toHaveBeenCalledWith(channel, 14097, request);
  });

  it('should not route questions for sessions without a mapped channel', () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([
      { threadId: 'chan_1', sessionId: 'ses_1', projectPath: '/p', port: 14097, createdAt: 0, lastUsedAt: 0 },
    ]);
    const channel = mockChannel();
    vi.mocked(clientRef.getClient).mockReturnValue({ channels: { cache: { get: () => channel } } } as any);

    ensureWatcher(14097);
    h.callbacks.question[0]({ id: 'que_2', sessionID: 'ses_unknown', questions: [] });

    expect(qaPrompts.postQuestion).not.toHaveBeenCalled();
  });

  it('should sync on background session idle when no active run', () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([
      { threadId: 'chan_1', sessionId: 'ses_1', projectPath: '/p', port: 14097, createdAt: 0, lastUsedAt: 0 },
    ]);
    vi.mocked(sessionManager.getSseClient).mockReturnValue(undefined);
    const channel = mockChannel();
    vi.mocked(clientRef.getClient).mockReturnValue({ channels: { cache: { get: () => channel } } } as any);

    ensureWatcher(14097);
    h.callbacks.idle[0]('ses_1');

    expect(sessionSync.syncSessionToChannel).toHaveBeenCalledWith(channel, 'chan_1');
  });

  it('should skip idle sync when a run is active in the channel', () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([
      { threadId: 'chan_1', sessionId: 'ses_1', projectPath: '/p', port: 14097, createdAt: 0, lastUsedAt: 0 },
    ]);
    vi.mocked(sessionManager.getSseClient).mockReturnValue({ isConnected: () => true } as any);
    const channel = mockChannel();
    vi.mocked(clientRef.getClient).mockReturnValue({ channels: { cache: { get: () => channel } } } as any);

    ensureWatcher(14097);
    h.callbacks.idle[0]('ses_1');

    expect(sessionSync.syncSessionToChannel).not.toHaveBeenCalled();
  });

  it('should skip archived channels', () => {
    vi.mocked(dataStore.getAllThreadSessions).mockReturnValue([
      { threadId: 'chan_1', sessionId: 'ses_1', projectPath: '/p', port: 14097, createdAt: 0, lastUsedAt: 0 },
    ]);
    const send = vi.fn(async () => {});
    const channel = mockChannel({ name: '🔒 test', send });
    vi.mocked(clientRef.getClient).mockReturnValue({ channels: { cache: { get: () => channel } } } as any);

    ensureWatcher(14097);
    h.callbacks.idle[0]('ses_1');

    expect(send).not.toHaveBeenCalled();
  });
});
