import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use hoisted mock factory that returns a proper constructor
const { mockSSEClient, makeSSEClient } = vi.hoisted(() => {
  const mock = vi.fn();
  function makeInstance() {
    const partUpdatedCbs: ((part: { sessionID: string; text: string }) => void)[] = [];
    const sessionIdleCbs: ((id: string) => void)[] = [];
    const sessionErrorCbs: ((id: string, err: { data?: { message?: string }; name?: string }) => void)[] = [];
    const errorCbs: ((e: Error) => void)[] = [];

    const fires = {
      partUpdated(part: { sessionID: string; text: string }) { partUpdatedCbs.forEach(cb => cb(part)); },
      sessionIdle(id: string) { sessionIdleCbs.forEach(cb => cb(id)); },
      sessionError(id: string, err: { data?: { message?: string }; name?: string }) { sessionErrorCbs.forEach(cb => cb(id, err)); },
      error(e: Error) { errorCbs.forEach(cb => cb(e)); },
    };

    const instance = {
      connect: vi.fn(),
      onPartUpdated: vi.fn().mockImplementation((cb: typeof partUpdatedCbs[0]) => partUpdatedCbs.push(cb)),
      onSessionIdle: vi.fn().mockImplementation((cb: typeof sessionIdleCbs[0]) => sessionIdleCbs.push(cb)),
      onSessionError: vi.fn().mockImplementation((cb: typeof sessionErrorCbs[0]) => sessionErrorCbs.push(cb)),
      onError: vi.fn().mockImplementation((cb: typeof errorCbs[0]) => errorCbs.push(cb)),
      disconnect: vi.fn(),
      _fires: fires,
    };

    return instance;
  }

  // Use a regular (non-arrow) function so `new` works
  mock.mockImplementation(function(this: any) { return makeInstance(); });

  return { mockSSEClient: mock, makeSSEClient: makeInstance };
});

vi.mock('../services/sseClient.js', () => ({
  SSEClient: mockSSEClient,
}));
vi.mock('../services/dataStore.js');
vi.mock('../services/sessionManager.js');
vi.mock('../services/serveManager.js');
vi.mock('../services/worktreeManager.js');

import { handleButton } from '../handlers/buttonHandler.js';
import * as dataStore from '../services/dataStore.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';

function makeInteraction() {
  const send = vi.fn().mockResolvedValue({});
  return {
    customId: 'pr_thread-1',
    channel: { isThread: () => true, parentId: 'parent-1', send } as any,
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('handleButton PR creation', () => {
  let sse: ReturnType<typeof makeSSEClient>;
  let interaction: ReturnType<typeof makeInteraction>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Ensure mockSSEClient returns a fresh instance
    sse = makeSSEClient();
    mockSSEClient.mockImplementation(function(this: any) { return sse; });

    vi.mocked(dataStore.getWorktreeMapping).mockReturnValue({
      threadId: 'thread-1', branchName: 'feat/test',
      worktreePath: '/tmp/worktree', projectPath: '/tmp/project',
      description: 'test', createdAt: 1,
    });
    vi.mocked(dataStore.getChannelModel).mockReturnValue(undefined);
    vi.mocked(serveManager.spawnServe).mockResolvedValue(4096);
    vi.mocked(serveManager.waitForReady).mockResolvedValue(undefined);
    vi.mocked(sessionManager.ensureSessionForThread).mockResolvedValue('session-1');
    vi.mocked(sessionManager.sendPrompt).mockResolvedValue(undefined);
  });

  it('posts accumulated text to thread on session.idle', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);

    sse._fires.partUpdated({ sessionID: 'session-1', text: 'Created PR #42: https://github.com/foo/bar/pull/42' });
    sse._fires.sessionIdle('session-1');

    expect(interaction.channel.send).toHaveBeenCalled();
    const content = interaction.channel.send.mock.calls[0][0].content;
    expect(content).toContain('PR Creation Complete');
    expect(content).toContain('Created PR #42');
    expect(sse.disconnect).toHaveBeenCalled();
    expect(sessionManager.clearSseClient).toHaveBeenCalledWith('thread-1');
  });

  it('posts warning when no output received on idle', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);
    sse._fires.sessionIdle('session-1');

    expect(interaction.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ PR creation completed but no output was received.' })
    );
  });

  it('ignores idle events from different sessions', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);
    sse._fires.sessionIdle('other-session');

    expect(interaction.channel.send).not.toHaveBeenCalled();
  });

  it('posts error on session.error', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);
    sse._fires.sessionError('session-1', { data: { message: 'No commits' }, name: 'Err' });

    expect(interaction.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '❌ **PR creation failed**: No commits' })
    );
    expect(sse.disconnect).toHaveBeenCalled();
  });

  it('falls back to error name when data.message absent', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);
    sse._fires.sessionError('session-1', { name: 'Unknown' });

    expect(interaction.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '❌ **PR creation failed**: Unknown' })
    );
  });

  it('posts connection error on SSE error', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);
    sse._fires.error(new Error('ECONNREFUSED'));

    expect(interaction.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '❌ **Connection error**: ECONNREFUSED' })
    );
  });

  it('no SSE cleanup when spawnServe throws (before construction)', async () => {
    interaction = makeInteraction();
    vi.mocked(serveManager.spawnServe).mockRejectedValue(new Error('port exhaustion'));

    await handleButton(interaction);

    expect(sessionManager.clearSseClient).not.toHaveBeenCalled();
  });

  it('no SSE cleanup needed when waitForReady throws (SSE not yet created)', async () => {
    interaction = makeInteraction();
    vi.mocked(serveManager.waitForReady).mockRejectedValue(new Error('timeout'));

    await handleButton(interaction);

    // SSE is constructed after waitForReady + ensureSession, so nothing to clean up
    expect(sse.disconnect).not.toHaveBeenCalled();
    expect(sessionManager.clearSseClient).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Failed to start PR creation') })
    );
  });

  it('cleans up SSE when sendPrompt throws after SSE connect', async () => {
    interaction = makeInteraction();
    vi.mocked(sessionManager.sendPrompt).mockRejectedValue(new Error('prompt failed'));

    await handleButton(interaction);

    expect(sse.disconnect).toHaveBeenCalled();
    expect(sessionManager.clearSseClient).toHaveBeenCalledWith('thread-1');
  });

  it('passes preferredModel to spawnServe and sendPrompt', async () => {
    interaction = makeInteraction();
    vi.mocked(dataStore.getChannelModel).mockReturnValue('anthropic/claude-sonnet-4');

    await handleButton(interaction);

    expect(serveManager.spawnServe).toHaveBeenCalledWith('/tmp/worktree', 'anthropic/claude-sonnet-4');
    expect(sessionManager.sendPrompt).toHaveBeenCalledWith(
      4096, 'session-1',
      expect.stringContaining('Create a pull request'),
      'anthropic/claude-sonnet-4',
    );
  });

  it('shows updated confirmation message', async () => {
    interaction = makeInteraction();
    await handleButton(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '✅ PR creation started — the result will be posted in this thread.' })
    );
  });

  it('returns early without mapping', async () => {
    interaction = makeInteraction();
    vi.mocked(dataStore.getWorktreeMapping).mockReturnValue(undefined);

    await handleButton(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ Worktree mapping not found.' })
    );
  });
});
