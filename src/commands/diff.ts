import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as dataStore from '../services/dataStore.js';
import type { Command } from './index.js';

const execFileAsync = promisify(execFile);

const MAX_LENGTH = 1900;
const CODE_BLOCK_OVERHEAD = 8; // ```diff\n...\n```
const GIT_REF_PATTERN = /^[a-zA-Z0-9._\/-]+$/;

function formatDiff(raw: string): string {
  const maxContent = MAX_LENGTH - CODE_BLOCK_OVERHEAD;

  if (raw.length <= maxContent) {
    return '```diff\n' + raw + '\n```';
  }

  const truncated = '...(truncated)...\n\n' + raw.slice(-maxContent + 20);
  return '```diff\n' + truncated + '\n```';
}

export function computeDiff(
  projectPath: string,
  target: string = 'unstaged',
  stat: boolean = false,
  base: string = 'main',
): Promise<{ ok: boolean; content?: string; error?: string }> {
  return (async () => {
    if (target === 'branch' && !GIT_REF_PATTERN.test(base)) {
      return { ok: false, error: 'Invalid base branch name.' };
    }

    let gitArgs: string[];
    switch (target) {
      case 'staged':
        gitArgs = ['diff', '--cached'];
        break;
      case 'branch':
        gitArgs = ['diff', `${base}...HEAD`];
        break;
      default:
        gitArgs = ['diff'];
    }

    if (stat) {
      gitArgs.push('--stat');
    }

    try {
      const { stdout } = await execFileAsync('git', gitArgs, { cwd: projectPath });
      const output = stdout.trim();
      if (!output) {
        const targetLabel = target === 'branch' ? `branch (base: ${base})` : target;
        return { ok: true, content: `✅ No ${targetLabel} changes.` };
      }
      return { ok: true, content: formatDiff(output) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  })();
}

export const diff: Command = {
  data: new SlashCommandBuilder()
    .setName('diff')
    .setDescription('Show git diff for the current project')
    .addStringOption(option =>
      option.setName('target')
        .setDescription('What to diff: unstaged (default), staged, or branch')
        .setRequired(false)
        .addChoices(
          { name: 'unstaged', value: 'unstaged' },
          { name: 'staged', value: 'staged' },
          { name: 'branch', value: 'branch' }
        )
    )
    .addBooleanOption(option =>
      option.setName('stat')
        .setDescription('Show summary stats only (--stat)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('base')
        .setDescription('Base branch for branch diff (default: main)')
        .setRequired(false)
    ) as SlashCommandBuilder,

  execute: async (interaction: any) => {
    const i = interaction as ChatInputCommandInteraction;
    const target = i.options.getString('target') ?? 'unstaged';
    const stat = i.options.getBoolean('stat') ?? false;
    const base = i.options.getString('base') ?? 'main';

    const channel = i.channel;
    if (!channel) {
      await i.reply({ content: '❌ Unknown channel.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Resolve project path: worktree thread takes priority
    let projectPath: string | undefined;
    if (channel.isThread()) {
      const mapping = dataStore.getWorktreeMapping(i.channelId);
      if (mapping) {
        projectPath = mapping.worktreePath;
      } else {
        const parentId = (channel as any).parentId;
        if (parentId) {
          projectPath = dataStore.getChannelProjectPath(parentId);
        }
      }
    } else {
      projectPath = dataStore.getChannelProjectPath(i.channelId);
    }

    if (!projectPath) {
      await i.reply({
        content: '❌ No project bound to this channel. Use `/setpath` and `/use` first.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await i.deferReply();

    const result = await computeDiff(projectPath, target, stat, base);
    if (result.ok) {
      await i.editReply(result.content as string);
    } else {
      await i.editReply(`❌ Failed to get diff: ${result.error}`);
    }
  }
};
