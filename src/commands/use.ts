import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, MessageFlags } from 'discord.js';
import { homedir } from 'node:os';
import * as dataStore from '../services/dataStore.js';

export const use = {
  data: new SlashCommandBuilder()
    .setName('use')
    .setDescription('Set the project for this channel')
    .addStringOption(option =>
      option.setName('alias')
        .setDescription('Project alias')
        .setRequired(true)
        .setAutocomplete(true)),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'alias') return;

    const projects = dataStore.getProjects();
    const home = homedir();
    const query = (focused.value || '').toLowerCase();

    const matches = projects
      .filter(p =>
        p.alias.toLowerCase().includes(query) ||
        p.path.toLowerCase().includes(query)
      )
      .slice(0, 25)
      .map(p => ({
        name: `${p.alias}  →  ${p.path.replace(home, '~')}`.slice(0, 100),
        value: p.alias
      }));

    await interaction.respond(matches);
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const alias = interaction.options.getString('alias', true);
    const channelId = interaction.channelId;

    const project = dataStore.getProject(alias);
    if (!project) {
      await interaction.reply({
        content: `❌ Project '${alias}' not found. Use \`/projects\` to see registered projects.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    dataStore.setChannelBinding(channelId, alias);
    await interaction.reply(`✅ Using project '${alias}' in this channel`);
  }
};
