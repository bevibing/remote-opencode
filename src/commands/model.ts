import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  MessageFlags,
  ThreadChannel
} from 'discord.js';
import { execFile, execFileSync } from 'node:child_process';
import * as dataStore from '../services/dataStore.js';
import { resolveOpencodeCommand } from '../services/serveManager.js';
import type { Command } from './index.js';
import { sanitizeModel, truncateModel } from '../utils/stringUtils.js';

let cachedModels: string[] = [];
let cacheTimestamp = 0;
let refreshInFlight = false;
const CACHE_TTL_MS = 30_000;

function refreshCacheAsync(): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const command = resolveOpencodeCommand();
  execFile(command, ['models'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
    refreshInFlight = false;
    if (!error && stdout) {
      cachedModels = stdout.split('\n').map(sanitizeModel).filter(m => m);
      cacheTimestamp = Date.now();
    }
  });
}

export function getCachedModels(): string[] {
  const now = Date.now();
  if (now - cacheTimestamp > CACHE_TTL_MS || cachedModels.length === 0) {
    if (cachedModels.length === 0) {
      try {
        const command = resolveOpencodeCommand();
        const output = execFileSync(command, ['models'], { encoding: 'utf-8', timeout: 5000 });
        cachedModels = output.split('\n').map(sanitizeModel).filter(m => m);
        cacheTimestamp = now;
      } catch { }
    } else {
      refreshCacheAsync();
    }
  }
  return cachedModels;
}

function getEffectiveChannelId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  if (channel?.isThread()) {
    return (channel as ThreadChannel).parentId ?? interaction.channelId;
  }
  return interaction.channelId;
}

export const model: Command = {
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('Manage AI models for the current channel')
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all available models'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the model to use in this channel')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('The model name (e.g., google/gemini-2.0-flash)')
            .setRequired(true)
            .setAutocomplete(true))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const command = resolveOpencodeCommand();
        const output = execFileSync(command, ['models'], { encoding: 'utf-8' });
        const models = output.split('\n').map(sanitizeModel).filter(m => m);
        
        if (models.length === 0) {
          await interaction.editReply('No models found.');
          return;
        }

        // Group models by provider
        const groups: Record<string, string[]> = {};
        for (const m of models) {
          const [provider] = m.split('/');
          if (!groups[provider]) groups[provider] = [];
          groups[provider].push(m);
        }

        // Build flat list of lines
        const lines: string[] = [];
        lines.push('### 🤖 Available Models\n');
        for (const [provider, providerModels] of Object.entries(groups)) {
          lines.push(`**${provider}**`);
          for (const m of providerModels) {
            lines.push(`• \`${truncateModel(m)}\``);
          }
          lines.push(''); // blank line between providers
        }

        // Flush lines into messages, respecting Discord's 2000-char ceiling
        const MAX_MESSAGE_LENGTH = 1800;
        let response = '';
        let isFirstMessage = true;

        const flush = async (text: string): Promise<void> => {
          if (isFirstMessage) {
            await interaction.editReply(text);
            isFirstMessage = false;
          } else {
            await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
          }
        };

        for (const line of lines) {
          const candidate = line + '\n';
          if (response.length + candidate.length > MAX_MESSAGE_LENGTH && response.length > 0) {
            await flush(response);
            response = '';
          }
          response += candidate;
        }

        if (response) {
          await flush(response);
        }
      } catch (error) {
        console.error('Failed to list models:', error);
        await interaction.editReply('❌ Failed to retrieve models from OpenCode CLI.');
      }
    } else if (subcommand === 'set') {
      const rawName = interaction.options.getString('name', true);
      const modelName = sanitizeModel(rawName);
      const channelId = getEffectiveChannelId(interaction);
      
      const projectAlias = dataStore.getChannelBinding(channelId);
      if (!projectAlias) {
        await interaction.reply({
          content: '❌ No project bound to this channel. Use `/use <alias>` first.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const availableModels = getCachedModels();
        if (availableModels.length > 0 && !availableModels.includes(modelName)) {
          await interaction.editReply(
            `❌ Model \`${truncateModel(modelName)}\` not found.\nUse \`/model list\` to see available models.`
          );
          return;
        }
      } catch {
        console.warn('[model] Could not validate model name against opencode models');
      }

      dataStore.setChannelModel(channelId, modelName);
      
      const displayName = truncateModel(modelName);
      await interaction.editReply(
        `✅ Model for this channel set to \`${displayName}\`.\nSubsequent commands will use this model.`
      );
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const models = getCachedModels();

    const filtered = models
      .filter(m => m.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(m => truncateModel(m, 100)); // Discord autocomplete name has 100-char limit

    try {
      await interaction.respond(
        filtered.map(m => ({ name: m, value: m }))
      );
    } catch { }
  }
};
