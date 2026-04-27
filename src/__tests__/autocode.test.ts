import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';

vi.mock('../services/dataStore.js');
vi.mock('../services/worktreeManager.js');

import { autocode } from '../commands/autocode.js';
import { work } from '../commands/work.js';
import { getOrCreateThread } from '../utils/threadHelper.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';

function makeInteraction(channelId: string, isThread = false, parentId?: string) {
  return {
    channelId,
    channel: isThread
      ? { isThread: () => true, parentId }
      : { isThread: () => false },
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('/autocode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replies with an error when no project is bound to the channel', async () => {
    const interaction = makeInteraction('channel-1');
    vi.mocked(dataStore.getChannelBinding).mockReturnValue(undefined);

    await autocode.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toContain('No project set');
    expect(dataStore.setProjectAutoPassthrough).not.toHaveBeenCalled();
  });

  it('flips false → true and reports enabled', async () => {
    const interaction = makeInteraction('channel-1');
    vi.mocked(dataStore.getChannelBinding).mockReturnValue('myproj');
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(false);
    vi.mocked(dataStore.setProjectAutoPassthrough).mockReturnValue(true);

    await autocode.execute(interaction);

    expect(dataStore.setProjectAutoPassthrough).toHaveBeenCalledWith('myproj', true);
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toMatch(/enabled/);
    expect(arg.content).toContain('myproj');
  });

  it('flips true → false and reports disabled', async () => {
    const interaction = makeInteraction('channel-1');
    vi.mocked(dataStore.getChannelBinding).mockReturnValue('myproj');
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(true);
    vi.mocked(dataStore.setProjectAutoPassthrough).mockReturnValue(true);

    await autocode.execute(interaction);

    expect(dataStore.setProjectAutoPassthrough).toHaveBeenCalledWith('myproj', false);
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toMatch(/disabled/);
  });

  it('resolves to the parent channel binding when invoked from a thread', async () => {
    const interaction = makeInteraction('thread-id', true, 'parent-channel');
    vi.mocked(dataStore.getChannelBinding).mockImplementation((id: string) =>
      id === 'parent-channel' ? 'myproj' : undefined
    );
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(false);
    vi.mocked(dataStore.setProjectAutoPassthrough).mockReturnValue(true);

    await autocode.execute(interaction);

    expect(dataStore.getChannelBinding).toHaveBeenCalledWith('parent-channel');
    expect(dataStore.setProjectAutoPassthrough).toHaveBeenCalledWith('myproj', true);
  });

  it('reports failure when setProjectAutoPassthrough returns false', async () => {
    const interaction = makeInteraction('channel-1');
    vi.mocked(dataStore.getChannelBinding).mockReturnValue('ghostproj');
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(false);
    vi.mocked(dataStore.setProjectAutoPassthrough).mockReturnValue(false);

    await autocode.execute(interaction);

    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toContain('not found');
  });
});

describe('auto-passthrough seeding via /work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(worktreeManager.sanitizeBranchName).mockImplementation((b: string) => b);
    vi.mocked(worktreeManager.createWorktree).mockResolvedValue('/tmp/worktree');

    vi.mocked(dataStore.getChannelProjectPath).mockReturnValue('/tmp/project');
    vi.mocked(dataStore.getWorktreeMappingByBranch).mockReturnValue(undefined);
    vi.mocked(dataStore.setWorktreeMapping).mockReturnValue(undefined);
    vi.mocked(dataStore.getChannelBinding).mockReturnValue('myproj');
  });

  async function runWork() {
    const threadsCreate = vi.fn().mockResolvedValue({
      id: 'new-thread-1',
      send: vi.fn().mockResolvedValue(undefined),
    });

    const interaction = {
      channelId: 'channel-1',
      user: { id: 'user-1' },
      channel: {
        isThread: () => false,
        type: ChannelType.GuildText,
        threads: { create: threadsCreate },
      },
      options: { getString: (n: string) => (n === 'branch' ? 'feat-x' : null) },
      reply: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await work.execute(interaction);
  }

  it('seeds passthrough on the new thread when project has autoPassthrough enabled', async () => {
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(true);
    await runWork();
    expect(dataStore.setPassthroughMode).toHaveBeenCalledWith('new-thread-1', true, 'user-1');
  });

  it('does not seed passthrough when autoPassthrough is disabled', async () => {
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(false);
    await runWork();
    expect(dataStore.setPassthroughMode).not.toHaveBeenCalled();
  });
});

describe('auto-passthrough seeding via /opencode (threadHelper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runHelper() {
    const threadsCreate = vi.fn().mockResolvedValue({ id: 'opencode-thread-1' });
    const interaction = {
      channelId: 'channel-1',
      user: { id: 'user-1' },
      channel: { isThread: () => false, threads: { create: threadsCreate } },
    } as any;
    return await getOrCreateThread(interaction, 'do a thing');
  }

  it('seeds passthrough when bound project has autoPassthrough enabled', async () => {
    vi.mocked(dataStore.getChannelBinding).mockReturnValue('myproj');
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(true);
    await runHelper();
    expect(dataStore.setPassthroughMode).toHaveBeenCalledWith('opencode-thread-1', true, 'user-1');
  });

  it('does not seed when no project is bound', async () => {
    vi.mocked(dataStore.getChannelBinding).mockReturnValue(undefined);
    await runHelper();
    expect(dataStore.setPassthroughMode).not.toHaveBeenCalled();
  });

  it('does not seed when autoPassthrough is disabled', async () => {
    vi.mocked(dataStore.getChannelBinding).mockReturnValue('myproj');
    vi.mocked(dataStore.getProjectAutoPassthrough).mockReturnValue(false);
    await runHelper();
    expect(dataStore.setPassthroughMode).not.toHaveBeenCalled();
  });
});
