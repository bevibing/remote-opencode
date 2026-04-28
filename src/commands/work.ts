import { SlashCommandBuilder, ChatInputCommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel, ThreadAutoArchiveDuration, MessageFlags, ChannelType } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';
import type { Command } from './index.js';

export const work: Command = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('Create a new worktree for a task')
    .addStringOption(option =>
      option.setName('branch')
        .setDescription('Branch name')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('description')
        .setDescription('Description of the work (defaults to branch name)')
        .setRequired(false)
    ) as SlashCommandBuilder,

  execute: async (interaction: any) => {
    const i = interaction as ChatInputCommandInteraction;
    const branchInput = i.options.getString('branch', true);
    const sanitizedBranch = worktreeManager.sanitizeBranchName(branchInput);
    const description = i.options.getString('description')?.trim() || sanitizedBranch;

    const channel = i.channel;
    if (!channel) {
      await i.reply({ content: '❌ Unknown channel.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (channel.isThread()) {
      await i.reply({
        content: '❌ Cannot create a worktree from inside a thread. Please use the main channel.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (channel.type !== ChannelType.GuildText) {
      await i.reply({
        content: '❌ Command can only be used in text channels.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const projectPath = dataStore.getChannelProjectPath(i.channelId);
    if (!projectPath) {
      await i.reply({
        content: '❌ No project bound to this channel. Use `/setpath` and `/use` first.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const existingMapping = dataStore.getWorktreeMappingByBranch(projectPath, sanitizedBranch);
    if (existingMapping) {
      await i.reply({
        content: `❌ Worktree for branch **${sanitizedBranch}** already exists in <#${existingMapping.threadId}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const worktreePath = await worktreeManager.createWorktree(projectPath, sanitizedBranch);

      const threadName = `🌳 ${sanitizedBranch}: ${description}`.substring(0, 100);
      const parentChannel = channel as TextChannel;
      
      const thread = await parentChannel.threads.create({
        name: threadName,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: `Worktree for ${sanitizedBranch}`
      });

      dataStore.setWorktreeMapping({
        threadId: thread.id,
        branchName: sanitizedBranch,
        worktreePath: worktreePath,
        projectPath: projectPath,
        description: description,
        createdAt: Date.now()
      });

      const alias = dataStore.getChannelBinding(i.channelId);
      if (alias && dataStore.getProjectAutoPassthrough(alias)) {
        dataStore.setPassthroughMode(thread.id, true, i.user.id);
      }

      const embed = new EmbedBuilder()
        .setTitle(`🌳 Worktree: ${sanitizedBranch}`)
        .setDescription(description)
        .addFields(
          { name: 'Branch', value: sanitizedBranch, inline: true },
          { name: 'Path', value: worktreePath, inline: true },
          { name: 'Created', value: new Date().toLocaleString(), inline: true }
        )
        .setColor(0x2ecc71);

      const buttons = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`delete_${thread.id}`)
            .setLabel('Delete')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`pr_${thread.id}`)
            .setLabel('Create PR')
            .setStyle(ButtonStyle.Primary)
        );

      await thread.send({
        embeds: [embed],
        components: [buttons]
      });

      await i.editReply({
        content: `✅ Created worktree **${sanitizedBranch}** -> <#${thread.id}>`,
      });

    } catch (error) {
      console.error('Worktree creation failed:', error);
      await i.editReply({
        content: `❌ Failed to create worktree: ${(error as Error).message}`,
      });
    }
  }
};
