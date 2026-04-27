import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';

vi.mock('../services/dataStore.js');
vi.mock('../services/worktreeManager.js');

import { work } from '../commands/work.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';

function makeInteraction(branch: string, description: string | null) {
  const threadSend = vi.fn().mockResolvedValue(undefined);
  const createdThread = { id: 'thread-1', send: threadSend };
  const threadsCreate = vi.fn().mockResolvedValue(createdThread);

  const channel = {
    isThread: () => false,
    type: ChannelType.GuildText,
    threads: { create: threadsCreate },
  };

  const optsMap = new Map<string, string | null>([
    ['branch', branch],
    ['description', description],
  ]);

  return {
    threadsCreate,
    threadSend,
    interaction: {
      channelId: 'channel-1',
      user: { id: 'user-1' },
      channel,
      options: {
        getString: (name: string, _required?: boolean) => optsMap.get(name) ?? null,
      },
      reply: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

describe('/work — description fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(worktreeManager.sanitizeBranchName).mockImplementation((b: string) => b);
    vi.mocked(worktreeManager.createWorktree).mockResolvedValue('/tmp/worktree');
    vi.mocked(dataStore.getChannelProjectPath).mockReturnValue('/tmp/project');
    vi.mocked(dataStore.getWorktreeMappingByBranch).mockReturnValue(undefined);
    vi.mocked(dataStore.setWorktreeMapping).mockReturnValue(undefined);
  });

  it('uses branch name as description when description is omitted', async () => {
    const { interaction, threadsCreate } = makeInteraction('feat-foo', null);

    await work.execute(interaction);

    expect(threadsCreate.mock.calls[0][0].name).toBe('🌳 feat-foo: feat-foo');
    const mapping = vi.mocked(dataStore.setWorktreeMapping).mock.calls[0][0];
    expect(mapping.description).toBe('feat-foo');
  });

  it('falls back to branch name when description is whitespace-only', async () => {
    const { interaction, threadsCreate } = makeInteraction('feat-bar', '   ');

    await work.execute(interaction);

    expect(threadsCreate.mock.calls[0][0].name).toBe('🌳 feat-bar: feat-bar');
    const mapping = vi.mocked(dataStore.setWorktreeMapping).mock.calls[0][0];
    expect(mapping.description).toBe('feat-bar');
  });

  it('uses provided description verbatim in the thread name', async () => {
    const { interaction, threadsCreate } = makeInteraction('feat-baz', 'build the thing');

    await work.execute(interaction);

    expect(threadsCreate.mock.calls[0][0].name).toBe('🌳 feat-baz: build the thing');
    const mapping = vi.mocked(dataStore.setWorktreeMapping).mock.calls[0][0];
    expect(mapping.description).toBe('build the thing');
  });

  it('truncates the thread name to 100 characters', async () => {
    const longDesc = 'x'.repeat(200);
    const { interaction, threadsCreate } = makeInteraction('feat-long', longDesc);

    await work.execute(interaction);

    expect(threadsCreate.mock.calls[0][0].name.length).toBe(100);
  });
});
