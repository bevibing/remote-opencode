import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import * as sessionManager from '../services/sessionManager.js';
import type { Command } from './index.js';

export const kill: Command = {
  data: new SlashCommandBuilder()
    .setName('kill')
    .setDescription('Force-kill the OpenCode session in this thread (use when /interrupt hangs)') as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const channel = interaction.channel;
    if (!channel?.isThread()) {
      await interaction.reply({
        content: '❌ `/kill` can only be used inside a thread.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await sessionManager.forceKillThread(channel.id);

    if (!result.hadSession) {
      await interaction.editReply({
        content: 'ℹ️ No active session in this thread — nothing to kill.',
      });
      return;
    }

    const lines = [
      `🔪 **Force kill complete**`,
      `• HTTP abort: ${result.httpAborted ? '✅' : '❌ (timed out or no session)'}`,
      `• SSE stream closed: ${result.sseDisconnected ? '✅' : '— (no active stream)'}`,
      `• Thread session cleared: ${result.sessionCleared ? '✅' : '— (no session)'}`,
      `• Queue cleared: ✅`,
      '',
      'Send a new message or `/opencode` to start fresh.',
    ];

    await interaction.editReply({ content: lines.join('\n') });
  }
};
