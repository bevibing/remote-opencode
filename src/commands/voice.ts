import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  MessageFlags 
} from 'discord.js';
import { getOpenAIApiKey, setOpenAIApiKey, removeOpenAIApiKey } from '../services/configStore.js';
import type { Command } from './index.js';

function maskApiKey(key: string): string {
  if (key.length <= 7) return '***';
  return key.slice(0, 3) + '...' + key.slice(-6);
}

export const voice: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage voice message transcription settings')
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set OpenAI API key for voice transcription')
        .addStringOption(option =>
          option.setName('key')
            .setDescription('OpenAI API key')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove OpenAI API key'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show voice transcription status')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set') {
      const key = interaction.options.getString('key', true);

      if (!key.startsWith('sk-') || key.length < 20) {
        await interaction.reply({
          content: '❌ Invalid API key format. Must start with `sk-` and be at least 20 characters.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      setOpenAIApiKey(key);
      await interaction.reply({
        content: '✅ OpenAI API key set. Voice messages in `/code` threads will now be transcribed.',
        flags: MessageFlags.Ephemeral,
      });
    } else if (subcommand === 'remove') {
      removeOpenAIApiKey();
      await interaction.reply({
        content: '✅ OpenAI API key removed. Voice transcription disabled.',
        flags: MessageFlags.Ephemeral,
      });
    } else if (subcommand === 'status') {
      const envKey = process.env.OPENAI_API_KEY;
      const configKey = getOpenAIApiKey();

      if (!configKey) {
        await interaction.reply({
          content: '🎙️ Voice Transcription: **Disabled**\n  No OpenAI API key configured.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const source = envKey ? 'environment variable' : 'config file';
      await interaction.reply({
        content: `🎙️ Voice Transcription: **Enabled**\n  Source: ${source}\n  API Key: \`${maskApiKey(configKey)}\``,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};
