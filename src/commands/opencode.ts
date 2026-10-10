import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import * as sessionFlow from '../services/sessionFlow.js';
import type { Command } from './index.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';

export const opencode: Command = {
  data: new SlashCommandBuilder()
    .setName('opencode')
    .setDescription('Enviar un prompt a OpenCode (crea un canal de sesión si no estás en uno)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt to send to OpenCode')
        .setRequired(true)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const prompt = interaction.options.getString('prompt', true);
    const channel = interaction.channel;

    let targetChannel: TextChannel | ThreadChannel;
    let threadId: string;
    let parentChannelId: string;

    if (channel?.isThread()) {
      targetChannel = channel;
      threadId = channel.id;
      parentChannelId = channel.parentId ?? channel.id;
    } else if (
      channel &&
      channel.isTextBased() &&
      !channel.isDMBased() &&
      dataStore.isPassthroughEnabled(channel.id)
    ) {
      targetChannel = channel as TextChannel;
      threadId = channel.id;
      parentChannelId = channel.id;
    } else {
      const hub = dataStore.getHubConfig();
      if (!hub || !interaction.guild) {
        await interaction.reply({
          content:
            '❌ No hay hub configurado. Usá `/hub` en el canal principal, o entrá a un canal de sesión.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      try {
        const created = await sessionFlow.createSessionChannel(
          interaction.guild,
          prompt.slice(0, 90),
          hub.projectAlias,
          hub.model,
          hub.agent,
          interaction.user.id,
        );
        targetChannel = created;
        threadId = created.id;
        parentChannelId = created.id;
      } catch (error) {
        await interaction.editReply({
          content: `❌ No se pudo crear el canal de sesión: ${(error as Error).message}`,
        });
        return;
      }
    }

    const projectPath = dataStore.getChannelProjectPath(parentChannelId);
    if (!projectPath) {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({
          content: '❌ No hay proyecto asignado a este canal.',
        });
      } else {
        await interaction.reply({
          content: '❌ No hay proyecto asignado a este canal.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    if (isBusy(threadId)) {
      dataStore.addToQueue(threadId, {
        prompt,
        userId: interaction.user.id,
        timestamp: Date.now(),
      });
      await interaction.editReply({
        content: `📥 Prompt agregado a la cola de <#${threadId}>.`,
      });
      return;
    }

    await interaction.editReply({
      content: `📌 **Prompt**: ${prompt} — sesión <#${threadId}>`,
    });

    await runPrompt(targetChannel as any, threadId, prompt, parentChannelId);
  },
};
