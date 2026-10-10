import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags
} from 'discord.js';
import type { Command } from './index.js';
import { isVoiceEnabled, getHandyBin } from '../services/voiceService.js';

export const voice: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Show voice message transcription status')
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show voice transcription status')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'status') {
      if (isVoiceEnabled()) {
        const model = process.env.HANDY_MODEL ? `\n  Model: \`${process.env.HANDY_MODEL}\`` : '';
        await interaction.reply({
          content: `🎙️ Voice Transcription: **Enabled**\n  Engine: **Handy** (local)\n  Binary: \`${getHandyBin()}\`${model}\n  Mandá un voice message en un canal de sesión y se transcribe automáticamente.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: `🎙️ Voice Transcription: **Disabled**\n  No se encontró Handy en \`${getHandyBin()}\`.\n  Instalalo con \`sudo apt install handy\` y dejalo corriendo.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
};
